// 本地预览与端到端测试用的模拟模型。不会访问任何外部服务。
// 情景由问题文本决定：可以传入「问题 → 情景」映射，或在问题里写标记：
//   [双是] [双否] [分歧]  两家的票      [缺席]  DeepSeek 连接失败
//   [全缺席]  两家首轮都失败，手动技术重试后成功    [致命]  GPT 提出致命风险    [慢]  延长等待
//   [重叠]  联网时两家引用的网站高度重叠
// 联网题的来源只使用保留域名 example.com / .org / .net，不指向真实网站。
const yesReasons = [
  '收益明确且代价可控，先做再按反馈调整更划算。',
  '目标与约束都能满足，主要风险都有对应的检查手段。',
  '这件事可以回退，试错成本低于继续犹豫的机会成本。',
  '关键数字支持这个选择，剩下的不确定性可以边做边验证。',
];
const noReasons = [
  '关键信息仍然缺失，现在决定的代价高于再等一等。',
  '约束条件里有一条大概率会被突破，得不偿失。',
  '收益依赖偏乐观的假设，按保守估计并不划算。',
  '存在更便宜的替代方案，应该先把它排除掉。',
];
const conditionPool = ['先确认合同里的退出条款', '把预算上限写清楚并留出两成余量', '一个月后设定一次复查节点'];
const riskPool = [
  { category: '财务', risk: '实际支出可能比预期高出两到三成。', check: '列出全部费用，向对方索取书面报价。', severity: '高' },
  { category: '时间', risk: '投入的时间会挤占现有的重要安排。', check: '把未来四周的日程排出来核对冲突。', severity: '中' },
  { category: '信息不足', risk: '缺少同类情况下的真实反馈。', check: '找两位有经验的人各聊二十分钟。', severity: '中' },
  { category: '机会成本', risk: '可能错过更合适的时间窗口。', check: '查清下一次机会出现的大致时间。', severity: '低' },
  { category: '关系', risk: '家人可能对这个安排有不同期待。', check: '先和家人把顾虑当面谈清楚。', severity: '高' },
];
const fatalRisk = { category: '法律', risk: '合同可能含有无法撤销的长期义务。', check: '请律师逐条审阅违约与解约条款。', severity: '致命' };
// 联网来源：GPT 默认引用 com、org，DeepSeek 默认引用 net、org（重叠 1/3）；[重叠] 时 DeepSeek 也引用 com（2/3）。
const webPool = {
  com: [
    { url: 'https://www.example.com/notice/2026-11', claim: '公告列出的截止日期为本月 30 日，逾期不再受理。' },
    { url: 'https://www.example.com/help/cancel', claim: '帮助页说明 14 天内可以无理由取消，费用全额退回。' },
  ],
  org: [
    { url: 'https://data.example.org/report/2026', claim: '年度报告显示同类方案的平均费用比去年上涨约 12%。' },
    { url: 'https://data.example.org/stats/2026-q3', claim: '第三季度统计显示需求仍在增长，供给没有明显增加。' },
  ],
  net: [
    { url: 'https://example.net/news/1187', claim: '近期报道称相关政策明年可能调整，但目前没有正式文件。' },
    { url: 'https://forum.example.net/t/4410', claim: '多位用户反馈实际体验与宣传一致，主要抱怨集中在售后响应慢。' },
  ],
};
function webSources(voter, scenario, seed) {
  const sites = voter === 'gpt' ? ['com', 'org'] : scenario.overlap ? ['com', 'org', 'net'] : ['net', 'org'];
  // 同站不同页面：两家各取一页，便于观察「同站计一次」
  return sites.map(site => webPool[site][(seed + (voter === 'gpt' ? 0 : 1)) % webPool[site].length]);
}

// 设置页可选的模拟模型与思考档位
const modelCatalog = {
  gpt: [
    { id: 'simulated-gpt', label: 'GPT（模拟）', efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
    { id: 'simulated-gpt-mini', label: 'GPT Mini（模拟）', efforts: ['none', 'low', 'medium', 'high'] },
  ],
  deepseek: [
    { id: 'simulated-deepseek', label: 'DeepSeek（模拟）', efforts: ['none', 'low', 'high', 'max'] },
    { id: 'simulated-deepseek-flash', label: 'DeepSeek Flash（模拟）', efforts: ['none', 'low', 'high', 'max'] },
  ],
};

const flips = ['如果总成本超过预算上限，我会改投另一边。', '如果拿到可靠的反面证据，我会改票。', '如果时间安排出现无法调和的冲突，我会改票。'];

function hash(text) {
  let h = 2166136261;
  for (const ch of text) h = Math.imul(h ^ ch.codePointAt(0), 16777619) >>> 0;
  return h;
}
const pick = (list, n) => list[n % list.length];

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => { clearTimeout(timer); reject(signal.reason); }, { once: true });
  });
}

export function scenarioFromText(question) {
  const s = {};
  if (question.includes('[双是]')) s.votes = { gpt: '是', deepseek: '是' };
  if (question.includes('[双否]')) s.votes = { gpt: '否', deepseek: '否' };
  if (question.includes('[分歧]')) s.votes = { gpt: '是', deepseek: '否' };
  if (question.includes('[缺席]')) s.absent = ['deepseek'];
  if (question.includes('[全缺席]')) s.failFirstRound = true;
  if (question.includes('[致命]')) s.fatal = true;
  if (question.includes('[慢]')) s.slow = true;
  if (question.includes('[重叠]')) s.overlap = true;
  return s;
}

/**
 * @param {{ delay?: () => [number, number], scenarios?: Map<string, object> }} options
 */
export function createSimulatedProviders(options = {}) {
  const attempts = new Map();
  const delay = options.delay ?? (() => [4000, 9000]);
  const scenarioOf = question => ({ ...scenarioFromText(question), ...(options.scenarios?.get(question) ?? {}) });

  function provider(voter) {
    const initial = { model: 'simulated-' + voter, effort: 'max' };
    return {
      model: initial.model,
      params: { reasoning: { effort: initial.effort } },
      async listModels() { return modelCatalog[voter]; },
      async call(prompt, signal, selection = initial, needsWeb = false) {
        const question = /【问题】(.*)/.exec(prompt)?.[1] ?? '';
        const scenario = scenarioOf(question);
        const key = voter + '\u0000' + question;
        const attempt = (attempts.get(key) ?? 0) + 1;
        attempts.set(key, attempt);
        const [min, max] = delay();
        const seed = hash(voter + question);
        await sleep((scenario.slow ? 25000 : min + (seed % Math.max(1, max - min))) * (attempt > 1 ? 0.5 : 1), signal);
        if (scenario.absent?.includes(voter)) throw new TypeError('fetch failed (simulated)');
        if (scenario.failFirstRound && attempt <= 2) throw new Error('simulated provider outage');
        const vote = scenario.votes?.[voter] ?? (seed % 10 < 7 ? '是' : '否');
        const risks = [];
        if (scenario.fatal && voter === 'gpt') risks.push(fatalRisk);
        const count = 1 + (seed % 3);
        for (let i = 0; i < count && risks.length < 3; i++) risks.push(pick(riskPool, (seed >>> (i * 3)) + i));
        const ballot = {
          vote,
          confidence: 55 + (seed % 40),
          core_reason: vote === '是' ? pick(yesReasons, seed) : pick(noReasons, seed),
          conditions: vote === '是' && seed % 2 === 0 ? [pick(conditionPool, seed >>> 4)] : [],
          risks,
          flip_condition: pick(flips, seed >>> 2),
          sources: needsWeb ? webSources(voter, scenario, seed) : [],
        };
        // 联网时返回本轮「检索到」的网页，后端据此核对 sources
        const webPages = needsWeb ? [...ballot.sources.map(src => src.url), 'https://example.net/about'] : undefined;
        return { raw: JSON.stringify(ballot), model: selection.model, usage: null, complete: true, ...(webPages ? { webPages } : {}) };
      },
    };
  }
  return { gpt: provider('gpt'), deepseek: provider('deepseek') };
}
