import { api, ApiError, setUnauthorizedHandler } from './api';
import { h } from './dom';
import { icon, type IconName } from './icons';
import { match, navigate, onNavigate, restoreScroll, route, type RouteContext } from './router';
import { appState, markSignedIn, markSignedOut } from './state';
import { emptyState, errorState } from './ui';
import { askView } from './views/ask';
import { loginView, setupView } from './views/auth';
import { detailView } from './views/detail';
import { historyView } from './views/history';
import { settingsView } from './views/settings';
import { statsView } from './views/stats';

route('/', 'ask', askView);
route('/ask', 'ask', askView);
route('/q/:id', 'detail', detailView);
route('/history', 'history', historyView);
route('/stats', 'stats', statsView);
route('/settings', 'settings', settingsView);
route('/devices', 'settings', settingsView); // 旧书签
route('/login', 'login', loginView, { public: true });
route('/setup', 'setup', setupView, { public: true });

const root = document.getElementById('app')!;

const navItems: { href: string; label: string; icon: IconName; names: string[] }[] = [
  { href: '/', label: '新决策', icon: 'plus', names: ['ask'] },
  { href: '/history', label: '记录', icon: 'list', names: ['history', 'detail'] },
  { href: '/stats', label: '统计', icon: 'chart', names: ['stats'] },
  { href: '/settings', label: '设置', icon: 'settings', names: ['settings'] },
];

const navLinks = navItems.map(item =>
  h('a', { class: 'nav-link', href: item.href, dataset: { names: item.names.join(' ') } },
    icon(item.icon, 'icon nav-icon'), h('span', { class: 'nav-text' }, item.label)));

const offlineBar = h('div', { class: 'offline-bar', role: 'status', hidden: navigator.onLine },
  icon('alert'), '网络已断开，恢复后可继续操作。');
window.addEventListener('online', () => { offlineBar.hidden = true; });
window.addEventListener('offline', () => { offlineBar.hidden = false; });

const main = h('main', { id: 'main', class: 'main' });
const header = h('header', { class: 'app-header' },
  h('div', { class: 'app-header-inner' },
    h('a', { class: 'brand', href: '/', 'aria-label': 'MAGI 首页' },
      h('span', { class: 'brand-mark', 'aria-hidden': 'true' }, h('i'), h('i'), h('i')),
      h('span', { class: 'brand-name' }, 'MAGI'),
      h('span', { class: 'brand-sub' }, 'TRI-VOTE · 三方表决')),
    h('nav', { class: 'app-nav', 'aria-label': '主导航' }, navLinks)));

const shell = h('div', { class: 'shell' },
  h('a', { class: 'skip-link', href: '#main' }, '跳到正文'),
  offlineBar, header, main);

let controller: AbortController | null = null;

function setTitle(title: string) {
  document.title = title ? title + ' · MAGI' : 'MAGI';
}

function notFound() {
  setTitle('页面不存在');
  return h('div', { class: 'page' }, emptyState({
    icon: 'info', title: '页面不存在',
    body: '链接可能有误，或页面已经移动。',
    action: h('a', { class: 'btn btn-primary', href: '/' }, '返回首页'),
  }));
}

function render() {
  controller?.abort();
  controller = new AbortController();
  const path = location.pathname;
  const found = match(path);
  const isPublic = found?.route.public ?? false;

  if (found?.route.name === 'login' && appState.auth === 'in') {
    navigate(new URLSearchParams(location.search).get('next') ?? '/', { replace: true });
    return;
  }
  if (!isPublic && appState.auth !== 'in') {
    navigate('/login?next=' + encodeURIComponent(path + location.search), { replace: true });
    return;
  }

  const ctx: RouteContext = {
    params: found?.params ?? {},
    query: new URLSearchParams(location.search),
    signal: controller.signal,
    setTitle,
  };
  const view = found ? found.route.view(ctx) : notFound();

  const bare = isPublic;
  root.classList.remove('boot');
  root.classList.toggle('is-bare', bare);
  if (bare) {
    root.replaceChildren(h('main', { id: 'main', class: 'main main-bare' }, view));
  } else {
    if (shell.parentNode !== root) root.replaceChildren(shell);
    main.replaceChildren(view);
    const name = found?.route.name ?? '';
    for (const link of navLinks) {
      const active = (link.dataset.names ?? '').split(' ').includes(name);
      if (active) link.setAttribute('aria-current', 'page');
      else link.removeAttribute('aria-current');
    }
  }
  window.scrollTo(0, restoreScroll ?? 0);
  const heading = view.querySelector<HTMLElement>('h1');
  if (heading && document.activeElement !== heading && restoreScroll === 0) {
    heading.setAttribute('tabindex', '-1');
    heading.focus({ preventScroll: true });
  }
}

onNavigate(render);

setUnauthorizedHandler(() => {
  if (appState.auth === 'out') return;
  markSignedOut('登录已过期，请重新用 Passkey 登录。');
  const here = location.pathname + location.search;
  navigate('/login?next=' + encodeURIComponent(here), { replace: true });
});

async function boot() {
  const path = location.pathname;
  // 邀请注册页无需会话，先渲染以尽快移除地址栏中的令牌。
  if (path === '/setup' || path === '/setup/') {
    api.me().then(() => markSignedIn(), () => markSignedOut());
    render();
    return;
  }
  try {
    await api.me();
    markSignedIn();
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) markSignedOut();
    else if (err instanceof ApiError && err.status === 429) markSignedIn(); // 被限流时乐观进入，后续请求会再次确认会话
    else {
      root.classList.remove('boot');
      root.replaceChildren(h('main', { class: 'main main-bare' }, h('div', { class: 'page auth-page' },
        errorState(err, () => { root.replaceChildren(); boot(); }, '无法连接 MAGI'))));
      return;
    }
  }
  render();
}

boot();
