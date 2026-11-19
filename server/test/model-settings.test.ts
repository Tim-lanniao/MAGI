import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import type { ModelSelection } from '../src/magi/providers/model-options.js';
import { createProviders } from '../src/magi/providers/responses.js';
import { config, origin, output, provider, setup, submission } from './helpers.js';

const path = '/api/settings/models';
it('校验真实目录的模型和档位，支持独立或原子保存，并保留认证和同源检查', async () => {
  let offline = false;
  const request: typeof fetch = async (input, init) => {
    const req = new Request(input, init);
    expect(req.method).toBe('GET');
    if (new URL(req.url).host === 'deepseek.test') {
      expect(req.headers.get('authorization')).toBe('Bearer test-deepseek');
      return offline ? new Response(null, { status: 503 }) : Response.json({ data: [
        { id: 'deepseek-flash', name: 'Flash', effort: { supported_levels: ['low','high','max'] } },
      ] });
    }
    expect(req.headers.get('authorization')).toBe('Bearer test-openai');
    return Response.json({ data: [{ id: 'gpt-6.2-astra' }, { id: 'gpt-6-sol' }, { id: 'image-only' }] });
  };
  const h = await setup(createProviders(config, request));
  const patch = (payload: object) => h.app.inject({ method: 'PATCH', url: path, headers: h.headers, payload });
  try {
    expect((await h.app.inject(path)).statusCode).toBe(401);
    expect((await h.app.inject(path+'/options')).statusCode).toBe(401);
    expect((await h.app.inject({ method: 'PATCH', url: path, headers: { origin }, payload: {} })).statusCode).toBe(401);
    expect((await h.app.inject({ method: 'PATCH', url: path, headers: { cookie: h.headers.cookie }, payload: {} })).statusCode).toBe(403);
    const defaults = { gpt: { model: 'model-a', effort: 'max' }, deepseek: { model: 'model-b', effort: 'max' } };
    expect((await h.get('/settings/models')).json()).toEqual(defaults);
    const options = (await h.get('/settings/models/options')).json();
    expect(options.gpt.models.map((m: {id: string}) => m.id)).toEqual(['gpt-6.2-astra','gpt-6-sol']);
    expect(options.gpt.models[0].efforts).not.toContain('none');
    expect(options.deepseek).toEqual({ available: true, models: [{ id: 'deepseek-flash', label: 'Flash', efforts: ['none','low','high','max'] }] });
    const gpt = { model: 'gpt-6.2-astra', effort: 'high' };
    const deepseek = { model: 'deepseek-flash', effort: 'none' };
    for (const bad of [{}, { unknown: gpt }, { gpt: { ...gpt, extra: true } }, { gpt: { model: 'image-only', effort: 'low' } },
      { gpt: { ...gpt, effort: 'none' } }, { gpt, deepseek: { ...deepseek, effort: 'medium' } }]) {
      expect((await patch(bad)).statusCode).toBe(422);
    }
    expect((await h.get('/settings/models')).json()).toEqual(defaults);
    offline = true;
    expect((await h.get('/settings/models/options')).json()).toMatchObject({ gpt: { available: true }, deepseek: { available: false, models: [] } });
    expect((await patch({ gpt, deepseek })).json().error.code).toBe('MODEL_CATALOG_UNAVAILABLE');
    expect((await h.get('/settings/models')).json()).toEqual(defaults);
    expect((await patch({ gpt })).json()).toEqual({ gpt, deepseek: defaults.deepseek });
    offline = false;
    const changed = { model: 'gpt-6-sol', effort: 'none' };
    const results = await Promise.all([patch({ gpt: changed }), patch({ deepseek })]);
    expect(results.map(r => r.statusCode)).toEqual([200,200]);
    expect((await h.get('/settings/models')).json()).toEqual({ gpt: changed, deepseek });
    expect((await h.get('/providers/gpt')).json()).toMatchObject({ mode: 'api_key', model: 'gpt-6-sol' });
  } finally { await h.close(); }
});

it('进行中的表决和自动重试沿用提交时的设置，手动重试使用最新选择', async () => {
  let ready!: () => void, release!: () => void;
  const started = new Promise<void>(r => { ready = r; });
  const wait = new Promise<void>(r => { release = r; });
  const calls: ModelSelection[] = [];
  let available = false;
  const voter = { ...provider(async (_prompt, _signal, selection) => {
    calls.push(selection!);
    ready(); await wait;
    return available ? output() : output('invalid ballot');
  }), listModels: async () => [{ id: 'other', label: 'Other', efforts: ['low' as const] }] };
  const h = await setup({ gpt: voter, deepseek: voter });
  try {
    const { id } = (await h.post('/questions', submission)).json();
    await started;
    const selected = { model: 'other', effort: 'low' };
    expect((await h.app.inject({ method: 'PATCH', url: path, headers: h.headers,
      payload: { gpt: selected, deepseek: selected } })).statusCode).toBe(200);
    release(); await h.runner.idle();
    expect(calls).toEqual(Array(4).fill({ model: 'model', effort: 'max' }));
    available = true;
    expect((await h.post('/questions/'+id+'/retry-absent')).statusCode).toBe(200);
    await h.runner.idle();
    expect(calls.slice(4)).toEqual([selected,selected]);
    const attempts = h.db.prepare('SELECT model_params FROM model_attempts ORDER BY id').pluck().all() as string[];
    expect(attempts.map(p => JSON.parse(p).reasoning.effort)).toEqual(['max','max','max','max','low','low']);
  } finally { release(); await h.close(); }
});

it('两个独立后端进程共用磁盘库，恢复旧表决并用最新设置向两家发送新表决', () => {
  const dir = mkdtempSync(join(tmpdir(), 'magi-model-settings-'));
  try {
    const run = (phase: string) => JSON.parse(execFileSync(process.execPath,
      ['--import','tsx','server/test/fixtures/settings-process.ts',join(dir,'settings.db'),phase],
      { encoding: 'utf8', timeout: 12000 }));
    const first = run('save');
    const second = run('restore');
    expect(second.settings).toEqual(first.settings);
    expect(second.sent).toHaveLength(4);
    expect(second.sent.slice(0,2)).toEqual(expect.arrayContaining([
      { model: 'gpt-6.2-sol', effort: 'low' }, { model: 'deepseek-flash', effort: 'high' },
    ]));
    expect(second.sent.slice(2)).toEqual(expect.arrayContaining([
      { model: 'gpt-6.2-astra', effort: 'high' }, { model: 'deepseek-v4-pro', effort: 'low' },
    ]));
  } finally { rmSync(dir, { recursive: true, force: true }); }
}, 25000);
