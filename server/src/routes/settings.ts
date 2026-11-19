import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { reasoningEffort } from '../config.js';
import type { Db } from '../db/index.js';
import { readModelSettings, saveModelSettings } from '../db/model-settings.js';
import { HttpError, invalid } from '../errors.js';
import type { Provider, Providers } from '../magi/providers/responses.js';
import type { ModelOption } from '../magi/providers/model-options.js';
import { models } from '../magi/schema.js';

const selection = z.strictObject({ model: z.string().trim().min(1).max(256), effort: reasoningEffort });
const patch = z.strictObject({ gpt: selection.optional(), deepseek: selection.optional() })
  .refine(value => value.gpt || value.deepseek, '至少选择一家供应商。');

async function catalog(provider: Provider): Promise<{ available: boolean; models: ModelOption[] }> {
  if (!provider.listModels) {
    return { available: true, models: [{ id: provider.model, label: provider.model, efforts: [provider.params.reasoning.effort] }] };
  }
  try { return { available: true, models: await provider.listModels() }; }
  catch { return { available: false, models: [] }; }
}

export function settingsRoutes(app: FastifyInstance, db: Db, providers: Providers) {
  app.get('/settings/models', async () => readModelSettings(db));
  app.get('/settings/models/options', async () => {
    const [gpt, deepseek] = await Promise.all([catalog(providers.gpt), catalog(providers.deepseek)]);
    return { gpt, deepseek };
  });
  app.patch('/settings/models', async req => {
    const changes = patch.parse(req.body);
    const current = readModelSettings(db);
    await Promise.all(models.map(async voter => {
      const next = changes[voter];
      if (!next || (next.model === current[voter].model && next.effort === current[voter].effort)) return;
      const options = await catalog(providers[voter]);
      if (!options.available) throw new HttpError(503, 'MODEL_CATALOG_UNAVAILABLE', voter + ' 模型目录暂时不可用，请稍后重试。');
      if (!options.models.some(m => m.id === next.model && m.efforts.includes(next.effort))) {
        throw invalid(voter + ' 的模型或思考强度不可用。');
      }
    }));
    return saveModelSettings(db, changes);
  });
}
