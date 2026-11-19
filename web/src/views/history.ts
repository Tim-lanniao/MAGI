import { api, errorMessage, isAbort } from '../api';
import { fill, h } from '../dom';
import { monthKey, relativeTime, statusLabel } from '../format';
import { icon } from '../icons';
import type { RouteContext } from '../router';
import type { HistoryItem } from '../types';
import { answerTag, emptyState, errorState, notice, pageHeader, seal, skeleton, statusChip, withBusy } from '../ui';

const PAGE_SIZE = 20;

// 返回列表时先用内存中的上一页结果渲染，便于恢复滚动位置，再在后台刷新。
let cache: { items: HistoryItem[]; nextCursor: string | null } | null = null;

export function historyView(ctx: RouteContext) {
  ctx.setTitle('记录');
  const page = h('div', { class: 'page page-history' });
  const listHost = h('div', { class: 'history-host' });
  const more = h('div', { class: 'load-more' });
  page.append(pageHeader({
    title: '记录',
    code: 'ARCHIVE · 表决档案',
    actions: h('a', { class: 'btn btn-primary btn-sm', href: '/' }, icon('plus'), '新决策'),
  }), listHost, more);

  let items: HistoryItem[] = [];
  let nextCursor: string | null = null;

  function render() {
    if (!items.length) {
      listHost.replaceChildren(emptyState({
        icon: 'history', title: '还没有表决记录',
        action: h('a', { class: 'btn btn-primary', href: '/' }, icon('plus'), '发起第一次表决'),
      }));
      more.replaceChildren();
      return;
    }
    const groups = new Map<string, HistoryItem[]>();
    for (const item of items) {
      const key = monthKey(item.createdAt);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(item);
    }
    fill(listHost,
      ...Array.from(groups, ([month, group]) => h('section', { class: 'history-group' },
        h('h2', { class: 'history-month' }, month, h('span', { class: 'history-month-count' }, group.length + ' 条')),
        h('ul', { class: 'history-list' }, group.map(row)))));
    renderMore();
  }

  function renderMore() {
    if (!nextCursor) {
      more.replaceChildren(h('p', { class: 'list-end' }, '已显示全部 ' + items.length + ' 条'));
      return;
    }
    const button = h('button', { class: 'btn btn-secondary', type: 'button' }, '加载更早的记录');
    button.addEventListener('click', () => withBusy(button, '正在加载…', async () => {
      try {
        const next = await api.history(PAGE_SIZE, nextCursor, ctx.signal);
        items = items.concat(next.items);
        nextCursor = next.nextCursor;
        cache = { items, nextCursor };
        render();
      } catch (err) {
        if (isAbort(err)) return;
        more.append(notice('danger', errorMessage(err)));
      }
    }));
    more.replaceChildren(button);
  }

  function load() {
    api.history(PAGE_SIZE, null, ctx.signal).then(first => {
      // 已经展开过更多页时保留，避免刷新后丢失位置。
      const known = cache && cache.items.length > first.items.length ? cache : null;
      if (known && known.items[0]?.id === first.items[0]?.id) {
        items = first.items.concat(known.items.slice(first.items.length));
        nextCursor = known.nextCursor;
      } else {
        items = first.items;
        nextCursor = first.nextCursor;
      }
      cache = { items, nextCursor };
      render();
    }).catch(err => {
      if (isAbort(err)) return;
      if (cache) return; // 已有缓存内容时保持显示
      listHost.replaceChildren(errorState(err, () => { listHost.replaceChildren(listSkeleton()); load(); }));
    });
  }

  if (cache) {
    items = cache.items;
    nextCursor = cache.nextCursor;
    render();
  } else {
    listHost.append(listSkeleton());
  }
  load();
  return page;
}

function listSkeleton() {
  return h('div', { class: 'history-skeleton', role: 'status', 'aria-label': '正在载入记录' },
    Array.from({ length: 5 }, () => h('div', { class: 'skeleton-row' }, h('span', { class: 'skeleton-seal' }), skeleton(2))));
}

const statusHint: Partial<Record<HistoryItem['status'], string>> = {
  running: '两家正在表决',
  paused: '致命风险待检查',
  needs_confirmation: '等你确认最终答案',
  failed: '两家缺席，可重试',
};

function row(item: HistoryItem) {
  const decided = item.status === 'decided';
  return h('li', null, h('a', { class: ['history-item', 'is-' + item.status], href: '/q/' + item.id },
    h('div', { class: 'history-mark' }, decided ? seal(item.finalDecision, 'sm') : statusChip(item.status)),
    h('div', { class: 'history-body' },
      h('p', { class: 'history-q' }, item.question),
      h('div', { class: 'history-meta' },
        h('span', null, relativeTime(item.createdAt)),
        h('span', { class: item.reversibility === '不可逆' ? 'meta-irreversible' : '' }, item.reversibility),
        item.parentId ? h('span', { class: 'meta-follow' }, icon('branch'), '追问') : null,
        decided ? h('span', { class: 'history-final' }, '决定 ', answerTag(item.finalDecision)) : h('span', { class: 'history-pending' }, statusHint[item.status] ?? statusLabel[item.status]))),
    icon('forward', 'icon history-arrow')));
}
