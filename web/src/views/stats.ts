import { api, isAbort } from '../api';
import { h, s } from '../dom';
import { percent } from '../format';
import type { RouteContext } from '../router';
import type { Stats, VoterStats } from '../types';
import { emptyState, errorState, notice, pageHeader, sectionHead, skeleton, voterLabel } from '../ui';

const SMALL_SAMPLE = 5;

export function statsView(ctx: RouteContext) {
  ctx.setTitle('统计');
  const page = h('div', { class: 'page page-stats' });
  const host = h('div', { class: 'stats-host' },
    h('div', { class: 'stat-tiles', role: 'status', 'aria-label': '正在载入统计' }, [0, 1, 2].map(() => h('div', { class: 'stat-tile' }, skeleton(3)))));
  page.append(pageHeader({
    title: '统计',
    code: 'PERFORMANCE · 判断校准',
  }), host);

  const load = () => {
    api.stats(ctx.signal).then(stats => host.replaceChildren(renderStats(stats))).catch(err => {
      if (isAbort(err)) return;
      host.replaceChildren(errorState(err, load));
    });
  };
  load();
  return page;
}

function renderStats(stats: Stats) {
  const judgedAny = stats.voters.some(v => v.judged > 0);
  if (!judgedAny) {
    return emptyState({
      icon: 'chart', title: '还没有可统计的复盘',
      body: '记录复盘后显示。',
      action: h('a', { class: 'btn btn-primary', href: '/history' }, '去记录里复盘'),
    });
  }
  const maxJudged = Math.max(...stats.voters.map(v => v.judged));
  return h('div', { class: 'stats' },
    maxJudged < SMALL_SAMPLE ? notice('info', '样本较少（' + maxJudged + ' 题），仅供参考。') : null,
    h('div', { class: 'stat-tiles' }, stats.voters.map(tile)),
    h('section', { class: 'section' },
      sectionHead('置信度校准'),
      h('p', { class: 'hint section-hint' }, '点在斜线下方表示过于自信，上方表示偏保守。'),
      calibrationChart(stats),
      calibrationTable(stats)));
}

function tile(v: VoterStats) {
  let gap: HTMLElement | null = null;
  if (v.accuracy !== null && v.avgConfidence !== null) {
    const diff = Math.round(v.avgConfidence - v.accuracy * 100);
    const word = Math.abs(diff) <= 3 ? '把握与结果相符' : diff > 0 ? '偏自信 ' + diff + ' 点' : '偏保守 ' + -diff + ' 点';
    gap = h('span', { class: ['stat-gap', Math.abs(diff) <= 3 ? 'is-even' : diff > 0 ? 'is-over' : 'is-under'] }, word);
  }
  return h('article', { class: ['stat-tile', 'series-' + v.voter] },
    h('div', { class: 'stat-head' }, voterLabel(v.voter), h('span', { class: 'series-key', 'aria-hidden': 'true' })),
    h('p', { class: 'stat-label' }, '准确率'),
    h('p', { class: 'stat-value' }, v.accuracy === null ? '—' : percent(v.accuracy)),
    h('p', { class: 'stat-sub' }, v.judged ? v.judged + ' 题中判断正确 ' + v.correct + ' 题' : '暂无复盘样本'),
    h('div', { class: 'stat-foot' },
      h('span', null, '平均置信 ', h('strong', null, v.avgConfidence === null ? '—' : String(Math.round(v.avgConfidence)))),
      gap));
}

// ── 校准图（SVG，按容器实际宽度以像素绘制，字号不随缩放变化） ──────────
const M = { top: 18, right: 16, bottom: 46, left: 44 };

function calibrationChart(stats: Stats) {
  const bins = stats.voters[0].calibration.map(b => ({ min: b.min, max: b.max }));
  const wrap = h('div', { class: 'chart-wrap' });
  const tooltip = h('div', { class: 'chart-tooltip', hidden: true, role: 'presentation' });
  let drawnWidth = 0;

  function draw(W: number) {
    drawnWidth = W;
    const H = W < 480 ? 240 : 300;
    const innerW = W - M.left - M.right;
    const innerH = H - M.top - M.bottom;
    const band = innerW / bins.length;
    const x = (i: number) => M.left + band * i + band / 2;
    const y = (acc: number) => M.top + innerH * (1 - acc);

    const svg = s('svg', { width: W, height: H, viewBox: `0 0 ${W} ${H}`, class: 'chart-svg', role: 'img', 'aria-labelledby': 'calib-desc' });
    svg.append(s('desc', { id: 'calib-desc' }, '三方在各置信度区间的实际正确率，与完全校准的参考线对比。数值见下方数据表。'));
    for (const tick of [0, 0.25, 0.5, 0.75, 1]) {
      svg.append(s('line', { x1: M.left, x2: W - M.right, y1: y(tick), y2: y(tick), class: 'grid' }),
        s('text', { x: M.left - 8, y: y(tick) + 4, class: 'axis-label', 'text-anchor': 'end' }, Math.round(tick * 100) + '%'));
    }
    bins.forEach((b, i) => {
      svg.append(s('text', { x: x(i), y: H - M.bottom + 20, class: 'axis-label', 'text-anchor': 'middle' }, b.min + '–' + b.max));
    });
    svg.append(s('text', { x: M.left + innerW / 2, y: H - 6, class: 'axis-title', 'text-anchor': 'middle' }, '投票时的置信度'));

    // 完全校准参考线：正确率 = 区间平均置信度。标签放在线的下方，避开 100% 网格线。
    const mid = (i: number) => (bins[i].min + bins[i].max) / 200;
    const last = bins.length - 1;
    svg.append(s('path', { d: bins.map((_, i) => `${i ? 'L' : 'M'}${x(i)},${y(mid(i))}`).join(' '), class: 'ideal-line' }),
      s('text', { x: x(last), y: y(mid(last)) + 18, class: 'ideal-label', 'text-anchor': 'middle' }, '完全校准'));

    // 同一区间里三方的点左右错开，正确率相同时也不会互相遮挡。
    stats.voters.forEach((v, si) => {
      const dx = (si - (stats.voters.length - 1) / 2) * Math.min(10, band / 8);
      const px = (i: number) => x(i) + dx;
      const g = s('g', { class: 'series series-' + v.voter });
      let path = '';
      let pen = false;
      v.calibration.forEach((b, i) => {
        if (b.accuracy === null) { pen = false; return; }
        path += (pen ? 'L' : 'M') + px(i) + ',' + y(b.accuracy) + ' ';
        pen = true;
      });
      if (path) g.append(s('path', { d: path.trim(), class: 'series-line' }));
      v.calibration.forEach((b, i) => {
        if (b.accuracy !== null) g.append(s('circle', { cx: px(i), cy: y(b.accuracy), r: 4.5, class: 'series-dot' }));
      });
      svg.append(g);
    });

    // 每个区间一个悬停热区，提示框同时列出三方。
    const hover = s('line', { class: 'crosshair', y1: M.top, y2: M.top + innerH, x1: 0, x2: 0, visibility: 'hidden' });
    svg.append(hover);
    bins.forEach((b, i) => {
      const zone = s('rect', { x: M.left + band * i, y: M.top, width: band, height: innerH, class: 'hit-zone', tabindex: '0', 'aria-label': '置信度 ' + b.min + '–' + b.max });
      const show = () => {
        hover.setAttribute('x1', String(x(i)));
        hover.setAttribute('x2', String(x(i)));
        hover.setAttribute('visibility', 'visible');
        tooltip.replaceChildren(
          h('p', { class: 'tooltip-title' }, '置信度 ' + b.min + '–' + b.max),
          ...stats.voters.map(v => {
            const bin = v.calibration[i];
            return h('p', { class: 'tooltip-row series-' + v.voter },
              h('span', { class: 'line-key', 'aria-hidden': 'true' }),
              h('strong', null, bin.accuracy === null ? '—' : percent(bin.accuracy)),
              voterLabel(v.voter),
              h('span', null, bin.judged ? bin.correct + '/' + bin.judged + ' 题' : '无样本'));
          }));
        tooltip.hidden = false;
        tooltip.style.setProperty('left', Math.min(Math.max(x(i), 96), W - 96) + 'px');
      };
      const hide = () => { tooltip.hidden = true; hover.setAttribute('visibility', 'hidden'); };
      zone.addEventListener('pointerenter', show);
      zone.addEventListener('pointerleave', hide);
      zone.addEventListener('focus', show);
      zone.addEventListener('blur', hide);
      svg.append(zone);
    });
    tooltip.hidden = true;
    wrap.replaceChildren(svg, tooltip);
  }

  const observer = new ResizeObserver(entries => {
    if (!wrap.isConnected) {
      if (drawnWidth) observer.disconnect(); // 已离开页面
      return;
    }
    const width = Math.floor(entries[0].contentRect.width);
    if (width > 0 && width !== drawnWidth) draw(width);
  });
  observer.observe(wrap);

  const legend = h('ul', { class: 'chart-legend' },
    stats.voters.map(v => h('li', { class: 'series-' + v.voter }, h('span', { class: 'line-key', 'aria-hidden': 'true' }), voterLabel(v.voter))),
    h('li', { class: 'legend-ideal' }, h('span', { class: 'line-key', 'aria-hidden': 'true' }), '完全校准'));
  return h('div', { class: 'card chart-card' }, legend, wrap);
}

function calibrationTable(stats: Stats) {
  const bins = stats.voters[0].calibration;
  return h('details', { class: 'table-details' },
    h('summary', null, '查看数据表'),
    h('div', { class: 'table-scroll' },
      h('table', { class: 'data-table' },
        h('caption', { class: 'visually-hidden' }, '各置信度区间的正确率与平均置信度'),
        h('thead', null, h('tr', null, h('th', { scope: 'col' }, '置信度'), stats.voters.map(v => h('th', { scope: 'col' }, voterLabel(v.voter))))),
        h('tbody', null,
          bins.map((b, i) => h('tr', null,
            h('th', { scope: 'row' }, b.min + '–' + b.max),
            stats.voters.map(v => {
              const bin = v.calibration[i];
              return h('td', null, bin.judged
                ? h('span', null, h('strong', null, percent(bin.accuracy)), h('span', { class: 'cell-sub' }, bin.correct + '/' + bin.judged + ' 题 · 均置信 ' + Math.round(bin.avgConfidence ?? 0)))
                : h('span', { class: 'cell-empty' }, '—'));
            }))),
          h('tr', { class: 'row-total' },
            h('th', { scope: 'row' }, '合计'),
            stats.voters.map(v => h('td', null, v.judged
              ? h('span', null, h('strong', null, percent(v.accuracy)), h('span', { class: 'cell-sub' }, v.correct + '/' + v.judged + ' 题'))
              : h('span', { class: 'cell-empty' }, '—'))))))));
}
