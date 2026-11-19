import { isIP, SocketAddress } from 'node:net';
import { at, now, type Db } from '../db/index.js';
import { HttpError } from '../errors.js';
import { digest, token, validToken } from './session.js';

export const invalidInvite = () => new HttpError(403, 'INVALID_INVITE', '邀请无效、已过期或不适用于当前网络。');
const usable = 'token_hash=? AND expires_at>? AND used_at IS NULL AND (allowed_ip IS NULL OR allowed_ip=?)';

function canonicalIp(address: string): string | null {
  const family = isIP(address);
  if (family === 4) return address;
  if (family !== 6 || address.includes('%')) return null;
  // The same IPv4 peer may arrive as an IPv4-mapped IPv6 address.
  return new SocketAddress({ address, family: 'ipv6' }).address.replace(/^::ffff:(?=\d+\.)/, '');
}

export function createInvite(db: Db, ip?: string) {
  const allowedIp = ip === undefined ? null : canonicalIp(ip);
  if (ip !== undefined && allowedIp === null) throw new Error('请为 --ip 指定一个有效的 IPv4 或 IPv6 地址。');
  const value = token();
  db.prepare('INSERT INTO invites(token_hash,expires_at,allowed_ip) VALUES (?,?,?)')
    .run(digest(value), at(Date.now() + 5 * 60_000), allowedIp);
  return value;
}
export function requireInvite(db: Db, value: unknown, ip: string) {
  if (!validToken(value)) throw invalidInvite();
  const hash = digest(value);
  if (!db.prepare('SELECT 1 FROM invites WHERE ' + usable).get(hash, now(), canonicalIp(ip))) throw invalidInvite();
  return hash;
}

export function consumeInvite(db: Db, hash: string, ip: string, time: string) {
  if (!db.prepare('UPDATE invites SET used_at=? WHERE ' + usable).run(time, hash, time, canonicalIp(ip)).changes) throw invalidInvite();
}
