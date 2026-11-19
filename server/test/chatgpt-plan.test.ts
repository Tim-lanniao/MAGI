import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { afterEach, describe, expect, it } from 'vitest';
import { readConfig } from '../src/config.js';
import { ChatGPTPlan } from '../src/magi/providers/chatgpt-plan.js';
import { startPlanLogin } from '../src/magi/providers/chatgpt-loopback.js';
import { PlanStore } from '../src/magi/providers/chatgpt-store.js';
import { createProviders } from '../src/magi/providers/responses.js';
import { ballot, config, setup, submission } from './helpers.js';

const oidc = 'https://auth.openai.com';
const resource = 'https://api.openai.com/v1';
const scope = 'openid email profile offline_access resource.invoke chatgpt.tokens.use.direct';
const dirs: string[] = [];
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }); });
async function fixture() {
  const folder = mkdtempSync(join(tmpdir(), 'magi-plan-'));
  dirs.push(folder);
  const store = new PlanStore(folder);
  const key = await generateKeyPair('RS256');
  const jwk = { ...await exportJWK(key.publicKey), alg: 'RS256', kid: 'test' };
  const state = { nonce: '', claimNonce: '', scopes: scope, refreshError: '', refreshes: 0, streamFailure: false,
    missingTerminal: false, exchanged: new URLSearchParams(), modelRequests: [] as { auth: string; body: Record<string, any> }[] };
  const fetcher: typeof fetch = async (input, init) => {
    const req = new Request(input, init);
    const url = new URL(req.url);
    if (url.origin === oidc) {
      switch (url.pathname) {
        case '/.well-known/openid-configuration': return Response.json({ issuer: oidc,
          authorization_endpoint: oidc + '/authorize', token_endpoint: oidc + '/token',
          jwks_uri: oidc + '/jwks', revocation_endpoint: oidc + '/revoke' });
        case '/jwks': return Response.json({ keys: [jwk] });
        case '/revoke': return new Response('', { status: 200 });
        case '/token': {
          state.exchanged = new URLSearchParams(await req.text());
          if (state.exchanged.get('grant_type') === 'refresh_token') {
            state.refreshes++;
            if (state.refreshError) return Response.json({ error: state.refreshError }, { status: 400 });
            await new Promise(r => setTimeout(r, 60));
            return Response.json({ access_token: 'renewed', refresh_token: 'rotated', token_type: 'Bearer', expires_in: 3600 });
          }
          const id = await new SignJWT({ nonce: state.claimNonce || state.nonce }).setProtectedHeader({ alg: 'RS256', kid: 'test' })
            .setSubject('owner').setAudience('oaiapp_test').setIssuer(oidc).setIssuedAt().setExpirationTime('1h').sign(key.privateKey);
          return Response.json({ id_token: id, access_token: 'direct', refresh_token: 'renew', scope: state.scopes,
            token_type: 'Bearer', expires_in: 3600 });
        }
      }
    }
    if (req.url === resource + '/models') return Response.json({ models: [
      { slug: 'model-a', visibility: 'list' },
      { slug: 'another', display_name: 'Another', visibility: 'list', supported_reasoning_levels: [{ effort: 'low' }, { effort: 'ultra' }] },
      { slug: 'hidden', visibility: 'hidden' },
    ] });
    const body = await req.json();
    state.modelRequests.push({ auth: req.headers.get('Authorization')!, body });
    const result = { model: 'actual-model', status: 'completed', usage: { total_tokens: 9 },
      output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(ballot()) }] }] };
    if (url.host === 'deepseek.test') return Response.json(result);
    const events: unknown[] = [{ type: 'response.output_text.delta', delta: 'partial' }];
    if (!state.missingTerminal) events.push(state.streamFailure
      ? { type: 'response.failed', response: { error: { code: 'subscription_sharing_usage_limit_exceeded' } } }
      : { type: 'response.completed', response: result });
    return new Response(events.map(e => 'data: ' + JSON.stringify(e) + '\n\n').join('') + 'data: [DONE]\n\n',
      { headers: { 'Content-Type': 'text/event-stream' } });
  };
  const plan = new ChatGPTPlan(store, fetcher);
  const begin = async () => {
    const flow = await plan.begin('http://127.0.0.1:39999/auth/callback');
    state.nonce = flow.authorize.searchParams.get('nonce')!;
    const reply = new URLSearchParams({ state: flow.state, code: 'a-code', client_id: 'oaiapp_test' });
    return { ...flow, reply };
  };
  return { state, store, folder, plan, fetcher, begin };
}
describe('ChatGPT plan connection', () => {
  it('authorizes on loopback and binds the code to the right host, PKCE, state, nonce and issued client', async () => {
    const f = await fixture();
    const listener = await startPlanLogin(f.plan);
    const root = listener.origin;
    const landing = await fetch(root);
    expect(landing.status).toBe(200);
    const startPath = (await landing.text()).match(/href="(\/authorize\?start=[A-Za-z0-9_-]+)"/)?.[1];
    expect(startPath).toBeDefined();
    for (const path of ['/authorize', '/authorize?start=wrong']) {
      const restart = await fetch(root + path, { redirect: 'manual' });
      expect(restart.status).toBe(303);
      expect(restart.headers.get('location')).toBe('/');
    }
    expect((await fetch(root + '/authorize', { method: 'POST', headers: { Origin: 'https://other.test' } })).status).toBe(403);
    const start = await fetch(root + startPath!, { redirect: 'manual' });
    expect(start.status).toBe(303);
    const previousForm = await fetch(root + '/authorize', { method: 'POST', headers: { Origin: root }, redirect: 'manual' });
    expect(previousForm.headers.get('location')).toBe(start.headers.get('location'));
    const auth = new URL(start.headers.get('location')!);
    expect(auth.searchParams.get('client_id')).toBe('dynamic_agent_client');
    expect(auth.searchParams.get('agent_name_hint')).toBe('MAGI');
    expect(auth.searchParams.get('ext_agent_host_id')).toMatch(/^urn:uuid:/);
    expect(auth.searchParams.get('redirect_uri')).toBe(root + '/auth/callback');
    expect((await fetch(root + '/auth/callback?state=other&code=x')).status).toBe(400);
    f.state.nonce = auth.searchParams.get('nonce')!;
    const callback = new URL(root + '/auth/callback');
    callback.search = new URLSearchParams({ state: auth.searchParams.get('state')!, code: 'test', client_id: 'oaiapp_test' }).toString();
    const [enabled, response] = await Promise.all([listener.completed, fetch(callback)]);
    expect(enabled && response.ok).toBe(true);
    expect(f.state.exchanged.get('client_id')).toBe('oaiapp_test');
    expect(f.state.exchanged.get('redirect_uri')).toBe(root + '/auth/callback');
    expect(createHash('sha256').update(f.state.exchanged.get('code_verifier')!).digest('base64url')).toBe(auth.searchParams.get('code_challenge'));
    expect(await f.plan.models()).toEqual(['model-a', 'another']);
    const next = await f.begin();
    expect(next.authorize.searchParams.get('client_id')).toBe('oaiapp_test');
    expect(next.authorize.searchParams.get('ext_agent_host_id')).toBe(auth.searchParams.get('ext_agent_host_id'));
    expect(next.authorize.searchParams.has('agent_name_hint')).toBe(false);
  });
  it('rejects mismatched nonce, missing plan permission, duplicate callbacks and changed accounts', async () => {
    const f = await fixture();
    const first = await f.begin();
    f.state.claimNonce = 'wrong';
    await expect(first.finish(first.reply)).rejects.toMatchObject({ code: 'CHATGPT_IDENTITY_INVALID' });
    expect((await f.store.snapshot()).account).toBeNull();
    f.state.claimNonce = '';
    f.state.scopes = 'openid email';
    const second = await f.begin();
    expect(await second.finish(second.reply)).toBe(false);
    await expect(f.plan.access()).rejects.toMatchObject({ code: 'CHATGPT_LOGIN_REQUIRED' });
    await expect(second.finish(second.reply)).rejects.toMatchObject({ code: 'CHATGPT_CALLBACK_USED' });
    const again = await f.begin();
    expect(again.authorize.searchParams.get('prompt')).toBe('consent');
    again.reply.set('client_id', 'another');
    await expect(again.finish(again.reply)).rejects.toMatchObject({ code: 'CHATGPT_CALLBACK_INVALID' });
  });
  it('serializes rotating refresh tokens across instances and clears a terminally invalid grant', async () => {
    const f = await fixture();
    const flow = await f.begin();
    await flow.finish(flow.reply);
    await f.store.change(async s => { s.account!.tokens!.expiresAt = 0; });
    const other = new ChatGPTPlan(new PlanStore(f.folder), f.fetcher);
    expect(await Promise.all([f.plan.access(), other.access()])).toEqual(['renewed', 'renewed']);
    expect(f.state.refreshes).toBe(1);
    expect((await f.store.snapshot()).account?.tokens?.refresh).toBe('rotated');
    await f.store.change(async s => { s.account!.tokens!.expiresAt = 0; });
    f.state.refreshError = 'invalid_grant';
    await expect(other.access()).rejects.toMatchObject({ code: 'CHATGPT_LOGIN_REQUIRED' });
    expect((await f.store.snapshot()).account?.tokens).toBeNull();
  });
  it('keeps key mode compatible and streams only GPT requests under the authorized plan', async () => {
    const f = await fixture();
    const flow = await f.begin();
    await flow.finish(flow.reply);
    const env = { ...config, OPENAI_AUTH_MODE: 'chatgpt_plan', OPENAI_API_KEY: '' };
    const vars = Object.fromEntries(Object.entries(env).map(([k,v]) => [k,String(v)]));
    const c = readConfig(vars);
    expect(() => readConfig({ ...vars, OPENAI_AUTH_MODE: 'api_key' })).toThrow(/OPENAI_API_KEY/);
    const providers = createProviders(c, f.fetcher, f.plan);
    expect(await providers.gpt.listModels!()).toEqual([
      { id: 'model-a', label: 'model-a', efforts: ['max'] }, { id: 'another', label: 'Another', efforts: ['low'] },
    ]);
    const result = await providers.gpt.call('my question', AbortSignal.timeout(3000), { model: 'another', effort: 'low' });
    expect(result).toMatchObject({ complete: true, raw: JSON.stringify(ballot()), model: 'actual-model', usage: { total_tokens: 9 } });
    await providers.deepseek.call('my question', AbortSignal.timeout(3000));
    expect(f.state.modelRequests[0]).toMatchObject({ auth: 'Bearer direct', body: { model: 'another', reasoning: { effort: 'low' }, stream: true, store: false,
      input: [{ role: 'user', content: 'my question' }], text: { format: { type: 'json_schema' } } } });
    expect(f.state.modelRequests[1]).toMatchObject({ auth: 'Bearer test-deepseek', body: { input: 'my question' } });
    f.state.missingTerminal = true;
    expect((await providers.gpt.call('q', AbortSignal.timeout(3000))).complete).toBe(false);
    f.state.missingTerminal = false;
    f.state.streamFailure = true;
    const h = await setup(providers);
    try {
      await h.post('/questions', submission);
      await h.runner.idle();
      const row = h.db.prepare("SELECT provider_code,error FROM model_attempts WHERE voter='gpt'").all();
      expect(row).toEqual([{ provider_code: 'subscription_sharing_usage_limit_exceeded', error: 'PROVIDER_REJECTED' }]);
    } finally { await h.close(); }
  });
});
