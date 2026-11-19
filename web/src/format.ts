import type { ModelVoter, Status, Voter } from './types';

export const voterName: Record<Voter, string> = { user: '我', gpt: 'GPT', deepseek: 'DeepSeek' };

export const statusLabel: Record<Status, string> = {
  running: '表决中',
  paused: '停机检查',
  needs_confirmation: '待你确认',
  decided: '已决定',
  failed: '两家缺席',
};

export const absenceReason: Record<string, string> = {
  TIMEOUT: '超时未返回',
  NETWORK: '无法连接服务商',
  INVALID_JSON: '返回内容不是有效的 JSON',
  INVALID_SCHEMA: '返回的票不符合格式',
  INCOMPLETE: '服务商未完整返回',
  PROVIDER_ERROR: '服务商出错',
  PROVIDER_REJECTED: '服务商拒绝了请求',
  INTERRUPTED: '请求发出后本机服务中断',
  WEB_SOURCES_UNVERIFIED: '联网引用无法核对',
};

export const absenceHint: Record<string, string> = {
  TIMEOUT: '已自动重试一次。最高推理档位偶尔会超过等待上限。',
  NETWORK: '已自动重试一次。请检查 Mac 的网络或服务商状态。',
  INVALID_JSON: '已自动重试一次，模型仍未给出可解析的票。',
  INVALID_SCHEMA: '已自动重试一次，模型的票缺少字段或超出取值范围。',
  INCOMPLETE: '已自动重试一次，回复被截断。',
  PROVIDER_ERROR: '已自动重试一次，服务商仍返回错误。',
  PROVIDER_REJECTED: '通常是密钥、额度或模型参数问题，未自动重试。请检查 .env 配置。',
  INTERRUPTED: '为避免重复索票，这次请求不会自动重发。',
  WEB_SOURCES_UNVERIFIED: '已自动重试一次，引用的网页与检索结果对不上。',
};

export const effortLabel: Record<string, string> = {
  none: '关闭', minimal: '最低', low: '低', medium: '中', high: '高', xhigh: '很高', max: '最高',
};

/** 链接显示用的站点名：去掉 www.。 */
export function siteName(url: string) {
  try { return new URL(url).hostname.replace(/\.$/, '').replace(/^www\./, ''); } catch { return url; }
}

export function absenceText(model: ModelVoter, error: string) {
  return voterName[model] + '：' + (absenceReason[error] ?? '未能投票（' + error + '）');
}

const pad = (n: number) => String(n).padStart(2, '0');
const weekdays = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

function sameDay(a: Date, b: Date) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

/** 11月18日 周三 22:01；跨年时带年份。 */
export function formatDateTime(iso: string, withWeekday = true) {
  const d = new Date(iso);
  const nowDate = new Date();
  const year = d.getFullYear() === nowDate.getFullYear() ? '' : d.getFullYear() + '年';
  return year + (d.getMonth() + 1) + '月' + d.getDate() + '日' + (withWeekday ? ' ' + weekdays[d.getDay()] : '') + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
}

export function formatDate(iso: string) {
  const d = new Date(iso);
  const nowDate = new Date();
  const year = d.getFullYear() === nowDate.getFullYear() ? '' : d.getFullYear() + '年';
  return year + (d.getMonth() + 1) + '月' + d.getDate() + '日';
}

export function relativeTime(iso: string) {
  const d = new Date(iso);
  const diff = Date.now() - d.getTime();
  const minute = 60_000;
  if (diff < minute) return '刚刚';
  if (diff < 60 * minute) return Math.floor(diff / minute) + ' 分钟前';
  const today = new Date();
  if (sameDay(d, today)) return '今天 ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  if (sameDay(d, yesterday)) return '昨天 ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  return formatDateTime(iso, false);
}

/** 1 分 42 秒；超过两天按天计。 */
export function duration(ms: number) {
  const total = Math.max(0, Math.round(ms / 1000));
  if (total >= 48 * 3600) return Math.round(total / 86400) + ' 天';
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const sec = total % 60;
  if (h) return h + ' 小时 ' + m + ' 分';
  if (m) return m + ' 分 ' + sec + ' 秒';
  return sec + ' 秒';
}

/** 计时器样式 03:27；超过一天时只显示「超过 1 天」。 */
export function clock(ms: number) {
  const total = Math.max(0, Math.floor(ms / 1000));
  if (total >= 86400) return '超过 ' + Math.floor(total / 86400) + ' 天';
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const sec = total % 60;
  return (h ? h + ':' + pad(m) : pad(m)) + ':' + pad(sec);
}

export function monthKey(iso: string) {
  const d = new Date(iso);
  return d.getFullYear() + '年' + (d.getMonth() + 1) + '月';
}

export function percent(value: number | null, digits = 0) {
  if (value === null || Number.isNaN(value)) return '—';
  return (value * 100).toFixed(digits) + '%';
}

export function confidenceWord(value: number) {
  if (value < 60) return '接近掷硬币';
  if (value < 70) return '略有倾向';
  if (value < 80) return '比较有把握';
  if (value < 90) return '很有把握';
  return '几乎确定';
}

export function guessDeviceName() {
  const ua = navigator.userAgent;
  if (/iPhone/.test(ua)) return '我的 iPhone';
  if (/iPad/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)) return '我的 iPad';
  if (/Macintosh/.test(ua)) return '我的 Mac';
  if (/Android/.test(ua)) return '我的 Android 手机';
  if (/Windows/.test(ua)) return '我的 Windows 电脑';
  return '我的设备';
}
