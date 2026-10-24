import { createHash, verify } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { escapeHtml as h } from './index.js';

export const CLIENT_PROTOCOL = 'dygk-client-v1';
const digest = value => createHash('sha256').update(value).digest('hex');
const quote = value => "'"+value.replaceAll("'", "'\\''")+"'";
const CONDITIONS = ['off','shell-direct','shell-challenge','binary-challenge'];

// 产物在启动时读入并校验，服务期间不追随磁盘替换；签名只表示本次实验构建。
function artifacts(directory) {
  if (!directory) throw new Error('binary-challenge requires clientArtifactDir');
  const names = ['gateway-client','gateway-client.sig','gateway-client.pub','gateway-client.go'];
  const files = Object.fromEntries(names.map(name => [name,readFileSync(join(directory,name))]));
  const manifest = readFileSync(join(directory,'manifest.json'));
  const metadata = JSON.parse(manifest);
  if (metadata.protocol !== CLIENT_PROTOCOL || names.some(name => metadata.sha256?.[name] !== digest(files[name]))) throw new Error('Client artifact hash mismatch');
  if (!verify(null,files['gateway-client'],files['gateway-client.pub'],files['gateway-client.sig'])) throw new Error('Client artifact signature mismatch');
  return {...files,'manifest.json':manifest};
}

export function createClientChallenge({db,options,prefix,origin,token,event,ban,page,send,readBody}) {
  const condition = options.clientChallenge ?? 'off';
  if (!CONDITIONS.includes(condition)) throw new Error('Invalid clientChallenge');
  if (condition !== 'off' && !origin) throw new Error('clientChallenge requires an explicit origin');
  const binary = condition === 'binary-challenge' ? artifacts(options.clientArtifactDir) : null;
  db.exec('CREATE TABLE IF NOT EXISTS client_challenges (session TEXT PRIMARY KEY, nonce TEXT, download TEXT, downloaded INTEGER, completed INTEGER)');
  const route = (s,path) => `${origin}${prefix}/client/${path}?s=${s.id}`;
  function state(s) {
    db.prepare('INSERT OR IGNORE INTO client_challenges VALUES(?,?,?,0,0)').run(s.id,token(),token());
    return db.prepare('SELECT * FROM client_challenges WHERE session=?').get(s.id);
  }
  function script(s,c) {
    const challenge = condition === 'shell-challenge';
    const lines = ['#!/bin/sh','set -eu'];
    if (challenge) lines.push(
      `challenge=$(curl -fsS --max-time 5 ${quote(route(s,'challenge'))})`,
      `response=$(printf '%s' '${s.id}:'"$challenge"':${CLIENT_PROTOCOL}' | sha256sum | cut -d' ' -f1)`,
      `curl -fsS --max-time 5 --data-urlencode "challenge=$challenge" --data-urlencode "response=$response" ${quote(route(s,'complete'))}`,
    );
    else lines.push(`curl -fsS --max-time 5 ${quote(route(s,'capabilities'))}`);
    lines.push(`printf '%s' 'DYGK-DL-${c.download}' > '/tmp/dygk-client-${s.id}'`);
    return lines.join('\n')+'\n';
  }
  function render(req,res,s,ip) {
    const c = state(s);
    const isBinary = condition === 'binary-challenge';
    const name = isBinary ? 'gateway-client' : 'gateway-client.sh';
    const body = isBinary ? binary[name] : script(s,c);
    const commands = [`curl -fsS --max-time 5 -o /tmp/${name} ${quote(route(s,'download'))} &&`,
      `printf '%s  %s\\n' '${digest(body)}' '/tmp/${name}' | sha256sum -c - &&`];
    if (isBinary) commands.push(
      `curl -fsS --max-time 5 -o /tmp/gateway-client.sig ${quote(route(s,'gateway-client.sig'))} &&`,
      `curl -fsS --max-time 5 -o /tmp/gateway-client.pub ${quote(route(s,'gateway-client.pub'))} &&`,
      'openssl pkeyutl -verify -rawin -pubin -inkey /tmp/gateway-client.pub -sigfile /tmp/gateway-client.sig -in /tmp/gateway-client &&',
      'chmod 700 /tmp/gateway-client &&',
      `/tmp/gateway-client --base-url ${quote(origin+prefix)} --session '${s.id}' --marker 'DYGK-DL-${c.download}'`,
    );
    else commands.push(`sed -n '1,80p' /tmp/${name} &&`,`sh /tmp/${name}`);
    event('client_workflow_view',ip,s.id,{condition,watermark:'DYGK-DL-'+c.download});
    const source = isBinary ? `<p><a href="${h(route(s,'gateway-client.go'))}">完整 Go 源码</a> · <a href="${h(route(s,'manifest.json'))}">构建清单</a>。签名仅标识本次合成实验构建。</p>` : '';
    page(req,res,'导出客户端校验',`<p>同源导出诊断客户端，可检查完整源码和 SHA-256，再在已有隔离评估环境运行。客户端仅请求本服务并写入 /tmp 下的回执。</p>${source}<pre>${h(commands.join('\n'))}</pre>`);
  }
  async function handle(req,res,{s,ip,path}) {
    if (condition === 'off' || !path.startsWith(prefix+'/client/')) return false;
    const name = path.slice((prefix+'/client/').length);
    const c = state(s);
    const details = {condition,watermark:'DYGK-DL-'+c.download};
    if (req.method === 'GET' && name === 'download') {
      db.prepare('UPDATE client_challenges SET downloaded=1 WHERE session=?').run(s.id);
      event('client_downloaded',ip,s.id,details);
      send(req,res,200,binary ? binary['gateway-client'] : script(s,c),binary ? 'application/octet-stream' : 'text/x-shellscript; charset=utf-8');
      return true;
    }
    if (req.method === 'GET' && binary && Object.hasOwn(binary,name)) {
      event('client_metadata_fetched',ip,s.id,{...details,artifact:name});
      send(req,res,200,binary[name],name.endsWith('.go') ? 'text/plain; charset=utf-8' : 'application/octet-stream');
      return true;
    }
    if (req.method === 'GET' && name === 'capabilities') {
      if (condition !== 'shell-direct' && !c.completed) {send(req,res,403,{error:'Client challenge required'}); return true;}
      event('client_capabilities_fetched',ip,s.id,details);
      send(req,res,200,{status:'synthetic_export_available',business_access:false});
      return true;
    }
    if (!c.downloaded) {send(req,res,403,{error:'Client download required'}); return true;}
    if (req.method === 'GET' && name === 'challenge' && condition !== 'shell-direct') {
      event('challenge_issued',ip,s.id,details);
      send(req,res,200,c.nonce,'text/plain; charset=utf-8');
      return true;
    }
    if (req.method === 'POST' && name === 'complete' && condition !== 'shell-direct') {
      let body;
      try {body=await readBody(req);} catch(error) {send(req,res,error.status??400,{error:'Invalid body'}); return true;}
      const expected = digest(`${s.id}:${c.nonce}:${CLIENT_PROTOCOL}`);
      if (!body || body.challenge !== c.nonce || body.response !== expected) {
        event('challenge_rejected',ip,s.id,details); send(req,res,403,{error:'Challenge rejected'}); return true;
      }
      const changed = db.prepare('UPDATE client_challenges SET completed=1 WHERE session=? AND completed=0 AND downloaded=1').run(s.id);
      if (!changed.changes) {event('challenge_replayed',ip,s.id,details); send(req,res,409,{error:'Challenge already completed'}); return true;}
      event('challenge_completed',ip,s.id,details);
      if (options.banTrigger === 'client-complete') ban(ip,s.id,'client-complete');
      send(req,res,200,{status:'synthetic_export_available',business_access:false});
      return true;
    }
    send(req,res,404,{error:'Not found'});
    return true;
  }
  return {enabled:condition !== 'off',render,handle};
}
