import Fastify, { LogController } from 'fastify';
import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import staticFiles from '@fastify/static';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { ZodError } from 'zod';
import { root, type Config } from './config.js';
import { at, now, type Db } from './db/index.js';
import { HttpError, invalid, missing } from './errors.js';
import { requireSession } from './auth/session.js';
import { authRoutes } from './auth/webauthn.js';
import { questionRoutes } from './routes/questions.js';
import { settingsRoutes } from './routes/settings.js';
import { initializeModelSettings, readModelSettings } from './db/model-settings.js';
import { Runner } from './magi/runner.js';
import { createProviders, type Providers } from './magi/providers/responses.js';
import { hasPlanScope } from './magi/providers/chatgpt-plan.js';
import { PlanStore } from './magi/providers/chatgpt-store.js';

const ceremonies = new Set(['/api/auth/register/options','/api/auth/register/verify','/api/auth/login/options','/api/auth/login/verify']);
const isApi = (path: string) => path === '/api' || path.startsWith('/api/');

export async function buildApp(config: Config, db: Db, providers: Providers = createProviders(config), logging = true,
  webRoot = join(root,'web/dist')) {
  const app = Fastify({
    trustProxy: config.TRUST_PROXY, bodyLimit: 256 * 1024, logController: new LogController({ disableRequestLogging: true }), exposeHeadRoutes: false,
    logger: logging ? { redact: { paths: ['req.headers','req.body','req.url','body','apiKey','inviteToken','response','*.raw_response'], remove: true } } : false,
  });
  initializeModelSettings(db, providers);
  const runner = new Runner(db, providers, config.MODEL_TIMEOUT_SECONDS * 1000, id => {
    app.log.error({ questionId: id }, '无法保存表决，将退出并由服务管理器恢复');
    // An unrecoverable storage error must never be silently treated as a model absence.
    if (logging) process.exit(1);
  });
  await app.register(cookie);
  await app.register(helmet, {
    contentSecurityPolicy: { useDefaults: false, directives: { defaultSrc: ["'self'"], scriptSrc: ["'self'"],
      connectSrc: ["'self'"], objectSrc: ["'none'"], baseUri: ["'none'"], formAction: ["'self'"], frameAncestors: ["'none'"] } },
    referrerPolicy: { policy: 'no-referrer' }, strictTransportSecurity: { maxAge: 31536000 },
  });
  await app.register(rateLimit, { global: false, keyGenerator: req => req.ip });
  app.addHook('onRequest', async (req,reply) => {
    const path = (req.raw.url ?? '/').split('?')[0];
    if (req.method !== 'GET' && req.headers.origin !== 'https://' + config.RP_ID) {
      throw new HttpError(403, 'ORIGIN_DENIED', '请求来源不匹配。');
    }
    if (!isApi(req.routeOptions.url ?? '') && !isApi(path)) return;
    reply.header('Cache-Control','no-store');
    if (!ceremonies.has(req.routeOptions.url ?? '') || req.method !== 'POST') requireSession(db,config,req,reply);
    if (!req.routeOptions.url?.startsWith('/api/')) throw missing();
  });
  app.setErrorHandler((err: Error & { statusCode?: number },req,reply) => {
    let error: HttpError;
    if (err instanceof HttpError) error = err;
    else if (err instanceof ZodError) error = invalid('请检查字段：' + err.issues.map(i => i.path.join('.') || '请求体').join('、'));
    else if (err.statusCode === 429) error = new HttpError(429,'RATE_LIMITED','请求过于频繁，请稍后重试。');
    else if (err.statusCode === 413) error = new HttpError(413,'PAYLOAD_TOO_LARGE','请求体超过大小限制。');
    else if (err.statusCode === 415) error = new HttpError(415,'UNSUPPORTED_MEDIA_TYPE','请使用 application/json。');
    else if (err.statusCode === 400) error = new HttpError(400,'BAD_REQUEST','请求格式无效。');
    else if (err.statusCode === 404) error = missing();
    else error = new HttpError(500,'INTERNAL_ERROR','服务暂时无法完成请求。');
    if (error.status >= 500 || req.routeOptions.url?.startsWith('/api/auth/')) {
      req.log.warn({ code: error.code, route: req.routeOptions.url, clientIp: req.ip }, '请求失败');
    }
    reply.code(error.status).send({ error: { code: error.code, message: error.message }, ...error.extra });
  });
  await app.register(async scope => {
    authRoutes(scope,db,config);
    questionRoutes(scope,db,runner,config.LINT_PHRASES);
    settingsRoutes(scope,db,providers);
    scope.get('/providers/gpt', async () => {
      const mode = config.OPENAI_AUTH_MODE;
      const { model } = readModelSettings(db).gpt;
      if (mode === 'api_key') return { mode, model };
      const { account } = await new PlanStore().snapshot();
      return { mode, model, authorized: !!account?.tokens?.refresh && hasPlanScope(account.tokens.scopes) };
    });
  }, { prefix: '/api' });

  const hasFrontend = existsSync(join(webRoot,'index.html'));
  const publicRoot = join(root,'public');
  await app.register(staticFiles, { root: hasFrontend ? webRoot : publicRoot, serve: hasFrontend, index: 'index.html' });
  if (!hasFrontend) {
    for (const path of ['/','/setup','/dev.html']) {
      app.get(path, async (_req,reply) => reply.header('Cache-Control','no-store').sendFile('dev.html',publicRoot));
    }
    app.get('/dev.js', async (_req,reply) => reply.sendFile('dev.js',publicRoot));
    app.get('/webauthn.js', async (_req,reply) =>
      reply.sendFile('index.umd.min.js',join(root,'node_modules/@simplewebauthn/browser/dist/bundle')));
  }
  app.setNotFoundHandler((req,reply) => {
    const path = (req.raw.url ?? '/').split('?')[0];
    if (isApi(path) || !hasFrontend || !['GET','HEAD'].includes(req.method)) throw missing();
    return reply.header('Cache-Control','no-store').sendFile('index.html',webRoot);
  });
  function cleanExpired() {
    const t = now();
    const idle = at(Date.now() - config.SESSION_IDLE_HOURS * 3_600_000);
    db.transaction(() => {
      db.prepare('DELETE FROM challenges WHERE expires_at<=?').run(t);
      db.prepare('DELETE FROM invites WHERE expires_at<=?').run(t);
      db.prepare('DELETE FROM sessions WHERE expires_at<=? OR last_seen_at<=?').run(t,idle);
    }).immediate();
  }
  cleanExpired();
  const timer = setInterval(cleanExpired, 300_000).unref();
  app.addHook('onClose', async () => { clearInterval(timer); await runner.idle(); });
  return { app, runner };
}
