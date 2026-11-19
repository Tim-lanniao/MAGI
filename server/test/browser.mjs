import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, createPublicKey } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { buildApp } from '../dist/src/app.js';
import { readConfig } from '../dist/src/config.js';
import { openDb } from '../dist/src/db/index.js';
import { createInvite } from '../dist/src/auth/invite.js';

if (!process.env.MAGI_BROWSER) throw new Error('设置 MAGI_BROWSER 为本机 Chromium 浏览器的可执行文件路径。');
const dir = await mkdtemp(join(tmpdir(),'magi-browser-'));
const db = openDb(':memory:');
const config = readConfig({ RP_ID:'magi.test',OPENAI_API_KEY:'test',OPENAI_MODEL:'test',OPENAI_REASONING:'max',
  DEEPSEEK_API_KEY:'test',DEEPSEEK_MODEL:'test',DEEPSEEK_THINKING:'max',DEEPSEEK_BASE_URL:'https://deepseek.test' });
const example = {vote:'是',confidence:70,core_reason:'已核对预算',risks:[],conditions:[],flip_condition:''};
const model = {model:'test',params:{reasoning:{effort:'max'}},
  call:async () => ({model:'test',raw:JSON.stringify(example),usage:null,complete:true})};
const { app } = await buildApp(config,db,{gpt:model,deepseek:model},false,join(dir,'no-spa'));
let tls, browser;
try {
  const key = join(dir,'key.pem'), cert = join(dir,'cert.pem');
  execFileSync(process.env.MAGI_TEST_OPENSSL || 'openssl', ['req','-x509','-newkey','rsa:2048','-nodes',
    '-keyout',key,'-out',cert,'-days','1','-subj','/CN=magi.test','-addext','subjectAltName=DNS:magi.test'],{stdio:'pipe'});
  const certPem = await readFile(cert);
  const pubkey = createPublicKey(certPem).export({format:'der',type:'spki'});
  const spki = createHash('sha256').update(pubkey).digest('base64');
  await app.ready();
  tls = createServer({key:await readFile(key),cert:certPem},app.routing);
  await new Promise((ok,fail) => { tls.once('error',fail); tls.listen(0,'127.0.0.1',ok); });
  browser = await chromium.launch({executablePath:process.env.MAGI_BROWSER,headless:true,chromiumSandbox:true,
    args:['--no-proxy-server','--host-resolver-rules=MAP magi.test 127.0.0.1:'+tls.address().port,
      '--ignore-certificate-errors-spki-list='+spki]});
  const context = await browser.newContext();
  const page = await context.newPage();
  const devtools = await context.newCDPSession(page);
  await devtools.send('WebAuthn.enable');
  await devtools.send('WebAuthn.addVirtualAuthenticator',{options:{protocol:'ctap2',transport:'internal',
    hasResidentKey:true,hasUserVerification:true,isUserVerified:true,automaticPresenceSimulation:true}});
  await page.goto('https://magi.test/setup?token='+createInvite(db));
  await page.getByLabel('设备名称').fill('测试浏览器');
  await page.getByRole('button',{name:'使用此邀请注册 Passkey'}).click();
  await page.getByText('注册完成，可以登录。',{exact:true}).waitFor();
  assert.equal(new URL(page.url()).search,'');
  await page.getByRole('button',{name:'用 Passkey 登录'}).click();
  await page.getByText('已登录。',{exact:true}).waitFor();
  const session = (await context.cookies()).find(c => c.name==='magi_sid');
  assert.ok(session.httpOnly && session.secure && session.sameSite==='Strict');
  await page.getByLabel('是／否问题').fill('现在是否提交测试问题？');
  await page.getByLabel('背景',{exact:true}).fill('本次为本机验证');
  await page.getByLabel('目标与约束').fill('确认浏览器流程');
  await page.getByLabel('核心理由').fill('流程可复核');
  await page.getByRole('button',{name:'锁定并提交一次'}).click();
  await page.waitForFunction(() => document.querySelector('#status').textContent.includes('"status": "decided"'));
  const result = JSON.parse(await page.locator('#status').textContent());
  assert.deepEqual(result.result.tally.yes,3);
  console.log('通过：本地 HTTPS 注册、登录、会话 cookie、锁票、轮询和计票。浏览器版本 '+browser.version());
} finally {
  await browser?.close();
  if (tls?.listening) { tls.closeAllConnections(); await new Promise(resolve => tls.close(resolve)); }
  await app.close();
  db.close();
  await rm(dir,{recursive:true,force:true});
}
