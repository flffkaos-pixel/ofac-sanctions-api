const express = require('express');
const path = require('path');
const { search, indexSize } = require('./sanctions');
const db = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;
const SCHEMAS = ['Person', 'Organization', 'Company', 'Vessel', 'Airplane', 'LegalEntity'];
const PLAN_LIMITS = { free: 100, pro: 10000 };

app.use(express.json());
app.use(function (_req, res, next) { res.set('Access-Control-Allow-Origin', '*'); res.set('Access-Control-Allow-Headers', '*'); if (_req.method === 'OPTIONS') { res.status(204).end(); return; } next(); });
app.use(express.static(path.join(__dirname, 'public')));

function apiKeyAuth(req, res, next) {
  var auth = req.headers.authorization || '';
  var key = auth.startsWith('Bearer ') ? auth.slice(7) : req.query.api_key;
  if (!key) return res.status(401).json({ error: 'API 키가 필요합니다. Authorization: Bearer <key>' });
  var user = db.findByApiKey(key);
  if (!user) return res.status(403).json({ error: '유효하지 않은 API 키입니다' });
  var today = new Date().toISOString().slice(0, 10);
  var limit = PLAN_LIMITS[user.plan] || 100;
  var used = user.usage[today] || 0;
  if (used >= limit) return res.status(429).json({ error: '일일 사용량 초과 (' + limit + '회). 업그레이드: pro@ofac-api.kr' });
  req._user = user;
  req._apiKey = key;
  next();
}

app.get('/api/health', async function (_req, res) {
  try { var size = await indexSize(); res.json({ status: 'ok', entries: size }); }
  catch (e) { res.status(503).json({ status: 'loading' }); }
});

app.post('/api/signup', async function (req, res) {
  try {
    var { email, password, company } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'email, password 필수' });
    var result = await db.signup(email, password, company);
    res.json({ success: true, apiKey: result.apiKey, plan: result.plan });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.post('/api/login', function (req, res) {
  try {
    var { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'email, password 필수' });
    var result = db.login(email, password);
    res.json({ success: true, apiKey: result.apiKey, plan: result.plan });
  } catch (e) { res.status(401).json({ error: e.message }); }
});

app.get('/api/dashboard', apiKeyAuth, function (req, res) {
  var usage = db.getUsage(req._user.id);
  var limit = PLAN_LIMITS[req._user.plan] || 100;
  var today = new Date().toISOString().slice(0, 10);
  res.json({
    email: req._user.email,
    company: req._user.company,
    plan: req._user.plan,
    keys: req._user.apiKeys.filter(k => k.active !== false).map(k => ({ key: k.key, name: k.name, createdAt: k.createdAt })),
    usage: { today: usage[today] || 0, limit: limit, total: Object.values(usage).reduce((a, b) => a + b, 0) },
  });
});

app.post('/api/rotate-key', apiKeyAuth, function (req, res) {
  try { var key = db.rotateApiKey(req._user.id); res.json({ apiKey: key }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

app.get('/api/search', apiKeyAuth, async function (req, res) {
  try {
    var query = (req.query.q || '').trim();
    if (!query || query.length < 2) return res.status(400).json({ error: 'query param "q" required (min 2 chars)' });
    var schema = req.query.schema || null;
    if (schema && SCHEMAS.indexOf(schema) === -1) return res.status(400).json({ error: 'invalid schema' });
    var limit = Math.min(parseInt(req.query.limit) || 25, 100);
    var matches = await search(query, { schema, limit });
    db.recordUsage(req._apiKey);
    res.json({ query, schema, total: matches.length, matches, source: 'OpenSanctions / US OFAC SDN', timestamp: new Date().toISOString() });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

process.on('uncaughtException', function (e) { console.error('[fatal]', e); });
process.on('unhandledRejection', function (e) { console.error('[unhandled]', e); });

app.listen(PORT, function () { console.log('OFAC API running on http://localhost:' + PORT); });
