import { execFileSync,spawnSync } from 'node:child_process';
import { mkdtempSync,rmSync,statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { expect,it } from 'vitest';
import { openDb } from '../src/db/index.js';
import { digest } from '../src/auth/session.js';
import { createQuestion,detail } from '../src/db/questions.js';
import { submission } from './helpers.js';

it('本机 CLI 与重开后的 SQLite 共享单用户、邀请和已锁定的问题，重置要求终端确认', () => {
  const dir = mkdtempSync(join(tmpdir(),'magi-storage-'));
  const path = join(dir,'magi.db');
  const env = {...process.env,RP_ID:'magi.test',DB_PATH:path};
  try {
    const printed = execFileSync(process.execPath,['--import','tsx','server/scripts/invite.ts'],{env,encoding:'utf8'}).trim();
    const url = new URL(printed);
    const token = url.searchParams.get('token')!;
    expect(url.origin+url.pathname).toBe('https://magi.test/setup');
    expect(Buffer.from(token,'base64url')).toHaveLength(32);
    const first = openDb(path);
    let handle, id;
    try {
      handle = first.prepare('SELECT hex(user_handle) FROM app_user').pluck().get();
      expect(first.prepare('SELECT token_hash FROM invites').pluck().get()).toBe(digest(token));
      id = createQuestion(first,submission);
    } finally { first.close(); }
    const refused = spawnSync(process.execPath,['--import','tsx','server/scripts/reset-credentials.ts'],{env,input:'RESET\n',encoding:'utf8'});
    expect(refused.status).toBe(1);
    const second = openDb(path);
    try {
      expect(second.prepare('SELECT hex(user_handle) FROM app_user').pluck().get()).toBe(handle);
      expect(second.prepare('SELECT count(*) FROM invites').pluck().get()).toBe(1);
      expect(detail(second,id!).votes[0]).toMatchObject({state:'valid',core_reason:'USER_PRIVATE_REASON'});
      expect(second.pragma('quick_check',{simple:true})).toBe('ok');
      if (process.platform !== 'win32') expect(statSync(path).mode & 0o777).toBe(0o600);
    } finally { second.close(); }
  } finally { rmSync(dir,{recursive:true,force:true}); }
});
