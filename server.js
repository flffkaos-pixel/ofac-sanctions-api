const express = require('express');
const path = require('path');
const { search, batchScreen, indexSize, loadAll, DATASETS } = require('./sanctions');
const db = require('./db');

var app = express();
var PORT = process.env.PORT || 3000;
var SCHEMAS = ['Person', 'Organization', 'Company', 'Vessel', 'Airplane', 'LegalEntity'];
var PLAN_LIMITS = { free: 100, pro: 10000, enterprise: 100000 };

app.use(express.json({ limit: '10mb' }));
app.use(function (_r, res, next) { res.set('Access-Control-Allow-Origin', '*'); res.set('Access-Control-Allow-Headers', '*'); if (_r.method === 'OPTIONS') { res.status(204).end(); return; } next(); });
app.use(express.static(path.join(__dirname, 'public')));

function auth(req, res, next) {
  var key = (req.headers.authorization || '').replace(/^Bearer\s+/i, '') || req.query.api_key;
  if (!key) return res.status(401).json({ error: 'API 키가 필요합니다. Authorization: Bearer <key>' });
  var user = db.findUserByApiKey(key);
  if (!user) return res.status(403).json({ error: '유효하지 않은 API 키' });
  var today = new Date().toISOString().slice(0, 10);
  var limit = PLAN_LIMITS[user.plan] || 100;
  if ((user.usage[today] || 0) >= limit) return res.status(429).json({ error: '일일 사용량 초과 (' + limit + '회). pro@ofac-api.kr' });
  req._user = user; req._key = key; next();
}

// ---- Public ----
app.get('/api/health', async function (_r, res) { try { var s = await indexSize(); res.json({ status: 'ok', entries: s, lists: Object.keys(DATASETS).length }); } catch (e) { res.json({ status: 'loading' }); } });

app.post('/api/signup', async function (req, res) {
  try { var r = await db.signup(req.body.email, req.body.password, req.body.company); res.json({ success: true, apiKey: r.apiKey, plan: r.plan }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

app.post('/api/login', function (req, res) {
  try { var r = db.login(req.body.email, req.body.password); res.json({ success: true, apiKey: r.apiKey, plan: r.plan }); }
  catch (e) { res.status(401).json({ error: e.message }); }
});

// ---- Dashboard ----
app.get('/api/dashboard', auth, function (req, res) {
  var usage = db.getUsage(req._user.id);
  var today = new Date().toISOString().slice(0, 10);
  res.json({
    email: req._user.email, company: req._user.company, plan: req._user.plan,
    keys: req._user.apiKeys.filter(function (k) { return k.active !== false; }).map(function (k) { return { key: k.key, name: k.name, createdAt: k.createdAt }; }),
    usage: { today: usage[today] || 0, limit: PLAN_LIMITS[req._user.plan] || 100, total: Object.values(usage).reduce(function (a, b) { return a + b; }, 0) },
  });
});

app.post('/api/rotate-key', auth, function (req, res) {
  try { res.json({ apiKey: db.rotateKey(req._user.id) }); } catch (e) { res.status(400).json({ error: e.message }); }
});

// ---- Search API ----
app.get('/api/search', auth, async function (req, res) {
  try {
    var q = (req.query.q || '').trim();
    if (!q || q.length < 2) return res.status(400).json({ error: 'query param "q" required' });
    var matches = await search(q, { schema: req.query.schema || null, limit: Math.min(parseInt(req.query.limit) || 25, 100) });
    db.recordUsage(req._key);
    res.json({ query: q, total: matches.length, matches: matches, source: 'OpenSanctions (OFAC/EU/UN/UK+PEP)', timestamp: new Date().toISOString() });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---- Batch Screening ----
app.post('/api/batch', auth, async function (req, res) {
  try {
    var names = req.body.names || [];
    if (!Array.isArray(names) || names.length === 0) return res.status(400).json({ error: 'names array required' });
    if (names.length > 100) return res.status(400).json({ error: 'max 100 names per batch' });
    var results = await batchScreen(names, { maxResults: 5 });
    db.recordUsage(req._key);
    res.json({ total: results.length, high: results.filter(function (r) { return r.risk === 'HIGH'; }).length, medium: results.filter(function (r) { return r.risk === 'MEDIUM'; }).length, clear: results.filter(function (r) { return r.risk === 'CLEAR'; }).length, results: results, timestamp: new Date().toISOString() });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---- Customers ----
app.get('/api/customers', auth, function (req, res) {
  res.json({ customers: db.getCustomers(req._user.id) });
});

app.post('/api/customers', auth, function (req, res) {
  try {
    var c = db.addCustomer(req._user.id, req.body.name, req.body.email, req.body.company, req.body.notes);
    res.json({ success: true, customer: c });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.post('/api/customers/:id/screen', auth, async function (req, res) {
  try {
    var customers = db.getCustomers(req._user.id);
    var c = customers.find(function (x) { return x.id === req.params.id; });
    if (!c) return res.status(404).json({ error: 'Customer not found' });
    var q = req.body.query || c.name;
    var matches = await search(q, { limit: 10 });
    var risk = matches.length > 0 ? (matches[0].name.toLowerCase() === q.toLowerCase() ? 'HIGH' : 'MEDIUM') : 'CLEAR';
    var result = { risk: risk, matches: matches };
    var audit = db.addScreeningResult(c.id, req._user.id, q, result);
    db.recordUsage(req._key);
    res.json({ customer: c.name, result: result, audit: audit });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---- Audit Log ----
app.get('/api/audit', auth, function (req, res) {
  res.json({ audit: db.getAuditLog(req._user.id, parseInt(req.query.limit) || 50) });
});

app.get('/api/audit/customer/:id', auth, function (req, res) {
  res.json({ audit: db.getAuditLogByCustomer(req.params.id, req._user.id) });
});

// ---- Stats ----
app.get('/api/stats', auth, function (req, res) {
  var audit = db.getAuditLog(req._user.id, 10000);
  var total = audit.length;
  var high = audit.filter(function (a) { return a.risk === 'HIGH'; }).length;
  var medium = audit.filter(function (a) { return a.risk === 'MEDIUM'; }).length;
  var clear = total - high - medium;
  res.json({ totalScreens: total, high: high, medium: medium, clear: clear, customers: db.getCustomers(req._user.id).length });
});

process.on('uncaughtException', function (e) { console.error('[fatal]', e); });
process.on('unhandledRejection', function (e) { console.error('[unhandled]', e); });

app.listen(PORT, function () {
  console.log('OFAC KYC API running on http://localhost:' + PORT);
});

// Preload datasets in background
loadAll().then(function (r) { console.log('[startup] loaded ' + r.total + ' entities from ' + r.lists.length + ' lists'); });
