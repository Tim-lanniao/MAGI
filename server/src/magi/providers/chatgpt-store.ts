import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { closeSync, lstatSync, mkdirSync, openSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

export interface PlanTokens {
  access: string;
  refresh: string;
  id: string;
  scopes: string;
  expiresAt: number;
}
export interface Registration {
  clientId: string;
  subject: string;
  email?: string;
  tokens: PlanTokens | null;
}
export interface PlanState {
  hostId: string;
  generation: number;
  account: Registration | null;
}

export const planDirectory = () => join(homedir(), 'Library', 'Application Support', 'MAGI', 'chatgpt');

async function lock(db: Database.Database, signal: AbortSignal) {
  for (;;) {
    signal.throwIfAborted();
    try { db.exec('BEGIN IMMEDIATE'); return; }
    catch (err) {
      if (!(err instanceof Database.SqliteError) || err.code !== 'SQLITE_BUSY') throw err;
      await delay(80, undefined, { signal });
    }
  }
}

/** A private database also serializes OAuth refresh-token rotation across Node processes. */
export class PlanStore {
  constructor(private readonly directory = planDirectory()) {}

  private async open(signal: AbortSignal) {
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const file = join(this.directory, 'connection.sqlite3');
    const folder = lstatSync(this.directory);
    if (!folder.isDirectory() || (process.platform !== 'win32' && (folder.mode & 0o077))) {
      throw new Error('ChatGPT 授权目录须为服务账号的私有目录（权限 700）。');
    }
    closeSync(openSync(file, 'a', 0o600));
    const stat = lstatSync(file);
    if (!stat.isFile() || (process.platform !== 'win32' && (stat.mode & 0o077))) {
      throw new Error('ChatGPT 授权文件须为普通文件，权限 600。');
    }
    const db = new Database(file, { timeout: 0 });
    try {
      db.pragma('secure_delete = ON');
      if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='connection'").get()) {
        await lock(db, signal);
        db.exec('CREATE TABLE IF NOT EXISTS connection (id INTEGER PRIMARY KEY CHECK(id=1), hostId TEXT NOT NULL, generation INTEGER NOT NULL, account TEXT)');
        db.prepare('INSERT OR IGNORE INTO connection VALUES (1, ?, 0, NULL)').run('urn:uuid:' + randomUUID());
        db.exec('COMMIT');
      }
      return db;
    } catch (err) { db.close(); throw err; }
  }

  private read(db: Database.Database): PlanState {
    const row = db.prepare('SELECT hostId,generation,account FROM connection WHERE id=1').get() as
      { hostId: string; generation: number; account: string | null };
    return { ...row, account: row.account ? JSON.parse(row.account) as Registration : null };
  }
  async snapshot(signal = AbortSignal.timeout(30_000)) {
    const db = await this.open(signal);
    try { return this.read(db); } finally { db.close(); }
  }
  async change<T>(update: (state: PlanState) => Promise<T>, signal = AbortSignal.timeout(45_000)): Promise<T> {
    const db = await this.open(signal);
    try {
      await lock(db, signal);
      const state = this.read(db);
      const result = await update(state);
      db.prepare('UPDATE connection SET generation=?,account=? WHERE id=1').run(state.generation,
        state.account ? JSON.stringify(state.account) : null);
      db.exec('COMMIT');
      return result;
    } finally { db.close(); } // Closing an uncommitted transaction rolls it back after errors or interruption.
  }
}
