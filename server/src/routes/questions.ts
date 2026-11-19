import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Db } from '../db/index.js';
import { checkRisk, confirm, createQuestion, detail, history, recordOutcome, retryAbsent } from '../db/questions.js';
import { stats } from '../db/stats.js';
import { HttpError } from '../errors.js';
import { lint } from '../magi/lint.js';
import { confirmation, lintBody, outcomeBody, questionBody, ulidText } from '../magi/schema.js';
import type { Runner } from '../magi/runner.js';

export function questionRoutes(app: FastifyInstance, db: Db, runner: Runner, phrases: string[]) {
  app.post('/questions/lint', async req => ({ warnings: lint(lintBody.parse(req.body).background,phrases) }));
  app.post('/questions', async (req,reply) => {
    const body = questionBody.parse(req.body);
    const warnings = lint(body.background,phrases);
    if (warnings.length && !body.acknowledgeWarnings) throw new HttpError(422,'LINT_WARNINGS','请确认背景中的倾向性措辞。',{ warnings });
    const id = createQuestion(db,body);
    runner.start(id);
    return reply.code(201).send({ id, status: 'running' });
  });
  app.get('/questions', async req => {
    const { limit, cursor } = z.strictObject({ limit: z.coerce.number().int().min(1).max(100).default(20), cursor: ulidText.optional() }).parse(req.query);
    return history(db,limit,cursor);
  });
  type Id = { Params: { id: string } };
  app.get<Id>('/questions/:id', async req => detail(db,req.params.id));
  app.post<Id>('/questions/:id/confirm', async req => {
    confirm(db,req.params.id,confirmation.parse(req.body));
    return { ok: true };
  });
  app.post<{Params: {id: string; riskId: string}}>('/questions/:id/checks/:riskId', async req => {
    z.strictObject({ done: z.literal(true) }).parse(req.body);
    checkRisk(db,req.params.id,req.params.riskId);
    return { ok: true };
  });
  app.post<Id>('/questions/:id/retry-absent', async req => {
    retryAbsent(db,req.params.id);
    runner.start(req.params.id);
    return { ok: true };
  });
  app.post<Id>('/questions/:id/outcome', async req => {
    recordOutcome(db,req.params.id,outcomeBody.parse(req.body));
    return { ok: true };
  });
  app.get('/stats', async () => stats(db));
}
