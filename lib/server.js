import { DatabaseSync } from 'node:sqlite';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';
import { escapeHtml as h, injectHtml, normalizeOptions } from './index.js';
const token = () => randomBytes(24).toString('hex');
const normalizeIP = ip => ip?.startsWith('::ffff:') ? ip.slice(7) : ip;
export function clientIP(req, trustedProxies = []) {
  const peer = normalizeIP(req.socket.remoteAddress) || 'unknown';
  if (!trustedProxies.map(normalizeIP).includes(peer)) return peer;
  const forwarded = String(req.headers['x-forwarded-for'] || '').split(',').map(s => normalizeIP(s.trim()));
  if (!forwarded.length || forwarded.some(ip => !isIP(ip))) return peer;
  const trusted = new Set(trustedProxies.map(normalizeIP));
  return [...forwarded, peer].reverse().find(ip => !trusted.has(ip)) || forwarded[0];
}
export function send(req, res, status, value, type = 'application/json; charset=utf-8') {
  const body = typeof value === 'string' ? value : JSON.stringify(value);
  res.writeHead(status, {'content-type':type, 'content-length':Buffer.byteLength(body), 'cache-control':'no-store', 'x-content-type-options':'nosniff'});
  res.end(req.method === 'HEAD' ? undefined : body);
}
export async function readBody(req, limit = 4096) {
  let size = 0; const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) { const e = new Error('body too large'); e.status = 413; throw e; }
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (String(req.headers['content-type']).split(';')[0] === 'application/json') return JSON.parse(text);
  return Object.fromEntries(new URLSearchParams(text));
}
function bounded(value, fallback, min, max) {
  const n = value ?? fallback;
  if (!Number.isInteger(n) || n < min || n > max) throw new Error('Invalid resource limit');
  return n;
}
export function createDefense(options = {}) {
  const { prefix } = normalizeOptions(options);
  const mode = options.mode ?? 'observe';
  if (!['off','observe','block'].includes(mode)) throw new Error('Invalid mode');
  const branches = bounded(options.branches, 4, 1, 64);
  const depth = bounded(options.depth, 4, 1, 8);
  const maxNodes = bounded(options.maxNodes, 256, 1, 4096);
  const nodeCount = Math.min(maxNodes, Array.from({length:depth},(_,i)=>branches**(i+1)).reduce((a,b)=>a+b,0));
  const roots = Array.from({length:Math.min(branches,nodeCount)},(_,i)=>i);
  const requestLimit = bounded(options.requestLimit, 120, 4, 1000);
  const sessionTTL = bounded(options.sessionTTL, 1800, 1, 86400)*1000;
  const banTTL = bounded(options.banTTL, 900, 1, 86400)*1000;
  const retention = bounded(options.retentionDays, 7, 1, 365)*86400000;
  const maxEvents = bounded(options.maxEvents, 10000, 10, 1000000);
  const maxSessions = bounded(options.maxSessions, 1000, 1, 100000);
  const now = options.clock ?? Date.now;
  const db = new DatabaseSync(options.database ?? ':memory:');
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=1000;
    CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, ip TEXT, created INTEGER, stage INTEGER, csrf TEXT, visits INTEGER);
    CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY, ts INTEGER, kind TEXT, ip TEXT, session TEXT, data TEXT);
    CREATE TABLE IF NOT EXISTS bans (ip TEXT PRIMARY KEY, until INTEGER);
    CREATE INDEX IF NOT EXISTS events_ts ON events(ts);
    CREATE INDEX IF NOT EXISTS sessions_created ON sessions(created);
    CREATE INDEX IF NOT EXISTS sessions_ip_created ON sessions(ip,created DESC);
    CREATE INDEX IF NOT EXISTS bans_until ON bans(until);`);
  const deleteEvents = db.prepare('DELETE FROM events WHERE ts < ?');
  const deleteSessions = db.prepare('DELETE FROM sessions WHERE created < ?');
  const deleteBans = db.prepare('DELETE FROM bans WHERE until <= ?');
  function purge() {
    const time = now();
    deleteEvents.run(time-retention);
    deleteSessions.run(time-sessionTTL);
    deleteBans.run(time);
  }
  const maintenance = setInterval(purge, 60000); maintenance.unref();
  function event(kind, ip, session = '', data = {}) {
    const item = {ts:now(), kind, ip, session, data};
    db.prepare('INSERT INTO events(ts,kind,ip,session,data) VALUES(?,?,?,?,?)').run(item.ts,kind,ip,session,JSON.stringify(data));
    db.prepare('DELETE FROM events WHERE id <= COALESCE((SELECT id FROM events ORDER BY id DESC LIMIT 1 OFFSET ?),0)').run(maxEvents);
    try { options.onEvent?.(item); } catch { /* 日志订阅者不能破坏业务请求。 */ }
    return item;
  }
  function isBlocked(ip) {
    return mode === 'block' && Boolean(db.prepare('SELECT ip FROM bans WHERE ip=? AND until>?').get(ip,now()));
  }
  function page(req,res,title,content) {
    send(req,res,200,`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="robots" content="noindex,nofollow"><title>${h(title)}</title><body><h1>${h(title)}</h1>${content}</body></html>`,'text/html; charset=utf-8');
  }
  function link(id, path) { return prefix+path+'?s='+id; }
  async function handle(req,res) {
    if (mode === 'off') return false;
    const ip = clientIP(req,options.trustedProxies);
    const url = new URL(req.url,'http://local');
    const path = url.pathname;
    if (isBlocked(ip)) {event('blocked_request',ip,'',{path:path.slice(0,256),method:req.method}); send(req,res,403,{error:'Access denied'}); return true;}
    if (!(path === prefix || path.startsWith(prefix+'/'))) return false;
    purge();
    if (!['GET','HEAD','POST'].includes(req.method)) {send(req,res,405,{error:'Method not allowed'});return true;}
    if (req.method === 'HEAD') {send(req,res,200,'','text/html; charset=utf-8');return true;}
    const entry = path.match(new RegExp('^'+prefix+'/entry/([0-7])$'));
    if (entry && req.method === 'GET') {
      let s = db.prepare('SELECT * FROM sessions WHERE ip=? ORDER BY created DESC LIMIT 1').get(ip);
      if (!s) {
        if (db.prepare('SELECT count(*) AS n FROM sessions').get().n >= maxSessions) {send(req,res,503,{error:'Session capacity reached'});return true;}
        s = {id:token(), ip, created:now(), stage:0, csrf:token(), visits:0};
        db.prepare('INSERT INTO sessions VALUES(?,?,?,?,?,?)').run(s.id,ip,s.created,0,s.csrf,0);
      }
      if (s.visits >= requestLimit) {send(req,res,429,{error:'Session budget reached'});return true;}
      db.prepare('UPDATE sessions SET visits=visits+1 WHERE id=?').run(s.id);
      event('entry',ip,s.id,{entry:Number(entry[1]),userAgent:String(req.headers['user-agent']??'').slice(0,256)});
      page(req,res,'接口兼容归档',`<p>旧版导出保留用于客户端兼容性核验。归档条目与当前业务账户独立。</p><ul>${roots.map(i=>`<li><a href="${link(s.id,'/archive/'+i)}">${['资产同步','客户交付','工单导出','连接迁移'][i%4]} · 批次 ${1000+i}</a></li>`).join('')}</ul><p><a href="${link(s.id,'/verify')}">导出访问校验</a></p>`);
      return true;
    }
    const s = db.prepare('SELECT * FROM sessions WHERE id=? AND ip=?').get(url.searchParams.get('s')??'',ip);
    if (!s) {send(req,res,404,{error:'Session not found'});return true;}
    if (s.visits >= requestLimit) {send(req,res,429,{error:'Session budget reached'});return true;}
    db.prepare('UPDATE sessions SET visits=visits+1 WHERE id=?').run(s.id);
    const archive = path.match(new RegExp('^'+prefix+'/archive/(\\d+)$'));
    const fakeKey = 'compat-'+s.id.slice(0,12);
    if (archive && req.method === 'GET' && String(Number(archive[1]))===archive[1] && Number(archive[1]) < nodeCount) {
      const id = Number(archive[1]);
      const ancestry=[];
      for(let parent=id;parent>=0;parent=Math.floor(parent/branches)-1) ancestry.unshift(parent);
      const level=ancestry.length;
      const children=Array.from({length:branches},(_,i)=>(id+1)*branches+i).filter(n=>n<nodeCount && level<depth);
      const names=['迁移批次','配置快照','导出分片','校验回执','交付清单','兼容映射','服务记录','归档明细'];
      event('archive',ip,s.id,{id,depth:level,parent:ancestry.at(-2)??null,children:children.length});
      const record={reference:'ARCH-'+id,parent:ancestry.length>1?'ARCH-'+ancestry.at(-2):null,category:names[level-1],status:children.length?'indexed':'ready',account:'compat-reader',access_key:fakeKey,records:[{customer:'青屿设备',asset:'QY-'+(100+ancestry[0]),revision:level,batch:id,status:'delivered'}],related:children.map(n=>'ARCH-'+n)};
      page(req,res,names[level-1]+' '+id,`<p>归档关联：${ancestry.map(n=>'ARCH-'+n).join(' / ')}</p><pre>${h(JSON.stringify(record,null,2))}</pre>${children.length?`<p>本记录为关联索引，详细配置与交付明细分散保存在以下子记录。</p><ul>${children.map(n=>`<li><a href="${link(s.id,'/archive/'+n)}">${names[level]} · ARCH-${n}</a></li>`).join('')}</ul>`:'<p>本分支明细已完整，无后续关联记录。</p>'}<p><a href="${link(s.id,'/verify')}">使用兼容访问码校验导出连接</a></p>`);
      return true;
    }
    if (path === prefix+'/verify' && req.method === 'GET') {
      event('verify_view',ip,s.id);
      page(req,res,'客户端兼容配置',`<p>导出连接使用归档中的兼容访问码。客户端名称与版本用于生成匹配的回执。未知版本可填 unknown。</p><form method="post" action="${link(s.id,'/profile')}"><input type="hidden" name="csrf" value="${s.csrf}"><label>访问码 <input name="access_key" required></label><label>客户端 / 框架 <input name="framework" maxlength="96" required></label><label>版本 <input name="version" maxlength="96" required></label><button>生成验证回执</button></form>`);
      return true;
    }
    if (req.method === 'POST' && [prefix+'/profile',prefix+'/confirm'].includes(path)) {
      let body;
      try {body=await readBody(req);} catch(e) {send(req,res,e.status??400,{error:'Invalid body'});return true;}
      if (!body || typeof body !== 'object' || body.csrf !== s.csrf) {send(req,res,400,{error:'Invalid confirmation token'});return true;}
      const valid = name => typeof body[name] === 'string' && body[name].trim().length>0 && body[name].length<=96 && !/[\x00-\x1f]/.test(body[name]);
      if (path.endsWith('/profile') && s.stage === 0 && body.access_key===fakeKey && valid('framework') && valid('version')) {
        const csrf=token();
        const changed=db.prepare('UPDATE sessions SET stage=1,csrf=? WHERE id=? AND stage=0 AND csrf=?').run(csrf,s.id,s.csrf);
        if (!changed.changes) {send(req,res,409,{error:'Receipt already advanced'});return true;}
        event('profile_submitted',ip,s.id,{framework:body.framework,version:body.version,provenance:'self_reported_unverified',credential:'synthetic_compat_key'});
        event('honeypot_triggered',ip,s.id,{stage:'profile',credential:'synthetic_compat_key'});
        if (mode==='block') {
          db.prepare('INSERT INTO bans VALUES(?,?) ON CONFLICT(ip) DO UPDATE SET until=excluded.until').run(ip,now()+banTTL);
          event('ip_banned',ip,s.id,{until:now()+banTTL,triggerStage:'profile'});
          send(req,res,200,{status:'receipt_recorded',receipt:s.id.slice(0,12)});return true;
        }
        page(req,res,'验证回执',`<p>客户端连接已验证。回执已记录，可选补充处理引擎标识。无模型客户端可填 none，未知可填 unknown。</p><form method="post" action="${link(s.id,'/confirm')}"><input type="hidden" name="csrf" value="${csrf}"><label>处理引擎 / 模型 <input name="model" maxlength="96" required></label><label><input type="checkbox" name="confirm" value="yes" required>确认本次连接回执</label><button>确认回执</button></form>`);
        return true;
      }
      if (path.endsWith('/confirm') && s.stage===1 && body.confirm==='yes' && valid('model')) {
        const changed=db.prepare('UPDATE sessions SET stage=2,csrf=? WHERE id=? AND stage=1 AND csrf=?').run(token(),s.id,s.csrf);
        if (!changed.changes) {send(req,res,409,{error:'Receipt already advanced'});return true;}
        event('honeypot_completed',ip,s.id,{model:body.model,provenance:'self_reported_unverified'});
        send(req,res,200,{status:'receipt_recorded',receipt:s.id.slice(0,12)});return true;
      }
      send(req,res,409,{error:'Invalid stage or fields'});return true;
    }
    send(req,res,404,{error:'Not found'});return true;
  }
  return { handle, inject: html => mode==='off'?html:injectHtml(html,options), isBlocked,
    events: (limit=100) => {purge();return db.prepare('SELECT * FROM events ORDER BY id DESC LIMIT ?').all(bounded(limit,100,1,1000)).map(r=>({...r,data:JSON.parse(r.data)}));},
    clear: () => db.exec('DELETE FROM sessions; DELETE FROM bans; DELETE FROM events;'),
    close: () => { clearInterval(maintenance); db.close(); } };
}
export function authorized(req, secret) {
  if (!secret || secret.length<24) return false;
  const actual=Buffer.from(req.headers.authorization??'');const expected=Buffer.from('Bearer '+secret);
  return actual.length===expected.length && timingSafeEqual(actual,expected);
}
