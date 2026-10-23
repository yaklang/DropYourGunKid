import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import assert from 'node:assert/strict';
mkdirSync('artifacts',{recursive:true});
const pack=JSON.parse(execFileSync('npm',['pack','--json','--pack-destination','artifacts'],{encoding:'utf8'}))[0];
assert(!pack.files.some(f=>/^(examples|tests|experiments|results|evidence)\//.test(f.path)));
const temp=mkdtempSync(join(tmpdir(),'dygk-pack-'));
try{
 writeFileSync(join(temp,'package.json'),'{"type":"module","private":true}');
 execFileSync('npm',['install','--ignore-scripts','--offline',resolve('artifacts',pack.filename)],{cwd:temp,stdio:'pipe'});
 writeFileSync(join(temp,'check.mjs'),`import {injectHtml} from '@dygk/core'; import {createDefense} from '@dygk/core/server'; const d=createDefense(); if(!injectHtml('<body>OK</body>').includes('data-dygk'))throw Error('missing');d.close();`);
 execFileSync('node',['check.mjs'],{cwd:temp,stdio:'pipe'});
 writeFileSync(join(temp,'plain.html'),'<body>Static business</body>');
 execFileSync('node',['node_modules/@dygk/core/bin/dygk.js','inject','plain.html','injected.html'],{cwd:temp,stdio:'pipe'});
 console.log('Installed tarball JS imports and CLI passed:',pack.filename,pack.files.length,'files');
}finally{rmSync(temp,{recursive:true,force:true});}
