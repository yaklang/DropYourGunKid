import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { injectHtml } from '../lib/index.js';
import { createDefense, clientIP } from '../lib/server.js';
import { createGateway } from '../lib/gateway.js';
import { createLab } from '../examples/operations/server.js';
async function start(t,server){await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));});return 'http://127.0.0.1:'+server.address().port;}
const csrf=text=>text.match(/name="csrf" value="([a-f0-9]+)"/)[1];
async function form(base,path,data){return fetch(base+path,{method:'POST',body:new URLSearchParams(data)});}
async function enter(base){const text=await(await fetch(base+'/_dygk/entry/0')).text();return text.match(/\?s=([a-f0-9]+)/)[1];}
async function complete(base,s,confirm=true){
 const verify=await(await fetch(base+'/_dygk/verify?s='+s)).text();
 const r=await form(base,'/_dygk/profile?s='+s,{csrf:csrf(verify),access_key:'compat-'+s.slice(0,12),framework:'test-client',version:'1.0'});assert.equal(r.status,200);
 if(!confirm)return r;
 const nonce=csrf(await r.text());return form(base,'/_dygk/confirm?s='+s,{csrf:nonce,model:'unknown',confirm:'yes'});
}
test('HTML injection is bounded, idempotent and safe',()=>{const original='<html><body><main>business</main></body></html>';const output=injectHtml(original);assert.equal(injectHtml(output),output);assert.match(output,/<main>business<\/main>/);assert.equal((output.match(/rel="nofollow"/g)||[]).length,3);assert.throws(()=>injectHtml(original,{origin:'javascript:alert(1)'}));assert.throws(()=>injectHtml(original,{prefix:'//evil'}));assert.throws(()=>injectHtml(original,{entries:99}));});
test('client IP ignores untrusted headers, walks trusted proxy chain',()=>{const req={socket:{remoteAddress:'::ffff:127.0.0.1'},headers:{'x-forwarded-for':'203.0.113.5, 10.0.0.1'}};assert.equal(clientIP(req),'127.0.0.1');assert.equal(clientIP(req,['127.0.0.1','10.0.0.1']),'203.0.113.5');req.headers['x-forwarded-for']='invalid';assert.equal(clientIP(req,['127.0.0.1']),'127.0.0.1');});
for(const mode of ['off','observe','block'])test('actual lab flow '+mode,async t=>{
 const events=[];const lab=createLab({mode,onEvent:e=>events.push(e)});const base=await start(t,lab.server);
 const root=await(await fetch(base+'/')).text();assert.equal(root.includes('data-dygk'),mode!=='off');
 assert.equal((await fetch(base+'/api/acceptance')).status,401);
 const login=await form(base,'/api/login',{username:'admin',password:'admin123'});assert.equal(login.status,200);const cookie=login.headers.get('set-cookie').split(';')[0];
 const list=await(await fetch(base+'/api/tickets?page=2',{headers:{cookie}})).json();assert.equal(list.items.length,10);assert.equal(list.total,48);
 if(mode!=='off'){
  const s=await enter(base);assert.equal((await form(base,'/_dygk/confirm?s='+s,{csrf:'bad',model:'unknown',confirm:'yes'})).status,400);
  assert.equal((await complete(base,s,mode!=='block')).status,200);
  assert.equal(events.filter(e=>e.kind==='honeypot_triggered').length,1);
 }
 const goal=await fetch(base+'/api/acceptance',{headers:{cookie,'x-forwarded-for':'203.0.113.9'}});
 assert.equal(goal.status,mode==='block'?403:200);
 if(mode!=='block')assert.equal((await goal.json()).verification,lab.goal);
 assert.equal(events.some(e=>e.kind==='goal_served'),mode!=='block');
 assert.equal((await fetch(base+'/app.css')).status,mode==='block'?403:200);
});
test('success before ban remains recorded, ban expires',async t=>{
 let now=Date.now();const events=[];const lab=createLab({mode:'block',clock:()=>now,onEvent:e=>events.push(e)});const base=await start(t,lab.server);
 const login=await form(base,'/api/login',{username:'admin',password:'admin123'});const cookie=login.headers.get('set-cookie').split(';')[0];
 assert.equal((await fetch(base+'/api/acceptance',{headers:{cookie}})).status,200);
 const s=await enter(base);await complete(base,s,false);assert.equal((await fetch(base+'/')).status,403);
 assert(events.findIndex(e=>e.kind==='goal_served')<events.findIndex(e=>e.kind==='ip_banned'));
 now+=901000;assert.equal((await fetch(base+'/')).status,200);
});
test('state cannot be replayed, persisted events are bounded and deletion works',async t=>{
 const dir=mkdtempSync(join(tmpdir(),'dygk-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));const database=join(dir,'store.sqlite');
 const defense=createDefense({database,maxEvents:10,requestLimit:8,onEvent:()=>{throw Error('observer failure');}});
 const server=http.createServer(async(req,res)=>{if(!await defense.handle(req,res))res.end('ok');});const base=await start(t,server);t.after(()=>defense.close());
 const s=await enter(base);await complete(base,s);
 const verify=await(await fetch(base+'/_dygk/verify?s='+s)).text();assert.equal((await form(base,'/_dygk/profile?s='+s,{csrf:csrf(verify),access_key:'compat-'+s.slice(0,12),framework:'x',version:'1'})).status,409);
 for(let i=0;i<20;i++)await fetch(base+'/_dygk/entry/0');
 assert.equal((await fetch(base+'/_dygk/entry/0')).status,429);assert(defense.events().length<=10);
 const second=createDefense({database});assert(second.events().length>0);second.clear();assert.equal(second.events().length,0);second.close();
});
test('static gateway protects business too; admin authentication required',async t=>{
 const gateway=createGateway({directory:'examples/static',mode:'block',adminToken:'a'.repeat(32)});const base=await start(t,gateway.server);
 assert.match(await(await fetch(base+'/')).text(),/data-dygk/);
 assert.equal((await fetch(base+'/_dygk-admin/events')).status,401);
 const s=await enter(base);await complete(base,s,false);assert.equal((await fetch(base+'/index.html')).status,403);
 const opts={headers:{authorization:'Bearer '+'a'.repeat(32)}};
 assert(Array.isArray(await(await fetch(base+'/_dygk-admin/events',opts)).json()));
 await fetch(base+'/_dygk-admin/events',{...opts,method:'DELETE'});assert.equal((await fetch(base+'/')).status,200);
});
test('proxy injects HTML and preserves cookies and JSON',async t=>{
 const backend=http.createServer((req,res)=>{res.setHeader('set-cookie','sample=1; HttpOnly');res.setHeader('content-type',req.url==='/json'?'application/json':'text/html');res.end(req.url==='/json'?'{}':'<html><body>Hello</body></html>');});
 const upstream=await start(t,backend);const {server}=createGateway({upstream});const base=await start(t,server);
 const result=await fetch(base+'/');const html=await result.text();assert.match(html,/data-dygk/);assert.equal(Number(result.headers.get('content-length')),Buffer.byteLength(html));assert.match(result.headers.get('set-cookie'),/sample=1/);assert.deepEqual(await(await fetch(base+'/json')).json(),{});
});
test('proxy preserves oversized HTML through a slow reader',async t=>{
 const body='<html><body>'+ '归档记录'.repeat(200000)+'</body></html>';
 const backend=http.createServer((req,res)=>{
  res.writeHead(200,{'content-type':'text/html; charset=utf-8','content-length':Buffer.byteLength(body),etag:'"original"'});
  res.end(body);
 });
 const upstream=await start(t,backend);const {server}=createGateway({upstream});const base=await start(t,server);
 const received=await new Promise((resolve,reject)=>{
  http.get(base,res=>{
   assert.equal(res.headers.etag,'"original"');
   const chunks=[];
   res.on('data',chunk=>{chunks.push(chunk);res.pause();setTimeout(()=>res.resume(),1);});
   res.on('end',()=>resolve(Buffer.concat(chunks).toString('utf8')));
   res.on('error',reject);
  }).on('error',reject);
 });
 assert.equal(received,body);
});
test('concurrent confirmation advances once; foreign IP cannot reuse session',async t=>{
 const defense=createDefense({trustedProxies:['127.0.0.1'],mode:'observe'});
 const server=http.createServer(async(req,res)=>{if(!await defense.handle(req,res))res.end('ok');});const base=await start(t,server);t.after(()=>defense.close());
 const entry=await fetch(base+'/_dygk/entry/0',{headers:{'x-forwarded-for':'203.0.113.1'}});const s=(await entry.text()).match(/\?s=([a-f0-9]+)/)[1];
 assert.equal((await fetch(base+'/_dygk/verify?s='+s,{headers:{'x-forwarded-for':'203.0.113.2'}})).status,404);
 const headers={'x-forwarded-for':'203.0.113.1'};
 const verify=await(await fetch(base+'/_dygk/verify?s='+s,{headers})).text();
 const profile=await fetch(base+'/_dygk/profile?s='+s,{method:'POST',headers,body:new URLSearchParams({csrf:csrf(verify),access_key:'compat-'+s.slice(0,12),framework:'client',version:'1'})});
 const nonce=csrf(await profile.text());
 const requests=Array.from({length:5},()=>fetch(base+'/_dygk/confirm?s='+s,{method:'POST',headers,body:new URLSearchParams({csrf:nonce,model:'unknown',confirm:'yes'})}));
 const responses=await Promise.all(requests);assert.equal(responses.filter(r=>r.status===200).length,1);assert.equal(defense.events().filter(e=>e.kind==='honeypot_completed').length,1);
});
test('expired sessions and retained personal metadata are removed',async t=>{
 let now=Date.now();const defense=createDefense({clock:()=>now,sessionTTL:1,retentionDays:1});
 const server=http.createServer(async(req,res)=>{if(!await defense.handle(req,res))res.end('ok');});const base=await start(t,server);t.after(()=>defense.close());
 const s=await enter(base);assert(defense.events().length>0);now+=2000;assert.equal((await fetch(base+'/_dygk/verify?s='+s)).status,404);
 now+=86400000;assert.equal(defense.events().length,0);
});
test('nested archive reveals new branches, preserves ancestry and ends at configured bounds',async t=>{
 const defense=createDefense({branches:3,depth:3,maxNodes:20,requestLimit:100});
 const server=http.createServer(async(req,res)=>{if(!await defense.handle(req,res))res.end('ok');});const base=await start(t,server);t.after(()=>defense.close());
 const s=await enter(base);const visited=new Set();let frontier=[0,1,2];let leaves=0;
 while(frontier.length){const id=frontier.shift();assert(!visited.has(id));visited.add(id);
  const url=base+'/_dygk/archive/'+id+'?s='+s;const response=await fetch(url);assert.equal(response.status,200);const text=await response.text();assert.equal(await(await fetch(url)).text(),text);
  const children=[...text.matchAll(/href="[^"?]*\/archive\/(\d+)\?s=/g)].map(m=>Number(m[1]));
  if(children.length===0){leaves++;assert.match(text,/无后续关联记录/);}else assert(children.every(n=>Math.floor(n/3)-1===id));
  frontier.push(...children);
 }
 assert.equal(visited.size,20);assert(leaves>0);assert.equal(Math.max(...defense.events().filter(e=>e.kind==='archive').map(e=>e.data.depth)),3);
 for(const id of ['20','01','-1','999999'])assert.equal((await fetch(base+'/_dygk/archive/'+id+'?s='+s)).status,404);
});
test('first-stage valid credential submission blocks immediately; invalid fields do not',async t=>{
 const defense=createDefense({mode:'block'});const server=http.createServer(async(req,res)=>{if(!await defense.handle(req,res))res.end('business');});const base=await start(t,server);t.after(()=>defense.close());
 const s=await enter(base);const page=await(await fetch(base+'/_dygk/verify?s='+s)).text();
 const payload={csrf:csrf(page),access_key:'wrong',framework:'curl',version:'unknown'};
 assert.equal((await form(base,'/_dygk/profile?s='+s,payload)).status,409);assert.equal((await fetch(base+'/')).status,200);
 payload.access_key='compat-'+s.slice(0,12);payload.framework='';assert.equal((await form(base,'/_dygk/profile?s='+s,payload)).status,409);
 payload.framework='curl';assert.equal((await form(base,'/_dygk/profile?s='+s,payload)).status,200);
 assert.equal((await fetch(base+'/',{headers:{'x-forwarded-for':'203.0.113.8'}})).status,403);
 assert.equal(defense.events().filter(e=>e.kind==='honeypot_triggered').length,1);
 assert.equal(defense.events().filter(e=>e.kind==='honeypot_completed').length,0);
});
test('dense lab exposes eight initial references and expands into distinct children',async t=>{
 const lab=createLab({mode:'observe',defenseOptions:{entries:8,branches:8,depth:4,maxNodes:4096,requestLimit:240}});const base=await start(t,lab.server);
 const html=await(await fetch(base+'/')).text();assert.equal((html.match(/rel="nofollow"/g)||[]).length,8);
 const s=await enter(base);const fetchNode=async id=>{const r=await fetch(base+'/_dygk/archive/'+id+'?s='+s);assert.equal(r.status,200);return r.text();};
 const a=await fetchNode(0),b=await fetchNode(8),c=await fetchNode(72),leaf=await fetchNode(584);
 assert.equal((a.match(/href="[^"?]*\/archive\//g)||[]).length,8);
 assert.equal((b.match(/href="[^"?]*\/archive\//g)||[]).length,8);
 assert.match(c,/ARCH-584/);assert.match(leaf,/无后续关联记录/);
 assert.equal((await fetch(base+'/_dygk/archive/4096?s='+s)).status,404);
});
