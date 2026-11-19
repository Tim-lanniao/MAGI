import { spawn } from 'node:child_process';
import { parseArgs } from 'node:util';
import { loadEnvironment } from '../src/config.js';
import { ChatGPTPlan, hasPlanScope, PlanError } from '../src/magi/providers/chatgpt-plan.js';
import { startPlanLogin } from '../src/magi/providers/chatgpt-loopback.js';

async function main() {
  process.umask(0o077);
  loadEnvironment();
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    port: { type: 'string' }, 'no-open': { type: 'boolean' },
  } });
  const [action = 'status'] = positionals;
  if (positionals.length > 1) throw new PlanError('CHATGPT_INVALID_ARGUMENT');
  const plan = new ChatGPTPlan();
  if (action === 'login') {
    const port = values.port === undefined ? 0 : Number(values.port);
    if (!Number.isInteger(port) || port < 0 || port > 65535) throw new PlanError('CHATGPT_INVALID_PORT');
    const session = await startPlanLogin(plan, port);
    console.log('MAGI ChatGPT 授权入口 ' + session.origin + '/');
    if (!values['no-open']) {
      const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'rundll32.exe' : 'xdg-open';
      const args = process.platform === 'win32' ? ['url.dll,FileProtocolHandler', session.origin] : [session.origin];
      const browser = spawn(command, args, { stdio: 'ignore' });
      browser.on('error', () => console.error('请在本机浏览器中打开上面的授权入口。'));
      browser.unref();
    }
    const enabled = await session.completed;
    if (!enabled) throw new PlanError('CHATGPT_PLAN_PERMISSION_REQUIRED', 403);
    console.log('ChatGPT 套餐授权已保存。');
  } else if (action === 'status') {
    const { account } = await plan.store.snapshot();
    const tokens = account?.tokens;
    console.log('GPT 模式 ' + (process.env.OPENAI_AUTH_MODE || 'api_key'));
    console.log(tokens?.refresh && hasPlanScope(tokens.scopes) ? 'ChatGPT 套餐授权已保存。' : '尚无可用于表决的 ChatGPT 套餐授权。');
    console.log('管理应用用量 https://chatgpt.com/settings/usage');
  } else if (action === 'models') {
    console.log((await plan.models()).join('\n'));
  } else if (action === 'logout') {
    const confirmed = await plan.logout();
    console.log(confirmed ? '已断开 MAGI 的 ChatGPT 套餐授权。' : '本机凭据已清除。请在 ChatGPT 设置中确认断开 MAGI。');
    if (!confirmed) process.exitCode = 1;
  } else { throw new PlanError('CHATGPT_UNKNOWN_COMMAND'); }
}
main().catch(err => {
  // The provider may include sensitive credentials in diagnostic objects. Print only a short code.
  const code = err instanceof PlanError ? err.code : typeof err?.code === 'string' && /^[A-Z0-9_]{1,48}$/.test(err.code)
    ? err.code : 'CHATGPT_CONNECTION_FAILED';
  console.error('MAGI ChatGPT 操作未完成 (' + code + ')');
  process.exitCode = 1;
});
