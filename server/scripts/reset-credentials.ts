import { createInterface } from 'node:readline/promises';
import { cliConfig, loadEnvironment } from '../src/config.js';
import { openDb } from '../src/db/index.js';

if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('请在本机交互终端执行。');
process.umask(0o077);
loadEnvironment();
const config = cliConfig();
const term = createInterface({ input: process.stdin, output: process.stdout });
try {
  const answer = await term.question('输入 RESET 确认清空本机所有 Passkey、会话、邀请和认证挑战：');
  if (answer === 'RESET') {
    const db = openDb(config.DB_PATH);
    try {
      db.transaction(() => db.exec('DELETE FROM credentials; DELETE FROM sessions; DELETE FROM invites; DELETE FROM challenges;')).immediate();
      console.log('凭证已重置。运行 npm run invite 注册新 Passkey。');
    } finally { db.close(); }
  } else { console.log('已取消。'); }
} finally { term.close(); }
