// 正式前端的端到端测试：本地 HTTPS、虚拟 Passkey 验证器、模拟模型，全程走真实后端与 web/dist。
// 用法：MAGI_BROWSER="<Chrome 或 Edge 可执行文件>" npm run test:web
// 可选：MAGI_SHOTS=<目录> 保存桌面与手机截图；MAGI_TEST_OPENSSL 指定 OpenSSL 路径。
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, createPublicKey } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { buildApp } from '../../server/dist/src/app.js';
import { readConfig, root } from '../../server/dist/src/config.js';
import { openDb } from '../../server/dist/src/db/index.js';
import { createInvite } from '../../server/dist/src/auth/invite.js';
import { createSimulatedProviders } from './simulator.mjs';

if (!process.env.MAGI_BROWSER) throw new Error('设置 MAGI_BROWSER 为本机 Chrome 或 Edge 的可执行文件路径。');
if (!existsSync(join(root, 'web/dist/index.html'))) throw new Error('缺少 web/dist，请先运行 npm run build。');
const shots = process.env.MAGI_SHOTS;
if (shots) await mkdir(shots, { recursive: true });

const dir = await mkdtemp(join(tmpdir(), 'magi-web-e2e-'));
const db = openDb(':memory:');
const config = readConfig({
  RP_ID: 'magi.test', OPENAI_API_KEY: 'test', OPENAI_MODEL: 'test', OPENAI_REASONING: 'max',
  DEEPSEEK_API_KEY: 'test', DEEPSEEK_MODEL: 'test', DEEPSEEK_THINKING: 'max', DEEPSEEK_BASE_URL: 'https://deepseek.test',
});
const { app } = await buildApp(config, db, createSimulatedProviders({ delay: () => [700, 1500] }), false);

let tls, browser;
const problems = [];
let passed = 0;
async function step(name, fn) {
  const started = Date.now();
  await fn();
  passed += 1;
  console.log('  ✓ ' + name + ' (' + (Date.now() - started) + 'ms)');
}

try {
  const key = join(dir, 'key.pem'), cert = join(dir, 'cert.pem');
  execFileSync(process.env.MAGI_TEST_OPENSSL || 'openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes',
    '-keyout', key, '-out', cert, '-days', '1', '-subj', '/CN=magi.test', '-addext', 'subjectAltName=DNS:magi.test'], { stdio: 'pipe' });
  const certPem = await readFile(cert);
  const spki = createHash('sha256').update(createPublicKey(certPem).export({ format: 'der', type: 'spki' })).digest('base64');
  await app.ready();
  tls = createServer({ key: await readFile(key), cert: certPem }, app.routing);
  await new Promise((ok, fail) => { tls.once('error', fail); tls.listen(0, '127.0.0.1', ok); });
  browser = await chromium.launch({
    executablePath: process.env.MAGI_BROWSER, headless: true, chromiumSandbox: true,
    args: ['--no-proxy-server', '--host-resolver-rules=MAP magi.test 127.0.0.1:' + tls.address().port, '--ignore-certificate-errors-spki-list=' + spki],
  });
  const context = await browser.newContext({ locale: 'zh-CN', viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  // 预期内的 4xx（未登录、倾向词确认、重复提交、限流）会被浏览器记为资源加载失败，其余错误一律视为问题。
  const expected = /Failed to load resource: the server responded with a status of (401|404|409|422|429)/;
  const missingRecord = '01M7R0TE0TQCJ2PTC2KBTKMP80'; // 测试里故意访问的不存在表决
  page.on('response', res => { if (res.status() === 404 && !res.url().includes(missingRecord)) problems.push('404: ' + res.url()); });
  page.on('console', msg => { if (msg.type() === 'error' && !expected.test(msg.text())) problems.push('console: ' + msg.text()); });
  page.on('pageerror', err => problems.push('pageerror: ' + err.message));
  const devtools = await context.newCDPSession(page);
  await devtools.send('WebAuthn.enable');
  await devtools.send('WebAuthn.addVirtualAuthenticator', { options: {
    protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true,
  } });
  const shot = async name => { if (shots) await page.screenshot({ path: join(shots, name + '.png'), fullPage: true }); };
  const dialog = () => page.getByRole('dialog');
  const nav = name => page.getByRole('navigation', { name: '主导航' }).getByRole('link', { name });

  console.log('MAGI 前端端到端测试');

  await step('邀请链接注册 Passkey，并从地址栏移除令牌', async () => {
    await page.goto('https://magi.test/setup?token=' + createInvite(db));
    await page.getByRole('heading', { name: '注册 Passkey' }).waitFor();
    assert.equal(new URL(page.url()).search, '');
    await page.getByLabel('设备名称').fill('测试浏览器');
    await page.getByRole('button', { name: '注册这台设备的 Passkey' }).click();
    await page.getByRole('heading', { name: '注册完成' }).waitFor();
  });

  await step('用刚注册的 Passkey 登录，会话 cookie 安全属性正确', async () => {
    await page.getByRole('button', { name: '用刚注册的 Passkey 登录' }).click();
    await page.getByRole('heading', { name: '新决策' }).waitFor();
    const session = (await context.cookies()).find(c => c.name === 'magi_sid');
    assert.ok(session?.httpOnly && session.secure && session.sameSite === 'Strict');
  });

  await step('表单校验：空提交定位到首个缺失字段', async () => {
    await page.getByRole('button', { name: '开始表决' }).click();
    await page.getByText('请写下要表决的问题。').first().waitFor();
    await page.getByText('请先投下你自己的一票。').first().waitFor();
    await page.waitForFunction(() => document.activeElement?.id === 'f-question');
  });

  const material = {
    question: '是否在下个月把团队周会改为隔周一次？[双否]',
    background: '团队 8 人，周会每次 90 分钟。\n我觉得最近两个月周会的有效讨论不到一半时间。',
    goals: '信息同步不变差；每人每月节省至少 3 小时。',
  };
  async function fillMaterial(irreversible) {
    await page.getByLabel('要表决的问题').fill(material.question);
    await page.getByLabel('背景').fill(material.background);
    await page.getByLabel('目标与约束').fill(material.goals);
    await page.locator('.choice-card', { hasText: irreversible ? '不可逆' : /^可逆$/ }).click();
  }

  await step('实时提示倾向词，草稿自动保存并在刷新后恢复', async () => {
    await fillMaterial(true);
    await page.locator('.lint-box mark', { hasText: '我觉得' }).waitFor();
    await page.locator('.vote-yes').click();
    await page.getByLabel('核心理由').fill('会议时间过长，隔周足以同步信息。');
    await page.waitForTimeout(600);
    await page.reload();
    await page.getByText('已恢复草稿。').waitFor();
    assert.equal(await page.getByLabel('要表决的问题').inputValue(), material.question);
    assert.ok(await page.locator('.vote-yes input').isChecked());
  });

  let firstId;
  await step('提交前确认倾向词，锁票后进入等待页', async () => {
    await page.getByRole('button', { name: '添加风险' }).click();
    await page.getByLabel('风险 1 类别').selectOption('关系');
    await page.getByLabel('风险 1 严重度').selectOption('致命');
    await page.getByText('表决后将先停机检查').waitFor();
    await page.getByLabel('风险 1 描述').fill('核心成员可能因此离职。');
    await page.getByLabel('风险 1 检查动作').fill('先和两位核心成员单独沟通。');
    await page.getByLabel('改票条件').fill('如果有人明确反对，我会改票。');
    await page.getByRole('button', { name: '开始表决' }).click();
    await dialog().getByText('背景里有倾向性措辞').waitFor();
    await shot('desktop-lint-dialog');
    await dialog().getByRole('button', { name: '仍然提交' }).click();
    await page.waitForURL(/\/q\/[0-9A-Z]{26}$/);
    firstId = page.url().split('/').pop();
    await page.getByRole('heading', { name: '等待揭晓' }).waitFor();
    assert.equal(await page.locator('.seat-model').count(), 0, '揭晓前不显示模型名');
    await shot('desktop-waiting');
  });

  await step('揭晓后进入停机检查，逐条完成致命风险检查', async () => {
    await page.getByRole('heading', { name: '停机检查' }).waitFor({ timeout: 20000 });
    await page.getByText('已完成 0 / 1').waitFor();
    await shot('desktop-paused');
    await page.getByRole('button', { name: '已完成检查' }).click();
    await dialog().getByRole('button', { name: '已完成' }).click();
    await page.getByRole('heading', { name: '需要你来定' }).waitFor();
  });

  await step('少数派本人确认：采纳多数意见并留下备注', async () => {
    await page.getByText('GPT 和 DeepSeek 都投了「否」').waitFor();
    await page.locator('.self-reminder').getByText('如果有人明确反对，我会改票。').waitFor();
    await shot('desktop-confirm');
    await page.locator('.choice-card', { hasText: '采纳多数意见' }).click();
    await page.getByLabel('备注').fill('两家都提到信息同步风险，先保持每周一次。');
    await page.getByRole('button', { name: '确认最终答案' }).click();
    await page.getByRole('heading', { name: '否，不做' }).waitFor();
    await page.getByText('你确认：采纳多数意见').waitFor();
    await page.getByText('已完成 1 项停机检查').waitFor();
    // 揭晓后两家席位显示标志与实际使用的模型
    assert.equal(await page.locator('.seat-gpt .seat-model').textContent(), 'simulated-gpt');
    assert.equal(await page.locator('.seat-deepseek .seat-model').textContent(), 'simulated-deepseek');
    assert.equal(await page.locator('.seat-gpt svg.seat-logo, .seat-deepseek svg.seat-logo').count(), 2);
    await page.locator('.vote-card .model-name', { hasText: 'simulated-gpt' }).waitFor();
    assert.equal(await page.locator('#sources-title, .meta-web, .source-list').count(), 0, '离线题不显示联网信息');
    await page.getByRole('heading', { name: '少数派理由' }).waitFor();
  });

  await step('记录事后复盘并显示各方对错', async () => {
    await page.locator('.segment-no').click();
    await page.getByLabel('复盘笔记').fill('维持周会两个月后，项目延期次数下降。');
    await page.getByRole('button', { name: '保存复盘' }).click();
    await page.locator('.outcome-answer').waitFor();
    await page.locator('.scoreboard .is-wrong', { hasText: '我' }).waitFor();
    await page.locator('.scoreboard .is-right', { hasText: 'GPT' }).waitFor();
    await shot('desktop-decided');
  });

  await step('相同材料重复提交时提示并打开已有表决', async () => {
    await nav('新决策').click();
    await fillMaterial(true);
    await page.locator('.vote-no').click();
    await page.getByLabel('核心理由').fill('换一张票也不应重新表决。');
    await page.getByRole('button', { name: '开始表决' }).click();
    await dialog().getByRole('button', { name: '仍然提交' }).click();
    await dialog().getByText('这组材料已经表决过').waitFor();
    await dialog().getByRole('button', { name: '打开已有表决' }).click();
    await page.waitForURL('**/q/' + firstId);
    await page.getByRole('heading', { name: '否，不做' }).waitFor();
    await page.goto('https://magi.test/');
    await page.getByRole('button', { name: '清空草稿' }).click();
    await dialog().getByRole('button', { name: '清空' }).click();
    await page.waitForFunction(() => document.querySelector('#f-question')?.value === '');
  });

  await step('带新信息追问：材料带入、要求至少十字新增信息', async () => {
    await page.goto('https://magi.test/q/' + firstId);
    await page.getByRole('link', { name: '带新信息追问' }).click();
    await page.getByRole('heading', { name: '带新信息追问' }).waitFor();
    assert.equal(await page.getByLabel('要表决的问题').inputValue(), material.question);
    await page.getByLabel('新增信息').fill('太短了');
    await page.locator('.vote-yes').click();
    await page.getByLabel('核心理由').fill('新增信息显示会议效率已改善。');
    await page.getByRole('button', { name: '开始表决' }).click();
    await page.getByText('新增信息至少需要 10 个字').first().waitFor();
    await page.getByLabel('新增信息').fill('新的会议纪要模板上线后，平均会议时长降到 50 分钟。');
    await page.getByRole('button', { name: '开始表决' }).click();
    await dialog().getByRole('button', { name: '仍然提交' }).click();
    await page.getByRole('heading', { name: '等待揭晓' }).waitFor();
    await page.getByRole('link', { name: '追问自原表决' }).waitFor();
    await page.locator('.material-new').getByText('新的会议纪要模板').waitFor();
  });

  await step('可逆问题的缺席与平票：DeepSeek 缺席时需要本人确认', async () => {
    await nav('新决策').click();
    await page.getByLabel('要表决的问题').fill('是否本周就更换团队的文档工具？[缺席][双否]');
    await page.getByLabel('背景').fill('现有工具每人每月 40 元，迁移需要两天。');
    await page.locator('.choice-card', { hasText: /^可逆$/ }).click();
    await page.locator('.vote-yes').click();
    await page.getByLabel('核心理由').fill('新工具更便宜，迁移成本可控。');
    await page.getByRole('button', { name: '开始表决' }).click();
    await page.getByRole('heading', { name: '需要你来定' }).waitFor({ timeout: 20000 });
    await page.getByText('DeepSeek 缺席').first().waitFor();
    await page.locator('.confirm-panel').getByText('票数打平').waitFor();
    await page.locator('.vote-card.is-absent').getByText('无法连接服务商').waitFor();
    await page.locator('.seat-deepseek.is-absent .seat-model', { hasText: 'simulated-deepseek' }).waitFor();
  });

  await step('两家都缺席时显示原因，技术重试后完成表决', async () => {
    await nav('新决策').click();
    await page.getByLabel('要表决的问题').fill('是否续订现在的云存储套餐？[全缺席][双是]');
    await page.locator('.choice-card', { hasText: /^可逆$/ }).click();
    await page.locator('.vote-yes').click();
    await page.getByLabel('核心理由').fill('容量仍然不够用。');
    await page.getByRole('button', { name: '开始表决' }).click();
    await page.getByRole('heading', { name: '两家均缺席' }).waitFor({ timeout: 20000 });
    await page.getByText('服务商出错').first().waitFor();
    await shot('desktop-failed');
    await page.getByRole('button', { name: '重新请求两家' }).click();
    await page.getByRole('heading', { name: '是，去做' }).waitFor({ timeout: 20000 });
  });

  let webId;
  await step('联网题：开关默认关闭，结果显示来源并标注信源重叠', async () => {
    await nav('新决策').click();
    await page.getByLabel('要表决的问题').fill('是否趁本月补贴换掉旧冰箱？[双是][重叠]');
    await page.locator('.choice-card', { hasText: /^可逆$/ }).click();
    const web = page.getByRole('switch', { name: '需要联网' });
    assert.equal(await web.isChecked(), false, '需要联网默认关闭');
    await page.locator('.switch').click();
    assert.equal(await web.isChecked(), true);
    await page.locator('.vote-yes').click();
    await page.getByLabel('核心理由').fill('补贴力度大，旧冰箱耗电高。');
    // 本人来源：网址不完整时拦截，改正后随票提交
    await page.getByRole('button', { name: '添加来源' }).click();
    await page.getByLabel('来源 1 网址').fill('example.com/notice');
    await page.getByLabel('来源 1 论点').fill('公告列出的补贴截止日期为本月 30 日。');
    await page.getByRole('button', { name: '开始表决' }).click();
    await page.getByText('第 1 条来源的网址需以 http:// 或 https:// 开头').first().waitFor();
    await shot('desktop-ask-source');
    await page.getByLabel('来源 1 网址').fill('https://www.example.com/notice/2026-11');
    await page.getByRole('button', { name: '开始表决' }).click();
    await page.waitForURL(/\/q\/[0-9A-Z]{26}$/);
    webId = page.url().split('/').pop();
    const mine = page.locator('.vote-card').first();
    await mine.locator('.source-claim', { hasText: '公告列出的补贴截止日期为本月 30 日。' }).waitFor();
    await page.locator('.meta-web').waitFor();
    await page.getByRole('heading', { name: '是，去做' }).waitFor({ timeout: 20000 });
    await page.locator('.how-overlap', { hasText: '两方信源重叠，独立性低' }).waitFor();
    await page.getByRole('heading', { name: '信源对比' }).waitFor();
    assert.equal(await page.locator('.overlap-num').textContent(), '2 / 3');
    assert.deepEqual(await page.locator('.overlap-sites li').allTextContents(), ['example.com', 'example.org']);
    const links = page.locator('.vote-card .source-link');
    assert.equal(await links.count(), 6);
    for (const text of await links.allTextContents()) assert.match(text, /^(?:[a-z]+\.)?example\.(?:com|org|net)$/, '站点名完整：' + text);
    assert.equal(await links.first().getAttribute('rel'), 'noopener noreferrer');
    assert.equal(await page.locator('.vote-card .source.is-shared').count(), 4);
    assert.equal(await mine.locator('.source.is-shared').count(), 0, '本人来源不参与信源对比');
    await shot('desktop-web');
  });

  await step('记录页分组列出全部表决并标出待处理项', async () => {
    await nav('记录').click();
    await page.getByRole('heading', { name: '记录' }).waitFor();
    await page.waitForFunction(() => document.querySelectorAll('.history-item').length === 5);
    assert.equal(await page.locator('.history-item:not(.is-decided)').count(), 2);
    await page.locator('.history-item', { hasText: '团队周会' }).first().waitFor();
    await shot('desktop-history');
  });

  await step('统计页显示准确率、置信度校准与数据表', async () => {
    await nav('统计').click();
    await page.getByRole('heading', { name: '置信度校准' }).waitFor();
    const tiles = await page.locator('.stat-tile .stat-value').allTextContents();
    assert.deepEqual(tiles, ['0%', '100%', '100%']);
    await page.locator('.chart-svg .series-dot').first().waitFor();
    await page.getByText('查看数据表').click();
    await page.locator('.data-table').waitFor();
    await shot('desktop-stats');
  });

  await step('设置页切换模型与思考强度，刷新后保留', async () => {
    await nav('设置').click();
    await page.getByRole('heading', { name: '设置', exact: true }).waitFor();
    const gptModel = page.getByLabel('GPT 模型');
    await gptModel.waitFor();
    assert.equal(await gptModel.inputValue(), 'simulated-gpt');
    assert.equal(await page.getByLabel('GPT 思考强度').inputValue(), 'max');
    const save = page.locator('.model-form').getByRole('button', { name: '保存' });
    assert.ok(await save.isDisabled(), '未改动时不能保存');
    await gptModel.selectOption('simulated-gpt-mini');
    // 新模型不支持「最高」，自动换成它支持的最高一档
    assert.equal(await page.getByLabel('GPT 思考强度').inputValue(), 'high');
    await page.getByLabel('DeepSeek 思考强度').selectOption('low');
    await save.click();
    await page.locator('.toast', { hasText: '已保存' }).waitFor();
    await shot('desktop-settings');
    await page.reload();
    await page.getByLabel('GPT 模型').waitFor();
    assert.equal(await page.getByLabel('GPT 模型').inputValue(), 'simulated-gpt-mini');
    assert.equal(await page.getByLabel('GPT 思考强度').inputValue(), 'high');
    assert.equal(await page.getByLabel('DeepSeek 思考强度').inputValue(), 'low');
  });

  await step('设置页重命名 Passkey，最后一个凭证不可删除', async () => {
    await page.getByText('测试浏览器').waitFor();
    await page.getByText('测试浏览器').waitFor();
    await page.getByRole('button', { name: '重命名 测试浏览器' }).click();
    await page.getByLabel('设备名称').fill('测试浏览器（Edge）');
    await page.locator('.cred-edit').getByRole('button', { name: '保存' }).click();
    await page.getByText('测试浏览器（Edge）').waitFor();
    assert.ok(await page.getByRole('button', { name: '删除 测试浏览器（Edge）' }).isDisabled());
    await page.getByText('只有一个 Passkey').waitFor();
  });

  await step('会话失效时回到登录页并提示，重新登录后返回原页面', async () => {
    db.exec('DELETE FROM sessions');
    await nav('统计').click();
    await page.getByText('登录已过期，请重新用 Passkey 登录。').waitFor();
    assert.match(page.url(), /\/login\?next=%2Fstats$/);
    await shot('desktop-login');
    await page.getByRole('button', { name: '用 Passkey 登录' }).click();
    await page.getByRole('heading', { name: '统计' }).waitFor();
  });

  await step('退出登录后受保护页面跳转到登录页', async () => {
    await nav('设置').click();
    await page.getByRole('button', { name: '退出登录' }).click();
    await page.getByRole('heading', { name: '登录 MAGI' }).waitFor();
    await page.goto('https://magi.test/history');
    await page.getByRole('heading', { name: '登录 MAGI' }).waitFor();
    await page.getByRole('button', { name: '用 Passkey 登录' }).click();
    await page.getByRole('heading', { name: '记录' }).waitFor();
  });

  await step('不存在的表决与未知页面显示空状态', async () => {
    await page.goto('https://magi.test/q/' + missingRecord);
    await page.getByRole('heading', { name: '找不到这条记录' }).waitFor();
    await page.goto('https://magi.test/nothing-here');
    await page.getByRole('heading', { name: '页面不存在' }).waitFor();
  });

  await step('手机视口：底部导航、表单与结果页布局', async () => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('https://magi.test/q/' + firstId);
    await page.getByRole('heading', { name: '否，不做' }).waitFor();
    const nav = await page.locator('.app-nav').boundingBox();
    assert.ok(nav && nav.y > 700, '底部导航应固定在视口底部');
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    assert.equal(overflow, 0, '手机上不应出现横向滚动');
    await shot('mobile-decided');
    for (const [path, name, heading] of [['/', 'mobile-ask', '新决策'], ['/history', 'mobile-history', '记录'], ['/stats', 'mobile-stats', '统计'], ['/settings', 'mobile-settings', '设置'], ['/q/' + webId, 'mobile-web', '是，去做']]) {
      await page.goto('https://magi.test' + path);
      await page.getByRole('heading', { name: heading, exact: true }).waitFor();
      await page.waitForTimeout(300);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth), 0, path + ' 不应横向滚动');
      await shot(name);
    }
  });

  assert.deepEqual(problems, [], '浏览器控制台不应出现错误或 CSP 拦截');
  console.log('通过 ' + passed + ' 项。浏览器版本 ' + browser.version() + (shots ? '，截图保存在 ' + shots : ''));
} catch (err) {
  if (problems.length) console.error('浏览器报告：\n  ' + problems.join('\n  '));
  throw err;
} finally {
  await browser?.close();
  if (tls?.listening) { tls.closeAllConnections(); await new Promise(resolve => tls.close(resolve)); }
  await app.close();
  db.close();
  await rm(dir, { recursive: true, force: true });
}
