import { createHash, randomBytes } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Config } from '../config.js';
import { at, type Db } from '../db/index.js';
import { HttpError } from '../errors.js';

export const digest = (s: string) => createHash('sha256').update(s).digest('hex');
export const token = () => randomBytes(32).toString('base64url');
export const validToken = (s: unknown): s is string => typeof s === 'string' && /^[A-Za-z0-9_-]{43}$/.test(s);
export const cookieOptions = { path: '/', httpOnly: true, sameSite: 'strict', secure: true } as const;
export const sid = 'magi_sid';

export function issueSession(db: Db, hours: number) {
  const value = token();
  const t = Date.now();
  db.prepare('INSERT INTO sessions VALUES (?,?,?,?)').run(digest(value), at(t), at(t), at(t + hours * 3_600_000));
  return value;
}
export function requireSession(db: Db, config: Config, req: FastifyRequest, reply: FastifyReply) {
  const value = req.cookies[sid];
  const t = Date.now();
  if (validToken(value) && db.prepare(`UPDATE sessions SET last_seen_at=? WHERE id_hash=?
    AND expires_at>? AND last_seen_at>?`).run(at(t), digest(value), at(t), at(t - config.SESSION_IDLE_HOURS*3_600_000)).changes) return;
  if (value) reply.clearCookie(sid, cookieOptions);
  throw new HttpError(401, 'UNAUTHENTICATED', '请用 Passkey 登录。');
}
