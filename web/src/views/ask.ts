import { api, ApiError, errorMessage, isAbort } from '../api';
import { autosize, charCount, debounce, h, nextId, storage, type Child } from '../dom';
import { confidenceWord, formatDate, relativeTime, statusLabel } from '../format';
import { icon } from '../icons';
import { navigate, type RouteContext } from '../router';
import {
  CATEGORIES, SEVERITIES, type Answer, type Ballot, type Category, type Detail, type HistoryItem, type LintWarning,
  type Reversibility, type Risk, type Severity, type Submission,
} from '../types';
import { errorState, loadingPage, notice, openDialog, pageHeader, seal, statusChip, withBusy } from '../ui';

interface DraftRisk { category: Category | ''; severity: Severity | ''; risk: string; check: string }
interface DraftSource { url: string; claim: string }
interface Draft {
  question: string;
  background: string;
  goals: string;
  reversibility: Reversibility | '';
  needsWeb: boolean;
  newInfo: string;
  vote: Answer | '';
  confidence: number;
  core_reason: string;
  conditions: string[];
  risks: DraftRisk[];
  flip_condition: string;
  sources: DraftSource[];
}

const LIMIT_REASON = 50;
const LIMIT_RISK = 40;
const MAX_RISKS = 3;
const LIMIT_CLAIM = 300;
const MAX_SOURCES = 8;

const emptyDraft = (): Draft => ({
  question: '', background: '', goals: '', reversibility: '', needsWeb: false, newInfo: '',
  vote: '', confidence: 70, core_reason: '', conditions: [], risks: [], flip_condition: '', sources: [],
});

/** 与后端一致：http(s) 完整网址，不含空白、反斜杠和账号密码。 */
function validSourceUrl(raw: string) {
  if (raw.length > 4096 || !/^https?:\/\//i.test(raw) || /[\s\\]/u.test(raw)) return false;
  try {
    const url = new URL(raw);
    return Boolean(url.hostname) && !url.username && !url.password;
  } catch {
    return false;
  }
}

const fieldNames: Record<string, string> = {
  question: '问题', background: '背景', goals: '目标与约束', reversibility: '可逆性', newInfo: '新增信息', parentId: '追问对象',
  'userVote.vote': '你的票', 'userVote.confidence': '置信度', 'userVote.core_reason': '核心理由',
  'userVote.conditions': '前提条件', 'userVote.risks': '风险', 'userVote.flip_condition': '改票条件', 'userVote.sources': '来源',
};
function translateFields(message: string) {
  return message.replace(/userVote\.[a-z_]+(?:\.\d+(?:\.[a-z_]+)?)?|question|background|goals|reversibility|newInfo|parentId/g, m => {
    const base = m.replace(/\.\d+.*$/, '');
    return fieldNames[base] ?? m;
  });
}

function loadDraft(key: string): Draft | null {
  const saved = storage.get<Partial<Draft>>(key);
  if (!saved || typeof saved !== 'object') return null;
  const base = emptyDraft();
  return {
    ...base, ...saved,
    needsWeb: saved.needsWeb === true,
    conditions: Array.isArray(saved.conditions) ? saved.conditions.filter(c => typeof c === 'string') : [],
    risks: Array.isArray(saved.risks) ? saved.risks.slice(0, MAX_RISKS) : [],
    sources: Array.isArray(saved.sources)
      ? saved.sources.filter(s => s && typeof s.url === 'string' && typeof s.claim === 'string').slice(0, MAX_SOURCES)
      : [],
    confidence: Number.isInteger(saved.confidence) && saved.confidence! >= 50 && saved.confidence! <= 100 ? saved.confidence! : 70,
  };
}

const hasContent = (d: Draft) => Boolean(d.question.trim() || d.background.trim() || d.goals.trim() || d.core_reason.trim() || d.newInfo.trim());

export function askView(ctx: RouteContext) {
  const parentId = ctx.query.get('parent');
  const page = h('div', { class: 'page page-ask' });
  if (!parentId) {
    ctx.setTitle('新决策');
    page.append(buildAsk(ctx, null));
    return page;
  }
  ctx.setTitle('带新信息追问');
  const load = () => {
    page.replaceChildren(loadingPage('正在载入原表决…'));
    api.detail(parentId, ctx.signal).then(parent => {
      if (parent.status !== 'decided') {
        page.replaceChildren(pageHeader({ title: '暂时不能追问', back: { href: '/q/' + parent.id, label: '返回原表决' } }),
          notice('warn', '只能对已经决定的表决追问。当前状态：' + statusLabel[parent.status] + '。'));
        return;
      }
      page.replaceChildren(buildAsk(ctx, parent));
    }).catch(err => {
      if (isAbort(err)) return;
      page.replaceChildren(errorState(err, load));
    });
  };
  load();
  return page;
}

function buildAsk(ctx: RouteContext, parent: Detail | null) {
  const draftKey = parent ? 'magi:draft:follow:' + parent.id : 'magi:draft:new';
  const draft: Draft = loadDraft(draftKey) ?? (parent ? {
    ...emptyDraft(), question: parent.question, background: parent.background, goals: parent.goals, reversibility: parent.reversibility,
  } : emptyDraft());

  let lintWarnings: LintWarning[] = [];
  let acknowledged = false;
  const errors = new Map<string, HTMLElement>();

  const savedNote = h('span', { class: 'draft-state', 'aria-live': 'polite' });
  // 提交成功或清空后不再写入草稿，避免延迟的保存把它写回来。
  let finished = false;
  const save = () => {
    if (finished || !(hasContent(draft) || draft.vote)) return;
    storage.set(draftKey, draft);
    savedNote.textContent = '草稿已保存';
  };
  const persist = debounce(save, 400);
  ctx.signal.addEventListener('abort', () => { persist.cancel(); save(); });
  const discardDraft = () => {
    finished = true;
    persist.cancel();
    storage.remove(draftKey);
  };
  const changed = () => {
    savedNote.textContent = '';
    persist();
  };

  // ── 字段构造 ─────────────────────────────────────────
  function errorSlot(key: string) {
    const el = h('p', { class: 'field-error', id: 'err-' + key, hidden: true });
    errors.set(key, el);
    return el;
  }
  function counter(value: string, limit: number) {
    const el = h('span', { class: 'counter', 'aria-live': 'off' });
    const update = (v: string) => {
      const n = charCount(v);
      el.textContent = n + ' / ' + limit;
      el.classList.toggle('over', n > limit);
    };
    update(value);
    return { el, update };
  }

  function textArea(opts: { key: keyof Draft; label: string; hint?: Child; placeholder?: string; rows?: number; required?: boolean; long?: boolean }) {
    const id = 'f-' + String(opts.key);
    const area = h('textarea', {
      id, class: ['input', 'textarea', opts.long ? 'textarea-long' : ''], rows: String(opts.rows ?? 3),
      placeholder: opts.placeholder, 'aria-describedby': 'err-' + String(opts.key) + (opts.hint ? ' hint-' + String(opts.key) : ''),
    });
    area.value = String(draft[opts.key] ?? '');
    autosize(area);
    area.addEventListener('input', () => {
      (draft[opts.key] as string) = area.value;
      clearError(String(opts.key));
      changed();
    });
    const wrap = h('div', { class: 'field' },
      h('div', { class: 'label-row' }, h('label', { class: 'label', for: id }, opts.label, opts.required ? h('span', { class: 'req', 'aria-hidden': 'true' }, '必填') : null)),
      opts.hint ? h('p', { class: 'hint', id: 'hint-' + String(opts.key) }, opts.hint) : null,
      area, errorSlot(String(opts.key)));
    return { wrap, area };
  }

  function clearError(key: string) {
    const el = errors.get(key);
    if (el && !el.hidden) {
      el.hidden = true;
      el.closest('.field, fieldset')?.classList.remove('has-error');
    }
  }
  function setError(key: string, message: string) {
    const el = errors.get(key);
    if (!el) return;
    el.textContent = message;
    el.hidden = false;
    el.closest('.field, fieldset')?.classList.add('has-error');
  }

  // ── 问题材料（发送给两家模型） ─────────────────────────
  const newInfoField = parent ? textArea({
    key: 'newInfo', label: '新增信息', required: true, rows: 4, long: true,
    placeholder: '上次表决后出现的新事实，至少 10 字',
  }) : null;
  const questionField = textArea({
    key: 'question', label: '要表决的问题', required: true, rows: 2,
    placeholder: '例如：是否在今年内接受这份新工作？',
  });
  questionField.area.classList.add('textarea-question');
  questionField.area.setAttribute('enterkeyhint', 'next');

  const backgroundField = textArea({
    key: 'background', label: '背景', rows: 7, long: true,
    placeholder: '现状、数字、时间点等事实',
  });
  const lintBox = h('div', { class: 'lint-box', 'aria-live': 'polite' });
  backgroundField.wrap.append(lintBox);

  const goalsField = textArea({
    key: 'goals', label: '目标与约束', rows: 3, long: true,
    placeholder: '想达到什么，哪些结果不能接受',
  });

  const revId = nextId('rev');
  const revField = h('fieldset', { class: 'field fieldset', 'aria-describedby': 'err-reversibility' },
    h('legend', { class: 'label' }, '可逆性', h('span', { class: 'req', 'aria-hidden': 'true' }, '必填')),
    h('div', { class: 'choice-cards' },
      (['可逆', '不可逆'] as const).map(value => {
        const input = h('input', { type: 'radio', name: revId, value, class: 'visually-hidden', checked: draft.reversibility === value });
        input.addEventListener('change', () => {
          draft.reversibility = value;
          clearError('reversibility');
          updateFatalHints();
          changed();
        });
        return h('label', { class: ['choice-card', value === '不可逆' ? 'choice-irreversible' : ''] },
          input, h('span', { class: 'choice-card-title' }, value));
      })),
    errorSlot('reversibility'));

  const webId = nextId('web');
  const webInput = h('input', { id: webId, type: 'checkbox', role: 'switch', class: 'visually-hidden', checked: draft.needsWeb, 'aria-describedby': 'hint-web' });
  webInput.addEventListener('change', () => {
    draft.needsWeb = webInput.checked;
    changed();
  });
  const webField = h('div', { class: 'field' },
    h('label', { class: 'switch', for: webId }, webInput,
      h('span', { class: 'switch-track', 'aria-hidden': 'true' }),
      h('span', { class: 'switch-label' }, icon('globe'), '需要联网')),
    h('p', { class: 'hint', id: 'hint-web' }, '涉及最新事实时打开'));

  const lint = debounce(async () => {
    if (!draft.background.trim()) {
      lintWarnings = [];
      renderLint();
      return;
    }
    try {
      const { warnings } = await api.lint(draft.question, draft.background, draft.goals, ctx.signal);
      lintWarnings = warnings;
      renderLint();
    } catch { /* 提示性检查失败时静默，提交时后端还会再检查 */ }
  }, 700);
  backgroundField.area.addEventListener('input', () => {
    acknowledged = false;
    lint();
  });

  function snippet(text: string, phrase: string) {
    const i = text.indexOf(phrase);
    if (i < 0) return null;
    const start = Math.max(0, i - 16);
    const end = Math.min(text.length, i + phrase.length + 16);
    return h('span', { class: 'lint-snippet' }, start > 0 ? '…' : '', text.slice(start, i).replace(/\s+/g, ' '),
      h('mark', null, phrase), text.slice(i + phrase.length, end).replace(/\s+/g, ' '), end < text.length ? '…' : '');
  }
  function renderLint() {
    if (!lintWarnings.length) {
      lintBox.replaceChildren();
      return;
    }
    lintBox.replaceChildren(notice('warn',
      h('p', { class: 'notice-title' }, '背景里有 ' + lintWarnings.length + ' 处倾向性措辞'),
      h('ul', { class: 'lint-list' }, lintWarnings.map(w => h('li', null, snippet(draft.background, w.phrase) ?? w.phrase)))));
  }

  const material = h('section', { class: 'card ask-material', 'aria-labelledby': 'material-title' },
    h('div', { class: 'card-head' }, h('h2', { class: 'card-title', id: 'material-title' }, '问题材料')),
    newInfoField?.wrap ?? null,
    questionField.wrap, backgroundField.wrap, goalsField.wrap, revField, webField);

  // ── 我的票（只保存在本机） ─────────────────────────────
  const voteName = nextId('vote');
  const voteField = h('fieldset', { class: 'field fieldset', 'aria-describedby': 'err-vote' },
    h('legend', { class: 'label' }, '你的判断', h('span', { class: 'req', 'aria-hidden': 'true' }, '必填')),
    h('div', { class: 'vote-choices' }, (['是', '否'] as const).map(value => {
      const input = h('input', { type: 'radio', name: voteName, value, class: 'visually-hidden', checked: draft.vote === value });
      input.addEventListener('change', () => {
        draft.vote = value;
        clearError('vote');
        updateVoteDependent();
        changed();
      });
      return h('label', { class: ['vote-choice', value === '是' ? 'vote-yes' : 'vote-no'] }, input, h('span', { class: 'vote-choice-mark' }, value));
    })),
    errorSlot('vote'));

  const confId = nextId('conf');
  const confOut = h('output', { class: 'conf-value', for: confId });
  const confWord = h('span', { class: 'conf-word' });
  const range = h('input', { id: confId, type: 'range', min: '50', max: '100', step: '1', class: 'range', value: String(draft.confidence) });
  const updateConf = () => {
    confOut.textContent = String(draft.confidence);
    confWord.textContent = confidenceWord(draft.confidence);
    range.style.setProperty('--fill', ((draft.confidence - 50) / 50) * 100 + '%');
  };
  range.addEventListener('input', () => {
    draft.confidence = Number(range.value);
    updateConf();
    changed();
  });
  updateConf();
  const confField = h('div', { class: 'field' },
    h('div', { class: 'label-row' }, h('label', { class: 'label', for: confId }, '置信度'), h('span', { class: 'conf-readout' }, confOut, confWord)),
    range);

  const reasonId = 'f-core_reason';
  const reasonCounter = counter(draft.core_reason, LIMIT_REASON);
  const reasonInput = h('textarea', { id: reasonId, class: 'input textarea', rows: '2', placeholder: '一句话说清你为什么这样投', 'aria-describedby': 'err-core_reason' });
  reasonInput.value = draft.core_reason;
  autosize(reasonInput);
  reasonInput.addEventListener('input', () => {
    draft.core_reason = reasonInput.value;
    reasonCounter.update(reasonInput.value);
    clearError('core_reason');
    changed();
  });
  const reasonField = h('div', { class: 'field' },
    h('div', { class: 'label-row' }, h('label', { class: 'label', for: reasonId }, '核心理由', h('span', { class: 'req', 'aria-hidden': 'true' }, '必填')), reasonCounter.el),
    reasonInput, errorSlot('core_reason'));

  // 前提条件：仅在投「是」时可填
  const conditionList = h('div', { class: 'stack-list' });
  const conditionAdd = h('button', { class: 'btn btn-ghost btn-sm', type: 'button' }, icon('plus'), '添加前提');
  conditionAdd.addEventListener('click', () => {
    draft.conditions.push('');
    renderConditions();
    conditionList.querySelector<HTMLInputElement>('.stack-row:last-child input')?.focus();
    changed();
  });
  const conditionField = h('div', { class: 'field' },
    h('div', { class: 'label-row' }, h('span', { class: 'label' }, '「是」成立的前提'), h('span', { class: 'optional' }, '可选')),
    conditionList, conditionAdd);
  function renderConditions() {
    conditionList.replaceChildren(...draft.conditions.map((text, i) => {
      const input = h('input', { class: 'input', value: text, placeholder: '例如：试用期内可以无责离职', 'aria-label': '前提 ' + (i + 1) });
      input.addEventListener('input', () => { draft.conditions[i] = input.value; changed(); });
      const remove = h('button', { class: 'icon-btn', type: 'button', 'aria-label': '删除前提 ' + (i + 1) }, icon('close'));
      remove.addEventListener('click', () => { draft.conditions.splice(i, 1); renderConditions(); changed(); });
      return h('div', { class: 'stack-row' }, input, remove);
    }));
  }

  // 风险：最多 3 条
  const riskList = h('div', { class: 'risk-editor-list' });
  const riskAdd = h('button', { class: 'btn btn-ghost btn-sm', type: 'button' }, icon('plus'), '添加风险');
  riskAdd.addEventListener('click', () => {
    if (draft.risks.length >= MAX_RISKS) return;
    draft.risks.push({ category: '', severity: '', risk: '', check: '' });
    renderRisks();
    riskList.querySelector<HTMLSelectElement>('.risk-editor:last-child select')?.focus();
    changed();
  });
  const riskField = h('div', { class: 'field' },
    h('div', { class: 'label-row' }, h('span', { class: 'label' }, '风险'), h('span', { class: 'optional' }, '最多 3 条')),
    riskList, riskAdd, errorSlot('risks'));

  function renderRisks() {
    riskList.replaceChildren(...draft.risks.map((r, i) => {
      const n = i + 1;
      const cat = h('select', { class: 'input select', 'aria-label': '风险 ' + n + ' 类别' },
        h('option', { value: '' }, '类别'), CATEGORIES.map(c => h('option', { value: c, selected: r.category === c }, c)));
      const sev = h('select', { class: 'input select', 'aria-label': '风险 ' + n + ' 严重度' },
        h('option', { value: '' }, '严重度'), SEVERITIES.map(sv => h('option', { value: sv, selected: r.severity === sv }, sv)));
      const riskCounter = counter(r.risk, LIMIT_RISK);
      const checkCounter = counter(r.check, LIMIT_RISK);
      const riskText = h('input', { class: 'input', value: r.risk, placeholder: '可能出什么问题', 'aria-label': '风险 ' + n + ' 描述' });
      const checkText = h('input', { class: 'input', value: r.check, placeholder: '怎么确认或降低它', 'aria-label': '风险 ' + n + ' 检查动作' });
      const fatalHint = h('p', { class: 'hint hint-fatal', hidden: true }, icon('alert'), '表决后将先停机检查');
      const sync = () => { fatalHint.hidden = !(r.severity === '致命' && draft.reversibility === '不可逆'); };
      cat.addEventListener('change', () => { r.category = cat.value as Category | ''; clearError('risks'); changed(); });
      sev.addEventListener('change', () => { r.severity = sev.value as Severity | ''; sev.dataset.sev = sev.value; sync(); clearError('risks'); changed(); });
      sev.dataset.sev = r.severity;
      riskText.addEventListener('input', () => { r.risk = riskText.value; riskCounter.update(r.risk); clearError('risks'); changed(); });
      checkText.addEventListener('input', () => { r.check = checkText.value; checkCounter.update(r.check); clearError('risks'); changed(); });
      const remove = h('button', { class: 'icon-btn', type: 'button', 'aria-label': '删除风险 ' + n }, icon('close'));
      remove.addEventListener('click', () => { draft.risks.splice(i, 1); renderRisks(); changed(); });
      sync();
      return h('div', { class: 'risk-editor', dataset: { index: String(i) } },
        h('div', { class: 'risk-editor-head' }, h('span', { class: 'risk-editor-n' }, '风险 ' + n), remove),
        h('div', { class: 'risk-editor-selects' }, cat, sev),
        h('div', { class: 'input-with-counter' }, riskText, riskCounter.el),
        h('div', { class: 'input-with-counter' }, checkText, checkCounter.el),
        fatalHint);
    }));
    riskAdd.hidden = draft.risks.length >= MAX_RISKS;
  }
  function updateFatalHints() {
    renderRisks();
  }

  const flipId = 'f-flip';
  const flipInput = h('textarea', { id: flipId, class: 'input textarea', rows: '2', placeholder: '例如：如果试用期考核标准不透明，我会改投「否」。' });
  flipInput.value = draft.flip_condition;
  autosize(flipInput);
  flipInput.addEventListener('input', () => { draft.flip_condition = flipInput.value; changed(); });
  const flipField = h('div', { class: 'field' },
    h('div', { class: 'label-row' }, h('label', { class: 'label', for: flipId }, '改票条件'), h('span', { class: 'optional' }, '可选')),
    flipInput);

  // 来源：可选，最多 8 条，只保存在 MAGI，不发送给模型
  const sourceList = h('div', { class: 'risk-editor-list' });
  const sourceAdd = h('button', { class: 'btn btn-ghost btn-sm', type: 'button' }, icon('plus'), '添加来源');
  sourceAdd.addEventListener('click', () => {
    if (draft.sources.length >= MAX_SOURCES) return;
    draft.sources.push({ url: '', claim: '' });
    renderSources();
    sourceList.querySelector<HTMLInputElement>('.risk-editor:last-child input')?.focus();
    changed();
  });
  const sourceField = h('div', { class: 'field' },
    h('div', { class: 'label-row' }, h('span', { class: 'label' }, '来源'), h('span', { class: 'optional' }, '可选')),
    sourceList, sourceAdd, errorSlot('sources'));

  function renderSources() {
    sourceList.replaceChildren(...draft.sources.map((src, i) => {
      const n = i + 1;
      const url = h('input', {
        class: 'input input-url', type: 'url', inputmode: 'url', value: src.url, placeholder: 'https://…',
        autocomplete: 'off', spellcheck: 'false', 'aria-label': '来源 ' + n + ' 网址',
      });
      const claimCounter = counter(src.claim, LIMIT_CLAIM);
      const claim = h('textarea', { class: 'input textarea textarea-claim', rows: '2', placeholder: '这页的哪条事实影响了你的判断', 'aria-label': '来源 ' + n + ' 论点' });
      claim.value = src.claim;
      autosize(claim);
      url.addEventListener('input', () => { src.url = url.value; clearError('sources'); changed(); });
      claim.addEventListener('input', () => { src.claim = claim.value; claimCounter.update(src.claim); clearError('sources'); changed(); });
      const remove = h('button', { class: 'icon-btn', type: 'button', 'aria-label': '删除来源 ' + n }, icon('close'));
      remove.addEventListener('click', () => { draft.sources.splice(i, 1); renderSources(); clearError('sources'); changed(); });
      return h('div', { class: 'risk-editor source-editor' },
        h('div', { class: 'risk-editor-head' }, h('span', { class: 'risk-editor-n' }, '来源 ' + n), claimCounter.el, remove),
        url, claim);
    }));
    sourceAdd.hidden = draft.sources.length >= MAX_SOURCES;
  }

  // 前提条件只在投「是」时出现
  function updateVoteDependent() {
    conditionField.hidden = draft.vote !== '是';
  }

  const voteCard = h('section', { class: 'card ask-vote', 'aria-labelledby': 'vote-title' },
    h('div', { class: 'card-head' }, h('h2', { class: 'card-title', id: 'vote-title' }, '我的票')),
    voteField, confField, reasonField, conditionField, riskField, flipField, sourceField);

  // ── 提交 ──────────────────────────────────────────
  const summary = h('div', { class: 'submit-errors', role: 'alert', hidden: true });
  // 只在 ChatGPT 套餐尚未授权时提醒（否则 GPT 会缺席），不显示计费说明。
  const gptUsage = h('p', { class: 'hint', hidden: true });
  void api.gptBilling(ctx.signal).then(info => {
    if (info.mode !== 'chatgpt_plan' || info.authorized) return;
    gptUsage.textContent = 'GPT 尚未连接 ChatGPT 套餐。请在服务机上运行 MAGI 的授权命令。';
    gptUsage.hidden = false;
  }).catch(() => { /* Earlier backend versions do not expose billing information. */ });
  const submitButton = h('button', { class: 'btn btn-primary btn-lg submit-btn', type: 'submit' }, icon('lock'), '开始表决');
  const clearButton = h('button', { class: 'link-btn', type: 'button' }, '清空草稿');
  clearButton.addEventListener('click', async () => {
    const choice = await openDialog({
      title: '清空草稿？', tone: 'warn',
      body: h('p', null, '无法恢复。'),
      actions: [{ label: '取消', value: '' , kind: 'ghost' }, { label: '清空', value: 'clear', kind: 'danger' }],
    });
    if (choice !== 'clear') return;
    discardDraft();
    navigate(location.pathname + location.search, { replace: true });
  });
  const submitBar = h('section', { class: 'submit-bar' },
    h('div', { class: 'submit-actions' }, gptUsage, summary, submitButton, h('div', { class: 'submit-meta' }, savedNote, clearButton)));

  const form = h('form', { class: 'ask-form', novalidate: true },
    h('div', { class: 'ask-grid' }, material, voteCard), submitBar);

  function validate(): { key: string; message: string }[] {
    const list: { key: string; message: string }[] = [];
    if (parent && charCount(draft.newInfo) < 10) list.push({ key: 'newInfo', message: '新增信息至少需要 10 个字（现在 ' + charCount(draft.newInfo) + ' 字）。' });
    if (!draft.question.trim()) list.push({ key: 'question', message: '请写下要表决的问题。' });
    if (!draft.reversibility) list.push({ key: 'reversibility', message: '请选择这个决定是否可逆。' });
    if (!draft.vote) list.push({ key: 'vote', message: '请先投下你自己的一票。' });
    const reasonLength = charCount(draft.core_reason);
    if (!reasonLength) list.push({ key: 'core_reason', message: '请用一句话写下核心理由。' });
    else if (reasonLength > LIMIT_REASON) list.push({ key: 'core_reason', message: '核心理由最多 ' + LIMIT_REASON + ' 字（现在 ' + reasonLength + ' 字）。' });
    draft.risks.forEach((r, i) => {
      const blank = !r.category && !r.severity && !r.risk.trim() && !r.check.trim();
      if (blank) return;
      const missing = [!r.category && '类别', !r.severity && '严重度', !r.risk.trim() && '风险描述', !r.check.trim() && '检查动作'].filter(Boolean);
      if (missing.length) list.push({ key: 'risks', message: '第 ' + (i + 1) + ' 条风险还缺：' + missing.join('、') + '。' });
      else if (charCount(r.risk) > LIMIT_RISK || charCount(r.check) > LIMIT_RISK) list.push({ key: 'risks', message: '第 ' + (i + 1) + ' 条风险的描述和检查动作各最多 ' + LIMIT_RISK + ' 字。' });
    });
    draft.sources.forEach((src, i) => {
      const url = src.url.trim();
      const claim = src.claim.trim();
      if (!url && !claim) return;
      const name = '第 ' + (i + 1) + ' 条来源';
      if (!url) list.push({ key: 'sources', message: name + '缺少网址。' });
      else if (!validSourceUrl(url)) list.push({ key: 'sources', message: name + '的网址需以 http:// 或 https:// 开头，且不含空格。' });
      if (!claim) list.push({ key: 'sources', message: name + '缺少论点。' });
      else if (charCount(claim) > LIMIT_CLAIM) list.push({ key: 'sources', message: name + '的论点最多 ' + LIMIT_CLAIM + ' 字（现在 ' + charCount(claim) + ' 字）。' });
    });
    return list;
  }

  function showErrors(list: { key: string; message: string }[]) {
    for (const key of errors.keys()) clearError(key);
    const firstPerKey = new Map<string, string>();
    for (const e of list) if (!firstPerKey.has(e.key)) firstPerKey.set(e.key, e.message);
    for (const [key, message] of firstPerKey) setError(key, message);
    if (!list.length) {
      summary.hidden = true;
      return;
    }
    summary.replaceChildren(notice('danger',
      h('p', { class: 'notice-title' }, '还有 ' + list.length + ' 处需要处理'),
      h('ul', { class: 'error-links' }, list.map(e => h('li', null, h('a', {
        href: '#err-' + e.key,
        onclick: (event: Event) => { event.preventDefault(); focusField(e.key); },
      }, e.message))))));
    summary.hidden = false;
  }
  function focusField(key: string) {
    const target = errors.get(key)?.closest('.field, fieldset');
    target?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    const focusable = target?.querySelector<HTMLElement>('textarea, input:not([type=radio]), select, input[type=radio]');
    window.setTimeout(() => focusable?.focus({ preventScroll: true }), 250);
  }

  function buildBody(): Submission {
    const userVote: Ballot = {
      vote: draft.vote as Answer,
      confidence: draft.confidence,
      core_reason: draft.core_reason.trim(),
      conditions: draft.vote === '是' ? draft.conditions.map(c => c.trim()).filter(Boolean) : [],
      risks: draft.risks.filter(r => r.category && r.severity && r.risk.trim() && r.check.trim()).map(r => ({
        category: r.category, severity: r.severity, risk: r.risk.trim(), check: r.check.trim(),
      }) as Risk),
      flip_condition: draft.flip_condition.trim(),
      sources: draft.sources.filter(s => s.url.trim() && s.claim.trim()).map(s => ({ url: s.url.trim(), claim: s.claim.trim() })),
    };
    return {
      question: draft.question.trim(),
      background: draft.background.trim(),
      goals: draft.goals.trim(),
      reversibility: draft.reversibility as Reversibility,
      parentId: parent?.id ?? null,
      newInfo: parent ? draft.newInfo.trim() : null,
      acknowledgeWarnings: acknowledged,
      needsWeb: draft.needsWeb,
      userVote,
    };
  }

  async function submit() {
    const list = validate();
    showErrors(list);
    if (list.length) {
      focusField(list[0].key);
      return;
    }
    await withBusy(submitButton, '正在锁定…', async () => {
      try {
        const created = await api.create(buildBody());
        discardDraft();
        navigate('/q/' + created.id);
      } catch (err) {
        await handleSubmitError(err);
      }
    });
  }

  async function handleSubmitError(err: unknown) {
    if (err instanceof ApiError && err.code === 'LINT_WARNINGS') {
      lintWarnings = err.body?.warnings ?? lintWarnings;
      renderLint();
      const choice = await openDialog({
        title: '背景里有倾向性措辞', tone: 'warn',
        body: h('p', { class: 'phrase-list' }, lintWarnings.map(w => h('mark', null, w.phrase))),
        actions: [
          { label: '仍然提交', value: 'continue', kind: 'secondary' },
          { label: '返回修改', value: 'edit', kind: 'primary' },
        ],
      });
      if (choice === 'continue') {
        acknowledged = true;
        await submit();
      } else {
        backgroundField.area.focus();
        backgroundField.area.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
      return;
    }
    if (err instanceof ApiError && err.code === 'DUPLICATE_QUESTION' && err.body?.existingId) {
      const existing = err.body.existingId;
      const choice = await openDialog({
        title: '这组材料已经表决过',
        body: h('p', null, '问题材料与已有表决完全相同。'),
        actions: [{ label: '留在此页', value: '', kind: 'ghost' }, { label: '打开已有表决', value: 'open', kind: 'primary' }],
      });
      if (choice === 'open') navigate('/q/' + existing);
      return;
    }
    const message = err instanceof ApiError && err.code === 'INVALID_INPUT' ? translateFields(err.message) : errorMessage(err);
    summary.replaceChildren(notice('danger', h('p', { class: 'notice-title' }, '提交没有成功'), h('p', null, message),
      err instanceof ApiError && err.status === 0 ? h('p', null, '草稿已保存。') : null));
    summary.hidden = false;
  }

  form.addEventListener('submit', event => {
    event.preventDefault();
    if (submitButton.disabled) return;
    void submit();
  });

  renderConditions();
  renderRisks();
  renderSources();
  updateVoteDependent();
  if (draft.background.trim()) lint();

  const restored = hasContent(draft) && storage.get(draftKey) !== null;
  const header = parent
    ? pageHeader({
      title: '带新信息追问',
      code: 'AMENDMENT · 追加议案',
      back: { href: '/q/' + parent.id, label: '原表决' },
    })
    : pageHeader({ title: '新决策', code: 'NEW PROPOSAL · 提交议案' });

  const wrap = h('div', { class: 'ask' }, header);
  if (parent) wrap.append(parentCard(parent));
  else wrap.append(pendingStrip(ctx));
  if (restored) wrap.append(notice('info', '已恢复草稿。'));
  wrap.append(form);
  return wrap;
}

function parentCard(parent: Detail) {
  return h('a', { class: 'parent-card', href: '/q/' + parent.id },
    seal(parent.result?.finalDecision ?? null, 'sm'),
    h('div', { class: 'parent-card-body' },
      h('span', { class: 'eyebrow' }, '原表决 · ' + formatDate(parent.createdAt) + ' · ' + (parent.result?.tally.label ?? '')),
      h('span', { class: 'parent-card-q' }, parent.question)),
    icon('forward'));
}

/** 首页顶部：需要处理的表决。 */
function pendingStrip(ctx: RouteContext) {
  const box = h('div', { class: 'pending-strip' });
  api.history(20, null, ctx.signal).then(page => {
    const pending = page.items.filter(i => i.status !== 'decided');
    if (!pending.length) return;
    box.replaceChildren(
      h('h2', { class: 'strip-title' }, '待你处理'),
      h('ul', { class: 'pending-list' }, pending.slice(0, 4).map(pendingItem)));
  }).catch(() => { /* 首页的提示区加载失败时不打扰填写 */ });
  return box;
}

function pendingItem(item: HistoryItem) {
  return h('li', null, h('a', { class: ['pending-item', 'is-' + item.status], href: '/q/' + item.id },
    statusChip(item.status),
    h('span', { class: 'pending-q' }, item.question),
    h('span', { class: 'pending-meta' }, relativeTime(item.createdAt))));
}
