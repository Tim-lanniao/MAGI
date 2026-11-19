export interface RouteContext {
  params: Record<string, string>;
  query: URLSearchParams;
  /** 离开页面时中止，用于取消请求与轮询。 */
  signal: AbortSignal;
  setTitle(title: string): void;
}

export type ViewFactory = (ctx: RouteContext) => HTMLElement;

interface Route {
  pattern: RegExp;
  keys: string[];
  view: ViewFactory;
  name: string;
  public?: boolean;
}

const routes: Route[] = [];

export function route(path: string, name: string, view: ViewFactory, options: { public?: boolean } = {}) {
  const keys: string[] = [];
  const source = path.replace(/:([a-zA-Z]+)/g, (_m, key: string) => {
    keys.push(key);
    return '([^/]+)';
  });
  routes.push({ pattern: new RegExp('^' + source + '/?$'), keys, view, name, public: options.public });
}

export function match(pathname: string) {
  for (const r of routes) {
    const m = r.pattern.exec(pathname);
    if (!m) continue;
    const params: Record<string, string> = {};
    r.keys.forEach((key, i) => { params[key] = decodeURIComponent(m[i + 1]); });
    return { route: r, params };
  }
  return null;
}

type Listener = () => void;
let listener: Listener = () => {};
export function onNavigate(fn: Listener) {
  listener = fn;
}

const scrollPositions = new Map<string, number>();
let entryKey = (history.state as { key?: string } | null)?.key ?? Math.random().toString(36).slice(2);
if (!history.state?.key) history.replaceState({ key: entryKey }, '');
if ('scrollRestoration' in history) history.scrollRestoration = 'manual';

export let restoreScroll: number | null = null;

export function navigate(to: string, options: { replace?: boolean } = {}) {
  const url = new URL(to, location.href);
  if (url.origin !== location.origin) {
    location.href = to;
    return;
  }
  scrollPositions.set(entryKey, window.scrollY);
  entryKey = Math.random().toString(36).slice(2);
  if (options.replace) history.replaceState({ key: entryKey }, '', url.pathname + url.search + url.hash);
  else history.pushState({ key: entryKey }, '', url.pathname + url.search + url.hash);
  restoreScroll = 0;
  listener();
}

window.addEventListener('popstate', event => {
  scrollPositions.set(entryKey, window.scrollY);
  entryKey = (event.state as { key?: string } | null)?.key ?? Math.random().toString(36).slice(2);
  restoreScroll = scrollPositions.get(entryKey) ?? 0;
  listener();
});

/** 拦截站内链接，交给前端路由处理。 */
document.addEventListener('click', event => {
  if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  const anchor = (event.target as Element | null)?.closest?.('a');
  if (!anchor || anchor.target || anchor.hasAttribute('download') || anchor.dataset.external !== undefined) return;
  const href = anchor.getAttribute('href');
  if (!href || !href.startsWith('/') || href.startsWith('//') || href.startsWith('/api/')) return;
  event.preventDefault();
  navigate(href);
});
