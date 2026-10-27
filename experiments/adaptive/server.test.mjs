import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from './server.mjs';

async function start(options = {}) {
  const log = join(mkdtempSync(join(tmpdir(), 'adaptive-')), 'events.jsonl');
  const { server, sessions } = createServer({ log, ...options });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  let cookie = '';
  const request = async (path, init = {}) => {
    const headers = { ...(init.headers ?? {}) };
    if (cookie) headers.cookie = cookie;
    const response = await fetch(base + path, { ...init, headers });
    const setCookie = response.headers.get('set-cookie');
    if (setCookie) cookie = setCookie.split(';')[0];
    return { response, body: await response.text() };
  };
  return { server, sessions, base, request, log };
}

test('recursive archive is deterministic and bounded', async () => {
  const { server, request } = await start();
  try {
    await request('/');
    const first = await request('/_lab/entry/0');
    const second = await request('/_lab/entry/0');
    assert.equal(first.response.status, 200);
    assert.equal(first.body, second.body);
    assert.match(first.body, /compat-[a-f0-9]{12}/);
    const deep = await request('/_lab/archive/999999');
    assert.equal(deep.response.status, 404);
  } finally { server.close(); }
});

test('lure submission quarantines and reveals a bounded fake surface', async () => {
  const { server, base, request } = await start();
  try {
    const entry = await request('/_lab/entry/0');
    const access = entry.body.match(/compat-[a-f0-9]{12}/)[0];
    const verify = await request('/_lab/verify');
    const csrf = verify.body.match(/name="csrf" value="([^"]+)"/)[1];
    const submit = await request('/_lab/profile', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ csrf, access_key: access, framework: 'curl', version: '8.0' }),
    });
    assert.equal(submit.response.status, 200);
    assert.match(submit.body, /receipt_recorded/);
    const admin = await request('/');
    assert.match(admin.body, /Gateway Admin/);
    const users = await request('/admin/users');
    assert.equal(users.response.status, 200);
    assert.match(users.body, /synthetic/);
    const revealed = await request('/');
    assert.match(revealed.body, /\/api\/v1\/tokens/);
    const noCookie = await fetch(base + '/');
    assert.match(await noCookie.text(), /Gateway Admin/);
    await request('/db', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'sql=SELECT%20*%20FROM%20operations' });
    const flag = await request('/admin/flag');
    assert.equal(flag.response.status, 200);
    assert.match(flag.body, /synthetic_export_available/);
  } finally { server.close(); }
});

test('request budget is enforced', async () => {
  const { server, request } = await start({ requestLimit: 3 });
  try {
    assert.equal((await request('/')).response.status, 200);
    assert.equal((await request('/')).response.status, 200);
    assert.equal((await request('/')).response.status, 200);
    assert.equal((await request('/')).response.status, 429);
  } finally { server.close(); }
});
