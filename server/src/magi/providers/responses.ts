import OpenAI from 'openai';
import type { Response as ModelResponse, ResponseCreateParamsBase, ResponseOutputItem } from 'openai/resources/responses/responses';
import type { Config, ReasoningEffort } from '../../config.js';
import { ChatGPTPlan, openaiResource, PlanError } from './chatgpt-plan.js';
import { instructions } from '../prompts.js';
import { voteJsonSchema, type Model } from '../schema.js';
import { keyModelOptions, type ModelOption, type ModelSelection } from './model-options.js';

export interface ModelOutput { raw: string; model: string; usage: unknown; complete: boolean; webPages?: string[] }
export interface Provider {
  model: string;
  params: { reasoning: { effort: ReasoningEffort } };
  listModels?: () => Promise<ModelOption[]>;
  call: (prompt: string, signal: AbortSignal, selection?: ModelSelection, needsWeb?: boolean) => Promise<ModelOutput>;
}
export type Providers = Record<Model, Provider>;

function responseFormat(voter: Model) {
  return { format: { type: 'json_schema' as const, name: 'magi_vote',
    ...(voter === 'gpt' ? { strict: true } : {}), schema: voteJsonSchema } };
}

function webRequest(voter: Model, model: string): Pick<ResponseCreateParamsBase,'tools'|'tool_choice'|'include'|'text'> {
  if (voter === 'deepseek' && model === 'deepseek-flash') {
    // DeepSeek's Flash-specific extension accepts text output. MAGI validates the same ballot schema locally.
    return { tools: [{ type: 'deepseek_web_search' } as unknown as OpenAI.Responses.Tool], tool_choice: 'required' };
  }
  return { tools: [{ type: 'web_search', ...(voter === 'gpt' ? { external_web_access: true } : {}) }],
    tool_choice: 'required', include: ['web_search_call.action.sources'], text: responseFormat(voter) };
}

function webPages(items: ResponseOutputItem[]) {
  const pages = new Set<string>();
  let searched = false;
  for (const item of items) {
    if (item.type !== 'web_search_call' || item.status !== 'completed') continue;
    searched = true;
    const action = item.action;
    if (action?.type === 'search') {
      for (const source of action.sources ?? []) if (source.type === 'url') pages.add(source.url);
    } else if (action?.url) pages.add(action.url);
    // DeepSeek also reports the opened page on the tool item.
    if ('page' in item && item.page && typeof item.page === 'object' && 'url' in item.page &&
      typeof item.page.url === 'string') pages.add(item.page.url);
  }
  if (!searched) return [];
  for (const item of items) {
    if (item.type !== 'message') continue;
    for (const part of item.content) {
      if (part.type !== 'output_text') continue;
      for (const ref of part.annotations ?? []) if (ref.type === 'url_citation') pages.add(ref.url);
    }
  }
  return [...pages];
}

function modelOutput(response: ModelResponse | undefined, items: ResponseOutputItem[], fallback: string, model: string, needsWeb: boolean): ModelOutput {
  // A web search can emit progress messages before the final ballot.
  const message = items.findLast(item => item.type === 'message' && item.phase !== 'commentary');
  const text = message?.type === 'message' ? message.content.filter(part => part.type === 'output_text').map(part => part.text).join('') : '';
  return { raw: text || fallback, model: response?.model || model, usage: response?.usage ?? null,
    complete: response?.status === 'completed', ...(needsWeb ? { webPages: webPages(items) } : {}) };
}

function responsesProvider(voter: Model, credential: string | ChatGPTPlan, baseURL: string, model: string, effort: Config['OPENAI_REASONING'],
  timeout: number, fetcher?: typeof fetch): Provider {
  const clientFor = (apiKey: string) => new OpenAI({ apiKey, baseURL, maxRetries: 0, timeout, logLevel: 'off', fetch: fetcher });
  const keyed = typeof credential === 'string' ? clientFor(credential) : undefined;
  const initial = { model, effort };
  const listModels = () => typeof credential === 'string'
    ? keyModelOptions(voter, baseURL, credential, initial, fetcher ?? fetch) : credential.modelOptions(initial);
  return { model, params: { reasoning: { effort } }, listModels, async call(prompt, signal, selection = initial, needsWeb = false) {
    const request = { model: selection.model, reasoning: { effort: selection.effort }, instructions: instructions(needsWeb), store: false,
      ...(needsWeb ? webRequest(voter, selection.model) : { text: responseFormat(voter) }) };
    if (keyed) {
      const response = await keyed.responses.create({ ...request, input: prompt }, { signal });
      return modelOutput(response, response.output, response.output_text ?? '', selection.model, needsWeb);
    }
    const plan = credential as ChatGPTPlan;
    const client = clientFor(await plan.access(signal));
    const stream = await client.responses.create({ ...request, input: [{ role: 'user', content: prompt }], stream: true }, { signal });
    let partial = '';
    let final: ModelResponse | undefined;
    const items: ResponseOutputItem[] = [];
    for await (const event of stream) {
      if (event.type === 'response.output_text.delta') partial += event.delta;
      if (event.type === 'response.output_item.done') items[event.output_index] = event.item;
      if (event.type === 'response.completed' || event.type === 'response.incomplete') { final = event.response; break; }
      if (event.type === 'response.failed') throw streamError(event.response.error?.code);
      if (event.type === 'error') throw streamError(event.code);
    }
    // Some plan streams deliver tool items only in output_item.done.
    return modelOutput(final, [...items.filter(Boolean), ...(final?.output ?? [])], partial, selection.model, needsWeb);
  } };
}
function streamError(raw?: string | null) {
  const code = raw && /^[a-zA-Z0-9_.-]{1,80}$/.test(raw) ? raw : 'CHATGPT_STREAM_FAILED';
  const status: Record<string, number> = { subscription_sharing_usage_limit_exceeded: 429, subscription_sharing_invalid_user: 401,
    subscription_sharing_user_not_eligible: 403, subscription_sharing_unsupported_capability: 400,
    subscription_sharing_route_not_supported: 403, chatpass_v2_scope_not_authorized: 403,
    chatpass_v2_invalid_authorization_context: 403 };
  return new PlanError(code, status[code] ?? 503);
}
export function createProviders(c: Config, fetcher?: typeof fetch, plan?: ChatGPTPlan): Providers {
  const timeout = c.MODEL_TIMEOUT_SECONDS * 1000;
  return {
    gpt: responsesProvider('gpt', c.OPENAI_AUTH_MODE === 'chatgpt_plan' ? plan ?? new ChatGPTPlan(undefined, fetcher) : c.OPENAI_API_KEY,
      openaiResource, c.OPENAI_MODEL, c.OPENAI_REASONING, timeout, fetcher),
    deepseek: responsesProvider('deepseek', c.DEEPSEEK_API_KEY, c.DEEPSEEK_BASE_URL, c.DEEPSEEK_MODEL, c.DEEPSEEK_THINKING, timeout, fetcher),
  };
}
