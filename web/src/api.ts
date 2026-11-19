import type {
  Answer, ConfirmReason, Credential, Detail, HistoryPage, LintWarning, ModelOptions, ModelSettings, OutcomeAnswer, Stats,
  Submission,
} from './types';

export interface ErrorBody {
  error?: { code?: string; message?: string };
  warnings?: LintWarning[];
  existingId?: string;
}

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public body: ErrorBody | null = null) {
    super(message);
    this.name = 'ApiError';
  }
}

// 面向使用者的说明。后端的 message 已是中文，这里补充下一步该做什么。
const friendly: Record<string, string> = {
  NETWORK: '网络连接失败，请检查网络后重试。',
  BAD_GATEWAY: 'MAGI 服务暂时不可达，可能正在重启。请稍后重试。',
  BAD_REQUEST: '请求格式无效，请刷新页面后重试。',
  UNAUTHENTICATED: '登录已过期，请重新用 Passkey 登录。',
  ORIGIN_DENIED: '请求来源与服务域名不符。请通过正式域名打开 MAGI。',
  INVALID_INVITE: '邀请无法使用。若邀请限定了来源 IP，请在指定网络重新打开原链接。已过期或已使用的邀请需要重新签发。',
  INVALID_CHALLENGE: '认证挑战已失效（有效期 5 分钟），请重新开始。',
  VERIFICATION_FAILED: 'Passkey 验证失败。请确认使用的是为 MAGI 注册的 Passkey。',
  COUNTER_REJECTED: 'Passkey 签名计数器异常，凭证可能被复制。请改用其他凭证，或在 Mac 上重置凭证。',
  CREDENTIAL_EXISTS: '这个 Passkey 已经注册过，可以直接登录。',
  LAST_CREDENTIAL: '至少需要保留一个 Passkey，否则将无法登录。',
  NOT_FOUND: '找不到这条记录，它可能不存在或链接有误。',
  INVALID_STATE: '表决状态已经变化，请刷新后再操作。',
  PAYLOAD_TOO_LARGE: '内容超过 256 KiB 上限，请精简背景材料。',
  RATE_LIMITED: '尝试过于频繁，请一分钟后再试。',
  MODEL_CATALOG_UNAVAILABLE: '模型目录暂时不可用，请稍后重试。',
  INTERNAL_ERROR: '服务暂时无法完成请求，请稍后重试。',
};

let onUnauthorized: () => void = () => {};
export function setUnauthorizedHandler(handler: () => void) {
  onUnauthorized = handler;
}

const publicPaths = ['auth/register/', 'auth/login/', 'auth/me'];

async function request<T>(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const headers: Record<string, string> = { accept: 'application/json' };
  const init: RequestInit = { method, headers, cache: 'no-store', credentials: 'same-origin', signal };
  if (body !== undefined) {
    headers['content-type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  let response: Response;
  try {
    response = await fetch('/api/' + path, init);
  } catch (err) {
    if (signal?.aborted) throw err;
    throw new ApiError(0, 'NETWORK', friendly.NETWORK);
  }
  const text = await response.text().catch(() => '');
  let data: unknown = null;
  if (text) {
    try { data = JSON.parse(text); } catch { data = null; }
  }
  if (!response.ok) {
    const errorBody = (data && typeof data === 'object' ? data : null) as ErrorBody | null;
    let code = errorBody?.error?.code;
    if (!code) code = [502, 503, 504].includes(response.status) ? 'BAD_GATEWAY' : response.status >= 500 ? 'INTERNAL_ERROR' : 'HTTP_' + response.status;
    const message = friendly[code] ?? errorBody?.error?.message ?? '请求失败（HTTP ' + response.status + '）。';
    if (response.status === 401 && !publicPaths.some(p => path.startsWith(p))) onUnauthorized();
    throw new ApiError(response.status, code, message, errorBody);
  }
  return data as T;
}

const q = (id: string) => 'questions/' + encodeURIComponent(id);

export const api = {
  gptBilling: (signal?: AbortSignal) => request<{ mode: 'api_key' | 'chatgpt_plan'; model: string; authorized?: boolean }>('GET', 'providers/gpt', undefined, signal),
  me: () => request<{ authenticated: boolean; credentialsCount: number }>('GET', 'auth/me'),
  registerOptions: (inviteToken: string, deviceName: string) =>
    request<Record<string, unknown>>('POST', 'auth/register/options', { inviteToken, deviceName }),
  registerVerify: (inviteToken: string, response: unknown) =>
    request<{ ok: true }>('POST', 'auth/register/verify', { inviteToken, response }),
  loginOptions: () => request<Record<string, unknown>>('POST', 'auth/login/options', {}),
  loginVerify: (response: unknown) => request<{ ok: true }>('POST', 'auth/login/verify', { response }),
  logout: () => request<{ ok: true }>('POST', 'auth/logout'),
  credentials: () => request<Credential[]>('GET', 'auth/credentials'),
  renameCredential: (id: string, deviceName: string) =>
    request<{ ok: true }>('PATCH', 'auth/credentials/' + encodeURIComponent(id), { deviceName }),
  deleteCredential: (id: string) => request<{ ok: true }>('DELETE', 'auth/credentials/' + encodeURIComponent(id)),

  lint: (question: string, background: string, goals: string, signal?: AbortSignal) =>
    request<{ warnings: LintWarning[] }>('POST', 'questions/lint', { question, background, goals }, signal),
  create: (body: Submission) => request<{ id: string; status: 'running' }>('POST', 'questions', body),
  history: (limit: number, cursor?: string | null, signal?: AbortSignal) =>
    request<HistoryPage>('GET', 'questions?limit=' + limit + (cursor ? '&cursor=' + encodeURIComponent(cursor) : ''), undefined, signal),
  detail: (id: string, signal?: AbortSignal) => request<Detail>('GET', q(id), undefined, signal),
  confirm: (id: string, final: Answer, reason: ConfirmReason, note?: string) =>
    request<{ ok: true }>('POST', q(id) + '/confirm', note ? { final, reason, note } : { final, reason }),
  check: (id: string, riskId: string) =>
    request<{ ok: true }>('POST', q(id) + '/checks/' + encodeURIComponent(riskId), { done: true }),
  retryAbsent: (id: string) => request<{ ok: true }>('POST', q(id) + '/retry-absent'),
  outcome: (id: string, correctAnswer: OutcomeAnswer, note?: string) =>
    request<{ ok: true }>('POST', q(id) + '/outcome', note ? { correctAnswer, note } : { correctAnswer }),
  stats: (signal?: AbortSignal) => request<Stats>('GET', 'stats', undefined, signal),

  modelSettings: (signal?: AbortSignal) => request<ModelSettings>('GET', 'settings/models', undefined, signal),
  modelOptions: (signal?: AbortSignal) => request<ModelOptions>('GET', 'settings/models/options', undefined, signal),
  saveModelSettings: (changes: Partial<ModelSettings>) => request<ModelSettings>('PATCH', 'settings/models', changes),
};

export function isAbort(err: unknown) {
  return err instanceof DOMException && err.name === 'AbortError';
}

export function errorMessage(err: unknown) {
  if (err instanceof ApiError) return err.message;
  if (err instanceof Error && err.message) return err.message;
  return '发生未知错误，请重试。';
}
