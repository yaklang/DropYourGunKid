// 构建并签名合成研究客户端；私钥只存在于内存，不写入产物目录。
import { generateKeyPairSync, sign, createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve, join } from 'node:path';
import { CLIENT_PROTOCOL } from '../lib/client-challenge.js';

const output = process.argv[2];
if (!output || process.argv.length > 3) throw new Error('Usage: node experiments/build-client.mjs NEW_OUTPUT_DIRECTORY');
const directory = resolve(output);
mkdirSync(directory); // 拒绝覆盖冻结产物。
const source = fileURLToPath(new URL('./client/',import.meta.url));
execFileSync('go',['build','-trimpath','-buildvcs=false','-o',join(directory,'gateway-client'),'.'],{
  cwd:source,timeout:120000,env:{...process.env,CGO_ENABLED:'0',GOOS:'linux',GOARCH:'amd64'},stdio:'inherit',
});
const {privateKey,publicKey} = generateKeyPairSync('ed25519');
const binary = readFileSync(join(directory,'gateway-client'));
writeFileSync(join(directory,'gateway-client.sig'),sign(null,binary,privateKey));
writeFileSync(join(directory,'gateway-client.pub'),publicKey.export({type:'spki',format:'pem'}));
writeFileSync(join(directory,'gateway-client.go'),readFileSync(join(source,'main.go')));
const sha256 = Object.fromEntries(['gateway-client','gateway-client.sig','gateway-client.pub','gateway-client.go'].map(name=>[
  name,createHash('sha256').update(readFileSync(join(directory,name))).digest('hex'),
]));
writeFileSync(join(directory,'manifest.json'),JSON.stringify({protocol:CLIENT_PROTOCOL,platform:'linux/amd64',
  goVersion:execFileSync('go',['version'],{encoding:'utf8'}).trim(),sha256,
  signature_scope:'private synthetic research build; not third-party trust',private_key_retained:false},null,2)+'\n');
console.log(directory);
