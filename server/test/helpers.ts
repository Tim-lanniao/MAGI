import { readConfig } from '../src/config.js';
import { openDb } from '../src/db/index.js';
import { buildApp } from '../src/app.js';
import { issueSession } from '../src/auth/session.js';
import type { Ballot, Vote, Voter, Answer, Risk } from '../src/magi/schema.js';
import type { ModelOutput, Provider, Providers } from '../src/magi/providers/responses.js';

export const config = readConfig({ RP_ID: 'magi.test', DB_PATH: ':memory:', OPENAI_API_KEY: 'test-openai',
  OPENAI_MODEL: 'model-a', OPENAI_REASONING: 'max', DEEPSEEK_API_KEY: 'test-deepseek',
  DEEPSEEK_BASE_URL: 'https://deepseek.test', DEEPSEEK_MODEL: 'model-b', DEEPSEEK_THINKING: 'max' });
export const origin = 'https://magi.test';
export const ballot = (vote: Answer = '是', risks: Risk[] = []): Ballot => ({ vote, confidence: 75, core_reason: '可核实的理由',
  conditions: [], risks, flip_condition: '', sources: [] });
export const vote = (voter: Voter, answer: Answer = '是', risks: Risk[] = []): Vote => ({ voter,state: 'valid',...ballot(answer,risks) });
export const absent = (voter: 'gpt' | 'deepseek'): Vote => ({ voter,state: 'absent',error: 'TIMEOUT' });
export const risk = (severity: Risk['severity'] = '高', category: Risk['category'] = '财务', text: string = category): Risk =>
  ({ category,severity,risk: text,check: '核对凭据' });
export const submission = { question: '本月是否订阅？',background: '月费 30 元',goals: '控制预算',reversibility: '可逆' as const,
  userVote: { ...ballot(),core_reason: 'USER_PRIVATE_REASON',flip_condition: 'USER_PRIVATE_FLIP' }, acknowledgeWarnings: false,
  needsWeb: false };
export const output = (raw = JSON.stringify(ballot())): ModelOutput => ({ raw,model: 'resolved-model',usage: { total_tokens: 42 },complete: true });
export const provider = (call: Provider['call'] = async () => output()): Provider => ({ model: 'model',
  params: { reasoning: { effort: 'max' } },call });
export async function setup(providers: Providers = { gpt: provider(),deepseek: provider() }, webRoot?: string) {
  const db = openDb(':memory:');
  const { app, runner } = await buildApp(config,db,providers,false,webRoot);
  await app.ready();
  const headers = { origin, cookie: 'magi_sid=' + issueSession(db,config.SESSION_ABSOLUTE_HOURS) };
  const post = (url: string, payload?: object) => app.inject({ method: 'POST',url: '/api'+url,headers,payload });
  const get = (url: string) => app.inject({ method: 'GET',url: '/api'+url,headers });
  const close = async () => { await app.close(); db.close(); };
  return { app,runner,db,headers,post,get,close };
}
