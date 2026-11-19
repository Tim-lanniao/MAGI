import { randomBytes } from 'node:crypto';
import { createServer, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { ChatGPTPlan, PlanError, sameSecret } from './chatgpt-plan.js';

const usageLink = '<a href="https://chatgpt.com/settings/usage" rel="noreferrer">管理 ChatGPT 用量</a>';
function page(res: ServerResponse, status: number, title: string, content: string) {
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end('<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<title>MAGI · ChatGPT 授权</title><style>body{font:17px/1.65 system-ui,sans-serif;max-width:36em;margin:12vh auto;padding:0 1.4em;color:#17232a}h1{font-size:1.55em}a{color:#12556e}.continue{display:inline-block;padding:.5em 1.1em;border-radius:.4em;background:#12556e;color:white;text-decoration:none}</style>' +
    '<main><h1>' + title + '</h1>' + content + '</main></html>');
}

/** The only browser callback is a short-lived loopback listener, independent of the public web service. */
export async function startPlanLogin(plan: ChatGPTPlan, port = 0, lifetime = 15 * 60_000) {
  const startToken = randomBytes(24).toString('base64url');
  let origin = '';
  let flow: Awaited<ReturnType<ChatGPTPlan['begin']>> | undefined;
  let exchanging = false;
  let resolve!: (enabled: boolean) => void, reject!: (error: Error) => void;
  const completed = new Promise<boolean>((yes, no) => { resolve = yes; reject = no; });
  const server = createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; form-action 'none'; base-uri 'none'; frame-ancestors 'none'");
    if (!flow || req.headers.host !== new URL(origin).host || !req.url?.startsWith('/') || req.url.startsWith('//')) {
      res.writeHead(400).end(); return;
    }
    const url = new URL(req.url, origin);
    if (req.method === 'GET' && url.pathname === '/') {
      page(res, 200, '为 MAGI 连接 ChatGPT 套餐',
        '<p>你在 MAGI 提交问题后，Mac 将使用你授权的套餐请求 GPT 投票，包括该次投票的技术重试。你可以在 OpenAI 的页面选择账号、工作空间和使用权限。</p>' +
        '<p><a class="continue" href="/authorize?start=' + startToken + '" rel="noreferrer">使用 ChatGPT 继续</a></p><p>' + usageLink + '</p>');
      return;
    }
    if (req.method === 'GET' && url.pathname === '/authorize') {
      // A normal browser navigation works even when privacy settings suppress Origin on forms.
      if (url.searchParams.getAll('start').length !== 1 || !sameSecret(startToken, url.searchParams.get('start'))) {
        res.writeHead(303, { Location: '/' }).end(); return;
      }
      res.writeHead(303, { Location: flow.authorize.href }).end(); return;
    }
    if (req.method === 'POST' && url.pathname === '/authorize') {
      if (req.headers.origin === origin) res.writeHead(303, { Location: flow.authorize.href }).end();
      else page(res, 403, '请重新打开授权入口', '<p><a href="/">返回 MAGI，继续授权</a></p>');
      return;
    }
    if (req.method !== 'GET' || url.pathname !== '/auth/callback') { res.writeHead(404).end(); return; }
    if (exchanging || url.searchParams.getAll('state').length !== 1 || !sameSecret(flow.state, url.searchParams.get('state'))) {
      res.writeHead(400).end(); return;
    }
    exchanging = true;
    try {
      const enabled = await flow.finish(url.searchParams);
      page(res, 200, enabled ? 'MAGI 已连接 ChatGPT 套餐' : '已登录，尚未启用套餐用量',
        '<p>' + (enabled ? '授权已保存在运行 MAGI 的电脑上。你可以关闭这个窗口。' : '重新连接时请选择允许 MAGI 使用你的 ChatGPT 套餐。') + '</p><p>' + usageLink + '</p>');
      resolve(enabled);
    } catch (err) {
      page(res, 400, '这次授权未完成', '<p>请返回 MAGI 的本机终端查看结果并重新连接。</p>');
      reject(err instanceof Error ? err : new PlanError('CHATGPT_AUTH_FAILED'));
    }
  });
  server.requestTimeout = 20_000;
  server.headersTimeout = 10_000;
  await new Promise<void>((yes, no) => { server.once('error', no); server.listen(port, '127.0.0.1', yes); });
  try {
    origin = 'http://127.0.0.1:' + (server.address() as AddressInfo).port;
    flow = await plan.begin(origin + '/auth/callback');
  } catch (err) { server.close(); throw err; }
  const timer = setTimeout(() => reject(new PlanError('CHATGPT_LOGIN_TIMED_OUT', 408)), lifetime);
  const close = () => { clearTimeout(timer); server.close(); server.closeIdleConnections(); };
  return { origin, completed: completed.finally(close), close };
}
