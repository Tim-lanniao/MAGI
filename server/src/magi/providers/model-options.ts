import { z } from 'zod';
import { reasoningEffort, type ReasoningEffort } from '../../config.js';
import type { Model } from '../schema.js';

export interface ModelSelection { model: string; effort: ReasoningEffort }
export interface ModelOption { id: string; label: string; efforts: ReasoningEffort[] }

const thinking: ReasoningEffort[] = ['low','medium','high','xhigh','max'];
const switchable: ReasoningEffort[] = ['none', ...thinking];
const deepseekEfforts: ReasoningEffort[] = ['none','low','high','max'];
// The API-key catalog contains IDs only. These text models support structured Responses.
const apiEfforts: Record<string, ReasoningEffort[]> = {
  'gpt-6.2-astra': thinking, 'gpt-6.2-sol': thinking, 'gpt-6.1-sol': thinking, 'gpt-6-astra': thinking,
  'gpt-6.1-terra': switchable, 'gpt-6-sol': switchable, 'gpt-6-luna': switchable,
  'gpt-5.6': switchable, 'gpt-5.6-sol': switchable, 'gpt-5.6-terra': switchable, 'gpt-5.6-luna': switchable,
};

const keyCatalog = z.object({ data: z.array(z.object({
  id: z.string(), name: z.string().optional(),
  effort: z.object({ supported_levels: z.array(z.string()) }).optional(),
})) });

export function modelOption(id: string, label: string, supported: readonly string[]): ModelOption[] {
  const efforts = reasoningEffort.options.filter(value => supported.includes(value));
  return efforts.length ? [{ id, label, efforts }] : [];
}

export async function keyModelOptions(voter: Model, baseURL: string, key: string, initial: ModelSelection,
  request: typeof fetch): Promise<ModelOption[]> {
  const response = await request(baseURL.replace(/\/$/, '') + '/models', {
    headers: { Authorization: 'Bearer ' + key }, redirect: 'error', signal: AbortSignal.timeout(8000),
  });
  if (!response.ok) throw new Error('Model catalog unavailable');
  const { data } = keyCatalog.parse(await response.json());
  return data.flatMap(entry => {
    let efforts: readonly string[] | undefined;
    if (voter === 'gpt') {
      const family = entry.id.replace(/-\d{4}-\d{2}-\d{2}$/, '');
      if (Object.hasOwn(apiEfforts, family)) efforts = apiEfforts[family];
    } else if (entry.effort) {
      // /models lists enabled thinking levels. Responses also accepts "none" to turn thinking off.
      efforts = deepseekEfforts.filter(e => e === 'none' || entry.effort!.supported_levels.includes(e));
    } else if (['deepseek-flash','deepseek-v4-pro'].includes(entry.id)) {
      efforts = deepseekEfforts;
    }
    return modelOption(entry.id, entry.name || entry.id, efforts ?? (entry.id === initial.model ? [initial.effort] : []));
  });
}
