import { createHash,generateKeyPairSync,randomBytes,sign } from 'node:crypto';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isoCBOR } from '@simplewebauthn/server/helpers';
import { afterEach,beforeEach,expect,it,vi } from 'vitest';
import { createInvite } from '../src/auth/invite.js';
import { digest } from '../src/auth/session.js';
import { at,openDb } from '../src/db/index.js';
import { origin,setup } from './helpers.js';

let h: Awaited<ReturnType<typeof setup>>;
beforeEach(async () => { h = await setup(); });
afterEach(async () => { await h.close(); });
const hash = (value: Buffer | string) => createHash('sha256').update(value).digest();
const b64 = (value: Uint8Array | string) => Buffer.from(value).toString('base64url');
const rpIdHash = hash('magi.test');
const u32 = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; };
const cookieOf = (r: { cookies: {name:string;value:string}[] },name:string) =>
  name + '=' + r.cookies.find(c => c.name === name)!.value;
const call = (suffix:string,payload:object,cookie='') =>
  h.app.inject({method:'POST',url:'/api/auth/'+suffix,headers:{origin,cookie},payload});

function authenticator() {
  const {publicKey,privateKey} = generateKeyPairSync('ec',{namedCurve:'P-256'});
  const id = randomBytes(32);
  const jwk = publicKey.export({format:'jwk'});
  const cose = new Map<number, number | Uint8Array>([[1,2],[3,-7],[-1,1],[-2,Buffer.from(jwk.x!,'base64url')],[-3,Buffer.from(jwk.y!,'base64url')]]);
  const envelope = {id:b64(id),rawId:b64(id),type:'public-key',clientExtensionResults:{}};
  return {id:b64(id),
    register(challenge:string) {
      const authData = Buffer.concat([rpIdHash,Buffer.from([0x45]),u32(0),Buffer.alloc(16),Buffer.from([0,id.length]),id,isoCBOR.encode(cose)]);
      const attestation = isoCBOR.encode(new Map<string, any>([['fmt','none'],['authData',authData],['attStmt',new Map()]]));
      return {...envelope,response:{clientDataJSON:b64(JSON.stringify({type:'webauthn.create',origin,challenge})),attestationObject:b64(attestation),transports:['internal']}};
    },
    login(challenge:string,userHandle:string,counter:number,flags=5) {
      const client = Buffer.from(JSON.stringify({type:'webauthn.get',origin,challenge}));
      const data = Buffer.concat([rpIdHash,Buffer.from([flags]),u32(counter)]);
      return {...envelope,response:{clientDataJSON:b64(client),authenticatorData:b64(data),userHandle,
        signature:b64(sign('sha256',Buffer.concat([data,hash(client)]),privateKey))}};
    },
  };
}
async function register(deviceName:string) {
  const key = authenticator();
  const inviteToken = createInvite(h.db);
  const opt = await call('register/options',{inviteToken,deviceName});
  expect(opt.statusCode).toBe(200);
  const opts = opt.json();
  expect(opts.authenticatorSelection).toMatchObject({residentKey:'required',userVerification:'required'});
  expect(opts.pubKeyCredParams.map((a:any)=>a.alg)).toEqual([-7,-257]);
  const body = {inviteToken,response:key.register(opts.challenge)};
  const cookie = cookieOf(opt,'magi_register');
  const verify = await call('register/verify',body,cookie);
  expect(verify.json()).toEqual({ok:true});
  return {key,handle:opts.user.id,inviteToken,body,cookie};
}
async function login(key: ReturnType<typeof authenticator>,handle: string,counter=0,flags=5) {
  const options = await call('login/options',{});
  const challenge = options.json().challenge;
  expect(options.json().allowCredentials ?? []).toEqual([]);
  const cookie = cookieOf(options,'magi_login');
  const payload = {response:key.login(challenge,handle,counter,flags)};
  return {response:await call('login/verify',payload,cookie),cookie,payload};
}
it('一次性邀请、挑战绑定、真实公钥验证、同步零计数器与递增计数器', async () => {
  const a = await register('手机');
  expect((await call('register/verify',a.body,a.cookie)).json().error.code).toBe('INVALID_INVITE');
  expect((await call('register/options',{inviteToken:a.inviteToken,deviceName:'第二次'})).statusCode).toBe(403);
  const inviteRecord = h.db.prepare('SELECT token_hash FROM invites').pluck().get();
  expect(inviteRecord).toBe(digest(a.inviteToken));
  const first = await login(a.key,a.handle);
  expect(first.response.statusCode).toBe(200);
  const cookie = cookieOf(first.response,'magi_sid');
  expect(first.response.headers['set-cookie']!.toString()).toMatch(/HttpOnly.*Secure.*SameSite=Strict/);
  expect((await h.app.inject({url:'/api/auth/me',headers:{cookie}})).json()).toEqual({authenticated:true,credentialsCount:1});
  expect((await call('login/verify',first.payload,first.cookie)).json().error.code).toBe('INVALID_CHALLENGE');
  expect((await login(a.key,a.handle)).response.statusCode).toBe(200);
  expect((await login(a.key,a.handle,2)).response.statusCode).toBe(200);
  expect((await login(a.key,a.handle,2)).response.json().error.code).toBe('COUNTER_REJECTED');
  expect((await login(a.key,a.handle,0)).response.statusCode).toBe(403);
  expect((await login(a.key,a.handle,3,1)).response.statusCode).toBe(403);
  expect((await login(a.key,b64(randomBytes(32)),3)).response.statusCode).toBe(403);
});
it('拒绝缺失、过期或不匹配的邀请与过期挑战', async () => {
  for (const route of ['register/options','register/verify']) expect((await call(route,{})).statusCode).toBe(403);
  const expired = createInvite(h.db);
  h.db.prepare('UPDATE invites SET expires_at=?').run('2000-01-01T00:00:00.000Z');
  expect((await call('register/options',{inviteToken:expired,deviceName:'Mac'})).statusCode).toBe(403);
  const inviteToken = createInvite(h.db);
  const options = await call('register/options',{inviteToken,deviceName:'Mac'});
  const opts = options.json();
  expect(h.db.prepare('SELECT challenge FROM challenges').pluck().get()).toBe(digest(opts.challenge));
  const other = createInvite(h.db);
  const response = authenticator().register(opts.challenge);
  expect((await call('register/verify',{inviteToken:other,response},cookieOf(options,'magi_register'))).json().error.code).toBe('INVALID_INVITE');
  const next = await call('register/options',{inviteToken,deviceName:'Mac'});
  h.db.prepare('UPDATE challenges SET expires_at=?').run('2000-01-01T00:00:00.000Z');
  expect((await call('register/verify',{inviteToken,response},cookieOf(next,'magi_register'))).json().error.code).toBe('INVALID_CHALLENGE');
  expect(h.db.prepare('SELECT count(*) FROM credentials').pluck().get()).toBe(0);
});
it('按邀请限定注册来源，保留一次性验证和换网后的登录', async () => {
  expect(() => createInvite(h.db, 'invalid')).toThrow(/--ip/);
  const ip = '192.0.2.10';
  const inviteToken = createInvite(h.db, '::ffff:c000:020a');
  const device = authenticator();
  const registerFrom = (route: string, address: string, payload: object, cookie = '') =>
    h.app.inject({ method: 'POST', url: '/api/auth/register/' + route, remoteAddress: '127.0.0.1',
      headers: { origin, cookie, 'x-forwarded-for': address }, payload });
  const options = { inviteToken, deviceName: '手机' };
  expect((await registerFrom('options', '192.0.2.20', options)).statusCode).toBe(403);
  const issued = await registerFrom('options', ip, options);
  expect(issued.statusCode).toBe(200);
  const attestation = { inviteToken, response: device.register(issued.json().challenge) };
  const cookie = cookieOf(issued, 'magi_register');
  expect((await registerFrom('verify', '192.0.2.20', attestation, cookie)).statusCode).toBe(403);
  expect((await registerFrom('verify', '::ffff:192.0.2.10', attestation, cookie)).statusCode).toBe(200);
  expect((await registerFrom('options', ip, options)).statusCode).toBe(403);
  expect((await login(device, issued.json().user.id)).response.statusCode).toBe(200);
  const v6 = { ...options, inviteToken: createInvite(h.db, '2001:0db8:0:0::1') };
  expect((await registerFrom('options', '2001:db8::1', v6)).statusCode).toBe(200);
});
it('最后一个凭证受保护，删除备用凭证注销全部会话', async () => {
  const a = await register('Mac');
  const b = await register('备用设备');
  const auth = await login(a.key,a.handle);
  const headers = {origin,cookie:cookieOf(auth.response,'magi_sid')};
  const opt = await call('register/options',{inviteToken:createInvite(h.db),deviceName:'新设备'});
  expect(opt.json().excludeCredentials.map((v:any)=>v.id).sort()).toEqual([a.key.id,b.key.id].sort());
  const path = '/api/auth/credentials/'+a.key.id;
  const rename = await h.app.inject({method:'PATCH',url:path,headers,payload:{deviceName:'工作 Mac'}});
  expect(rename.statusCode).toBe(200);
  const list = await h.app.inject({url:'/api/auth/credentials',headers});
  expect(list.json().find((c:any)=>c.id===a.key.id).deviceName).toBe('工作 Mac');
  expect((await h.app.inject({method:'DELETE',url:'/api/auth/credentials/'+b.key.id,headers})).statusCode).toBe(200);
  expect((await h.app.inject({url:'/api/auth/me',headers})).statusCode).toBe(401);
  const next = await login(a.key,a.handle);
  expect((await h.app.inject({method:'DELETE',url:path,headers:{origin,cookie:cookieOf(next.response,'magi_sid')}})).json().error.code).toBe('LAST_CREDENTIAL');
});
it('会话闲置、绝对到期和主动注销均生效', async () => {
  const {key,handle} = await register('Mac');
  for (const field of ['last_seen_at','expires_at']) {
    const auth = await login(key,handle);
    const c = auth.response.cookies.find(c=>c.name==='magi_sid')!;
    h.db.prepare('UPDATE sessions SET '+field+'=? WHERE id_hash=?').run('2000-01-01T00:00:00.000Z',digest(c.value));
    expect((await h.app.inject({url:'/api/auth/me',headers:{cookie:'magi_sid='+c.value}})).statusCode).toBe(401);
  }
  const auth = await login(key,handle);
  const c = cookieOf(auth.response,'magi_sid');
  expect((await call('logout',{},c)).json()).toEqual({ok:true});
  expect((await h.app.inject({url:'/api/auth/me',headers:{cookie:c}})).statusCode).toBe(401);
});
it('同一来源认证速率受限', async () => {
  for (let i=0; i<10; i++) expect((await call('login/options',{})).statusCode).toBe(200);
  const limited = await call('login/options',{});
  expect(limited.statusCode).toBe(429);
  expect(limited.json().error.code).toBe('RATE_LIMITED');
});

it('登录 cookie 与会话均在 24 小时到期，访问不会续期', async () => {
  const { key,handle } = await register('Mac');
  const start = Date.now();
  vi.useFakeTimers({ toFake: ['Date'] });
  try {
    vi.setSystemTime(start);
    const { response } = await login(key,handle);
    const cookie = response.cookies.find(c => c.name === 'magi_sid')!;
    expect(cookie.maxAge).toBe(86_400);
    const end = start + 24 * 3_600_000;
    expect(h.db.prepare('SELECT expires_at FROM sessions WHERE id_hash=?').pluck().get(digest(cookie.value))).toBe(at(end));
    const me = () => h.app.inject({ url:'/api/auth/me', headers:{cookie:'magi_sid='+cookie.value} });
    vi.setSystemTime(end - 1);
    expect((await me()).statusCode).toBe(200);
    vi.setSystemTime(end);
    expect((await me()).statusCode).toBe(401);
  } finally { vi.useRealTimers(); }
});

it('注册链接从签发计时，在第 5 分钟即拒绝已开始的注册', async () => {
  const start = Date.now();
  vi.useFakeTimers({ toFake: ['Date'] });
  try {
    vi.setSystemTime(start);
    const inviteToken = createInvite(h.db);
    const end = start + 5 * 60_000;
    expect(h.db.prepare('SELECT expires_at FROM invites WHERE token_hash=?').pluck().get(digest(inviteToken))).toBe(at(end));
    vi.setSystemTime(end - 1);
    const options = await call('register/options',{ inviteToken,deviceName:'Mac' });
    expect(options.statusCode).toBe(200);
    const response = authenticator().register(options.json().challenge);
    vi.setSystemTime(end);
    const verified = await call('register/verify',{ inviteToken,response },cookieOf(options,'magi_register'));
    expect(verified.json().error.code).toBe('INVALID_INVITE');
    expect((await call('register/options',{ inviteToken,deviceName:'Mac' })).json().error.code).toBe('INVALID_INVITE');
  } finally { vi.useRealTimers(); }
});

it('已有会话和未用链接按原签发时间缩短，再次打开数据库时不重复扣减', () => {
  const dir = mkdtempSync(join(tmpdir(),'magi-auth-expiry-'));
  const path = join(dir,'legacy.db');
  const t = Date.now(), hour = 3_600_000, minute = 60_000;
  try {
    const legacy = openDb(path);
    try {
      // This is a data-only migration. Seed the same schema immediately before it runs.
      legacy.prepare('DELETE FROM migrations WHERE name=?').run('005_auth_expiry.sql');
      const add = legacy.prepare('INSERT INTO sessions VALUES (?,?,?,?)');
      add.run('long',at(t-2*hour),at(t),at(t+166*hour));
      add.run('short',at(t),at(t),at(t+hour));
      const invite = legacy.prepare('INSERT INTO invites(token_hash,expires_at,used_at) VALUES (?,?,?)');
      invite.run('fresh',at(t+9*minute),null);
      invite.run('old',at(t+3*minute),null);
      invite.run('used',at(t+9*minute),at(t));
    } finally { legacy.close(); }
    for (let i=0; i<2; i++) {
      const db = openDb(path);
      try {
        const session = db.prepare('SELECT expires_at FROM sessions WHERE id_hash=?').pluck();
        expect(session.get('long')).toBe(at(t+22*hour));
        expect(session.get('short')).toBe(at(t+hour));
        const invite = db.prepare('SELECT expires_at FROM invites WHERE token_hash=?').pluck();
        expect(invite.get('fresh')).toBe(at(t+4*minute));
        expect(invite.get('old')).toBe(at(t-2*minute));
        expect(invite.get('used')).toBe(at(t+9*minute));
      } finally { db.close(); }
    }
  } finally { rmSync(dir,{recursive:true,force:true}); }
});
