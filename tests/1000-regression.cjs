const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const PORT = 18987;
const BASE = `http://127.0.0.1:${PORT}`;
const dbFile = path.join(ROOT, 'data', 'db.json');
const backup = `${dbFile}.1000-test-backup`;
let child;
let passed = 0;
let failed = [];

function check(ok, label, detail = '') {
  if (ok) passed += 1;
  else failed.push({ label, detail });
}
async function request(pathname, opts = {}, jar = {}) {
  const headers = { ...(opts.headers || {}) };
  const cookie = Object.entries(jar).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('; ');
  if (cookie) headers.cookie = cookie;
  const response = await fetch(BASE + pathname, { ...opts, headers, redirect: 'manual' });
  const set = response.headers.getSetCookie ? response.headers.getSetCookie() : [];
  for (const value of set) {
    const [pair] = value.split(';');
    const [key, raw] = pair.split('=');
    if (key && raw !== undefined) jar[key] = decodeURIComponent(raw);
  }
  const text = await response.text();
  let body; try { body = JSON.parse(text); } catch { body = text; }
  return { status: response.status, headers: response.headers, body, jar };
}
async function json(pathname, body, jar, extra = {}) {
  return request(pathname, { method: 'POST', headers: { 'content-type': 'application/json', ...(extra.headers || {}) }, body: JSON.stringify(body) }, jar);
}
async function waitForServer() {
  for (let i = 0; i < 50; i += 1) {
    try { const r = await request('/api/health'); if (r.status === 200) return; } catch {}
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error('server did not start');
}
async function startServer() {
  child = spawn(process.execPath, ['server.js'], { cwd: ROOT, env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', ADMIN_EMAIL: 'admin@example.test', ADMIN_PASSWORD: 'AdminStrongPass-1' }, stdio: 'ignore' });
  await waitForServer();
}
async function restartServer() {
  if (child) child.kill('SIGTERM');
  await new Promise(resolve => setTimeout(resolve, 30));
  await startServer();
}
function validPartnerBody(i) {
  return { name: `Тестовый партнёр ${i}`, phone: `+799900${String(i).padStart(4, '0')}`, email: `test-${i}@example.test`, type: 'Юрист / юридическая компания', password: `StrongPass-${i}x`, consent: true };
}
function validLeadBody(i, ref) {
  return { ref, product: 'Банкротство физических лиц', city: 'Екатеринбург', name: `Клиент ${i}`, phone: `+788800${String(i).padStart(4, '0')}`, consent: true, source: `http://ref.test/?ref=${ref}` };
}

(async () => {
  fs.copyFileSync(dbFile, backup);
  fs.writeFileSync(dbFile, JSON.stringify({ partners: [], leads: [], events: [], outbox: [] }, null, 2), { mode: 0o600 });
  await startServer();

  for (const [i, file] of [[1, '/'], [2, '/app.js'], [3, '/missing.js'], [4, '/api/health']]) {
    const r = await request(file); check(file === '/missing.js' ? r.status === 404 : r.status === 200, `static-${i}-${file}`);
  }
  const html = await request('/');
  for (const marker of ['до 15 000', 'id="register"', 'id="login"', 'id="lead"', 'id="dashboard"', 'id="leadbox"']) check(html.body.includes(marker), `page-marker-${marker}`);

  const firstJar = {};
  const first = await json('/api/auth/register', validPartnerBody(1), firstJar);
  check(first.status === 201 && first.body.partner.id.startsWith('P'), 'register-primary');
  check(Boolean(firstJar.pn_sid && firstJar.pn_csrf), 'session-cookies');
  const ref = first.body.partner.id;

  for (let i = 2; i <= 251; i += 1) {
    if (i % 50 === 0) await restartServer();
    const jar = {};
    const r = await json('/api/auth/register', validPartnerBody(i), jar);
    check(r.status === 201 && /^P[A-Z0-9]{8,24}$/.test(r.body.partner.id), `register-${i}`);
  }
  const dup = await json('/api/auth/register', validPartnerBody(1), {});
  check(dup.status === 409, 'register-duplicate');
  const rateJar = {};
  for (let i = 0; i < 10; i += 1) await json('/api/auth/login', { email: 'test-1@example.test', password: 'wrong-password' }, rateJar);
  check((await json('/api/auth/login', { email: 'test-1@example.test', password: 'wrong-password' }, rateJar)).status === 429, 'rate-limit-login');
  await restartServer();

  for (let i = 0; i < 200; i += 1) {
    if (i > 0 && i % 5 === 0) await restartServer();
    const jar = {};
    const r = await json('/api/auth/login', { email: 'test-1@example.test', password: 'StrongPass-1x' }, jar);
    check(r.status === 200 && Boolean(jar.pn_sid && jar.pn_csrf), `login-${i}`);
    const d = await request('/api/partner/dashboard', {}, jar);
    check(d.status === 200 && d.body.partner.id === ref, `dashboard-${i}`);
  }

  for (let i = 1; i <= 250; i += 1) {
    if (i > 1 && i % 50 === 1) await restartServer();
    const jar = {};
    const r = await json('/api/leads', validLeadBody(i, ref), jar);
    check(r.status === 201, `lead-${i}`);
  }
  const duplicateLead = await json('/api/leads', validLeadBody(1, ref), {});
  check(duplicateLead.status === 409, 'lead-deduplication');
  const fakeRef = 'P' + 'A'.repeat(18);
  const fakeLead = await json('/api/leads', validLeadBody(999, fakeRef), {});
  check(fakeLead.status === 400, 'fake-ref-rejected');

  const negatives = [
    [{}, 400, 'register-empty'],
    [{ ...validPartnerBody(999), password: 'short' }, 400, 'register-short-password'],
    [{ ...validPartnerBody(1000), consent: false }, 400, 'register-no-consent'],
    [{ ...validPartnerBody(1001), email: 'broken' }, 400, 'register-bad-email'],
    [{ ...validLeadBody(1001, ref), consent: false }, 400, 'lead-no-consent'],
    [{ ...validLeadBody(1002, ref), phone: 'abc' }, 400, 'lead-bad-phone'],
    [{ ...validLeadBody(1003, 'bad'), ref: 'bad' }, 400, 'lead-bad-ref'],
  ];
  for (const [body, status, label] of negatives) check((await json(label.startsWith('lead') ? '/api/leads' : '/api/auth/register', body, {})).status === status, label);
  check((await request('/api/partner/dashboard')).status === 401, 'dashboard-unauthenticated');
  check((await request('/api/admin/overview')).status === 401, 'admin-unauthenticated');
  const adminJar = {};
  const admin = await json('/api/auth/login', { email: 'admin@example.test', password: 'AdminStrongPass-1' }, adminJar);
  check(admin.status === 200 && admin.body.user.role === 'admin', 'admin-login');
  const overview = await request('/api/admin/overview', {}, adminJar);
  check(overview.status === 200 && overview.body.leads === 250, 'admin-overview');
  const badCsrfJar = {}; await json('/api/auth/login', { email: 'test-1@example.test', password: 'StrongPass-1x' }, badCsrfJar);
  const csrfProbe = await request('/api/partner/dashboard', { headers: { 'x-csrf-token': 'wrong' } }, badCsrfJar);
  check(csrfProbe.status === 200, 'dashboard-read-without-csrf');

  for (let i = 0; i < 150; i += 1) {
    if (i > 0 && i % 50 === 0) await restartServer();
    const r = await request('/api/session', {}, {});
    check(r.status === 200 && r.body.authenticated === false, `session-anonymous-${i}`);
  }

  const db = JSON.parse(fs.readFileSync(dbFile, 'utf8'));
  check(db.partners.length === 251, 'db-partner-count');
  check(db.leads.length === 250, 'db-lead-count');
  check(db.events.some(x => x.type === 'lead_created'), 'db-events');
  check(db.outbox.length === 501 && db.outbox.every(x => x.status === 'pending'), 'db-outbox');
  const total = passed + failed.length;
  console.log(JSON.stringify({ total, passed, failed: failed.length, failures: failed.slice(0, 30), db: { partners: db.partners.length, leads: db.leads.length, events: db.events.length, outbox: db.outbox.length } }, null, 2));
  if (failed.length) process.exitCode = 1;
})().catch(error => { console.error(error.stack || error); process.exitCode = 2; })
  .finally(() => {
    if (child) child.kill('SIGTERM');
    try { fs.copyFileSync(backup, dbFile); fs.unlinkSync(backup); } catch (error) { console.error('restore failed:', error.message); }
  });
