import { api, ApiError, errorMessage, isAbort } from '../api';
import { autosize, charCount, h, nextId, paragraphs, session, type Child } from '../dom';
import { absenceHint, absenceReason, clock, duration, formatDateTime, siteName, voterName } from '../format';
import { brandIcon, icon } from '../icons';
import type { RouteContext } from '../router';
import type { Answer, ConfirmReason, Detail, MergedRisk, ModelVoter, OutcomeAnswer, Result, Source, ValidVote, Vote, Voter } from '../types';
import {
  answerTag, confidenceMeter, errorState, loadingPage, notice, openDialog, sectionHead, severityChip, statusChip,
  toast, voterLabel, withBusy,
} from '../ui';

const POLL_MS = 3000;
const RETRY_KEY = 'magi:retry:';
const seatCode: Record<Voter, string> = { user: 'SEAT·01', gpt: 'SEAT·02', deepseek: 'SEAT·03' };
const MATERIAL_PREVIEW_CHARS = 160;

const isValid = (v: Vote): v is ValidVote => v.state === 'valid';
function hostOf(url: string) {
  try { return new URL(url).hostname.toLowerCase().replace(/\.$/, ''); } catch { return ''; }
}
const onSite = (url: string, sites: string[]) => {
  const host = hostOf(url);
  return sites.some(site => host === site || host.endsWith('.' + site));
};
const opposite = (a: Answer): Answer => (a === '是' ? '否' : '是');

interface ViewState {
  data: Detail | null;
  signature: string;
  showAllRisks: boolean;
  materialOpen: boolean;
  editingOutcome: boolean;
  confirmChoice: ConfirmReason | null;
  confirmNote: string;
  outcomeChoice: OutcomeAnswer | null;
  outcomeNote: string;
  revealed: boolean;
  pollFailures: number;
}

export function detailView(ctx: RouteContext) {
  const id = ctx.params.id;
  const root = h('div', { class: 'page page-detail' });
  const state: ViewState = {
    data: null, signature: '', showAllRisks: false, materialOpen: false, editingOutcome: false,
    confirmChoice: null, confirmNote: '', outcomeChoice: null, outcomeNote: '', revealed: false, pollFailures: 0,
  };
  let pollTimer: number | undefined;
  let tickTimer: number | undefined;
  const pollStatus = h('p', { class: 'poll-status', role: 'status', 'aria-live': 'polite' });

  ctx.signal.addEventListener('abort', () => {
    window.clearTimeout(pollTimer);
    window.clearInterval(tickTimer);
    document.removeEventListener('visibilitychange', onVisibility);
  });

  function onVisibility() {
    if (document.visibilityState === 'visible' && state.data?.status === 'running') {
      window.clearTimeout(pollTimer);
      void fetchDetail();
    }
  }
  document.addEventListener('visibilitychange', onVisibility);

  async function fetchDetail(initial = false) {
    try {
      const data = await api.detail(id, ctx.signal);
      state.pollFailures = 0;
      pollStatus.textContent = '';
      apply(data);
    } catch (err) {
      if (isAbort(err)) return;
      if (initial || !state.data) {
        root.replaceChildren(errorState(err, () => { root.replaceChildren(loadingPage()); void fetchDetail(true); }));
        ctx.setTitle('加载失败');
        return;
      }
      if (err instanceof ApiError && err.status === 401) return;
      state.pollFailures += 1;
      pollStatus.textContent = '连接中断，' + Math.min(30, POLL_MS / 1000 * 2 ** state.pollFailures) + ' 秒后重试（' + errorMessage(err) + '）';
    }
    schedulePoll();
  }

  function schedulePoll() {
    window.clearTimeout(pollTimer);
    if (ctx.signal.aborted || state.data?.status !== 'running') return;
    const delay = state.pollFailures ? Math.min(30_000, POLL_MS * 2 ** state.pollFailures) : POLL_MS;
    pollTimer = window.setTimeout(() => {
      if (document.visibilityState === 'hidden') return; // 回到前台时立即刷新
      void fetchDetail();
    }, delay);
  }

  function apply(data: Detail) {
    const signature = JSON.stringify(data);
    const previous = state.data;
    state.data = data;
    if (signature === state.signature) return;
    const justRevealed = previous?.status === 'running' && data.status !== 'running';
    const statusChanged = previous !== null && previous.status !== data.status;
    state.signature = signature;
    if (data.outcome && state.outcomeChoice === null) {
      state.outcomeChoice = data.outcome.correctAnswer;
      state.outcomeNote = data.outcome.note ?? '';
    }
    if (data.status !== 'running') session.remove(RETRY_KEY + data.id);
    ctx.setTitle(data.status === 'running' ? '表决中' : data.question);
    render(justRevealed);
    if (justRevealed) toast('两家的票已揭晓');
    if (statusChanged) {
      root.querySelector('.detail-header')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }

  async function refresh() {
    await fetchDetail();
  }

  function render(reveal = false) {
    const d = state.data!;
    window.clearInterval(tickTimer);
    const children: Child[] = [header(d)];
    if (d.status === 'running') {
      children.push(waitingPanel(d), materialSection(d), myVoteSection(d));
    } else {
      const r = d.result!;
      children.push(board(d));
      if (d.status === 'paused') children.push(pausedPanel(d, r));
      if (d.status === 'needs_confirmation') children.push(confirmPanel(d, r));
      if (d.status === 'failed') children.push(failedPanel(d));
      if (d.status === 'decided') children.push(verdictPanel(d, r));
      children.push(materialSection(d), votesSection(d, r), sourcesSection(d, r), minoritySection(d, r), risksSection(d, r));
      if (r.conditions.length) children.push(conditionsSection(r));
      if (d.status === 'decided') children.push(outcomeSection(d), followUpSection(d));
    }
    children.push(pollStatus);
    const content = h('div', { class: ['detail', reveal ? 'is-revealing' : ''] }, children);
    const scroll = window.scrollY;
    root.replaceChildren(content);
    window.scrollTo(0, scroll);
  }

  // ── 头部 ──────────────────────────────────────────
  function header(d: Detail) {
    const meta: Child[] = [
      h('span', null, icon('clock'), formatDateTime(d.createdAt)),
      h('span', { class: d.reversibility === '不可逆' ? 'meta-irreversible' : '' }, d.reversibility),
    ];
    if (d.needsWeb) meta.push(h('span', { class: 'meta-web' }, icon('globe'), '联网'));
    if (d.decidedAt) meta.push(h('span', null, '历时 ' + duration(new Date(d.decidedAt).getTime() - new Date(d.createdAt).getTime())));
    if (d.parentId) meta.push(h('a', { href: '/q/' + d.parentId, class: 'meta-link' }, icon('branch'), '追问自原表决'));
    return h('header', { class: 'page-header detail-header' },
      h('a', { class: 'back-link', href: '/history' }, icon('back'), '记录'),
      h('div', { class: 'detail-status' },
        h('span', { class: 'page-code', 'aria-hidden': 'true' }, h('span', { class: 'code-tick' }), 'CASE ' + d.id),
        statusChip(d.status)),
      h('h1', { class: 'detail-question', tabindex: '-1' }, d.question),
      h('div', { class: 'meta-row' }, meta));
  }

  // ── 等待两家表决 ───────────────────────────────────
  function waitingPanel(d: Detail) {
    // 技术重试后从重试时刻计时（记录在本标签页）；否则从提交时刻计时。
    const retriedAt = Number(session.get(RETRY_KEY + d.id)) || 0;
    const since = Math.max(new Date(d.createdAt).getTime(), retriedAt);
    const elapsed = h('span', { class: 'wait-clock', 'aria-hidden': 'true' }, clock(Date.now() - since));
    tickTimer = window.setInterval(() => {
      elapsed.textContent = clock(Date.now() - since);
    }, 1000);
    return h('section', { class: 'action-panel wait-panel', 'aria-labelledby': 'wait-title' },
      board(d),
      h('div', { class: 'wait-head' },
        h('h2', { class: 'panel-title', id: 'wait-title' }, '等待揭晓'),
        h('div', { class: 'wait-timer' }, h('span', { class: 'wait-label' }, '已等待'), elapsed)));
  }

  // ── 三席表决面板：本人在上，两家模型在下，中央六边形为决议 ──────────
  function board(d: Detail) {
    const r = d.result;
    const seat = (voter: Voter) => {
      const v = d.votes.find(x => x.voter === voter);
      let state = 'is-pending';
      let big = '审议中';
      let meta: Child = '独立推理中';
      if (v?.state === 'valid') {
        big = v.vote;
        if (d.status === 'running') {
          state = 'is-locked ' + (v.vote === '是' ? 'lock-yes' : 'lock-no');
          meta = h('span', null, icon('lock'), '已锁定 · 置信 ' + v.confidence);
        } else {
          state = v.vote === '是' ? 'is-yes' : 'is-no';
          meta = '置信 ' + v.confidence;
        }
      } else if (v?.state === 'absent') {
        state = 'is-absent';
        big = '缺席';
        meta = absenceReason[v.error] ?? v.error;
      }
      const dissent = r?.tally.dissenters.includes(voter) ?? false;
      const model = v && v.state !== 'pending' ? v.model : undefined;
      return h('div', { class: ['seat', 'seat-' + voter, state, dissent ? 'is-dissent' : ''] },
        h('div', { class: 'seat-head' },
          h('span', { class: 'seat-code' }, seatCode[voter]),
          dissent ? h('span', { class: 'seat-flag' }, '少数派') : null),
        h('div', { class: 'seat-name', title: voter === 'user' ? undefined : voterName[voter] },
          voter === 'user' ? '本人' : [brandIcon(voter, 'brand-icon seat-logo'), h('span', { class: 'visually-hidden' }, voterName[voter])]),
        model ? h('div', { class: 'seat-model', title: model }, model) : null,
        h('div', { class: 'seat-vote' }, h('span', null, big)),
        h('div', { class: 'seat-meta' }, meta));
    };
    const final = r?.finalDecision ?? null;
    const hubs: Record<string, [string, string, string]> = {
      running: ['审议', 'IN SESSION', 'hub-running'],
      paused: ['停机', 'HALT', 'hub-paused'],
      needs_confirmation: ['裁定', 'OVERRIDE', 'hub-pending'],
      failed: ['流会', 'NO QUORUM', 'hub-failed'],
      // 中央只显示比分，缺席情况已在对应席位上标出
      decided: [final ?? '—', (r?.tally.label ?? '').split('（')[0], final === '是' ? 'hub-yes' : 'hub-no'],
    };
    const [value, code, tone] = hubs[d.status];
    const summary = d.votes.map(v => (v.voter === 'user' ? '本人' : voterName[v.voter]) + '：'
      + (v.state === 'valid' ? v.vote : v.state === 'absent' ? '缺席' : '审议中')).join('，');
    return h('section', { class: ['magi-board', 'board-' + d.status], role: 'group', 'aria-label': '三方表决：' + summary + '。决议：' + value },
      seat('user'),
      h('div', { class: 'hub-wrap', 'aria-hidden': 'true' },
        h('div', { class: ['hub', tone] },
          h('span', { class: 'hub-label' }, '决议'),
          h('span', { class: 'hub-value' }, h('span', null, value)),
          h('span', { class: 'hub-code' }, code))),
      seat('gpt'),
      seat('deepseek'));
  }

  function myVoteSection(d: Detail) {
    const user = d.votes.find(v => v.voter === 'user');
    if (!user || !isValid(user)) return null;
    return h('section', { class: 'section' }, sectionHead('我的票'), h('div', { class: 'vote-grid vote-grid-single' }, voteCard(user, d)));
  }

  // ── 停机检查 ─────────────────────────────────────
  function pausedPanel(d: Detail, r: Result) {
    const fatal = r.risks.filter(risk => r.pausedBy.includes(risk.id));
    const done = fatal.filter(risk => risk.checkDone).length;
    return h('section', { class: 'action-panel paused-panel', 'aria-labelledby': 'paused-title' },
      h('div', { class: 'panel-icon' }, icon('shield')),
      h('h2', { class: 'panel-title', id: 'paused-title' }, '停机检查'),
      h('p', { class: 'panel-lead' }, '不可逆决定出现 ' + fatal.length + ' 条致命风险，检查完成后给出结论。'),
      h('div', { class: 'progress-row' },
        h('span', { class: 'progress-text' }, '已完成 ' + done + ' / ' + fatal.length),
        progressBar(done, fatal.length)),
      h('ol', { class: 'fatal-list' }, fatal.map(risk => h('li', null, riskItem(d, risk, true)))));
  }

  function progressBar(done: number, total: number) {
    const fill = h('span', { class: 'progress-fill' });
    fill.style.setProperty('--pct', (total ? (done / total) * 100 : 0) + '%');
    return h('span', { class: 'progress', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': String(total), 'aria-valuenow': String(done) }, fill);
  }

  // ── 本人确认 ─────────────────────────────────────
  function confirmPanel(d: Detail, r: Result) {
    const user = d.votes.find(v => v.voter === 'user') as ValidVote;
    const models = d.votes.filter((v): v is ValidVote => v.voter !== 'user' && isValid(v));
    const opponents = models.filter(m => m.vote !== user.vote);
    const absent = d.votes.filter(v => v.state === 'absent').map(v => voterName[v.voter]);
    const other = opposite(user.vote);
    let situation: string;
    if (r.tally.userInMinority) {
      situation = opponents.map(o => voterName[o.voter]).join(' 和 ') + ' 都投了「' + other + '」，你投了「' + user.vote + '」。你是少数派。';
    } else {
      situation = (absent.length ? absent.join('、') + ' 缺席；' : '') + opponents.map(o => voterName[o.voter]).join('、') + ' 投了「' + other + '」，与你的「' + user.vote + '」相反，票数打平。';
    }
    const adoptLabel = r.tally.userInMinority ? '采纳多数意见' : '采纳 ' + opponents.map(o => voterName[o.voter]).join('、') + ' 的意见';

    const name = nextId('confirm');
    const options: [ConfirmReason, string, Answer][] = [
      ['adopt_majority', adoptLabel, other],
      ['keep_mine', '坚持我的票', user.vote],
    ];
    const errorEl = h('p', { class: 'field-error', hidden: true, role: 'alert' });
    const noteId = nextId('note');
    const note = h('textarea', { id: noteId, class: 'input textarea', rows: '3', placeholder: '为什么这样定' });
    note.value = state.confirmNote;
    autosize(note);
    note.addEventListener('input', () => { state.confirmNote = note.value; });
    const submit = h('button', { class: 'btn btn-primary btn-lg', type: 'submit' }, '确认最终答案');
    const form = h('form', { class: 'confirm-form', novalidate: true },
      h('fieldset', { class: 'fieldset' },
        h('legend', { class: 'label' }, '最终答案'),
        h('div', { class: 'choice-cards' }, options.map(([value, title, answer]) => {
          const input = h('input', { type: 'radio', name, value, class: 'visually-hidden', checked: state.confirmChoice === value });
          input.addEventListener('change', () => { state.confirmChoice = value; errorEl.hidden = true; });
          return h('label', { class: 'choice-card choice-answer' }, input,
            h('span', { class: 'choice-card-title' }, answerTag(answer), title));
        }))),
      h('div', { class: 'field' }, h('div', { class: 'label-row' }, h('label', { class: 'label', for: noteId }, '备注'), h('span', { class: 'optional' }, '可选')), note),
      errorEl,
      h('div', { class: 'form-actions' }, submit, h('span', { class: 'hint' }, '确认后不能更改。')));
    form.addEventListener('submit', event => {
      event.preventDefault();
      const choice = state.confirmChoice;
      if (!choice) {
        errorEl.textContent = '请选择最终答案。';
        errorEl.hidden = false;
        return;
      }
      const final = choice === 'keep_mine' ? user.vote : other;
      void withBusy(submit, '正在确认…', async () => {
        try {
          await api.confirm(d.id, final, choice, state.confirmNote.trim() || undefined);
          toast('已确认最终答案：' + final);
          await refresh();
        } catch (err) {
          errorEl.textContent = errorMessage(err);
          errorEl.hidden = false;
          if (err instanceof ApiError && err.code === 'INVALID_STATE') await refresh();
        }
      });
    });

    return h('section', { class: 'action-panel confirm-panel', 'aria-labelledby': 'confirm-title' },
      h('div', { class: 'panel-icon' }, icon('info')),
      h('h2', { class: 'panel-title', id: 'confirm-title' }, '需要你来定'),
      h('p', { class: 'panel-lead' }, situation),
      r.sourceOverlap?.warning ? notice('warn', r.sourceOverlap.warning) : null,
      h('div', { class: 'counter-args' },
        opponents.map(o => h('blockquote', { class: 'counter-arg' },
          h('div', { class: 'counter-arg-head' }, voterLabel(o.voter), answerTag(o.vote), h('span', { class: 'conf-chip' }, '置信 ' + o.confidence)),
          h('p', { class: 'counter-arg-reason' }, o.core_reason),
          o.flip_condition ? h('p', { class: 'counter-arg-flip' }, h('span', null, '改票条件'), o.flip_condition) : null))),
      user.flip_condition
        ? h('div', { class: 'self-reminder' }, h('span', { class: 'self-reminder-label' }, '你的改票条件'), h('p', null, '「' + user.flip_condition + '」'))
        : null,
      form);
  }

  // ── 双缺席 ───────────────────────────────────────
  function failedPanel(d: Detail) {
    const absent = d.votes.filter((v): v is { voter: ModelVoter; state: 'absent'; error: string } => v.state === 'absent');
    const button = h('button', { class: 'btn btn-primary', type: 'button' }, icon('refresh'), '重新请求两家');
    const errorEl = h('p', { class: 'field-error', hidden: true, role: 'alert' });
    button.addEventListener('click', () => withBusy(button, '正在重新派发…', async () => {
      try {
        await api.retryAbsent(d.id);
        session.set(RETRY_KEY + d.id, String(Date.now()));
        toast('已重新发送给两家');
        await refresh();
      } catch (err) {
        errorEl.textContent = errorMessage(err);
        errorEl.hidden = false;
        if (err instanceof ApiError && err.code === 'INVALID_STATE') await refresh();
      }
    }));
    return h('section', { class: 'action-panel failed-panel', 'aria-labelledby': 'failed-title' },
      h('div', { class: 'panel-icon' }, icon('alert')),
      h('h2', { class: 'panel-title', id: 'failed-title' }, '两家均缺席'),
      h('ul', { class: 'absence-list' }, absent.map(v => h('li', null,
        h('div', { class: 'absence-head' }, voterLabel(v.voter), h('strong', null, absenceReason[v.error] ?? v.error)),
        h('p', { class: 'hint' }, absenceHint[v.error] ?? '')))),
      h('div', { class: 'form-actions' }, button),
      errorEl);
  }

  // ── 已决定 ───────────────────────────────────────
  function verdictPanel(d: Detail, r: Result) {
    const final = r.finalDecision;
    let how: Child;
    if (r.finalReason === 'adopt_majority') how = h('span', { class: 'how how-confirm' }, '你确认：采纳' + (r.tally.userInMinority ? '多数意见' : '模型意见'));
    else if (r.finalReason === 'keep_mine') how = h('span', { class: 'how how-keep' }, '你确认：坚持自己的票');
    else how = h('span', { class: 'how' }, r.tally.dissenters.length ? '多数决' : '一致通过');
    const fatal = r.risks.filter(x => x.severity === '致命');
    const stopChecked = d.reversibility === '不可逆' && fatal.length > 0 && fatal.every(x => x.checkDone);
    return h('section', { class: 'verdict', 'aria-labelledby': 'verdict-title' },
      h('div', { class: 'verdict-body' },
        h('p', { class: 'eyebrow' }, '最终决定'),
        h('h2', { class: 'verdict-title', id: 'verdict-title' }, final ? (final === '是' ? '是，去做' : '否，不做') : '—'),
        h('div', { class: 'verdict-meta' }, tallyDots(d), h('span', { class: 'tally-label' }, r.tally.label), how,
          stopChecked ? h('span', { class: 'how how-checked' }, icon('shield'), '已完成 ' + fatal.length + ' 项停机检查') : null,
          r.sourceOverlap?.warning ? h('span', { class: 'how how-overlap' }, icon('alert'), r.sourceOverlap.warning) : null),
        r.finalNote ? h('div', { class: 'verdict-note' }, h('span', { class: 'verdict-note-label' }, '确认备注'), paragraphs(r.finalNote, 'prose prose-sm')) : null));
  }

  function tallyDots(d: Detail) {
    return h('span', { class: 'tally-dots', 'aria-hidden': 'true' }, d.votes.map(v => h('span', {
      class: ['tally-dot', v.state === 'valid' ? (v.vote === '是' ? 'is-yes' : 'is-no') : 'is-absent'],
      title: voterName[v.voter] + '：' + (v.state === 'valid' ? v.vote : '缺席'),
    }, v.state === 'valid' ? v.vote : '–')));
  }

  // ── 三方票 ───────────────────────────────────────
  function votesSection(d: Detail, r: Result) {
    return h('section', { class: 'section', 'aria-labelledby': 'votes-title' },
      sectionHead('三方票', h('span', { class: 'tally-inline' }, tallyDots(d), r.tally.label), 'votes-title'),
      h('div', { class: 'vote-grid' }, d.votes.map(v => voteCard(v, d))));
  }

  function voteCard(v: Vote, d: Detail) {
    const r = d.result;
    const dissent = r?.tally.dissenters.includes(v.voter) ?? false;
    const model = v.state !== 'pending' ? v.model : undefined;
    const head = h('div', { class: 'vote-card-head' }, voterLabel(v.voter),
      model ? h('span', { class: 'model-name', title: '使用的模型' }, model) : null,
      dissent ? h('span', { class: 'mini-tag tag-dissent' }, '少数派') : null);
    if (v.state === 'absent') {
      return h('article', { class: 'vote-card is-absent' }, head,
        h('div', { class: 'vote-absent' }, h('span', { class: 'vote-big' }, '缺席'), h('p', null, absenceReason[v.error] ?? v.error)));
    }
    if (v.state === 'pending') {
      return h('article', { class: 'vote-card is-pending' }, head, h('p', { class: 'hint' }, '尚未揭晓'));
    }
    const final = r?.finalDecision;
    return h('article', { class: ['vote-card', v.vote === '是' ? 'is-yes' : 'is-no', dissent ? 'is-dissent' : '', final && final !== v.vote ? 'is-overruled' : ''] },
      head,
      h('div', { class: 'vote-main' },
        h('span', { class: 'vote-big' }, v.vote),
        h('div', { class: 'vote-conf' }, h('span', { class: 'vote-conf-num' }, v.confidence, h('small', null, '%')), confidenceMeter(v.confidence, v.vote))),
      h('p', { class: 'vote-reason' }, v.core_reason),
      v.conditions.length ? h('div', { class: 'vote-block' }, h('h4', null, '前提'), h('ul', { class: 'bullets' }, v.conditions.map(c => h('li', null, c)))) : null,
      v.risks.length ? h('div', { class: 'vote-block' }, h('h4', null, '风险'), h('ul', { class: 'vote-risks' }, v.risks.map(risk =>
        h('li', null, severityChip(risk.severity), h('span', { class: 'vote-risk-cat' }, risk.category), h('span', null, risk.risk))))) : null,
      v.flip_condition ? h('div', { class: 'vote-block' }, h('h4', null, '改票条件'), h('p', null, v.flip_condition)) : null,
      v.sources?.length ? h('div', { class: 'vote-block' }, h('h4', null, '来源'), sourceList(v.sources, v.voter === 'user' ? [] : r?.sourceOverlap?.sharedSites ?? [])) : null);
  }

  function sourceList(sources: Source[], shared: string[]) {
    return h('ol', { class: 'source-list' }, sources.map(src => h('li', { class: ['source', onSite(src.url, shared) ? 'is-shared' : ''] },
      h('p', { class: 'source-claim' }, src.claim),
      h('p', { class: 'source-meta' },
        h('a', { class: 'source-link', href: src.url, target: '_blank', rel: 'noopener noreferrer', title: src.url },
          siteName(src.url), icon('external')),
        onSite(src.url, shared) ? h('span', { class: 'mini-tag tag-shared' }, '共同') : null))));
  }

  // ── 信源对比（仅联网题）──────────────────────────────
  function sourcesSection(d: Detail, r: Result) {
    if (!d.needsWeb) return null;
    const o = r.sourceOverlap;
    const head = sectionHead('信源对比', o ? h('span', { class: 'section-count' }, Math.round(o.score * 100) + '%') : null, 'sources-title');
    if (!o) {
      return h('section', { class: 'section', 'aria-labelledby': 'sources-title' }, head,
        h('p', { class: 'muted-text' }, '有模型缺席，未比较。'));
    }
    const bar = h('span', { class: 'overlap-fill' });
    bar.style.setProperty('--pct', o.score * 100 + '%');
    return h('section', { class: 'section', 'aria-labelledby': 'sources-title' }, head,
      o.warning ? notice('warn', o.warning) : null,
      h('div', { class: ['overlap', o.warning ? 'is-high' : ''] },
        h('div', { class: 'overlap-score' },
          h('span', { class: 'overlap-num' }, o.sharedSites.length, h('small', null, ' / ' + o.totalSites)),
          h('span', { class: 'overlap-label' }, '共同网站 / 两家网站')),
        h('span', { class: 'overlap-bar', role: 'img', 'aria-label': '重叠 ' + Math.round(o.score * 100) + '%，阈值 67%' }, bar, h('i', { class: 'overlap-mark' })),
        o.sharedSites.length
          ? h('ul', { class: 'overlap-sites' }, o.sharedSites.map(site => h('li', null, site)))
          : h('p', { class: 'muted-text' }, '没有共同网站。')));
  }

  // ── 少数派 ───────────────────────────────────────
  function minoritySection(d: Detail, r: Result) {
    const valid = d.votes.filter(isValid);
    const dissenters = valid.filter(v => r.tally.dissenters.includes(v.voter));
    let body: Child;
    if (dissenters.length) {
      body = h('div', { class: 'minority-list' }, dissenters.map(v => h('blockquote', { class: 'minority' },
        h('div', { class: 'minority-head' }, voterLabel(v.voter), h('span', null, '投了'), answerTag(v.vote), h('span', { class: 'conf-chip' }, '置信 ' + v.confidence)),
        h('p', { class: 'minority-reason' }, v.core_reason),
        v.flip_condition ? h('p', { class: 'minority-flip' }, h('span', null, '改票条件'), v.flip_condition) : null)));
    } else if (r.tally.yes === r.tally.no && valid.length > 1) {
      body = h('p', { class: 'muted-text' }, '票数打平。');
    } else if (valid.length === 1) {
      body = h('p', { class: 'muted-text' }, '只有一张有效票。');
    } else {
      body = h('p', { class: 'muted-text' }, '意见一致。');
    }
    return h('section', { class: 'section', 'aria-labelledby': 'minority-title' }, sectionHead('少数派理由', null, 'minority-title'), body);
  }

  // ── 风险检查 ─────────────────────────────────────
  function risksSection(d: Detail, r: Result) {
    if (!r.risks.length) {
      return h('section', { class: 'section', 'aria-labelledby': 'risks-title' }, sectionHead('风险检查', null, 'risks-title'),
        h('p', { class: 'muted-text' }, '三方都没有提出风险。'));
    }
    const fatal = r.risks.filter(x => x.severity === '致命');
    const done = r.risks.filter(x => x.checkDone).length;
    const shown = state.showAllRisks ? r.risks : r.risks.filter(x => x.visible || x.severity === '致命');
    const hidden = r.risks.length - shown.length;
    const toggle = hidden > 0 || state.showAllRisks
      ? h('button', { class: 'btn btn-ghost btn-sm', type: 'button', onclick: () => { state.showAllRisks = !state.showAllRisks; render(); } },
        state.showAllRisks ? '收起' : '显示其余 ' + hidden + ' 条', icon('down', state.showAllRisks ? 'icon flip' : 'icon'))
      : null;
    return h('section', { class: 'section', 'aria-labelledby': 'risks-title' },
      sectionHead('风险检查', h('span', { class: 'section-count' }, '已检查 ' + done + ' / ' + r.risks.length), 'risks-title'),
      fatal.length && d.status !== 'paused' ? notice(d.reversibility === '不可逆' ? 'danger' : 'warn',
        '有 ' + fatal.length + ' 条致命风险') : null,
      h('ol', { class: 'risk-list' }, shown.map(risk => h('li', null, riskItem(d, risk, false)))),
      toggle);
  }

  function riskItem(d: Detail, risk: MergedRisk, emphasise: boolean) {
    const action = risk.checkDone
      ? h('span', { class: 'check-done' }, icon('check'), '已检查')
      : (() => {
        const button = h('button', { class: ['btn', emphasise ? 'btn-primary' : 'btn-secondary', 'btn-sm'], type: 'button' }, icon('check'), emphasise ? '已完成检查' : '标记已检查');
        button.addEventListener('click', async () => {
          if (emphasise) {
            const ok = await openDialog({
              title: '确认已完成检查？', tone: 'warn',
              body: h('div', { class: 'prose prose-sm' }, h('p', null, risk.check), h('p', null, '标记后不能撤销。')),
              actions: [{ label: '还没有', value: '', kind: 'ghost' }, { label: '已完成', value: 'ok', kind: 'primary' }],
            });
            if (ok !== 'ok') return;
          }
          await withBusy(button, '保存中…', async () => {
            try {
              await api.check(d.id, risk.id);
              toast('已标记：' + risk.check);
              await refresh();
            } catch (err) {
              toast(errorMessage(err), 'error');
            }
          });
        });
        return button;
      })();
    const sevKey = { 致命: 'fatal', 高: 'high', 中: 'mid', 低: 'low' }[risk.severity];
    return h('div', { class: ['risk-item', 'sev-row-' + sevKey, risk.checkDone ? 'is-done' : ''] },
      h('div', { class: 'risk-tags' },
        severityChip(risk.severity),
        h('span', { class: 'risk-cat' }, risk.category),
        h('span', { class: 'risk-mention' }, risk.mentionLabel),
        risk.fromDissent ? h('span', { class: 'mini-tag tag-dissent' }, '来自少数派') : null,
        h('span', { class: 'risk-voter' }, voterLabel(risk.voter))),
      h('p', { class: 'risk-text' }, risk.risk),
      h('div', { class: 'risk-check-row' },
        h('p', { class: 'risk-check' }, h('span', { class: 'risk-check-label' }, '检查'), risk.check),
        action));
  }

  function conditionsSection(r: Result) {
    return h('section', { class: 'section', 'aria-labelledby': 'cond-title' },
      sectionHead('「是」成立的前提', null, 'cond-title'),
      h('ul', { class: 'condition-list' }, r.conditions.map(c => h('li', null, h('span', { class: 'risk-voter' }, voterLabel(c.voter)), h('span', null, c.text)))));
  }

  // ── 事后复盘 ─────────────────────────────────────
  function outcomeSection(d: Detail) {
    const o = d.outcome;
    const head = sectionHead('事后复盘', o ? h('span', { class: 'section-count' }, '记录于 ' + formatDateTime(o.recordedAt, false)) : null, 'outcome-title');
    if (o && !state.editingOutcome) {
      const valid = d.votes.filter(isValid);
      const verdicts = o.correctAnswer === '说不清'
        ? h('p', { class: 'muted-text' }, '不计入准确率。')
        : h('ul', { class: 'scoreboard' }, valid.map(v => h('li', { class: v.vote === o.correctAnswer ? 'is-right' : 'is-wrong' },
          voterLabel(v.voter), answerTag(v.vote), h('span', { class: 'score-mark' }, v.vote === o.correctAnswer ? '判断正确' : '判断有误'))));
      return h('section', { class: 'section outcome', 'aria-labelledby': 'outcome-title' }, head,
        h('div', { class: 'outcome-record' },
          h('div', { class: 'outcome-answer' }, h('span', { class: 'eyebrow' }, '正确答案'), answerTag(o.correctAnswer, 'answer-lg')),
          o.note ? paragraphs(o.note, 'prose outcome-note') : null,
          verdicts,
          h('button', { class: 'btn btn-ghost btn-sm', type: 'button', onclick: () => { state.editingOutcome = true; render(); } }, icon('edit'), '修改复盘')));
    }
    const name = nextId('outcome');
    const errorEl = h('p', { class: 'field-error', hidden: true, role: 'alert' });
    const noteId = nextId('onote');
    const note = h('textarea', { id: noteId, class: 'input textarea textarea-long', rows: '4', placeholder: '实际发生了什么' });
    note.value = state.outcomeNote;
    autosize(note);
    note.addEventListener('input', () => { state.outcomeNote = note.value; });
    const submit = h('button', { class: 'btn btn-primary', type: 'submit' }, o ? '更新复盘' : '保存复盘');
    const cancel = o ? h('button', { class: 'btn btn-ghost', type: 'button', onclick: () => { state.editingOutcome = false; render(); } }, '取消') : null;
    const form = h('form', { class: 'outcome-form', novalidate: true },
      h('fieldset', { class: 'fieldset' },
        h('legend', { class: 'label' }, '正确答案'),
        h('div', { class: 'segmented' }, (['是', '否', '说不清'] as const).map(value => {
          const input = h('input', { type: 'radio', name, value, class: 'visually-hidden', checked: state.outcomeChoice === value });
          input.addEventListener('change', () => { state.outcomeChoice = value; errorEl.hidden = true; });
          return h('label', { class: ['segment', 'segment-' + (value === '是' ? 'yes' : value === '否' ? 'no' : 'unclear')] }, input, h('span', null, value));
        }))),
      h('div', { class: 'field' }, h('div', { class: 'label-row' }, h('label', { class: 'label', for: noteId }, '复盘笔记'), h('span', { class: 'optional' }, '可选')), note),
      errorEl,
      h('div', { class: 'form-actions' }, submit, cancel));
    form.addEventListener('submit', event => {
      event.preventDefault();
      const answer = state.outcomeChoice;
      if (!answer) {
        errorEl.textContent = '请选择正确答案。';
        errorEl.hidden = false;
        return;
      }
      void withBusy(submit, '保存中…', async () => {
        try {
          await api.outcome(d.id, answer, state.outcomeNote.trim() || undefined);
          state.editingOutcome = false;
          toast('复盘已保存');
          await refresh();
        } catch (err) {
          errorEl.textContent = errorMessage(err);
          errorEl.hidden = false;
        }
      });
    });
    return h('section', { class: 'section outcome', 'aria-labelledby': 'outcome-title' }, head,
      form);
  }

  function followUpSection(d: Detail) {
    return h('section', { class: 'follow-up' },
      h('h2', { class: 'follow-up-title' }, '有新信息？'),
      h('a', { class: 'btn btn-secondary', href: '/ask?parent=' + d.id }, icon('branch'), '带新信息追问'));
  }

  // ── 问题材料 ─────────────────────────────────────
  function materialSection(d: Detail) {
    const total = charCount(d.background) + charCount(d.goals) + charCount(d.newInfo ?? '');
    const long = total > MATERIAL_PREVIEW_CHARS * 2;
    const open = state.materialOpen || !long;
    const blocks = [
      d.newInfo ? h('div', { class: 'material-block material-new' }, h('h3', null, '新增信息'), paragraphs(d.newInfo)) : null,
      h('div', { class: 'material-block' }, h('h3', null, '背景'), d.background.trim() ? paragraphs(d.background) : h('p', { class: 'muted-text' }, '未填写')),
      h('div', { class: 'material-block' }, h('h3', null, '目标与约束'), d.goals.trim() ? paragraphs(d.goals) : h('p', { class: 'muted-text' }, '未填写')),
    ];
    const body = h('div', { class: ['material', open ? 'is-open' : 'is-clipped'] }, blocks);
    const toggle = long ? h('button', {
      class: 'btn btn-ghost btn-sm material-toggle', type: 'button', 'aria-expanded': String(open),
      onclick: () => { state.materialOpen = !state.materialOpen; render(); },
    }, open ? '收起材料' : '展开全部材料', icon('down', open ? 'icon flip' : 'icon')) : null;
    return h('section', { class: 'section', 'aria-labelledby': 'material-title' },
      sectionHead('问题材料', null, 'material-title'), body, toggle);
  }

  root.append(loadingPage('正在载入表决…'));
  void fetchDetail(true);
  return root;
}
