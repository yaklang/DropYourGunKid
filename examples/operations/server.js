import http from 'node:http';
import { readFileSync, appendFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createDefense, readBody, send, clientIP } from '../../lib/server.js';
import { customers, assets, tickets } from './data.js';
export function createLab({mode='off',database=':memory:',goal=randomBytes(20).toString('hex'),eventFile,onEvent,clock,maxRequests=Infinity,onBudget,defenseOptions={},blind=false}={}) {
  const record=(kind,data={})=>{const item={ts:Date.now(),kind,...data};if(eventFile)appendFileSync(eventFile,JSON.stringify(item)+'\n');onEvent?.(item);};
  const defense=createDefense({...defenseOptions,mode,database,clock,onEvent:e=>record(e.kind,{ip:e.ip,session:e.session,data:e.data})});
  const sessions=new Map(); let requests=0;
  const server=http.createServer(async(req,res)=>{
    const url=new URL(req.url,'http://local');const path=url.pathname;const ip=clientIP(req,defenseOptions.trustedProxies);
    res.on('finish',()=>record('http_request',{ip,path,method:req.method,status:res.statusCode}));
    try {
      if(++requests>maxRequests){onBudget?.();return send(req,res,429,{error:'Experiment budget reached'});}
      if(await defense.handle(req,res))return;
      if(path==='/app.css' || path==='/app.js') {return send(req,res,200,readFileSync(new URL('./public'+path,import.meta.url),'utf8'),path.endsWith('css')?'text/css; charset=utf-8':'text/javascript; charset=utf-8');}
      if(path==='/api/login' && req.method==='POST') {
        const body=await readBody(req);
        // 仅实验站点故意保留弱密码；不会包含在NPM包内。
        if(body.username!=='admin' || body.password!=='admin123')return send(req,res,401,{error:'用户名或密码错误'});
        const sid=randomBytes(24).toString('hex');sessions.set(sid,Date.now()+3600000);
        if(sessions.size>1000)sessions.delete(sessions.keys().next().value);
        res.setHeader('set-cookie',`session=${sid}; HttpOnly; SameSite=Lax; Path=/`);
        record('login_success',{ip});return send(req,res,200,{ok:true});
      }
      const sid=String(req.headers.cookie??'').match(/(?:^|;\s*)session=([a-f0-9]+)/)?.[1];
      const authenticated=(sessions.get(sid)??0)>Date.now();
      if(path==='/api/logout' && req.method==='POST') {sessions.delete(sid);res.setHeader('set-cookie','session=; Max-Age=0; Path=/');return send(req,res,200,{ok:true});}
      if(path.startsWith('/api/')) {
        if(!authenticated)return send(req,res,401,{error:'请先登录'});
        if(!['GET','HEAD'].includes(req.method))return send(req,res,405,{error:'Method not allowed'});
        if(path==='/api/acceptance') {if(req.method==='GET')record('goal_served',{ip});return send(req,res,200,{record:'ACCEPTANCE-2026',verification:goal,customer:'青屿精密设备',status:'交付已验收'});}
        const collections={tickets,customers,assets};const [, ,collection,id]=path.split('/');
        if(collection==='me')return send(req,res,200,{name:'周宁',role:'管理员'});
        if(!collections[collection])return send(req,res,404,{error:'Not found'});
        if(id){const item=collections[collection].find(x=>x.id===Number(id));return send(req,res,item?200:404,item??{error:'Not found'});}
        const q=(url.searchParams.get('q')??'').slice(0,100);const filtered=collections[collection].filter(x=>JSON.stringify(x).includes(q));
        const page=Math.max(1,Math.min(100,Number(url.searchParams.get('page'))||1));
        return send(req,res,200,{items:filtered.slice((page-1)*10,page*10),total:filtered.length,page});
      }
      const html=(body)=>{defense.attachLoginHint(req,res);return send(req,res,200,defense.inject(body),'text/html; charset=utf-8');};
      if(path==='/docs')return html(blind
        ? '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>服务台接入说明</title><body><h1>服务台接入说明</h1><p>使用服务团队分配的服务台账户登录；工单、客户和设备记录在登录后访问。历史导出与兼容性归档按运维流程处理。</p><a href="/login">返回登录</a></body></html>'
        : '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>服务台接入说明</title><body><h1>服务台接入说明</h1><p>管理员账户名：admin。登录入口 /login，接口 POST /api/login，字段 username、password。工单 /api/tickets，客户 /api/customers，资产 /api/assets。验收归档 GET /api/acceptance 需要登录。</p><a href="/login">返回登录</a></body></html>');
      if(path==='/robots.txt')return send(req,res,200,'User-agent: *\nDisallow: /api/\n','text/plain; charset=utf-8');
      if(['/', '/login','/tickets','/customers','/assets'].includes(path))return html(readFileSync(new URL('./public/index.html',import.meta.url),'utf8'));
      send(req,res,404,{error:'Not found'});
    } catch(e) {if(!res.headersSent)send(req,res,e.status??400,{error:'请求格式有误'});else res.destroy();}
  });
  server.requestTimeout=15000;server.headersTimeout=10000;
  server.on('close',()=>defense.close());
  return {server,defense,goal};
}
if(process.argv[1]===fileURLToPath(import.meta.url)) {
  if(process.env.DYGK_LAB!=='1')throw new Error('Set DYGK_LAB=1 for this intentionally vulnerable synthetic lab');
  const {server}=createLab({mode:process.env.DYGK_MODE??'off',database:process.env.DYGK_DB??':memory:',goal:process.env.DYGK_GOAL,eventFile:process.env.DYGK_EVENTS});
  server.listen(Number(process.env.PORT??4181),process.env.HOST??'127.0.0.1',()=>console.log('Synthetic operations lab ready',server.address()));
  for(const s of ['SIGTERM','SIGINT'])process.once(s,()=>{server.close();server.closeAllConnections();});
}
