import { h, nextId, type Child } from './dom';
import { brandIcon, icon, type IconName } from './icons';
import { statusLabel, voterName } from './format';
import { errorMessage, ApiError } from './api';
import type { Answer, OutcomeAnswer, Severity, Status, Voter } from './types';

function setBusy(button: HTMLButtonElement, busy: boolean, busyLabel?: string) {
  button.disabled = busy;
  button.classList.toggle('is-busy', busy);
  if (busy) {
    button.setAttribute('aria-busy', 'true');
    if (busyLabel) button.replaceChildren(h('span', { class: 'spinner', 'aria-hidden': 'true' }), busyLabel);
  } else {
    button.removeAttribute('aria-busy');
  }
}

/** 包装一个异步按钮动作：禁用、显示进度，结束后恢复原内容。 */
export async function withBusy<T>(button: HTMLButtonElement, busyLabel: string, task: () => Promise<T>): Promise<T> {
  const original = Array.from(button.childNodes);
  setBusy(button, true, busyLabel);
  try {
    return await task();
  } finally {
    if (button.isConnected) {
      button.replaceChildren(...original);
      setBusy(button, false);
    }
  }
}

export function voterBadge(voter: Voter, size: 'sm' | 'md' = 'md') {
  // 本人用人形图标，两家模型用各自的标志。
  return h('span', { class: ['voter-badge', 'voter-' + voter, 'size-' + size], 'aria-hidden': 'true' },
    voter === 'user' ? icon('user', 'icon voter-icon') : brandIcon(voter, 'brand-icon voter-icon'));
}

/** 本人显示「我」；两家模型只显示标志，名称留给读屏与悬停提示。 */
export function voterLabel(voter: Voter) {
  if (voter === 'user') return h('span', { class: 'voter-label' }, voterBadge(voter, 'sm'), h('span', null, voterName[voter]));
  return h('span', { class: 'voter-label', title: voterName[voter] }, voterBadge(voter, 'sm'), h('span', { class: 'visually-hidden' }, voterName[voter]));
}

export function answerTag(answer: OutcomeAnswer | null, extra = '') {
  if (!answer) return h('span', { class: 'answer-tag answer-none ' + extra }, '—');
  const kind = answer === '是' ? 'yes' : answer === '否' ? 'no' : 'unclear';
  return h('span', { class: ['answer-tag', 'answer-' + kind, extra] }, answer);
}

export function statusChip(status: Status) {
  return h('span', { class: ['chip', 'status-' + status] }, h('span', { class: 'chip-dot', 'aria-hidden': 'true' }), statusLabel[status]);
}

export function severityChip(severity: Severity) {
  const kind = { 致命: 'fatal', 高: 'high', 中: 'mid', 低: 'low' }[severity];
  return h('span', { class: ['sev', 'sev-' + kind] }, severity);
}

/** 六边形决议徽记：最终决定在列表、追问卡片等处的缩略呈现。 */
export function seal(answer: Answer | null, size: 'lg' | 'sm' = 'lg', label?: string) {
  if (!answer) {
    return h('div', { class: ['seal', 'seal-' + size, 'seal-empty'], role: 'img', 'aria-label': label ?? '尚无结论' }, h('span', null, '—'));
  }
  return h('div', { class: ['seal', 'seal-' + size, answer === '是' ? 'seal-yes' : 'seal-no'], role: 'img', 'aria-label': label ?? '最终决定：' + answer },
    h('span', null, answer));
}

/** 置信度 50–100 以 10 格信号条呈现，每格 5 点。 */
export function confidenceMeter(value: number, answer?: Answer) {
  const lit = Math.max(0, Math.min(10, Math.round((value - 50) / 5)));
  return h('span', { class: ['meter', answer === '是' ? 'meter-yes' : answer === '否' ? 'meter-no' : ''], role: 'img', 'aria-label': '置信度 ' + value },
    Array.from({ length: 10 }, (_, i) => h('i', { class: i < lit ? 'on' : '' })));
}

export function skeleton(lines = 3, className = '') {
  return h('div', { class: ['skeleton-block', className], 'aria-hidden': 'true' },
    Array.from({ length: lines }, (_, i) => h('span', { class: ['skeleton-line', i === lines - 1 ? 'short' : ''] })));
}

export function loadingPage(label = '正在载入…') {
  return h('div', { class: 'page-loading', role: 'status', 'aria-live': 'polite' },
    h('span', { class: 'visually-hidden' }, label),
    h('div', { class: 'skeleton-title', 'aria-hidden': 'true' }),
    skeleton(2),
    h('div', { class: 'skeleton-card', 'aria-hidden': 'true' }, skeleton(4)),
    h('div', { class: 'skeleton-card', 'aria-hidden': 'true' }, skeleton(3)));
}

export function emptyState(opts: { icon: IconName; title: string; body?: Child; action?: Child }) {
  return h('div', { class: 'empty-state' },
    h('div', { class: 'empty-code', 'aria-hidden': 'true' }, 'NO RECORD'),
    h('div', { class: 'empty-icon' }, icon(opts.icon)),
    h('h2', { class: 'empty-title' }, opts.title),
    opts.body ? h('div', { class: 'empty-body' }, opts.body) : null,
    opts.action ? h('div', { class: 'empty-action' }, opts.action) : null);
}

export function errorState(err: unknown, retry?: () => void, title = '加载失败') {
  const notFound = err instanceof ApiError && err.status === 404;
  return h('div', { class: 'empty-state is-error', role: 'alert' },
    h('div', { class: 'empty-code', 'aria-hidden': 'true' }, notFound ? 'ERROR 404 · NOT FOUND' : 'SIGNAL LOST'),
    h('div', { class: 'empty-icon' }, icon(notFound ? 'info' : 'alert')),
    h('h2', { class: 'empty-title' }, notFound ? '找不到这条记录' : title),
    h('div', { class: 'empty-body' }, errorMessage(err)),
    h('div', { class: 'empty-action' },
      retry && !notFound ? h('button', { class: 'btn btn-secondary', type: 'button', onclick: retry }, icon('refresh'), '重试') : null,
      notFound ? h('a', { class: 'btn btn-secondary', href: '/history' }, '返回记录') : null));
}

export function notice(kind: 'info' | 'warn' | 'danger' | 'ok', ...children: Child[]) {
  const name: IconName = kind === 'ok' ? 'check' : kind === 'info' ? 'info' : 'alert';
  return h('div', { class: ['notice', 'notice-' + kind], role: kind === 'danger' ? 'alert' : undefined },
    icon(name, 'icon notice-icon'), h('div', { class: 'notice-body' }, children));
}

export function inlineError(target: HTMLElement | null, message: string | null) {
  if (!target) return;
  target.textContent = message ?? '';
  target.hidden = !message;
}

let toastRegion: HTMLElement | null = null;
export function toast(message: string, kind: 'ok' | 'error' = 'ok') {
  if (!toastRegion) {
    toastRegion = h('div', { class: 'toasts', role: 'status', 'aria-live': 'polite' });
    document.body.append(toastRegion);
  }
  const item = h('div', { class: ['toast', 'toast-' + kind] }, icon(kind === 'ok' ? 'check' : 'alert'), h('span', null, message));
  toastRegion.append(item);
  window.setTimeout(() => {
    item.classList.add('leaving');
    window.setTimeout(() => item.remove(), 300);
  }, kind === 'error' ? 5000 : 2800);
}

export interface DialogAction {
  label: string;
  value: string;
  kind?: 'primary' | 'secondary' | 'danger' | 'ghost';
}

/** 原生 <dialog> 模态框，返回所选按钮的 value；按 Esc 或点击遮罩返回 null。 */
export function openDialog(opts: { title: string; body: Child; actions: DialogAction[]; tone?: 'default' | 'warn' | 'danger' }): Promise<string | null> {
  return new Promise(resolve => {
    const titleId = nextId('dlg');
    const dialog = h('dialog', { class: ['dialog', 'tone-' + (opts.tone ?? 'default')], 'aria-labelledby': titleId },
      h('form', { method: 'dialog', class: 'dialog-inner' },
        h('h2', { id: titleId, class: 'dialog-title' }, opts.title),
        h('div', { class: 'dialog-body' }, opts.body),
        h('div', { class: 'dialog-actions' }, opts.actions.map(a =>
          h('button', { class: ['btn', 'btn-' + (a.kind ?? 'secondary')], value: a.value }, a.label)))));
    dialog.addEventListener('click', event => {
      if (event.target === dialog) dialog.close('');
    });
    dialog.addEventListener('close', () => {
      resolve(dialog.returnValue || null);
      dialog.remove();
    });
    document.body.append(dialog);
    dialog.showModal();
    const primary = dialog.querySelector<HTMLButtonElement>('.btn-primary, .btn-danger');
    primary?.focus();
  });
}

/** 页头：上方是等宽英文代号（装饰，读屏跳过），下方是压缩粗体中文标题。 */
export function pageHeader(opts: { title: string; code?: string; eyebrow?: Child; lead?: Child; actions?: Child; back?: { href: string; label: string } }) {
  return h('header', { class: 'page-header' },
    opts.back ? h('a', { class: 'back-link', href: opts.back.href }, icon('back'), opts.back.label) : null,
    opts.code ? h('div', { class: 'page-code', 'aria-hidden': 'true' }, h('span', { class: 'code-tick' }), opts.code) : null,
    opts.eyebrow ? h('div', { class: 'eyebrow' }, opts.eyebrow) : null,
    h('div', { class: 'page-title-row' },
      h('h1', { class: 'page-title', tabindex: '-1' }, opts.title),
      opts.actions ? h('div', { class: 'page-actions' }, opts.actions) : null),
    opts.lead ? h('p', { class: 'page-lead' }, opts.lead) : null);
}

const sectionCodes: Record<string, string> = {
  三方票: 'VOTES', 少数派理由: 'MINORITY REPORT', 风险检查: 'RISK AUDIT', '「是」成立的前提': 'PRECONDITIONS',
  事后复盘: 'POST-MORTEM', 问题材料: 'DOSSIER', 我的票: 'SEAT·01', 置信度校准: 'CALIBRATION',
  Passkey: 'ACCESS KEYS', 本次会话: 'SESSION', 模型: 'MODELS', 信源对比: 'SOURCES',
};

export function sectionHead(title: string, aside?: Child, id?: string) {
  const code = sectionCodes[title];
  return h('div', { class: 'section-head' },
    code ? h('span', { class: 'section-code', 'aria-hidden': 'true' }, code) : null,
    h('h2', { class: 'section-title', id }, title),
    h('span', { class: 'section-rule', 'aria-hidden': 'true' }),
    aside ? h('div', { class: 'section-aside' }, aside) : null);
}
