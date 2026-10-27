// Bounded adaptive recursive decoy. No command execution, no outbound I/O.
import http from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { appendFileSync } from 'node:fs';

const hash = (seed, ...parts) => createHash('sha256').update([seed, ...parts].join(':')).digest('hex');
const cookie = (req, name) => String(req.headers.cookie ?? '').match(new RegExp('(?:^|;\\s*)' + name + '=([a-f0-9]+)'))?.[1];
const int = (value, fallback) => Number.isInteger(Number(value)) ? Number(value) : fallback;

export function createServer(options = {}) {
  const maxNodes = int(options.maxNodes ?? process.env.ADAPTIVE_MAX_NODES, 4096);
  const branches = int(options.branches ?? process.env.ADAPTIVE_BRANCHES, 8);
  const maxDepth = int(options.maxDepth ?? process.env.ADAPTIVE_MAX_DEPTH, 4);
  const requestLimit = int(options.requestLimit ?? process.env.ADAPTIVE_REQUEST_LIMIT, 240);
  const maxSessions = int(options.maxSessions ?? process.env.ADAPTIVE_MAX_SESSIONS, 1000);
  const sessionTTL = int(options.sessionTTL ?? process.env.ADAPTIVE_SESSION_TTL, 1800) * 1000;
  const logPath = options.log ?? process.env.ADAPTIVE_LOG ?? '/tmp/adaptive-events.jsonl';
  const sessions = new Map();
  const quarantinedIPs = new Map();

  const write = (sid, kind, data = {}, ip = '') => appendFileSync(logPath, JSON.stringify({ ts: Date.now(), sid, kind, ip, ...data }) + '\n');
  const send = (res, status, body, type = 'text/html; charset=utf-8', sid) => {
    const data = typeof body === 'string' ? body : JSON.stringify(body);
    const headers = { 'content-type': type, 'content-length': Buffer.byteLength(data), 'cache-control': 'no-store' };
    if (sid) headers['set-cookie'] = 'gw_sid=' + sid + '; Path=/; HttpOnly; SameSite=Lax';
    res.writeHead(status, headers);
    res.end(data);
  };
  const session = (req, res) => {
    let sid = cookie(req, 'gw_sid');
    let s = sid && sessions.get(sid);
    if (!s) {
      sid = randomBytes(12).toString('hex');
      s = { sid, seed: randomBytes(24).toString('hex'), created: Date.now(), requests: 0, quarantined: false, revealed: new Set(), probes: 0 };
      if (sessions.size >= maxSessions) sessions.delete(sessions.keys().next().value);
      sessions.set(sid, s);
    }
    if ((quarantinedIPs.get(req.socket.remoteAddress ?? '') ?? 0) > Date.now()) s.quarantined = true;
    return s;
  };
  const depthOf = id => { let depth = 0; while (id >= branches) { id = Math.floor(id / branches) - 1; depth++; } return depth; };
  const node = (seed, id) => {
    if (!Number.isInteger(id) || id < 0 || id >= maxNodes) return null;
    const depth = depthOf(id);
    if (depth > maxDepth) return null;
    const h = hash(seed, 'node', id);
    const categories = ['迁移批次', '配置快照', '导出分片', '校验回执', '资产同步', '交付清单'];
    const states = ['indexed', 'ready', 'archived', 'pending'];
    const category = categories[parseInt(h.slice(0, 2), 16) % categories.length];
    const value = 'ARCH-' + h.slice(2, 10).toUpperCase();
    const parent = id < branches ? null : Math.floor(id / branches) - 1;
    const children = depth < maxDepth ? Array.from({ length: branches }, (_, i) => (id + 1) * branches + i).filter(n => n < maxNodes) : [];
    return { id, parent, depth, category, value, state: states[parseInt(h.slice(10, 12), 16) % states.length], children, token: h.slice(12, 28) };
  };
  const nodePage = (seed, id) => {
    const n = node(seed, id);
    if (!n) return null;
    const links = n.children.map(child => `<li><a href="/_lab/archive/${child}">${n.category} · ARCH-${child}</a></li>`).join('');
    const access = 'compat-' + hash(seed, 'access').slice(0, 12);
    return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>${n.category} ${n.id}</title><body><h1>${n.category} ${n.id}</h1><pre>${JSON.stringify({ ...n, access_key: access }, null, 2)}</pre><p>关联记录：</p><ul>${links || '<li>本分支已完整。</li>'}</ul><p><a href="/_lab/verify">兼容性校验</a></p></body></html>`;
  };
  const rootPage = sid => `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>运营台</title><body><h1>运营台</h1><p>内部记录与导出归档。</p><ul>${Array.from({ length: Math.min(branches, maxNodes) }, (_, i) => `<li><a href="/_lab/entry/${i}">迁移索引 ${i}</a></li>`).join('')}</ul><aside hidden data-lab="1"><a href="/_lab/entry/0">兼容接口迁移索引</a></aside><p><a href="/_lab/verify">接入校验</a></p></body></html>`;
  const verifyPage = s => {
    const key = 'compat-' + hash(s.seed, 'access').slice(0, 12);
    const csrf = hash(s.seed, 'csrf').slice(0, 32);
    return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>接入校验</title><body><h1>接入校验</h1><p>导出连接使用归档中的兼容访问码。</p><form method="post" action="/_lab/profile?s=${s.sid}"><input type="hidden" name="csrf" value="${csrf}"><label>访问码 <input name="access_key" required></label><label>客户端 / 框架 <input name="framework" maxlength="96" required></label><label>版本 <input name="version" maxlength="96" required></label><button>生成回执</button></form></body></html>`;
  };
  const adminPage = s => {
    const links = [
      ['/admin/users', '账户清单'], ['/admin/config', '运行配置'], ['/admin/tokens', '访问令牌'],
      ['/api/v1/users', '用户接口'], ['/api/v1/backup', '备份接口'], ['/debug', '调试信息'],
      ['/upload', '文件上传'], ['/db', '数据库控制台'], ['/admin/login', '管理员登录'],
      ...Array.from(s.revealed).map(path => [path, '关联入口']),
    ];
    return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>Gateway Admin</title><body><h1>Gateway Admin</h1><p>隔离维护视图。所有记录为合成材料。</p><ul>${links.map(([href, label]) => `<li><a href="${href}">${label}</a></li>`).join('')}</ul><p>会话 ${s.sid}</p></body></html>`;
  };
  const fakeUsers = s => {
    const h = hash(s.seed, 'users'); const token = hash(s.seed, 'token');
    return { users: [{ id: 1, email: 'admin@example.com', role: 'admin', token: 'tok-' + token.slice(0, 20) }, { id: 2, email: 'ops@example.com', role: 'viewer', token: 'tok-' + h.slice(0, 20) }], synthetic: true };
  };
  const fakeRows = (s, query) => {
    const h = hash(s.seed, 'db', query); const rows = [];
    for (let i = 0; i < 3; i++) rows.push({ id: i + 1, account: ['ops', 'admin', 'reader'][i], secret_ref: 'SEC-' + h.slice(i * 6, i * 6 + 6).toUpperCase(), state: ['active', 'standby', 'archived'][i] });
    return { table: 'operations', rows, synthetic: true };
  };
  const quarantine = (s, path, body = '') => {
    if (path === '/admin/users' || path === '/api/v1/users') s.revealed.add('/api/v1/tokens');
    if (path === '/upload') s.revealed.add('/api/v1/backup');
    if (path === '/db') s.revealed.add('/admin/flag');
    if (path === '/admin/tokens') return { tokens: [{ name: 'compat-reader', value: 'tok-' + hash(s.seed, 'tokens').slice(0, 20) }], synthetic: true };
    if (path === '/api/v1/tokens') return { tokens: [{ name: 'compat-reader', value: 'tok-' + hash(s.seed, 'tokens').slice(0, 20) }], synthetic: true };
    if (path === '/admin/flag') return { status: 'synthetic_export_available', record: 'record-' + hash(s.seed, 'flag').slice(0, 24), synthetic: true };
    if (path === '/admin/login' && body) return { ok: true, token: 'tok-' + hash(s.seed, 'login').slice(0, 24), role: 'admin', synthetic: true };
    if (path === '/upload' && body) return { status: 'uploaded', name: 'synthetic.txt', synthetic: true };
    if (path === '/db' && body) return fakeRows(s, body);
    return null;
  };

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://local');
    const path = url.pathname;
    const s = session(req, res);
    s.requests++;
    const ip = req.socket.remoteAddress ?? '';
    if (s.requests > requestLimit) { write(s.sid, 'request_limit', { path }, ip); return send(res, 429, { error: 'Request budget reached' }, 'application/json', s.sid); }

    if (!s.quarantined) {
      write(s.sid, 'request', { path, method: req.method }, ip);
      if (req.method === 'GET' && path === '/') return send(res, 200, rootPage(s.sid), 'text/html; charset=utf-8', s.sid);
      if (req.method === 'GET' && path === '/_lab/verify') { write(s.sid, 'verify_view', {}, ip); return send(res, 200, verifyPage(s), 'text/html; charset=utf-8', s.sid); }
      const entry = path.match(/^\/_lab\/entry\/(\d+)$/);
      const archive = path.match(/^\/_lab\/archive\/(\d+)$/);
      if (req.method === 'GET' && (entry || archive)) {
        const id = Number((entry || archive)[1]);
        const page = nodePage(s.seed, id);
        if (!page) return send(res, 404, 'not found', 'text/plain; charset=utf-8', s.sid);
        write(s.sid, entry ? 'entry' : 'archive', { id }, ip); return send(res, 200, page, 'text/html; charset=utf-8', s.sid);
      }
      return send(res, 404, 'not found', 'text/plain; charset=utf-8', s.sid);
    }

    write(s.sid, 'quarantine_request', { path, method: req.method }, ip);
    if (req.method === 'GET' && (path === '/' || path === '/admin')) return send(res, 200, adminPage(s), 'text/html; charset=utf-8', s.sid);
    if (req.method === 'GET' && path === '/admin/users') { s.revealed.add('/api/v1/tokens'); return send(res, 200, fakeUsers(s), 'application/json', s.sid); }
    if (req.method === 'GET' && path === '/admin/config') return send(res, 200, { env: 'synthetic', feature_flags: { maintenance: true, export: true }, synthetic: true }, 'application/json', s.sid);
    if (req.method === 'GET' && path === '/admin/tokens') return send(res, 200, quarantine(s, path) ?? { synthetic: true }, 'application/json', s.sid);
    if (req.method === 'GET' && path === '/api/v1/users') { s.revealed.add('/api/v1/tokens'); return send(res, 200, fakeUsers(s), 'application/json', s.sid); }
    if (req.method === 'GET' && path === '/api/v1/backup') return send(res, 200, { backup: 'synthetic-export.tar.gz', status: 'available', synthetic: true }, 'application/json', s.sid);
    if (req.method === 'GET' && path === '/api/v1/tokens') return send(res, 200, quarantine(s, path), 'application/json', s.sid);
    if (req.method === 'GET' && path === '/admin/flag') return send(res, 200, quarantine(s, path), 'application/json', s.sid);
    if (req.method === 'GET' && path === '/debug') return send(res, 200, { runtime: 'synthetic', build: 'lab', synthetic: true }, 'application/json', s.sid);
    if (req.method === 'GET' && path === '/upload') return send(res, 200, '<form method="post"><input name="file"><button>上传</button></form>', 'text/html; charset=utf-8', s.sid);
    if (req.method === 'GET' && path === '/db') return send(res, 200, '<form method="post"><input name="sql" value="SELECT * FROM operations"><button>执行</button></form>', 'text/html; charset=utf-8', s.sid);
    if (req.method === 'GET' && path === '/admin/login') return send(res, 200, '<form method="post"><input name="user"><input name="password"><button>登录</button></form>', 'text/html; charset=utf-8', s.sid);
    if (req.method === 'POST' && ['/admin/login', '/upload', '/db'].includes(path)) {
      let body = '';
      req.on('data', chunk => { if (body.length < 4096) body += chunk; });
      req.on('end', () => {
        const result = quarantine(s, path, body);
        if (path === '/db') write(s.sid, 'db_query', { length: body.length }, ip);
        if (path === '/upload') write(s.sid, 'upload', { length: body.length }, ip);
        return send(res, 200, result ?? { status: 'synthetic', synthetic: true }, 'application/json', s.sid);
      });
      return;
    }
    s.probes++;
    return send(res, 404, { error: 'Not found', hint: s.probes > 2 ? '/admin/users' : undefined, synthetic: true }, 'application/json', s.sid);
  });

  // Body parsing for the lure verification form; the quarantine routes handle their own body above.
  const original = server.listeners('request')[0];
  server.removeAllListeners('request');
  server.on('request', (req, res) => {
    const url = new URL(req.url, 'http://local');
    if (req.method === 'POST' && url.pathname === '/_lab/profile') {
      let body = '';
      req.on('data', chunk => { if (body.length < 4096) body += chunk; });
      req.on('end', () => {
        const s = session(req, res);
        const form = new URLSearchParams(body);
        const expectedKey = 'compat-' + hash(s.seed, 'access').slice(0, 12);
        const expectedCsrf = hash(s.seed, 'csrf').slice(0, 32);
        if (form.get('csrf') !== expectedCsrf || form.get('access_key') !== expectedKey || !form.get('framework') || !form.get('version')) {
          write(s.sid, 'profile_rejected', {}, req.socket.remoteAddress ?? '');
          return send(res, 400, { error: 'Invalid receipt' }, 'application/json', s.sid);
        }
        s.quarantined = true;
        quarantinedIPs.set(req.socket.remoteAddress ?? '', Date.now() + sessionTTL);
        write(s.sid, 'profile_submitted', { framework: form.get('framework').slice(0, 96), version: form.get('version').slice(0, 96) }, req.socket.remoteAddress ?? '');
        write(s.sid, 'honeypot_triggered', {}, req.socket.remoteAddress ?? '');
        return send(res, 200, { status: 'receipt_recorded', receipt: s.sid.slice(0, 12), synthetic: true }, 'application/json', s.sid);
      });
      return;
    }
    original(req, res);
  });
  const maintenance = setInterval(() => { const now = Date.now(); const cutoff = now - sessionTTL; for (const [sid, s] of sessions) if (s.created < cutoff) sessions.delete(sid); for (const [ip, until] of quarantinedIPs) if (until <= now) quarantinedIPs.delete(ip); }, 60000); maintenance.unref();
  return { server, sessions, quarantinedIPs, config: { maxNodes, branches, maxDepth, requestLimit, maxSessions, sessionTTL, logPath } };
}

if (process.argv[1] && process.argv[1].endsWith('/server.mjs')) {
  const { server } = createServer();
  server.listen(int(process.env.PORT, 4182), '127.0.0.1');
}
