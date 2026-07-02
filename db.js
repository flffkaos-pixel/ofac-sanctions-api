const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

var DB_DIR = process.env.DATA_DIR || __dirname;
var USERS_PATH = path.join(DB_DIR, 'data', 'users.json');
var CUSTOMERS_PATH = path.join(DB_DIR, 'data', 'customers.json');
var AUDIT_PATH = path.join(DB_DIR, 'data', 'audit.json');

function ensureDir() { fs.mkdirSync(path.join(DB_DIR, 'data'), { recursive: true }); }

function readJSON(p) { try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { return []; } }
function writeJSON(p, d) { ensureDir(); fs.writeFileSync(p, JSON.stringify(d, null, 2)); }

function hashPw(pw) { var salt = crypto.randomBytes(16).toString('hex'); return salt + ':' + crypto.scryptSync(pw, salt, 64).toString('hex'); }
function verifyPw(pw, stored) { var sp = stored.split(':'); return crypto.scryptSync(pw, sp[0], 64).toString('hex') === sp[1]; }
function genKey() { return 'osk_' + crypto.randomBytes(24).toString('hex'); }

function findBy(arr, key, val) { return arr.find(function (x) { return x[key] === val; }) || null; }

// ---- Users ----
function getUsers() { return readJSON(USERS_PATH); }
function saveUsers(u) { writeJSON(USERS_PATH, u); }

function signup(email, password, company) {
  email = email.toLowerCase().trim();
  if (getUsers().some(function (u) { return u.email === email; })) throw new Error('이미 등록된 이메일');
  if (password.length < 6) throw new Error('비밀번호 6자 이상');
  var user = { id: crypto.randomUUID(), email: email, password: hashPw(password), company: company || '', plan: 'free', apiKeys: [{ key: genKey(), name: 'default', createdAt: new Date().toISOString(), active: true }], usage: {}, createdAt: new Date().toISOString() };
  var users = getUsers(); users.push(user); saveUsers(users);
  return { id: user.id, apiKey: user.apiKeys[0].key, plan: user.plan };
}

function login(email, password) {
  var user = findBy(getUsers(), 'email', email.toLowerCase().trim());
  if (!user || !verifyPw(password, user.password)) throw new Error('이메일 또는 비밀번호 불일치');
  if (!user.apiKeys.some(function (k) { return k.active; })) { user.apiKeys.push({ key: genKey(), name: 'default', createdAt: new Date().toISOString(), active: true }); saveUsers(getUsers().map(function (u) { return u.id === user.id ? user : u; })); }
  return { id: user.id, apiKey: user.apiKeys.find(function (k) { return k.active; }).key, plan: user.plan };
}

function findByApiKey(key) { return findBy(getUsers(), 'apiKeys', undefined) || null; }
// Fix: need to search within apiKeys array
function findUserByApiKey(key) {
  return getUsers().find(function (u) { return u.apiKeys.some(function (k) { return k.key === key && k.active !== false; }); }) || null;
}

function recordUsage(apiKey) {
  var users = getUsers();
  var user = users.find(function (u) { return u.apiKeys.some(function (k) { return k.key === apiKey; }); });
  if (!user) return;
  var today = new Date().toISOString().slice(0, 10);
  user.usage[today] = (user.usage[today] || 0) + 1;
  saveUsers(users);
}

function rotateKey(userId) {
  var users = getUsers();
  var user = findBy(users, 'id', userId);
  if (!user) throw new Error('User not found');
  var key = genKey();
  user.apiKeys.push({ key: key, name: 'rotated-' + Date.now(), createdAt: new Date().toISOString(), active: true });
  saveUsers(users);
  return key;
}

function getUsage(userId) {
  var user = findBy(getUsers(), 'id', userId);
  return user ? user.usage : {};
}

// ---- Customers ----
function getCustomers(userId) {
  return readJSON(CUSTOMERS_PATH).filter(function (c) { return c.userId === userId; });
}

function addCustomer(userId, name, email, company, notes) {
  var customers = readJSON(CUSTOMERS_PATH);
  var c = { id: crypto.randomUUID(), userId: userId, name: name, email: email || '', companyName: company || '', notes: notes || '', status: 'active', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), screenCount: 0, lastScreen: null };
  customers.push(c);
  writeJSON(CUSTOMERS_PATH, customers);
  return c;
}

function addScreeningResult(customerId, userId, query, results) {
  var customers = readJSON(CUSTOMERS_PATH);
  var c = customers.find(function (x) { return x.id === customerId && x.userId === userId; });
  if (!c) throw new Error('Customer not found');
  c.screenCount = (c.screenCount || 0) + 1;
  c.lastScreen = new Date().toISOString();
  writeJSON(CUSTOMERS_PATH, customers);

  var audit = readJSON(AUDIT_PATH);
  audit.push({
    id: crypto.randomUUID(), userId: userId, customerId: customerId, customerName: c.name,
    query: query, risk: results.risk || 'CLEAR', matches: results.matches.length,
    details: results.matches.slice(0, 10),
    timestamp: new Date().toISOString(),
  });
  writeJSON(AUDIT_PATH, audit);
  return audit[audit.length - 1];
}

function getAuditLog(userId, limit) {
  limit = limit || 50;
  return readJSON(AUDIT_PATH).filter(function (a) { return a.userId === userId; }).sort(function (a, b) { return new Date(b.timestamp) - new Date(a.timestamp); }).slice(0, limit);
}

function getAuditLogByCustomer(customerId, userId) {
  return readJSON(AUDIT_PATH).filter(function (a) { return a.customerId === customerId && a.userId === userId; }).sort(function (a, b) { return new Date(b.timestamp) - new Date(a.timestamp); });
}

module.exports = { signup: signup, login: login, findUserByApiKey: findUserByApiKey, recordUsage: recordUsage, rotateKey: rotateKey, getUsage: getUsage, getUsers: getUsers, getCustomers: getCustomers, addCustomer: addCustomer, addScreeningResult: addScreeningResult, getAuditLog: getAuditLog, getAuditLogByCustomer: getAuditLogByCustomer };
