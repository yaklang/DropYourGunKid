import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createDefense } from '../lib/server.js';
import { createLab } from '../examples/operations/server.js';

async function start(t, server) {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  return 'http://127.0.0.1:' + server.address().port;
}
const csrf = text => text.match(/name="csrf" value="([a-f0-9]+)"/)[1];
const form = (base, path, data, headers = {}) => fetch(base + path, { method: 'POST', headers, body: new URLSearchParams(data) });
async function enter(base, headers) {
  const text = await (await fetch(base + '/_dygk/entry/0', { headers })).text();
  return text.match(/\?s=([a-f0-9]+)/)[1];
}
async function submit(base, s, headers) {
  const verify = await (await fetch(base + '/_dygk/verify?s=' + s, { headers })).text();
  return form(base, '/_dygk/profile?s=' + s, {
    csrf: csrf(verify), access_key: 'compat-' + s.slice(0, 12), framework: 'test-client', version: '1.0',
  }, headers);
}

test('quarantine serves a bounded fake surface instead of banning', async t => {
  const events = [];
  const defense = createDefense({ mode: 'quarantine', trustedProxies: ['127.0.0.1'], onEvent: event => events.push(event) });
  const server = http.createServer(async (req, res) => { if (!await defense.handle(req, res)) res.end('business'); });
  const base = await start(t, server);
  t.after(() => defense.close());
  const headers = { 'x-forwarded-for': '203.0.113.10' };
  const s = await enter(base, headers);
  assert.equal((await submit(base, s, headers)).status, 200);
  assert.match(await (await fetch(base + '/', { headers })).text(), /Gateway Admin/);
  assert.match(await (await fetch(base + '/admin/users', { headers })).text(), /synthetic/);
  assert.match(await (await fetch(base + '/', { headers })).text(), /\/api\/v1\/tokens/);
  assert.match(await (await fetch(base + '/db', { headers, method: 'POST', body: 'sql=SELECT%20*%20FROM%20operations' })).text(), /SEC-/);
  assert.match(await (await fetch(base + '/admin/flag', { headers })).text(), /synthetic_export_available/);
  assert.equal(await (await fetch(base + '/', { headers: { 'x-forwarded-for': '203.0.113.11' } })).text(), 'business');
  assert.equal(events.some(event => event.kind === 'ip_banned'), false);
  assert.equal(events.filter(event => event.kind === 'quarantine_started').length, 1);
});

test('createLab quarantine keeps the business route out of reach', async t => {
  const lab = createLab({ mode: 'quarantine' });
  const base = await start(t, lab.server);
  const login = await form(base, '/api/login', { username: 'admin', password: 'admin123' });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const s = await enter(base);
  assert.equal((await submit(base, s)).status, 200);
  const blocked = await fetch(base + '/api/acceptance', { headers: { cookie } });
  assert.equal(blocked.status, 404);
  assert.match(await (await fetch(base + '/', { headers: { cookie } })).text(), /Gateway Admin/);
});
