import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync } from 'node:fs';
import http from 'node:http';
import { createLab } from '../examples/operations/server.js';
const {server}=createLab({mode:'observe'});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const browser=await chromium.launch({headless:true});
const base='http://127.0.0.1:'+server.address().port;
mkdirSync('artifacts/screenshots',{recursive:true});
try{
 for(const width of [1366,390]){
  const page=await browser.newPage({viewport:{width,height:900}});const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(base);await page.locator('#login-form').waitFor();
  assert.equal(await page.locator('[data-dygk]').count(),1);
  assert.equal(await page.locator('[data-dygk]').isVisible(),false);
  await page.screenshot({path:`artifacts/screenshots/login-${width}.png`,fullPage:true});
  await page.getByPlaceholder('请输入账户').fill('admin');await page.getByPlaceholder('请输入密码').fill('wrong');await page.locator('#login-form button').click();await page.getByRole('alert').filter({hasText:'错误'}).waitFor();
  await page.getByPlaceholder('请输入密码').fill('admin123');await page.locator('#login-form button').click();await page.locator('#rows tr').first().waitFor();
  assert.equal(await page.locator('#rows tr').count(),10);await page.locator('#next').click();await page.locator('#page').filter({hasText:'2 / 5'}).waitFor();
  await page.locator('#query').fill('校准');await page.locator('#search button').click();await page.locator('#count').filter({hasText:'8 条'}).waitFor();
  await page.locator('#rows button').first().click();await page.locator('dialog[open]').waitFor();await page.locator('dialog button').click();
  await page.locator('#query').fill('不存在记录');await page.locator('#search button').click();await page.locator('#notice').filter({hasText:'没有符合'}).waitFor();
  await page.locator('[data-view="customers"]').click();await page.locator('#rows tr').first().waitFor();assert.equal(await page.locator('#rows tr').count(),6);
  await page.locator('[data-view="assets"]').click();await page.locator('#rows tr').first().waitFor();
  await page.screenshot({path:`artifacts/screenshots/desk-${width}.png`,fullPage:true});
  assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  assert.deepEqual(errors,[]);await page.locator('#logout').click();await page.locator('#login-form').waitFor();await page.close();
 }
 const supplement=http.createServer((req,res)=>{
  if(['/lib/browser.js','/lib/index.js'].includes(req.url)){res.setHeader('content-type','text/javascript');res.end(readFileSync('.'+req.url));return;}
  res.setHeader('content-type','text/html');res.end('<body><h1>Business</h1><script type="module">import {install} from "/lib/browser.js";install();install();</script></body>');
 });
 await new Promise(r=>supplement.listen(0,'127.0.0.1',r));
 try {const page=await browser.newPage();await page.goto('http://127.0.0.1:'+supplement.address().port);await page.waitForFunction(()=>!!document.querySelector('[data-dygk]'));assert.equal(await page.locator('[data-dygk]').count(),1);assert.equal(await page.locator('[data-dygk]').isVisible(),false);await page.close();}
 finally{supplement.closeAllConnections();await new Promise(r=>supplement.close(r));}
 console.log('Browser acceptance passed: desktop + mobile login, failure, paging, search, empty, details, navigation, logout');
}finally{await browser.close();server.closeAllConnections();await new Promise(r=>server.close(r));}
