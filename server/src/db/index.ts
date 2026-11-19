import Database from 'better-sqlite3';
import { chmodSync, closeSync, mkdirSync, openSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { root } from '../config.js';

export type Db = Database.Database;
export const now = () => new Date().toISOString();
export const at = (ms: number) => new Date(ms).toISOString();

export function openDb(path: string): Db {
  if (path !== ':memory:') {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    closeSync(openSync(path, 'a', 0o600));
    if (process.platform !== 'win32') chmodSync(path, 0o600);
  }
  const db = new Database(path);
  try {
    db.pragma('busy_timeout = 5000');
    db.pragma('foreign_keys = ON');
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = FULL');
    const folder = join(root, 'server/src/db/migrations');
    db.transaction(() => {
      db.exec('CREATE TABLE IF NOT EXISTS migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)');
      for (const name of readdirSync(folder).filter(name => name.endsWith('.sql')).sort()) {
        if (db.prepare('SELECT 1 FROM migrations WHERE name=?').get(name)) continue;
        db.exec(readFileSync(join(folder, name), 'utf8'));
        db.prepare('INSERT INTO migrations VALUES (?,?)').run(name, now());
      }
      db.prepare('INSERT OR IGNORE INTO app_user VALUES (1,?,?)').run(randomBytes(32), now());
    }).immediate();
    return db;
  } catch (err) { db.close(); throw err; }
}
