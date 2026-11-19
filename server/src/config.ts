import { existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { z } from 'zod';

export const root = process.cwd();
export const defaultPhrases = '我觉得、我认为、我倾向、我打算、我已经决定、我更想、我更愿意、显然、肯定应该、毫无疑问';

export function loadEnvironment() {
  const path = resolve(root, '.env');
  if (!existsSync(path)) return;
  if (process.platform !== 'win32' && (statSync(path).mode & 0o077)) {
    throw new Error('请执行 chmod 600 .env 后重新启动。');
  }
  process.loadEnvFile(path);
}

const positive = z.coerce.number().int().positive();
export const reasoningEffort = z.enum(['none','minimal','low','medium','high','xhigh','max']);
export type ReasoningEffort = z.infer<typeof reasoningEffort>;
const base = z.object({
  RP_ID: z.string().regex(/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/).default('magi.lanthan.cn'),
  RP_NAME: z.string().min(1).default('MAGI'),
  DB_PATH: z.string().min(1).default('~/Library/Application Support/MAGI/magi.db').transform(p =>
    p === ':memory:' ? p : p.startsWith('~/') ? resolve(homedir(), p.slice(2)) : resolve(root, p)),
});
const service = base.extend({
  PORT: positive.max(65535).default(3000),
  TRUST_PROXY: z.literal('127.0.0.1').default('127.0.0.1'),
  SESSION_ABSOLUTE_HOURS: positive.max(87600).default(24),
  SESSION_IDLE_HOURS: positive.max(87600).default(24),
  MODEL_TIMEOUT_SECONDS: positive.max(86400).default(600),
  OPENAI_AUTH_MODE: z.enum(['api_key','chatgpt_plan']).default('api_key'),
  OPENAI_API_KEY: z.string().trim().default(''),
  OPENAI_MODEL: z.string().trim().min(1),
  OPENAI_REASONING: reasoningEffort,
  DEEPSEEK_API_KEY: z.string().trim().min(1),
  DEEPSEEK_BASE_URL: z.url().refine(value => new URL(value).protocol === 'https:'),
  DEEPSEEK_MODEL: z.string().trim().min(1),
  DEEPSEEK_THINKING: z.enum(['none','low','high','max']),
  LINT_PHRASES: z.string().default(defaultPhrases).transform(value =>
    [...new Set(value.split(/[、,，]/u).map(s => s.trim()).filter(Boolean))]),
}).superRefine((config, ctx) => {
  if (config.OPENAI_AUTH_MODE === 'api_key' && !config.OPENAI_API_KEY) {
    ctx.addIssue({ code: 'custom', path: ['OPENAI_API_KEY'], message: 'API Key 模式需要密钥' });
  }
});
function parseEnv<T extends z.ZodType>(schema: T, env: NodeJS.ProcessEnv): z.output<T> {
  const result = schema.safeParse(env);
  if (!result.success) throw new Error('配置缺失或无效：' + result.error.issues.map(i => i.path.join('.')).join('、'));
  return result.data;
}
export const cliConfig = () => parseEnv(base, process.env);
export const readConfig = (env = process.env) => parseEnv(service, env);
export type Config = ReturnType<typeof readConfig>;
