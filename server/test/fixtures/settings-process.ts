// Runs in a separate Node process per phase, against the test's private database and mock upstreams.
import assert from 'node:assert/strict';
import { buildApp } from '../../src/app.js';
import { issueSession } from '../../src/auth/session.js';
import { openDb } from '../../src/db/index.js';
import { createQuestion } from '../../src/db/questions.js';
import { createProviders } from '../../src/magi/providers/responses.js';
import type { ModelSelection } from '../../src/magi/providers/model-options.js';
import { ballot, config, origin, submission } from '../helpers.js';

const [path, phase] = process.argv.slice(2);
const db = openDb(path);
const sent: ModelSelection[] = [];
const cfg = phase === 'save' ? config : { ...config, OPENAI_MODEL: 'changed-env-gpt', DEEPSEEK_MODEL: 'changed-env-deepseek' };
const providers = createProviders(cfg, async (input, init) => {
  const req = new Request(input, init);
  if (req.method === 'GET') {
    const ids = new URL(req.url).host === 'deepseek.test' ? ['deepseek-flash','deepseek-v4-pro'] : ['gpt-6.2-sol','gpt-6.2-astra'];
    return Response.json({ data: ids.map(id => ({ id })) });
  }
  const body = await req.json();
  sent.push({ model: body.model, effort: body.reasoning.effort });
  return Response.json({ id: 'resp_fixture', object: 'response', model: body.model, status: 'completed',
    output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: JSON.stringify(ballot()) }] }] });
});
const { app, runner } = await buildApp(cfg, db, providers, false);
const headers = { origin, cookie: 'magi_sid=' + issueSession(db, 1) };
const url = '/api/settings/models';
async function save(gpt: ModelSelection, deepseek: ModelSelection) {
  const result = await app.inject({ method: 'PATCH', url, headers, payload: { gpt, deepseek } });
  assert.equal(result.statusCode, 200);
}
try {
  if (phase === 'save') {
    await save({ model: 'gpt-6.2-sol', effort: 'low' }, { model: 'deepseek-flash', effort: 'high' });
    createQuestion(db, submission); // The process exits before these votes are dispatched.
    await save({ model: 'gpt-6.2-astra', effort: 'high' }, { model: 'deepseek-v4-pro', effort: 'low' });
  } else {
    assert.equal(phase, 'restore');
    runner.recover(); await runner.idle();
    const res = await app.inject({ method: 'POST', url: '/api/questions', headers, payload: { ...submission, question: '另一项决策？' } });
    assert.equal(res.statusCode, 201);
    await runner.idle();
    assert.equal(db.prepare("SELECT count(*) FROM questions WHERE status='decided'").pluck().get(), 2);
  }
  const result = await app.inject({ url, headers });
  assert.equal(result.statusCode, 200);
  console.log(JSON.stringify({ settings: result.json(), sent }));
} finally { await app.close(); db.close(); }
