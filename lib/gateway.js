import http from 'node:http';
import https from 'node:https';
import { pipeline } from 'node:stream';
import { readFile, realpath } from 'node:fs/promises';
import { resolve, sep, extname } from 'node:path';
import { createDefense, authorized, send } from './server.js';
/** 独立静态站点或反向代理网关；封禁先于业务资源处理。 */
export function createGateway(options = {}) {
  if (Boolean(options.directory) === Boolean(options.upstream)) throw new Error('Specify directory or upstream');
  const upstream = options.upstream ? new URL(options.upstream) : null;
  if (upstream && (!['http:','https:'].includes(upstream.protocol) || upstream.username || upstream.password)) throw new Error('Invalid upstream');
  const defense = createDefense(options);
  const server = http.createServer(async (req,res) => {
    try {
      const url = new URL(req.url,'http://local');
      if (url.pathname === '/_dygk-admin/events') {
        if (!authorized(req,options.adminToken)) return send(req,res,401,{error:'Unauthorized'});
        if (req.method==='GET') return send(req,res,200,defense.events());
        if (req.method==='DELETE') {defense.clear();return send(req,res,200,{status:'cleared'});}
        return send(req,res,405,{error:'Method not allowed'});
      }
      if (await defense.handle(req,res)) return;
      if (upstream) return proxy(req,res,upstream,defense);
      if (!['GET','HEAD'].includes(req.method)) return send(req,res,405,{error:'Method not allowed'});
      const root = await realpath(options.directory);
      const relative = decodeURIComponent(url.pathname).replace(/^\/+/, '') || 'index.html';
      const file = await realpath(resolve(root,relative));
      if (!file.startsWith(root+sep)) return send(req,res,404,{error:'Not found'});
      const content = await readFile(file);
      const mime = {'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json; charset=utf-8'}[extname(file)]??'application/octet-stream';
      if (extname(file)==='.html') return send(req,res,200,defense.inject(content.toString()),mime);
      res.writeHead(200,{'content-type':mime,'content-length':content.length});res.end(req.method==='HEAD'?undefined:content);
    } catch (e) {
      if (!res.headersSent) send(req,res,e.code==='ENOENT'?404:400,{error:'Request rejected'});
      else res.destroy();
    }
  });
  server.requestTimeout=15000;server.headersTimeout=10000;
  server.on('close',()=>defense.close());
  return { server, defense };
}
function proxy(req,res,origin,defense) {
  const url = new URL(origin);const incoming = new URL(req.url,'http://local');
  url.pathname=incoming.pathname;url.search=incoming.search;
  const headers={...req.headers,host:origin.host,'accept-encoding':'identity'};
  for (const key of ['connection','proxy-connection','transfer-encoding','upgrade','x-forwarded-for','forwarded']) delete headers[key];
  const forward=(origin.protocol==='https:'?https:http).request(url,{method:req.method,headers,timeout:15000}, response=>{
    const responseHeaders={...response.headers};
    for(const key of ['connection','transfer-encoding']) delete responseHeaders[key];
    const html=String(response.headers['content-type']).includes('text/html') && !response.headers['content-encoding'] && req.method!=='HEAD';
    if (!html) {res.writeHead(response.statusCode,responseHeaders);pipeline(response,res,()=>{});return;}
    pipeline(response,async function* (source) {
      const chunks=[];let bytes=0;let passthrough=false;
      for await (const chunk of source) {
        if (passthrough) {yield chunk;continue;}
        chunks.push(chunk);bytes+=chunk.length;
        if (bytes<=1048576) continue;
        passthrough=true;
        res.writeHead(response.statusCode,responseHeaders);
        yield Buffer.concat(chunks);
        chunks.length=0;
      }
      if(passthrough)return;
      const body=defense.inject(Buffer.concat(chunks).toString('utf8'));
      delete responseHeaders.etag;delete responseHeaders['content-md5'];
      responseHeaders['content-length']=Buffer.byteLength(body);
      res.writeHead(response.statusCode,responseHeaders);
      yield body;
    },res,()=>{});
  });
  forward.on('timeout',()=>forward.destroy());
  forward.on('error',()=>{if(!res.headersSent)send(req,res,502,{error:'Upstream unavailable'});else res.destroy();});
  res.on('close',()=>forward.destroy());
  req.on('aborted',()=>forward.destroy());req.pipe(forward);
}
