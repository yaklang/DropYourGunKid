#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
import { injectHtml } from '../lib/index.js';
import { createGateway } from '../lib/gateway.js';
const [command,...args]=process.argv.slice(2);
function option(name,fallback) {const i=args.indexOf('--'+name);return i<0?fallback:args[i+1];}
if(command==='inject') {
  const [input,output]=args;
  if(!input || !output) throw new Error('dygk inject input.html output.html [--origin https://gateway.example]');
  await writeFile(output,injectHtml(await readFile(input,'utf8'),{origin:option('origin',''),prefix:option('prefix','/_dygk')}));
} else if(command==='serve') {
  const {server}=createGateway({directory:option('directory'),upstream:option('upstream'),mode:option('mode','observe'),database:option('database','dygk.sqlite'),adminToken:process.env.DYGK_ADMIN_TOKEN});
  server.listen(Number(option('port','4180')),option('host','127.0.0.1'),()=>console.log('DYGK gateway listening',server.address()));
  for(const signal of ['SIGINT','SIGTERM']) process.once(signal,()=>{server.close();server.closeAllConnections();});
} else {
  console.log('dygk inject input.html output.html [--origin URL]\ndygk serve --directory ./dist | --upstream http://127.0.0.1:3000 [--mode observe|block] [--port 4180]');
}
