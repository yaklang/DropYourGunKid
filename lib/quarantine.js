import { createHash } from 'node:crypto';

const digest = (value) => createHash('sha256').update(value).digest('hex');
const safePath = (value) => typeof value === 'string' ? value.slice(0, 256) : '';

// Bounded fake surface for a quarantined source. Every write is synthetic and every path is bounded.
export function createQuarantine({ event, send, readBody, requestLimit = 240, ttl = 1800000,
  maxEntries = 1000, now = Date.now }) {
  const entries = new Map();
  const current = ip => {
    let q = entries.get(ip);
    if (!q || q.until <= now()) return null;
    return q;
  };
  const open = ip => {
    let q = current(ip);
    if (q) return q;
    q = { until: now() + ttl, requests: 0, revealed: new Set(), probes: 0, label: digest(ip).slice(0, 12) };
    if (entries.size >= maxEntries) entries.delete(entries.keys().next().value);
    entries.set(ip, q);
    return q;
  };
  const active = ip => Boolean(current(ip));
  const activate = ip => {
    const q = open(ip);
    q.until = now() + ttl;
    event('quarantine_started', ip, '', { synthetic: true });
  };
  const users = q => {
    const h = digest(q.label + ':users');
    return { users: [
      { id: 1, email: 'admin@example.com', role: 'admin', token: 'tok-' + h.slice(0, 20) },
      { id: 2, email: 'ops@example.com', role: 'viewer', token: 'tok-' + h.slice(20, 40) },
      { id: 3, email: 'audit@example.com', role: 'auditor', token: 'tok-' + h.slice(40, 60) },
    ], synthetic: true };
  };
  const rows = (q, query = '') => {
    const h = digest(q.label + ':db:' + query);
    return { table: 'operations', rows: Array.from({ length: 3 }, (_, i) => ({
      id: i + 1, account: ['ops', 'admin', 'audit'][i],
      secret_ref: 'SEC-' + h.slice(i * 6, i * 6 + 6).toUpperCase(),
      state: ['active', 'standby', 'archived'][i],
    })), synthetic: true };
  };
  const page = q => {
    const links = [
      ['/admin/users', '账户清单'], ['/admin/config', '运行配置'], ['/admin/tokens', '访问令牌'],
      ['/api/v1/users', '用户接口'], ['/api/v1/backup', '备份接口'], ['/debug', '调试信息'],
      ['/upload', '文件上传'], ['/db', '数据库控制台'], ['/admin/login', '管理员登录'],
      ...Array.from(q.revealed).map(path => [path, '关联入口']),
    ];
    return '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>Gateway Admin</title><body><h1>Gateway Admin</h1><p>隔离维护视图。所有记录为合成材料。</p><ul>' +
      links.map(([href, label]) => '<li><a href="' + href + '">' + label + '</a></li>').join('') + '</ul><p>来源标记 ' + q.label + '</p></body></html>';
  };
  const fake = (q, path, body, ip) => {
    if (path === '/admin/users' || path === '/api/v1/users') { q.revealed.add('/api/v1/tokens'); return users(q); }
    if (path === '/admin/tokens' || path === '/api/v1/tokens') return { tokens: [{ name: 'compat-reader', value: 'tok-' + digest(q.label + ':token').slice(0, 20) }], synthetic: true };
    if (path === '/api/v1/backup') return { backup: 'synthetic-export.tar.gz', status: 'available', synthetic: true };
    if (path === '/admin/flag') return { status: 'synthetic_export_available', record: 'record-' + digest(q.label + ':flag').slice(0, 24), synthetic: true };
    if (path === '/admin/config') return { env: 'synthetic', feature_flags: { maintenance: true, export: true }, synthetic: true };
    if (path === '/debug') return { runtime: 'synthetic', build: 'quarantine', synthetic: true };
    if (path === '/admin/login' && body) return { ok: true, token: 'tok-' + digest(q.label + ':login').slice(0, 24), role: 'admin', synthetic: true };
    if (path === '/upload' && body) { q.revealed.add('/api/v1/backup'); return { status: 'uploaded', name: 'synthetic.txt', synthetic: true }; }
    if (path === '/db' && body) { q.revealed.add('/admin/flag'); event('quarantine_db_query', ip, '', { length: String(body).length }); return rows(q, String(body)); }
    return null;
  };
  async function handle(req, res, { ip, path }) {
    const q = current(ip);
    if (!q) return false;
    q.requests++;
    event('quarantine_request', ip, '', { path: safePath(path), method: req.method });
    if (q.requests > requestLimit) {
      event('quarantine_budget', ip, '', {});
      send(req, res, 429, { error: 'Synthetic request budget reached', synthetic: true });
      return true;
    }
    if (req.method === 'GET' && (path === '/' || path === '/admin')) { send(req, res, 200, page(q), 'text/html; charset=utf-8'); return true; }
    if (req.method === 'GET' && path === '/upload') { send(req, res, 200, '<form method="post"><input name="file"><button>上传</button></form>', 'text/html; charset=utf-8'); return true; }
    if (req.method === 'GET' && path === '/db') { send(req, res, 200, '<form method="POST"><input name="sql" value="SELECT * FROM operations"><button>执行</button></form>', 'text/html; charset=utf-8'); return true; }
    if (req.method === 'GET' && path === '/admin/login') { send(req, res, 200, '<form method="POST"><input name="user"><input name="password"><button>登录</button></form>', 'text/html; charset=utf-8'); return true; }
    if (req.method === 'GET' && ['/admin/users', '/api/v1/users', '/admin/tokens', '/api/v1/tokens',
      '/api/v1/backup', '/admin/flag', '/admin/config', '/debug'].includes(path)) {
      send(req, res, 200, fake(q, path, undefined, ip), 'application/json; charset=utf-8'); return true;
    }
    if (req.method === 'POST' && ['/admin/login', '/upload', '/db'].includes(path)) {
      let body;
      try { body = await readBody(req); } catch (error) { send(req, res, error.status ?? 400, { error: 'Invalid body' }); return true; }
      const result = fake(q, path, body, ip);
      send(req, res, 200, result ?? { status: 'synthetic', synthetic: true });
      return true;
    }
    q.probes++;
    send(req, res, 404, { error: 'Not found', synthetic: true, hint: q.probes > 2 ? '/admin/users' : undefined });
    return true;
  }
  return { active, activate, handle, entries };
}
