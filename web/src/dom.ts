// 极简的 DOM 构造工具。所有样式都通过类名或 CSSOM 设置，以满足后端 CSP（不允许内联 style 属性）。
export type Child = Node | string | number | null | undefined | false | true | Child[];
export type Props = Record<string, unknown>;

export function cx(...parts: unknown[]): string {
  const out: string[] = [];
  for (const part of parts) {
    if (!part) continue;
    if (typeof part === 'string') out.push(part);
    else if (Array.isArray(part)) out.push(cx(...part));
    else if (typeof part === 'object') {
      for (const [key, on] of Object.entries(part as Record<string, unknown>)) if (on) out.push(key);
    }
  }
  return out.join(' ');
}

function applyProps(el: Element, props: Props) {
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') {
      const name = cx(value);
      if (name) el.setAttribute('class', name);
    } else if (key === 'style') {
      for (const [prop, v] of Object.entries(value as Record<string, string | number>)) {
        (el as HTMLElement).style.setProperty(prop, String(v));
      }
    } else if (key === 'dataset') {
      Object.assign((el as HTMLElement).dataset, value);
    } else if (key === 'ref') {
      (value as (node: Element) => void)(el);
    } else if (key.startsWith('on') && typeof value === 'function') {
      el.addEventListener(key.slice(2).toLowerCase(), value as EventListener);
    } else if (['value', 'checked', 'disabled', 'hidden', 'selected', 'indeterminate', 'open', 'multiple', 'required', 'readOnly'].includes(key)) {
      (el as unknown as Record<string, unknown>)[key] = value;
    } else {
      el.setAttribute(key, value === true ? '' : String(value));
    }
  }
}

export function append(parent: Node, children: Child[]) {
  for (const child of children) {
    if (child === null || child === undefined || child === false || child === true) continue;
    if (Array.isArray(child)) append(parent, child);
    else if (child instanceof Node) parent.appendChild(child);
    else parent.appendChild(document.createTextNode(String(child)));
  }
}

/** replaceChildren 的宽松版本：允许传入 null、false 与数组。 */
export function fill(parent: Element, ...children: Child[]) {
  parent.replaceChildren();
  append(parent, children);
  return parent;
}

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, props?: Props | null, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (props) applyProps(el, props);
  append(el, children);
  return el;
}

const SVG_NS = 'http://www.w3.org/2000/svg';
export function s<K extends keyof SVGElementTagNameMap>(tag: K, props?: Props | null, ...children: Child[]): SVGElementTagNameMap[K] {
  const el = document.createElementNS(SVG_NS, tag);
  if (props) applyProps(el, props);
  append(el, children);
  return el;
}

export function frag(...children: Child[]) {
  const f = document.createDocumentFragment();
  append(f, children);
  return f;
}

/** 将用户输入的长文本按换行拆成段落，保留原有分段。 */
export function paragraphs(text: string, className = 'prose') {
  const lines = text.split(/\r?\n/).map(l => l.trimEnd()).filter(l => l.trim().length > 0);
  return h('div', { class: className }, lines.map(line => h('p', null, line)));
}

/** 字数按 Unicode 码点计，与后端一致。 */
export const charCount = (text: string) => Array.from(text.trim()).length;

/** 在支持 field-sizing 的浏览器上交给 CSS，否则用 CSSOM 自动撑高文本框。 */
const nativeAutosize = typeof CSS !== 'undefined' && CSS.supports?.('field-sizing', 'content');
export function autosize(textarea: HTMLTextAreaElement) {
  if (nativeAutosize) return;
  const resize = () => {
    textarea.style.height = 'auto';
    textarea.style.height = textarea.scrollHeight + 2 + 'px';
  };
  textarea.addEventListener('input', resize);
  requestAnimationFrame(resize);
}

export function debounce<A extends unknown[]>(fn: (...args: A) => void, ms: number) {
  let timer: number | undefined;
  const run = (...args: A) => {
    window.clearTimeout(timer);
    timer = window.setTimeout(() => fn(...args), ms);
  };
  run.cancel = () => window.clearTimeout(timer);
  return run;
}

let uid = 0;
export const nextId = (prefix = 'f') => prefix + '-' + (++uid).toString(36);

export const storage = {
  get<T>(key: string): T | null {
    try {
      const raw = localStorage.getItem(key);
      return raw ? (JSON.parse(raw) as T) : null;
    } catch { return null; }
  },
  set(key: string, value: unknown) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* 存储不可用时忽略 */ }
  },
  remove(key: string) {
    try { localStorage.removeItem(key); } catch { /* 忽略 */ }
  },
};

export const session = {
  get(key: string) {
    try { return sessionStorage.getItem(key); } catch { return null; }
  },
  set(key: string, value: string) {
    try { sessionStorage.setItem(key, value); } catch { /* 忽略 */ }
  },
  remove(key: string) {
    try { sessionStorage.removeItem(key); } catch { /* 忽略 */ }
  },
};
