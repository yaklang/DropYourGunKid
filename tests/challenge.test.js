import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createDefense } from '../lib/server.js';

const sha = value => createHash('sha256').update(value).digest('hex');
async function setup(t,options={}) {
  let defense;
  const server = http.createServer(async(req,res)=>{if (!await defense.handle(req,res)) res.end('business');});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const base = 'http://127.0.0.1:'+server.address().port;
  t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));defense?.close();});
  defense = createDefense({origin:base,...options});
  const html = await (await fetch(base+'/_dygk/entry/0')).text();
  const session = html.match(/\?s=([a-f0-9]+)/)[1];
  const endpoint = name=>base+'/_dygk/client/'+name+'?s='+session;
  return {base,defense,session,endpoint};
}
async function complete(endpoint,session,challenge) {
  return fetch(endpoint('complete'),{method:'POST',body:new URLSearchParams({challenge,response:sha(`${session}:${challenge}:dygk-client-v1`)})});
}

test('trace binds page watermarks and fingerprints to the same session',async t=>{
  const {base,session,defense}=await setup(t,{trace:true});
  const first=await(await fetch(base+'/_dygk/archive/0?s='+session)).text();
  const second=await(await fetch(base+'/_dygk/archive/0?s='+session)).text();
  assert.equal(first,second);
  const watermark=first.match(/DYGK-PAGE-[a-f0-9]{24}/)[0];
  const events=defense.events();
  assert(events.filter(e=>e.kind==='http_fingerprint').every(e=>e.session===session && e.data.headerOrder.length===16));
  assert(events.some(e=>e.kind==='page_render' && e.session===session && e.data.watermark===watermark));
  assert(!JSON.stringify(events).includes('authorization'));
});

test('offline analysis pairs actual serialized events with tool watermarks',async t=>{
  const {base,session,defense}=await setup(t,{trace:true});
  const html=await(await fetch(base+'/_dygk/archive/0?s='+session)).text();
  const watermark=html.match(/DYGK-PAGE-[a-f0-9]{24}/)[0];
  const dir=mkdtempSync(join(tmpdir(),'dygk-trace-'));
  t.after(()=>rmSync(dir,{recursive:true,force:true}));
  writeFileSync(join(dir,'events.jsonl'),defense.events().reverse().map(e=>JSON.stringify(e)).join('\n'));
  writeFileSync(join(dir,'tools.jsonl'),JSON.stringify({stage:'report',content:watermark}));
  execFileSync('python3',['experiments/trace_analysis.py','--events',join(dir,'events.jsonl'),'--tools',join(dir,'tools.jsonl'),'--output',join(dir,'summary.json')],{timeout:10000});
  const summary=JSON.parse(readFileSync(join(dir,'summary.json')));
  assert.equal(summary.pairs.length,1);
  assert.equal(summary.pairs[0].events[0].session,session);
  assert.equal(summary.sessions[session].marker_execution_evidence,false);
});

test('shell direct allows capabilities without claiming challenge completion',async t=>{
  const {base,session,endpoint,defense}=await setup(t,{clientChallenge:'shell-direct'});
  assert.equal((await fetch(endpoint('capabilities'))).status,200);
  const page=await(await fetch(base+'/_dygk/verify?s='+session)).text();
  assert.equal(Buffer.byteLength(page),8192);
  const body=await(await fetch(endpoint('download'))).text();
  assert(page.includes(sha(body)));
  assert.match(body,new RegExp('/tmp/dygk-client-'+session));
  assert.match(body,/DYGK-DL-[a-f0-9]{48}/);
  execFileSync('sh',['-n'],{input:body,timeout:5000});
  assert(!defense.events().some(e=>e.kind==='challenge_completed'));
});

test('challenge rejects skipping and cross source; only completion bans',async t=>{
  const {base,session,endpoint,defense}=await setup(t,{clientChallenge:'shell-challenge',mode:'block',banTrigger:'client-complete',trustedProxies:['127.0.0.1']});
  assert.equal((await fetch(endpoint('challenge'))).status,403);
  assert.equal((await fetch(endpoint('capabilities'))).status,403);
  const body=await(await fetch(endpoint('download'))).text();
  assert.match(body,/challenge=\$\(curl/);
  assert.equal((await fetch(base+'/')).status,200);
  assert.equal((await fetch(endpoint('challenge'),{headers:{'x-forwarded-for':'203.0.113.99'}})).status,404);
  const challenge=await(await fetch(endpoint('challenge'))).text();
  const wrong=await fetch(endpoint('complete'),{method:'POST',body:new URLSearchParams({challenge,response:'0'.repeat(64)})});
  assert.equal(wrong.status,403);
  assert.equal((await fetch(base+'/')).status,200);
  assert.equal((await complete(endpoint,session,challenge)).status,200);
  assert.equal((await fetch(base+'/')).status,403);
  const events=defense.events().reverse();
  assert.equal(events.filter(e=>e.kind==='challenge_completed').length,1);
  assert(events.findIndex(e=>e.kind==='challenge_completed')<events.findIndex(e=>e.kind==='ip_banned'));
});

test('observe records exactly one concurrent completion and rejects replays',async t=>{
  const {session,endpoint,defense}=await setup(t,{clientChallenge:'shell-challenge'});
  await fetch(endpoint('download'));
  const challenge=await(await fetch(endpoint('challenge'))).text();
  const results=await Promise.all(Array.from({length:4},()=>complete(endpoint,session,challenge)));
  assert.equal(results.filter(r=>r.status===200).length,1);
  assert.equal(results.filter(r=>r.status===409).length,3);
  assert.equal(defense.events().filter(e=>e.kind==='challenge_replayed').length,3);
  assert.equal((await fetch(endpoint('capabilities'))).status,200);
});

test('session expiry and clear remove client state; budgets also cover client endpoints',async t=>{
  let clock=Date.now();
  const {base,session,endpoint,defense}=await setup(t,{clientChallenge:'shell-challenge',clock:()=>clock,sessionTTL:1,requestLimit:4});
  for(let i=0;i<3;i++) assert.equal((await fetch(endpoint('download'))).status,200);
  assert.equal((await fetch(endpoint('challenge'))).status,429);
  clock+=1001;
  assert.equal((await fetch(endpoint('download'))).status,404);
  defense.clear();
  assert.equal(defense.events().length,0);
  const next=await(await fetch(base+'/_dygk/entry/0')).text();
  assert(!next.includes('?s='+session));
});

function makeArtifacts(t) {
  const directory=mkdtempSync(join(tmpdir(),'dygk-client-test-'));
  t.after(()=>rmSync(directory,{recursive:true,force:true}));
  const {privateKey,publicKey}=generateKeyPairSync('ed25519');
  const binary=Buffer.from([0x7f,0x45,0x4c,0x46,0xff,0x00]);
  const files={'gateway-client':binary,'gateway-client.sig':sign(null,binary,privateKey),
    'gateway-client.pub':publicKey.export({type:'spki',format:'pem'}),'gateway-client.go':'// 合成测试源码'};
  for(const [name,body] of Object.entries(files)) writeFileSync(join(directory,name),body);
  writeFileSync(join(directory,'manifest.json'),JSON.stringify({protocol:'dygk-client-v1',sha256:Object.fromEntries(Object.entries(files).map(([name,body])=>[name,sha(body)]))}));
  return {directory,binary};
}

test('signed binary bytes survive HTTP and frozen content survives disk changes',async t=>{
  const {directory,binary}=makeArtifacts(t);
  const {endpoint}=await setup(t,{clientChallenge:'binary-challenge',clientArtifactDir:directory});
  assert.deepEqual(Buffer.from(await(await fetch(endpoint('download'))).arrayBuffer()),binary);
  writeFileSync(join(directory,'gateway-client'),'tampered');
  assert.deepEqual(Buffer.from(await(await fetch(endpoint('download'))).arrayBuffer()),binary);
  assert.throws(()=>createDefense({origin:'http://127.0.0.1',clientChallenge:'binary-challenge',clientArtifactDir:directory}),/hash mismatch/);
  writeFileSync(join(directory,'gateway-client'),binary);
  const signature=Buffer.alloc(64);
  writeFileSync(join(directory,'gateway-client.sig'),signature);
  const manifest=JSON.parse(readFileSync(join(directory,'manifest.json')));
  manifest.sha256['gateway-client.sig']=sha(signature);
  writeFileSync(join(directory,'manifest.json'),JSON.stringify(manifest));
  assert.throws(()=>createDefense({origin:'http://127.0.0.1',clientChallenge:'binary-challenge',clientArtifactDir:directory}),/signature mismatch/);
});

test('shell workflow quotes configured origins safely',async t=>{
  const {endpoint}=await setup(t,{origin:"http://example'host",clientChallenge:'shell-challenge'});
  const body=await(await fetch(endpoint('download'))).text();
  execFileSync('sh',['-n'],{input:body,timeout:5000});
});

test('optional features validate configuration and remain disabled by default',async t=>{
  assert.throws(()=>createDefense({clientChallenge:'shell-challenge'}),/explicit origin/);
  assert.throws(()=>createDefense({banTrigger:'client-complete'}),/requires clientChallenge/);
  const {endpoint,defense}=await setup(t);
  assert.equal((await fetch(endpoint('download'))).status,404);
  assert(!defense.events().some(e=>['http_fingerprint','page_render','client_downloaded'].includes(e.kind)));
});
