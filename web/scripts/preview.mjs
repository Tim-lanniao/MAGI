// 本地预览：真实后端 + 正式前端 + 模拟模型，数据只存在内存里。
// 用法：npm run preview:web  （会先构建后端与前端）
// 打开终端里打印的地址即可免 Passkey 进入；问题文本中的标记见 simulator.mjs。
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { buildApp } from '../../server/dist/src/app.js';
import { readConfig, root } from '../../server/dist/src/config.js';
import { openDb } from '../../server/dist/src/db/index.js';
import { issueSession, cookieOptions, sid } from '../../server/dist/src/auth/session.js';
import { createInvite } from '../../server/dist/src/auth/invite.js';
import { createSimulatedProviders } from './simulator.mjs';

const port = Number(process.env.PREVIEW_PORT ?? 5199);
const seed = !process.argv.includes('--empty');
if (!existsSync(join(root, 'web/dist/index.html'))) {
  console.error('缺少 web/dist/index.html，请先运行 npm run build。');
  process.exit(1);
}

const config = readConfig({
  RP_ID: 'localhost', DB_PATH: ':memory:', PORT: String(port),
  OPENAI_API_KEY: 'preview', OPENAI_MODEL: 'simulated-gpt', OPENAI_REASONING: 'max',
  DEEPSEEK_API_KEY: 'preview', DEEPSEEK_BASE_URL: 'https://deepseek.invalid', DEEPSEEK_MODEL: 'simulated-deepseek', DEEPSEEK_THINKING: 'max',
});

let seeding = false;
const scenarios = new Map();
const providers = createSimulatedProviders({ scenarios, delay: () => (seeding ? [20, 60] : [5000, 12000]) });
const db = openDb(':memory:');
const { app, runner } = await buildApp(config, db, providers, false);

// 预览专用：浏览器无法在 http://localhost 上完成绑定 https://localhost 的 Passkey 验证，
// 因此提供一个仅本机可用的免密入口。正式部署不包含这段代码。
app.get('/__preview/login', async (_req, reply) => {
  const value = issueSession(db, config.SESSION_ABSOLUTE_HOURS);
  reply.setCookie(sid, value, { ...cookieOptions, secure: false, maxAge: config.SESSION_ABSOLUTE_HOURS * 3600 });
  return reply.redirect('/');
});
app.get('/__preview/invite', async (_req, reply) => reply.redirect('/setup?token=' + createInvite(db)));
await app.ready();

if (seed) await seedData();

const server = createServer((req, res) => {
  // 后端要求非 GET 请求的 Origin 精确等于 https://RP_ID；预览走 http，这里在本机改写。
  const origin = req.headers.origin;
  if (origin && /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) req.headers.origin = 'https://localhost';
  app.routing(req, res);
});
server.listen(port, '127.0.0.1', () => {
  console.log('\nMAGI 前端预览已启动（模拟模型，数据仅在内存中）');
  console.log('  免 Passkey 进入：  http://localhost:' + port + '/__preview/login');
  console.log('  登录页：          http://localhost:' + port + '/login');
  console.log('  邀请注册页：      http://localhost:' + port + '/__preview/invite  （仅看界面，http 下无法完成 Passkey 验证）');
  console.log('  问题里写 [双否] [分歧] [缺席] [全缺席] [致命] [慢] [重叠] 可触发对应情景。按 Ctrl-C 结束。\n');
});

async function shutdown() {
  server.close();
  await app.close();
  db.close();
  process.exit(0);
}
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);

// ── 示例数据 ─────────────────────────────────────────
async function seedData() {
  seeding = true;
  const cookie = 'magi_sid=' + issueSession(db, 1);
  const headers = { origin: 'https://localhost', cookie };
  const call = async (method, url, payload) => {
    const res = await app.inject({ method, url: '/api' + url, headers, payload });
    if (res.statusCode >= 400) throw new Error(method + ' ' + url + ' → ' + res.statusCode + ' ' + res.body);
    return res.json();
  };
  const waitSettled = async id => {
    for (let i = 0; i < 200; i++) {
      const d = await call('GET', '/questions/' + id);
      if (d.status !== 'running') return d;
      await new Promise(r => setTimeout(r, 20));
    }
    throw new Error('seed timeout');
  };
  const day = 86_400_000;
  const backdate = (id, daysAgo, decidedAfterMin) => {
    const created = new Date(Date.now() - daysAgo * day);
    db.prepare('UPDATE questions SET created_at=?, decided_at=CASE WHEN decided_at IS NULL THEN NULL ELSE ? END WHERE id=?')
      .run(created.toISOString(), new Date(created.getTime() + decidedAfterMin * 60_000).toISOString(), id);
    return created;
  };
  const ballot = (vote, confidence, core_reason, extra = {}) => ({ vote, confidence, core_reason, conditions: [], risks: [], flip_condition: '', ...extra });

  const seeds = [
    {
      daysAgo: 64, minutes: 3.2,
      question: '是否接受猎头推荐的那份远程工作？',
      background: '现在的公司通勤单程一小时十分钟，薪资三年没有调整。\n新岗位全远程，月薪比现在高 18%，团队在深圳，每季度线下聚一次。\n试用期三个月，期间双方都可以无责解约。',
      goals: '收入不低于现在；每周工作时间不超过 45 小时；保留陪孩子的晚上时间。',
      reversibility: '可逆', scenario: { votes: { gpt: '是', deepseek: '是' } },
      vote: ballot('是', 75, '收入和通勤都明显改善，试用期给了退路。', { risks: [{ category: '职业', risk: '远程工作可能让晋升变慢。', check: '问清团队里远程成员的晋升记录。', severity: '中' }], flip_condition: '如果对方要求试用期内每周到岗三天，我会改票。' }),
      outcome: { correctAnswer: '是', note: '入职三个月，远程协作顺畅，收入提升约 18%。晚上基本都能陪孩子。' },
    },
    {
      daysAgo: 58, minutes: 2.6,
      question: '是否给父母把今年的体检升级到包含胃肠镜的套餐？',
      background: '父母都已六十出头，过去三年只做了基础体检。升级套餐每人多 1600 元，需要提前预约并请一天假陪同。',
      goals: '尽早发现大病隐患；总花费控制在 4000 元以内。',
      reversibility: '可逆', scenario: { votes: { gpt: '是', deepseek: '否' } },
      vote: ballot('是', 80, '年龄到了，胃肠镜的早筛价值远高于费用。'),
      outcome: { correctAnswer: '是', note: '父亲查出两枚小息肉，当场切除，医生说发现得及时。' },
    },
    {
      daysAgo: 37, minutes: 4.1,
      question: '是否在年底前卖掉旧车，改用共享出行？',
      background: '车已经开了九年，今年保养和保险花了 1.1 万元。\n我平时地铁通勤，车主要用于周末带孩子上兴趣班和冬天接送。\n二手车商报价 3.2 万元，年底前成交可以多拿 2000 元补贴。',
      goals: '一年用车相关总支出降到 6000 元以内；冬天接送孩子不能受影响。',
      reversibility: '不可逆', scenario: { votes: { gpt: '否', deepseek: '否' } },
      vote: ballot('是', 60, '养车成本远高于实际使用频率。', { risks: [{ category: '时间', risk: '冬天打车可能要等很久。', check: '查过去一个冬天早高峰的平均等车时间。', severity: '中' }], flip_condition: '如果冬季接送的替代方案不可靠，我会改票。' }),
      confirm: { final: '否', reason: 'adopt_majority', note: '两家都提到冬季接送没有可靠替代。我自己写下的改票条件也确实出现了。' },
      outcome: { correctAnswer: '否', note: '冬天通勤确实离不开车，幸好没卖。明年春天再评估。' },
    },
    {
      daysAgo: 30, minutes: 2.2,
      question: '是否报名明年四月的全程马拉松？',
      background: '今年跑过两次半马，最好成绩 2 小时 05 分。去年夏天右膝有过一次髌腱炎，休息了两个月。',
      goals: '不受伤是第一位；完赛即可，不追求成绩。',
      reversibility: '可逆', scenario: { votes: { gpt: '是', deepseek: '是' } },
      vote: ballot('否', 55, '膝盖旧伤还没完全恢复，全马负荷翻倍。', { flip_condition: '如果运动医学检查确认膝盖没有问题，我会改票。' }),
      confirm: { final: '否', reason: 'keep_mine', note: '膝盖旧伤还没好，宁可保守一年。' },
      outcome: { correctAnswer: '说不清' },
    },
    {
      daysAgo: 9, minutes: 2.9,
      question: '是否把应急基金的一半转去提前偿还房贷本金？',
      background: '应急基金 12 万元，约等于家庭 8 个月开支。房贷利率 3.95%，剩余 22 年。\n提前还款需要提前一个月向银行预约，还款后无法再取出。',
      goals: '降低总利息支出；任何时候都要留够 4 个月的家庭开支。',
      reversibility: '不可逆', scenario: { votes: { gpt: '是', deepseek: '是' }, fatal: true },
      vote: ballot('是', 66, '利率高于理财收益，留六万仍够四个月开支。', { conditions: ['工作收入在未来半年内保持稳定'] }),
    },
    {
      daysAgo: 4, minutes: 3.5,
      question: '是否本周就和合伙人摊牌，提出退出共同项目？',
      background: '项目做了一年半，收入一直没有覆盖成本，我每月个人贴补约 3000 元。合伙人仍然看好，计划明年再融资一轮。\n我们之间没有签退出协议，只有一份口头约定。',
      goals: '止损；尽量保住多年的朋友关系；在三个月内把精力转回主业。',
      reversibility: '可逆', scenario: { votes: { gpt: '否' }, absent: ['deepseek'] },
      vote: ballot('是', 70, '持续贴补没有尽头，越早说清楚越好。', { flip_condition: '如果合伙人能拿出明确的盈利时间表，我会改票。' }),
    },
    {
      daysAgo: 2, minutes: 3.8, needsWeb: true,
      question: '是否趁本月的以旧换新补贴换掉家里的旧冰箱？',
      background: '冰箱用了 13 年，夏天压缩机几乎不停，电费比邻居同户型高约 40 元/月。\n本月以旧换新补贴为售价的 15%，最高 2000 元，看中的型号到手约 5200 元。',
      goals: '三年内总花费（含电费）不高于继续用旧冰箱；不影响日常使用。',
      reversibility: '可逆', scenario: { votes: { gpt: '是', deepseek: '是' }, overlap: true },
      vote: ballot('是', 70, '补贴力度大，旧冰箱耗电高，三年能回本。', { flip_condition: '如果补贴需要额外条件才能拿到，我会改票。' }),
    },
    {
      daysAgo: 1, minutes: 0,
      question: '是否续订那套按年付费的设计软件？',
      background: '年费 2388 元，过去一年实际用了四个月。免费替代品能覆盖大约八成需求。',
      goals: '工具支出每年不超过 1500 元。',
      reversibility: '可逆', scenario: { failFirstRound: true },
      vote: ballot('否', 72, '使用频率太低，替代品基本够用。'),
    },
    {
      daysAgo: 0.2, minutes: 4.4,
      question: '是否在下个学期让孩子转到离家更近的公立学校？',
      background: '孩子现在读三年级，在一所民办学校，单程通勤 50 分钟，每天早上 6 点 40 分出门。学费每年 4.6 万元。\n离家 800 米的公立学校今年新换了校长，学区内口碑中上，三年级还有两个插班名额，需要在下月 15 日前提交申请。\n孩子在现在的学校有两个很要好的朋友，转学时会舍不得。班主任评价孩子适应能力不错，成绩在班里中等偏上。\n家里的考虑是：省下的通勤时间可以用来睡觉和运动；学费省下来也能覆盖兴趣班。顾虑是公立学校班额较大，英语课时比现在少。',
      goals: '孩子每天睡够 9 小时；教育支出每年控制在 3 万元以内；转学过程中孩子的情绪要照顾好。',
      reversibility: '不可逆', needsWeb: true, scenario: { votes: { gpt: '是', deepseek: '是' } },
      vote: ballot('是', 68, '睡眠和通勤的改善是确定的，学业差异可以补。', { risks: [{ category: '关系', risk: '孩子会和现在的好朋友分开。', check: '约好每月周末见一次朋友。', severity: '中' }], flip_condition: '如果孩子明确强烈反对，我会改票。' }),
    },
  ];

  for (const s of seeds) {
    scenarios.set(s.question, s.scenario);
    const created = await call('POST', '/questions', {
      question: s.question, background: s.background, goals: s.goals, reversibility: s.reversibility,
      needsWeb: s.needsWeb ?? false, acknowledgeWarnings: true, userVote: s.vote,
    });
    let detail = await waitSettled(created.id);
    if (detail.status === 'paused' && s.daysAgo > 10) {
      for (const id of detail.result.pausedBy) await call('POST', '/questions/' + created.id + '/checks/' + id, { done: true });
      detail = await call('GET', '/questions/' + created.id);
    }
    if (s.confirm && detail.status === 'needs_confirmation') await call('POST', '/questions/' + created.id + '/confirm', s.confirm);
    if (s.outcome) await call('POST', '/questions/' + created.id + '/outcome', s.outcome);
    const when = backdate(created.id, s.daysAgo, s.minutes);
    if (s.outcome) db.prepare('UPDATE outcomes SET recorded_at=? WHERE question_id=?').run(new Date(when.getTime() + 20 * 86_400_000).toISOString(), created.id);
  }
  await runner.idle();
  seeding = false;
}
