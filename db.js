const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const DB_PATH = path.join(process.env.DATA_DIR || __dirname, 'data', 'users.json');

function loadRaw() {
  try { return JSON.parse(fs.readFileSync(DB_PATH, 'utf-8')); }
  catch { return []; }
}

function saveRaw(users) {
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  fs.writeFileSync(DB_PATH, JSON.stringify(users, null, 2));
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const key = crypto.scryptSync(password, salt, 64).toString('hex');
  return salt + ':' + key;
}

function verifyPassword(password, stored) {
  const [salt, key] = stored.split(':');
  const derived = crypto.scryptSync(password, salt, 64).toString('hex');
  return key === derived;
}

function genApiKey() {
  return 'osk_' + crypto.randomBytes(24).toString('hex');
}

function findByEmail(email) {
  const users = loadRaw();
  return users.find(u => u.email === email.toLowerCase()) || null;
}

function findByApiKey(key) {
  const users = loadRaw();
  return users.find(u => u.apiKeys.some(k => k.key === key && k.active !== false)) || null;
}

async function signup(email, password, company) {
  email = email.toLowerCase().trim();
  if (findByEmail(email)) throw new Error('이미 등록된 이메일입니다');
  if (password.length < 6) throw new Error('비밀번호는 6자 이상이어야 합니다');

  const user = {
    id: crypto.randomUUID(),
    email,
    password: hashPassword(password),
    company: company || '',
    plan: 'free',
    apiKeys: [{ key: genApiKey(), name: 'default', createdAt: new Date().toISOString(), active: true }],
    usage: {},
    createdAt: new Date().toISOString(),
  };

  const users = loadRaw();
  users.push(user);
  saveRaw(users);
  return { id: user.id, email: user.email, apiKey: user.apiKeys[0].key, plan: user.plan };
}

function login(email, password) {
  const user = findByEmail(email);
  if (!user || !verifyPassword(password, user.password)) throw new Error('이메일 또는 비밀번호가 올바르지 않습니다');
  var key = user.apiKeys.find(k => k.active);
  if (!key) { key = { key: genApiKey(), name: 'default', createdAt: new Date().toISOString(), active: true }; user.apiKeys.push(key); saveRaw(loadRaw().map(u => u.id === user.id ? user : u)); }
  return { id: user.id, email: user.email, apiKey: key.key, plan: user.plan };
}

function rotateApiKey(userId) {
  var users = loadRaw();
  var user = users.find(u => u.id === userId);
  if (!user) throw new Error('User not found');
  var key = genApiKey();
  user.apiKeys.push({ key, name: 'rotated-' + Date.now(), createdAt: new Date().toISOString(), active: true });
  saveRaw(users);
  return key;
}

function recordUsage(apiKey) {
  var users = loadRaw();
  var user = users.find(u => u.apiKeys.some(k => k.key === apiKey));
  if (!user) return;
  var today = new Date().toISOString().slice(0, 10);
  user.usage[today] = (user.usage[today] || 0) + 1;
  saveRaw(users);
}

function getUsage(userId) {
  var users = loadRaw();
  var user = users.find(u => u.id === userId);
  return user ? user.usage : {};
}

module.exports = { signup, login, findByApiKey, rotateApiKey, recordUsage, getUsage };
