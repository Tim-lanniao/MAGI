export type AuthState = 'unknown' | 'in' | 'out';

export const appState = {
  auth: 'unknown' as AuthState,
  /** 登录页顶部展示一次的提示，例如会话过期或凭证被删除。 */
  notice: null as string | null,
};

export function markSignedIn() {
  appState.auth = 'in';
  appState.notice = null;
}

export function markSignedOut(notice: string | null = null) {
  appState.auth = 'out';
  appState.notice = notice;
}

export function takeNotice() {
  const value = appState.notice;
  appState.notice = null;
  return value;
}

/** 只接受站内路径作为登录后的跳转目标。 */
export function safeNext(value: string | null | undefined) {
  if (!value || !value.startsWith('/') || value.startsWith('//') || value.startsWith('/login') || value.startsWith('/setup')) return '/';
  return value;
}
