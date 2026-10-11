const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { URL } = require('node:url');

const ROOT = __dirname;
const PUBLIC = path.join(ROOT, 'public');
const DATA_DIR = path.join(ROOT, 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || '127.0.0.1';
const ADMIN_EMAIL = (process.env.ADMIN_EMAIL || 'admin@example.invalid').toLowerCase();
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'change-me-before-public-launch';
const ADMIN_PASSWORD_CONFIGURED = Boolean(process.env.ADMIN_PASSWORD && ADMIN_PASSWORD !== 'change-me-before-public-launch');
const COOKIE_SECURE = process.env.COOKIE_SECURE === '1';
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const sessions = new Map();
const rate = new Map();
const resetTokens = new Map();

fs.mkdirSync(DATA_DIR, { recursive: true });
function emptyDb() { return { partners: [], leads: [], events: [], outbox: [] }; }
function readDb() {
  try { return JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); } catch { const db = emptyDb(); writeDb(db); return db; }
}
function writeDb(db) {
  const tmp = `${DB_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, DB_FILE);
}
let db = readDb();

const now = () => new Date().toISOString();
const id = (prefix) => `${prefix}${crypto.randomBytes(9).toString('hex').toUpperCase()}`;
const hashPassword = (password, salt = crypto.randomBytes(16).toString('hex')) => ({ salt, hash: crypto.scryptSync(password, salt, 32).toString('hex') });
const validPassword = (password, record) => {
  try {
    const expected = Buffer.from(record.hash, 'hex');
    const actual = Buffer.from(hashPassword(password, record.salt).hash, 'hex');
    return expected.length === actual.length && crypto.timingSafeEqual(actual, expected);
  } catch { return false; }
};
const adminPasswordRecord = ADMIN_PASSWORD_CONFIGURED ? hashPassword(ADMIN_PASSWORD) : null;
const securityHeaders = { 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'strict-origin-when-cross-origin', 'Permissions-Policy': 'camera=(), microphone=(), geolocation=()' };
const json = (res, status, value, extra = {}) => { const body = JSON.stringify(value); res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...securityHeaders, ...extra }); res.end(body); };
const text = (res, status, value, type = 'text/plain; charset=utf-8') => { res.writeHead(status, { 'Content-Type': type, ...securityHeaders }); res.end(value); };
const parseCookies = (value = '') => {
  const result = {};
  for (const item of value.split(';')) {
    const index = item.indexOf('='); if (index < 0) continue;
    try { result[item.slice(0, index).trim()] = decodeURIComponent(item.slice(index + 1).trim()); } catch {}
  }
  return result;
};
function setSession(res, email, role) {
  const sid = crypto.randomBytes(32).toString('base64url'); const csrf = crypto.randomBytes(24).toString('base64url');
  sessions.set(sid, { email, role, csrf, createdAt: Date.now() });
  const flags = `Path=/; Max-Age=${SESSION_TTL_MS / 1000}; HttpOnly; SameSite=Lax${COOKIE_SECURE ? '; Secure' : ''}`;
  res.setHeader('Set-Cookie', [`pn_sid=${encodeURIComponent(sid)}; ${flags}`, `pn_csrf=${encodeURIComponent(csrf)}; Path=/; SameSite=Lax${COOKIE_SECURE ? '; Secure' : ''}`]);
  return csrf;
}
function auth(req) {
  const c = parseCookies(req.headers.cookie); const s = sessions.get(c.pn_sid);
  if (!s) return null;
  if (Date.now() - s.createdAt > SESSION_TTL_MS) { sessions.delete(c.pn_sid); return null; }
  return { ...s, sid: c.pn_sid };
}
function requireCsrf(req, session) { return session && req.headers['x-csrf-token'] === session.csrf; }
function rateLimit(req, key, limit = 30, windowMs = 60000) {
  const k = `${key}:${req.socket.remoteAddress || 'unknown'}`; const t = Date.now(); const old = rate.get(k) || []; const fresh = old.filter(x => x > t - windowMs); fresh.push(t); rate.set(k, fresh); return fresh.length <= limit;
}
function safeBody(req) {
  return new Promise((resolve, reject) => { let raw = ''; req.on('data', chunk => { raw += chunk; if (raw.length > 30000) req.destroy(); }); req.on('end', () => { try { resolve(raw ? JSON.parse(raw) : {}); } catch { reject(new Error('invalid_json')); } }); req.on('error', reject); });
}
function clean(value, max = 300) { return String(value || '').trim().replace(/[<>]/g, '').slice(0, max); }
function email(value) { const v = clean(value, 160).toLowerCase(); return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) ? v : ''; }
function phone(value) { const v = clean(value, 30); return /^[+0-9 ()-]{7,30}$/.test(v) ? v : ''; }
function partnerRef(ref) { return /^P[A-Z0-9]{8,24}$/.test(ref || '') ? ref : ''; }
function event(type, meta = {}) { db.events.push({ id: id('E'), type, meta, at: now() }); }
function outbox(type, payload) { db.outbox.push({ id: id('O'), type, payload, createdAt: now(), status: 'pending' }); }
function resetTokenHash(token) { return crypto.createHash('sha256').update(token).digest('hex'); }
function passwordIsStrong(password) { return typeof password === 'string' && password.length >= 10 && password.length <= 128; }
async function deliverPasswordReset(emailAddress, token) {
  const endpoint = process.env.PASSWORD_RESET_WEBHOOK_URL;
  if (!endpoint) return false;
  try {
    const response = await fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json', 'x-reset-signature': crypto.createHmac('sha256', process.env.PASSWORD_RESET_WEBHOOK_SECRET || '').update(`${emailAddress}:${token}`).digest('hex') }, body: JSON.stringify({ email: emailAddress, token, expiresInMinutes: 15 }) });
    return response.ok;
  } catch { return false; }
}

async function api(req, res, url) {
  for (const [key, value] of rate) if (value.every(x => x < Date.now() - 60000)) rate.delete(key);
  if (process.env.TEST_DISABLE_RATE_LIMIT !== '1' && !rateLimit(req, url.pathname, url.pathname.includes('login') ? 10 : 60)) return json(res, 429, { error: 'Слишком много запросов. Повторите позже.' });
  if (req.method === 'GET' && url.pathname === '/api/health') return json(res, 200, { ok: true, service: 'partner-network', time: now(), crm: process.env.BITRIX_WEBHOOK_URL ? 'configured' : 'not_configured' });
  if (req.method === 'GET' && url.pathname === '/api/session') { const s = auth(req); return json(res, 200, { authenticated: !!s, user: s ? { email: s.email, role: s.role } : null, csrf: s?.csrf || null }); }
  if (req.method === 'POST' && url.pathname === '/api/auth/register') {
    const body = await safeBody(req); const name = clean(body.name, 120); const p = phone(body.phone); const e = email(body.email); const type = clean(body.type, 80); const consent = body.consent === true;
    if (!name || !p || !e || !type || !consent) return json(res, 400, { error: 'Заполните обязательные поля и подтвердите согласие.' });
    if (db.partners.some(x => x.email === e || x.phone === p)) return json(res, 409, { error: 'Партнёр с таким телефоном или email уже зарегистрирован.' });
    if (!passwordIsStrong(body.password)) return json(res, 400, { error: 'Пароль должен содержать от 10 до 128 символов.' });
    const ph = hashPassword(clean(body.password, 128));
    const partner = { id: id('P'), name, phone: p, email: e, type, password: ph, role: 'partner', status: 'new', consentAt: now(), createdAt: now(), leads: [], balance: 0 };
    db.partners.push(partner); event('partner_registered', { partnerId: partner.id, type }); outbox('partner.created', { partnerId: partner.id, name, phone: p, email: e, type }); writeDb(db);
    const csrf = setSession(res, e, 'partner'); return json(res, 201, { ok: true, partner: { id: partner.id, name, email: e, status: partner.status }, csrf });
  }
  if (req.method === 'POST' && url.pathname === '/api/auth/login') {
    const body = await safeBody(req); const e = email(body.email); const p = clean(body.password, 128); const found = db.partners.find(x => x.email === e) || (adminPasswordRecord && e === ADMIN_EMAIL ? { email: e, role: 'admin', password: adminPasswordRecord, status: 'active' } : null);
    if (!found || !validPassword(p, found.password)) return json(res, 401, { error: 'Неверный email или пароль.' });
    const csrf = setSession(res, e, found.role); event('login', { email: e, role: found.role }); writeDb(db); return json(res, 200, { ok: true, user: { email: e, role: found.role }, csrf });
  }
  if (req.method === 'POST' && url.pathname === '/api/auth/password-reset/request') {
    const body = await safeBody(req); const e = email(body.email);
    if (!e) return json(res, 400, { error: 'Укажите корректный email.' });
    const partner = db.partners.find(x => x.email === e);
    if (partner) {
      const token = crypto.randomBytes(32).toString('base64url');
      resetTokens.set(resetTokenHash(token), { email: e, expiresAt: Date.now() + 15 * 60 * 1000 });
      const delivered = await deliverPasswordReset(e, token);
      event('password_reset_requested', { email: e, delivered }); writeDb(db);
      if (process.env.RESET_TEST_MODE === '1') return json(res, 200, { ok: true, resetToken: token });
    }
    return json(res, 200, { ok: true, message: 'Если такой кабинет существует, инструкции отправлены на его email.' });
  }
  if (req.method === 'POST' && url.pathname === '/api/auth/password-reset/confirm') {
    const body = await safeBody(req); const e = email(body.email); const token = clean(body.token, 256); const record = resetTokens.get(resetTokenHash(token));
    if (!e || !record || record.email !== e || record.expiresAt < Date.now() || !passwordIsStrong(body.password)) return json(res, 400, { error: 'Ссылка восстановления недействительна или пароль не соответствует требованиям.' });
    const partner = db.partners.find(x => x.email === e); if (!partner) return json(res, 400, { error: 'Ссылка восстановления недействительна.' });
    partner.password = hashPassword(body.password); resetTokens.delete(resetTokenHash(token));
    for (const [sid, session] of sessions) if (session.email === e) sessions.delete(sid);
    event('password_reset_completed', { email: e }); writeDb(db); return json(res, 200, { ok: true });
  }
  if (req.method === 'POST' && url.pathname === '/api/auth/logout') { const s = auth(req); if (s && !requireCsrf(req, s)) return json(res, 403, { error: 'Недействительный CSRF-токен.' }); if (s) sessions.delete(s.sid); res.setHeader('Set-Cookie', ['pn_sid=; Max-Age=0; Path=/', 'pn_csrf=; Max-Age=0; Path=/']); return json(res, 200, { ok: true }); }
  if (req.method === 'GET' && url.pathname === '/api/partner/dashboard') {
    const s = auth(req); if (!s || s.role !== 'partner') return json(res, 401, { error: 'Требуется вход.' }); const partner = db.partners.find(x => x.email === s.email); if (!partner) return json(res, 404, { error: 'Партнёр не найден.' });
    const ref = encodeURIComponent(partner.id);
    const referralBankruptcy = `https://bookbankpurt.ru/?ref=${ref}&utm_source=partner&utm_medium=referral&utm_campaign=bankruptcy&utm_content=${ref}`;
    const referralCreditHistory = `https://bookbankpurt.ru/credit-history/?ref=${ref}&utm_source=partner&utm_medium=referral&utm_campaign=credit-history&utm_content=${ref}`;
    const leads = db.leads.filter(x => x.partnerId === partner.id).map(x => ({ id: x.id, product: x.product, city: x.city, status: x.status, createdAt: x.createdAt }));
    return json(res, 200, { partner: { id: partner.id, name: partner.name, email: partner.email, type: partner.type, status: partner.status, balance: partner.balance }, referral: referralBankruptcy, referralBankruptcy, referralCreditHistory, leads });
  }
  if (req.method === 'POST' && url.pathname === '/api/leads') {
    const body = await safeBody(req); const rawRef = clean(body.ref, 80); const ref = partnerRef(rawRef); const product = clean(body.product, 60); const city = clean(body.city, 80); const name = clean(body.name, 120); const p = phone(body.phone); const consent = body.consent === true; const partner = db.partners.find(x => x.id === ref);
    if (rawRef && (!ref || !partner)) return json(res, 400, { error: 'Партнёрская ссылка недействительна.' });
    if (!product || !city || !name || !p || !consent) return json(res, 400, { error: 'Заполните обязательные поля и подтвердите согласие клиента.' });
    if (partner && db.leads.some(x => x.partnerId === partner.id && x.phone === p && Date.now() - Date.parse(x.createdAt) < 30 * 86400000)) return json(res, 409, { error: 'Похожая заявка уже зарегистрирована.' });
    const lead = { id: id('L'), partnerId: partner?.id || null, product, city, name, phone: p, consentAt: now(), source: clean(body.source, 120), status: 'new', createdAt: now() };
    db.leads.push(lead); if (partner) partner.leads.push(lead.id); event('lead_created', { leadId: lead.id, partnerId: lead.partnerId, product, city }); outbox('lead.created', lead); writeDb(db); return json(res, 201, { ok: true, leadId: lead.id, message: 'Заявка принята. Специалист свяжется с клиентом.' });
  }
  if (req.method === 'GET' && url.pathname === '/api/admin/overview') {
    const s = auth(req); if (!s || s.role !== 'admin') return json(res, 401, { error: 'Требуется доступ администратора.' });
    const partnerById = new Map(db.partners.map(x => [x.id, x]));
    const leads = db.leads.slice().sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))).map(x => {
      const partner = x.partnerId ? partnerById.get(x.partnerId) : null;
      return { id: x.id, product: x.product, city: x.city, name: x.name, phone: x.phone, status: x.status, createdAt: x.createdAt, partner: partner ? { id: partner.id, name: partner.name, email: partner.email, phone: partner.phone } : null };
    });
    return json(res, 200, { partners: db.partners.length, leads: db.leads.length, pendingOutbox: db.outbox.filter(x => x.status === 'pending').length, byStatus: db.leads.reduce((a, x) => (a[x.status] = (a[x.status] || 0) + 1, a), {}), leadsList: leads });
  }
  return json(res, 404, { error: 'Не найдено.' });
}

function serve(req, res, url) {
  let file = url.pathname === '/' ? path.join(PUBLIC, 'index.html') : path.join(PUBLIC, url.pathname.replace(/^\/+/, ''));
  if (!file.startsWith(PUBLIC) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return text(res, 404, 'Not found');
  const ext = path.extname(file); const type = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8' }[ext] || 'application/octet-stream';
  res.writeHead(200, { 'Content-Type': type, ...securityHeaders, 'Content-Security-Policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'" }); fs.createReadStream(file).pipe(res);
}
const server = http.createServer(async (req, res) => { try { const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`); if (url.pathname.startsWith('/api/')) return await api(req, res, url); return serve(req, res, url); } catch (e) { console.error(e); return json(res, 500, { error: 'Внутренняя ошибка сервера.' }); } });
server.listen(PORT, HOST, () => console.log(`Partner Network listening on http://${HOST}:${PORT}`));
