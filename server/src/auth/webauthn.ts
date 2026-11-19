import { generateAuthenticationOptions, generateRegistrationOptions, verifyAuthenticationResponse,
  verifyRegistrationResponse, type AuthenticationResponseJSON, type RegistrationResponseJSON,
  type AuthenticatorTransportFuture } from '@simplewebauthn/server';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import type { Config } from '../config.js';
import { at, now, type Db } from '../db/index.js';
import { HttpError, missing } from '../errors.js';
import { cookieOptions, digest, issueSession, sid, token, validToken } from './session.js';
import { consumeInvite, invalidInvite, requireInvite } from './invite.js';

const device = z.string().trim().min(1).max(120);
const registerOptions = z.strictObject({ inviteToken: z.string(), deviceName: device });
const publicKey = z.looseObject({ id: z.string().min(1), rawId: z.string(), type: z.literal('public-key'),
  clientExtensionResults: z.looseObject({}) });
const loginVerify = z.strictObject({ response: publicKey.extend({ response: z.looseObject({
  clientDataJSON: z.string(), authenticatorData: z.string(), signature: z.string(), userHandle: z.string().nullish(),
}) }) });
const registerVerify = z.strictObject({ inviteToken: z.string(), response: publicKey.extend({ response: z.looseObject({
  clientDataJSON: z.string(), attestationObject: z.string(),
}) }) });
const denied = () => new HttpError(403, 'VERIFICATION_FAILED', 'Passkey 验证失败。');
const counterDenied = () => new HttpError(403, 'COUNTER_REJECTED', 'Passkey 签名计数器异常。');
type Ceremony = 'register' | 'login';
interface Challenge { challenge: string; invite_hash: string | null; device_name: string | null }
interface Credential { id: string; public_key: Buffer; counter: number; transports: string }
const challengeCookie = (kind: Ceremony) => 'magi_' + kind;
function issueChallenge(db: Db, reply: FastifyReply, kind: Ceremony, value: string, invite: string | null = null, name: string | null = null) {
  const id = token();
  db.prepare('INSERT INTO challenges VALUES (?,?,?,?,?,?)')
    .run(digest(id), kind, digest(value), at(Date.now() + 300_000), invite, name);
  reply.setCookie(challengeCookie(kind), id, { ...cookieOptions, maxAge: 300 });
}
function takeChallenge(db: Db, req: FastifyRequest, reply: FastifyReply, kind: Ceremony) {
  const value = req.cookies[challengeCookie(kind)];
  reply.clearCookie(challengeCookie(kind), cookieOptions);
  const row = validToken(value) && db.prepare(`DELETE FROM challenges WHERE id=? AND type=? AND expires_at>?
    RETURNING challenge,invite_hash,device_name`).get(digest(value), kind, now()) as Challenge | undefined;
  if (!row) throw new HttpError(403, 'INVALID_CHALLENGE', '认证挑战已失效，请重新开始。');
  return row;
}

export function authRoutes(app: FastifyInstance, db: Db, config: Config) {
  const rpID = config.RP_ID;
  const expectedOrigin = 'https://' + rpID;
  const handle = () => (db.prepare('SELECT user_handle FROM app_user WHERE id=1').get() as { user_handle: Buffer }).user_handle;
  const count = () => (db.prepare('SELECT count(*) AS n FROM credentials').get() as { n: number }).n;
  const ceremonyLimit = { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } };

  app.post('/auth/register/options', ceremonyLimit, async (req, reply) => {
    const hash = requireInvite(db, (req.body as { inviteToken?: unknown } | null)?.inviteToken, req.ip);
    const body = registerOptions.parse(req.body);
    const creds = db.prepare('SELECT id,transports FROM credentials').all() as Pick<Credential,'id'|'transports'>[];
    const options = await generateRegistrationOptions({
      rpID, rpName: config.RP_NAME, userID: new Uint8Array(handle()), userName: 'MAGI', userDisplayName: config.RP_NAME,
      attestationType: 'none', timeout: 300_000, supportedAlgorithmIDs: [-7,-257],
      authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
      excludeCredentials: creds.map(c => ({ id: c.id, transports: JSON.parse(c.transports) })),
    });
    issueChallenge(db, reply, 'register', options.challenge, hash, body.deviceName);
    return options;
  });
  app.post('/auth/register/verify', ceremonyLimit, async (req, reply) => {
    const hash = requireInvite(db, (req.body as { inviteToken?: unknown } | null)?.inviteToken, req.ip);
    const { response } = registerVerify.parse(req.body);
    const challenge = takeChallenge(db, req, reply, 'register');
    if (challenge.invite_hash !== hash) throw invalidInvite();
    const verified = await verifyRegistrationResponse({
      response: response as RegistrationResponseJSON, expectedRPID: rpID, expectedOrigin,
      expectedChallenge: s => digest(s) === challenge.challenge, requireUserVerification: true, supportedAlgorithmIDs: [-7,-257],
    }).catch(() => { throw denied(); });
    if (!verified.verified || !verified.registrationInfo) throw denied();
    const { credential } = verified.registrationInfo;
    db.transaction(() => {
      const t = now();
      consumeInvite(db, hash, req.ip, t);
      if (!db.prepare(`INSERT INTO credentials(id, public_key, counter, transports, device_name, created_at)
        VALUES (?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING`).run(credential.id, Buffer.from(credential.publicKey),
        credential.counter, JSON.stringify(credential.transports ?? []), challenge.device_name, t).changes) {
        throw new HttpError(409, 'CREDENTIAL_EXISTS', '此 Passkey 已注册。');
      }
    }).immediate();
    return { ok: true };
  });
  app.post('/auth/login/options', ceremonyLimit, async (req, reply) => {
    z.strictObject({}).parse(req.body ?? {});
    const options = await generateAuthenticationOptions({ rpID, userVerification: 'required', allowCredentials: [], timeout: 300_000 });
    issueChallenge(db, reply, 'login', options.challenge);
    return options;
  });
  app.post('/auth/login/verify', ceremonyLimit, async (req, reply) => {
    const body = loginVerify.parse(req.body);
    const challenge = takeChallenge(db, req, reply, 'login');
    const response = body.response as AuthenticationResponseJSON;
    const stored = db.prepare('SELECT * FROM credentials WHERE id=?').get(response.id) as Credential | undefined;
    if (!stored || response.response.userHandle !== handle().toString('base64url')) throw denied();
    const verified = await verifyAuthenticationResponse({
      response, expectedOrigin, expectedRPID: rpID, expectedChallenge: s => digest(s) === challenge.challenge,
      requireUserVerification: true,
      credential: { id: stored.id, publicKey: new Uint8Array(stored.public_key), counter: stored.counter,
        transports: JSON.parse(stored.transports) as AuthenticatorTransportFuture[] },
    }).catch((error: unknown) => {
      if (error instanceof Error && /counter/i.test(error.message)) throw counterDenied();
      throw denied();
    });
    if (!verified.verified) throw denied();
    const counter = verified.authenticationInfo.newCounter;
    const value = db.transaction(() => {
      if (!db.prepare(`UPDATE credentials SET counter=?,last_used_at=? WHERE id=? AND public_key=?
        AND ((counter=0 AND ?=0) OR counter<?)`).run(counter, now(), stored.id, stored.public_key, counter, counter).changes) throw counterDenied();
      const old = req.cookies[sid];
      if (validToken(old)) db.prepare('DELETE FROM sessions WHERE id_hash=?').run(digest(old));
      return issueSession(db, config.SESSION_ABSOLUTE_HOURS);
    }).immediate();
    reply.setCookie(sid, value, { ...cookieOptions, maxAge: config.SESSION_ABSOLUTE_HOURS * 3600 });
    return { ok: true };
  });

  app.get('/auth/me', ceremonyLimit, async () => ({ authenticated: true, credentialsCount: count() }));
  app.post('/auth/logout', ceremonyLimit, async (req, reply) => {
    db.prepare('DELETE FROM sessions WHERE id_hash=?').run(digest(req.cookies[sid]!));
    reply.clearCookie(sid, cookieOptions);
    return { ok: true };
  });
  app.get('/auth/credentials', ceremonyLimit, async () => db.prepare(`SELECT id,device_name AS deviceName,created_at AS createdAt,
    last_used_at AS lastUsedAt FROM credentials ORDER BY created_at,id`).all());
  app.patch<{ Params: { id: string } }>('/auth/credentials/:id', ceremonyLimit, async req => {
    const { deviceName } = z.strictObject({ deviceName: device }).parse(req.body);
    if (!db.prepare('UPDATE credentials SET device_name=? WHERE id=?').run(deviceName, req.params.id).changes) throw missing();
    return { ok: true };
  });
  app.delete<{ Params: { id: string } }>('/auth/credentials/:id', ceremonyLimit, async (req, reply) => {
    db.transaction(() => {
      if (!db.prepare('SELECT 1 FROM credentials WHERE id=?').get(req.params.id)) throw missing();
      if (count() <= 1) throw new HttpError(409, 'LAST_CREDENTIAL', '请保留至少一个 Passkey。');
      db.prepare('DELETE FROM credentials WHERE id=?').run(req.params.id);
      db.exec('DELETE FROM sessions; DELETE FROM challenges;');
    }).immediate();
    reply.clearCookie(sid, cookieOptions);
    return { ok: true };
  });
}
