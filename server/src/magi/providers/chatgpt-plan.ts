import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createRemoteJWKSet, customFetch, jwtVerify } from 'jose';
import { z } from 'zod';
import { PlanStore, type PlanTokens } from './chatgpt-store.js';
import { modelOption, type ModelSelection } from './model-options.js';

const issuer = 'https://auth.openai.com';
export const openaiResource = 'https://api.openai.com/v1';
const directScope = 'chatgpt.tokens.use.direct';
const requiredScopes = ['resource.invoke', directScope];
const requested = ['openid', 'profile', 'email', 'offline_access', ...requiredScopes].join(' ');
const endpoint = z.url().refine(url => new URL(url).origin === issuer);
const metadata = z.object({ issuer: z.literal(issuer), authorization_endpoint: endpoint,
  token_endpoint: endpoint, jwks_uri: endpoint, revocation_endpoint: endpoint });
const tokenReply = z.object({
  access_token: z.string().min(1), refresh_token: z.string().min(1).optional(),
  id_token: z.string().min(1).optional(), token_type: z.string().regex(/^bearer$/i),
  expires_in: z.number().int().positive(), scope: z.string().optional(),
});
const catalog = z.object({ models: z.array(z.object({
  slug: z.string(), visibility: z.string().optional(), display_name: z.string().optional(),
  supported_reasoning_levels: z.array(z.union([z.string(), z.object({ effort: z.string() })])).optional(),
})) });
const oauthError = z.object({ error: z.string().regex(/^[A-Za-z0-9_.-]{1,80}$/) });
export const hasPlanScope = (scopes: string) => requiredScopes.every(s => scopes.split(/\s+/).includes(s));
const nonce = () => randomBytes(32).toString('base64url');
export function sameSecret(left: string, right: string | null) {
  if (!right) return false;
  const a = Buffer.from(left), b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

export class PlanError extends Error {
  constructor(readonly code: string, readonly status = 400) { super(code); }
}
function limited(signal?: AbortSignal) {
  const timeout = AbortSignal.timeout(15_000);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}
async function safeError(response: Response) {
  const json: unknown = await response.json().catch(() => null);
  const result = oauthError.safeParse(json);
  return new PlanError(result.success ? result.data.error : 'CHATGPT_HTTP_ERROR', response.status);
}

export class ChatGPTPlan {
  private discovery?: Promise<z.infer<typeof metadata>>;
  private keys?: ReturnType<typeof createRemoteJWKSet>;
  constructor(readonly store = new PlanStore(), private readonly request: typeof fetch = fetch) {}
  private endpoints() {
    this.discovery ??= (async () => {
      const res = await this.request(issuer + '/.well-known/openid-configuration',
        { redirect: 'error', signal: limited() });
      if (!res.ok) throw await safeError(res);
      return metadata.parse(await res.json());
    })().catch(err => { this.discovery = undefined; throw err; });
    return this.discovery;
  }
  private async identity(token: string, clientId: string, expectedNonce?: string) {
    const config = await this.endpoints();
    this.keys ??= createRemoteJWKSet(new URL(config.jwks_uri), { [customFetch]: this.request });
    const { payload } = await jwtVerify(token, this.keys, {
      issuer, audience: clientId, algorithms: ['RS256'], requiredClaims: ['sub', 'exp', 'iat'], clockTolerance: 10,
    });
    if (typeof payload.sub !== 'string' || !payload.sub ||
        (expectedNonce !== undefined && payload.nonce !== expectedNonce) ||
        ((payload.azp !== undefined || (Array.isArray(payload.aud) && payload.aud.length > 1)) && payload.azp !== clientId)) {
      throw new PlanError('CHATGPT_IDENTITY_INVALID', 401);
    }
    return { subject: payload.sub, email: payload.email_verified === true && typeof payload.email === 'string'
      ? payload.email : undefined };
  }
  private async exchange(params: Record<string, string>, signal?: AbortSignal) {
    const res = await this.request((await this.endpoints()).token_endpoint, {
      method: 'POST', body: new URLSearchParams({ ...params, resource: openaiResource }),
      redirect: 'error', signal: limited(signal),
    });
    if (!res.ok) throw await safeError(res);
    const parsed = tokenReply.safeParse(await res.json());
    if (!parsed.success) throw new PlanError('CHATGPT_TOKEN_RESPONSE_INVALID', 502);
    return parsed.data;
  }
  async begin(redirectUri: string) {
    const callback = new URL(redirectUri);
    if (callback.protocol !== 'http:' || callback.hostname !== '127.0.0.1' || !callback.port ||
        callback.pathname !== '/auth/callback' || callback.search || callback.hash || callback.username || callback.password) {
      throw new PlanError('CHATGPT_LOOPBACK_REQUIRED');
    }
    const saved = await this.store.snapshot();
    const verifier = nonce(), state = nonce(), oidcNonce = nonce();
    const authorize = new URL((await this.endpoints()).authorization_endpoint);
    const prior = saved.account;
    authorize.search = new URLSearchParams({
      client_id: prior?.clientId ?? 'dynamic_agent_client',
      ...(prior ? {} : { agent_name_hint: 'MAGI' }),
      ...(prior?.tokens?.id ? { id_token_hint: prior.tokens.id } : {}),
      ...(prior && !hasPlanScope(prior.tokens?.scopes ?? '') ? { prompt: 'consent' } : {}),
      ext_agent_host_id: saved.hostId, response_type: 'code', redirect_uri: redirectUri,
      scope: requested, resource: openaiResource, state, nonce: oidcNonce,
      code_challenge_method: 'S256', code_challenge: createHash('sha256').update(verifier).digest('base64url'),
    }).toString();
    let used = false;
    return { authorize, state, finish: async (params: URLSearchParams) => {
      if (params.getAll('state').length !== 1 || !sameSecret(state, params.get('state'))) throw new PlanError('CHATGPT_STATE_MISMATCH');
      if (used) throw new PlanError('CHATGPT_CALLBACK_USED');
      used = true;
      if (params.has('error')) throw new PlanError('CHATGPT_CONSENT_DENIED', 403);
      const code = params.get('code');
      const clientId = params.get('client_id') ?? prior?.clientId;
      if (!code || params.getAll('code').length !== 1 || params.getAll('client_id').length > 1 ||
          !clientId || clientId === 'dynamic_agent_client' || (prior && clientId !== prior.clientId)) {
        throw new PlanError('CHATGPT_CALLBACK_INVALID');
      }
      const reply = await this.exchange({ grant_type: 'authorization_code', code, client_id: clientId,
        code_verifier: verifier, redirect_uri: redirectUri });
      if (!reply.id_token) throw new PlanError('CHATGPT_ID_TOKEN_MISSING', 401);
      const verified = await this.identity(reply.id_token, clientId, oidcNonce);
      if (prior && verified.subject !== prior.subject) throw new PlanError('CHATGPT_ACCOUNT_MISMATCH', 401);
      const scopes = reply.scope ?? '';
      const enabled = hasPlanScope(scopes) && !!reply.refresh_token;
      const tokens: PlanTokens = { access: reply.access_token, refresh: reply.refresh_token ?? '', id: reply.id_token,
        scopes, expiresAt: Date.now() + reply.expires_in * 1000 };
      await this.store.change(async current => {
        if (current.generation !== saved.generation) throw new PlanError('CHATGPT_CONNECTION_CHANGED', 409);
        current.account = { clientId, ...verified, tokens };
        current.generation++;
      });
      return enabled;
    } };
  }
  async access(signal = AbortSignal.timeout(45_000)): Promise<string> {
    function usable(tokens: PlanTokens | null | undefined) {
      if (!tokens?.refresh || !hasPlanScope(tokens.scopes)) throw new PlanError('CHATGPT_LOGIN_REQUIRED', 401);
      return tokens.expiresAt > Date.now() + 60_000 ? tokens.access : null;
    }
    const available = usable((await this.store.snapshot(signal)).account?.tokens);
    if (available) return available;
    const result = await this.store.change(async current => {
      const account = current.account;
      const tokens = account?.tokens;
      const fresh = usable(tokens);
      if (fresh) return fresh;
      if (!account || !tokens) throw new PlanError('CHATGPT_LOGIN_REQUIRED', 401);
      let reply;
      try { reply = await this.exchange({ grant_type: 'refresh_token', client_id: account.clientId, refresh_token: tokens.refresh }, signal); }
      catch (err) {
        if (!(err instanceof PlanError) || !['invalid_grant', 'refresh_token_expired', 'refresh_token_reused', 'refresh_token_invalidated'].includes(err.code)) throw err;
        account.tokens = null;
        current.generation++;
        return null;
      }
      if (reply.id_token && (await this.identity(reply.id_token, account.clientId)).subject !== account.subject) {
        throw new PlanError('CHATGPT_ACCOUNT_MISMATCH', 401);
      }
      account.tokens = { access: reply.access_token, refresh: reply.refresh_token ?? tokens.refresh,
        id: reply.id_token ?? tokens.id, scopes: reply.scope ?? tokens.scopes, expiresAt: Date.now() + reply.expires_in * 1000 };
      return hasPlanScope(account.tokens.scopes) ? account.tokens.access : null;
    }, signal);
    if (!result) throw new PlanError('CHATGPT_LOGIN_REQUIRED', 401);
    return result;
  }
  private async listedModels() {
    const token = await this.access();
    const res = await this.request(openaiResource + '/models', { headers: { Authorization: 'Bearer ' + token },
      redirect: 'error', signal: limited() });
    if (!res.ok) throw await safeError(res);
    return catalog.parse(await res.json()).models.filter(m => m.visibility === 'list');
  }
  async models() {
    return (await this.listedModels()).map(m => m.slug);
  }
  async modelOptions(initial: ModelSelection) {
    return (await this.listedModels()).flatMap(m => {
      const efforts = m.supported_reasoning_levels?.map(level => typeof level === 'string' ? level : level.effort);
      return modelOption(m.slug, m.display_name || m.slug, efforts ?? (m.slug === initial.model ? [initial.effort] : []));
    });
  }
  async logout() {
    return this.store.change(async state => {
      const account = state.account;
      let confirmed = true;
      if (account?.tokens?.refresh) {
        try {
          const uri = (await this.endpoints()).revocation_endpoint;
          const res = await this.request(uri, { method: 'POST', redirect: 'error', signal: limited(),
            body: new URLSearchParams({ token: account.tokens.refresh, token_type_hint: 'refresh_token', client_id: account.clientId }) });
          confirmed = res.ok;
        } catch { confirmed = false; }
      }
      if (account) account.tokens = null;
      state.generation++;
      return confirmed;
    });
  }
}
