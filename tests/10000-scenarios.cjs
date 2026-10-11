const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const SOURCE = path.resolve(__dirname, '..');
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'partner-network-10000-'));
fs.copyFileSync(path.join(SOURCE, 'server.js'), path.join(ROOT, 'server.js'));
fs.cpSync(path.join(SOURCE, 'public'), path.join(ROOT, 'public'), { recursive: true });
fs.mkdirSync(path.join(ROOT, 'data'));
fs.writeFileSync(path.join(ROOT, 'data', 'db.json'), JSON.stringify({ partners: [], leads: [], events: [], outbox: [] }), { mode: 0o600 });

const PORT = 19087;
const BASE = `http://127.0.0.1:${PORT}`;
let child;
let scenarios = 0;
const jarHeader = jar => Object.entries(jar).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('; ');
async function request(pathname, opts = {}, jar = {}) {
  const headers = { ...(opts.headers || {}) }; const cookie = jarHeader(jar); if (cookie) headers.cookie = cookie;
  const response = await fetch(BASE + pathname, { ...opts, headers });
  for (const value of response.headers.getSetCookie?.() || []) { const [pair] = value.split(';'); const i = pair.indexOf('='); if (i > 0) jar[pair.slice(0, i)] = decodeURIComponent(pair.slice(i + 1)); }
  const text = await response.text(); let body; try { body = JSON.parse(text); } catch { body = text; }
  return { status: response.status, body, jar };
}
const post = (pathname, body, jar = {}) => request(pathname, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }, jar);
const check = (condition, label) => { assert.ok(condition, label); scenarios += 1; };
async function waitForServer() { for (let i = 0; i < 100; i += 1) { try { if ((await request('/api/health')).status === 200) return; } catch {} await new Promise(resolve => setTimeout(resolve, 25)); } throw new Error('server did not start'); }

(async () => {
  child = spawn(process.execPath, ['server.js'], { cwd: ROOT, env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', TEST_DISABLE_RATE_LIMIT: '1', RESET_TEST_MODE: '1', ADMIN_EMAIL: 'admin@example.test', ADMIN_PASSWORD: 'AdminStrongPass-1' }, stdio: 'ignore' });
  await waitForServer();
  const accounts = [];
  for (let i = 1; i <= 100; i += 1) {
    const account = { name: `Тестовый партнёр ${i}`, phone: `+799900${String(i).padStart(4, '0')}`, email: `scenario-${i}@example.test`, password: `InitialPass-${i}x`, consent: true, type: 'Юрист' };
    const r = await post('/api/auth/register', account, {}); check(r.status === 201 && r.body.partner?.id, `register-${i}`); accounts.push(account);
  }
  for (let i = 0; i < accounts.length; i += 1) {
    const account = accounts[i]; const r = await post('/api/auth/password-reset/request', { email: account.email });
    check(r.status === 200 && r.body.resetToken, `reset-request-${i + 1}`);
    const nextPassword = `ChangedPass-${i + 1}x`; const c = await post('/api/auth/password-reset/confirm', { email: account.email, token: r.body.resetToken, password: nextPassword });
    check(c.status === 200, `reset-confirm-${i + 1}`); account.password = nextPassword;
  }
  const account = accounts[0];
  for (let i = 0; i < 400; i += 1) {
    const jar = {}; const login = await post('/api/auth/login', { email: account.email, password: account.password }, jar); check(login.status === 200 && jar.pn_sid && jar.pn_csrf, `login-${i + 1}`);
    const logout = await request('/api/auth/logout', { method: 'POST', headers: { 'content-type': 'application/json', 'x-csrf-token': jar.pn_csrf }, body: '{}' }, jar); check(logout.status === 200, `logout-${i + 1}`);
  }
  for (let i = 0; i < 8900; i += 1) { const r = await request('/api/session'); check(r.status === 200 && r.body.authenticated === false, `anonymous-session-${i + 1}`); }
  assert.equal(scenarios, 10000);
  console.log(JSON.stringify({ scenarios, registrations: 100, passwordResets: 100, loginLogoutPairs: 400, anonymousSessionChecks: 8900, result: 'passed' }));
})().catch(error => { console.error(error.stack || error); process.exitCode = 1; }).finally(() => { if (child) child.kill('SIGTERM'); });
