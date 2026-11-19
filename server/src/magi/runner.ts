import OpenAI from 'openai';
import { now, type Db } from '../db/index.js';
import { getQuestion, settle } from '../db/questions.js';
import { userPrompt } from './prompts.js';
import { ballot, models, type Ballot, type Model } from './schema.js';
import type { ModelOutput, Providers } from './providers/responses.js';
import type { ModelSelection } from './providers/model-options.js';
import { PlanError } from './providers/chatgpt-plan.js';
import { pageKey } from './sources.js';

export type AttemptError = 'TIMEOUT' | 'NETWORK' | 'INVALID_JSON' | 'INVALID_SCHEMA' | 'INCOMPLETE'
  | 'PROVIDER_ERROR' | 'PROVIDER_REJECTED' | 'INTERRUPTED' | 'WEB_SOURCES_UNVERIFIED';
function parseVote(output: ModelOutput, needsWeb: boolean): Ballot | AttemptError {
  const text = output.raw.trim();
  const fence = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(text);
  let json: unknown;
  try { json = JSON.parse(fence ? fence[1] : text); } catch { return 'INVALID_JSON'; }
  const result = ballot.safeParse(json);
  if (!result.success) return 'INVALID_SCHEMA';
  const vote = result.data;
  if (!needsWeb) return vote.sources.length ? 'INVALID_SCHEMA' : vote;
  const pages = new Map<string,string>();
  for (const url of output.webPages ?? []) {
    const key = pageKey(url);
    if (key) pages.set(key,url);
  }
  if (!vote.sources.length) return 'WEB_SOURCES_UNVERIFIED';
  for (const source of vote.sources) {
    const page = pages.get(pageKey(source.url)!);
    if (!page) return 'WEB_SOURCES_UNVERIFIED';
    source.url = page;
  }
  return vote;
}
function classify(err: unknown, signal: AbortSignal): AttemptError {
  if (signal.aborted || err instanceof OpenAI.APIConnectionTimeoutError) return 'TIMEOUT';
  if (err instanceof OpenAI.APIConnectionError || err instanceof TypeError) return 'NETWORK';
  if (err instanceof PlanError) return err.status < 500 ? 'PROVIDER_REJECTED' : 'PROVIDER_ERROR';
  if (err instanceof OpenAI.APIError && err.code === 'subscription_sharing_usage_limit_exceeded') return 'PROVIDER_REJECTED';
  if (err instanceof OpenAI.APIError && err.status && err.status < 500 && ![408,409,429].includes(err.status)) return 'PROVIDER_REJECTED';
  return 'PROVIDER_ERROR';
}

export class Runner {
  private readonly jobs = new Map<string, Promise<void>>();
  constructor(private db: Db, private providers: Providers, private timeoutMs: number, private onFault: (id: string) => void) {}
  start(id: string) {
    if (this.jobs.has(id)) return;
    const job = Promise.resolve().then(async () => {
      const q = getQuestion(this.db,id);
      if (q.status !== 'running') return;
      const prompt = userPrompt({ question: q.question, background: q.background, goals: q.goals,
        reversibility: q.reversibility, newInfo: q.parentId ? q.newInfo : null });
      const work = await Promise.allSettled(models.map(model => this.runVote(id, model, prompt, q.needsWeb)));
      if (work.some(r => r.status === 'rejected')) throw new Error('数据库未能保存模型票。');
      settle(this.db,id);
    }).catch(() => this.onFault(id)).finally(() => { this.jobs.delete(id); });
    this.jobs.set(id, job);
  }
  async idle() { await Promise.all(this.jobs.values()); }

  // Called after the single listener has acquired its port. A dispatched request whose
  // response was lost on process death may already have voted. Never resend that request.
  recover() {
    this.db.transaction(() => {
      this.db.prepare(`UPDATE votes SET state='absent',error='INTERRUPTED' WHERE state='pending' AND EXISTS
        (SELECT 1 FROM model_attempts a WHERE a.question_id=votes.question_id AND a.voter=votes.voter AND a.finished_at IS NULL)`).run();
      this.db.prepare("UPDATE model_attempts SET finished_at=?,error='INTERRUPTED' WHERE finished_at IS NULL").run(now());
    }).immediate();
    for (const row of this.db.prepare("SELECT id FROM questions WHERE status='running'").all() as {id: string}[]) this.start(row.id);
  }

  private async runVote(id: string, voter: Model, prompt: string, needsWeb: boolean) {
    const provider = this.providers[voter];
    const selection = this.db.prepare(`SELECT requested_model AS model, requested_effort AS effort FROM votes
      WHERE question_id=? AND voter=? AND state='pending'`).get(id, voter) as ModelSelection | undefined;
    if (!selection) return;
    const params = JSON.stringify({ reasoning: { effort: selection.effort }, needsWeb });
    for (;;) {
      const claim = this.db.transaction(() => {
        const row = this.db.prepare(`UPDATE votes SET attempts=attempts+1,model_name=?,model_params=?
          WHERE question_id=? AND voter=? AND state='pending' AND attempts<2 RETURNING attempts`)
          .get(selection.model,params,id,voter) as { attempts: number } | undefined;
        if (!row) return null;
        const attempt = this.db.prepare(`INSERT INTO model_attempts(question_id,voter,started_at,model_name,model_params)
          VALUES (?,?,?,?,?)`).run(id,voter,now(),selection.model,params);
        return { number: row.attempts, id: attempt.lastInsertRowid };
      }).immediate();
      if (!claim) return;
      const start = performance.now();
      const signal = AbortSignal.timeout(this.timeoutMs);
      let output: ModelOutput | undefined;
      let parsed: Ballot | AttemptError;
      let providerStatus: number | null = null;
      let providerCode: string | null = null;
      try {
        output = await provider.call(prompt, signal, selection, needsWeb);
        parsed = output.complete ? parseVote(output, needsWeb) : 'INCOMPLETE';
      } catch (err) {
        parsed = classify(err, signal);
        if (err instanceof OpenAI.APIError || err instanceof PlanError) {
          providerStatus = err.status ?? null;
          if (typeof err.code === 'string' && /^[A-Za-z0-9_.-]{1,80}$/.test(err.code)) providerCode = err.code;
        }
      }
      const error = typeof parsed === 'string' ? parsed : null;
      const valid = typeof parsed === 'string' ? null : parsed;
      const retry = error !== null && error !== 'PROVIDER_REJECTED' && claim.number < 2;
      const audit = { model: output?.model ?? selection.model, raw: output?.raw ?? null, usage: output?.usage ? JSON.stringify(output.usage) : null,
        ms: Math.round(performance.now()-start), error };
      this.db.transaction(() => {
        this.db.prepare(`UPDATE model_attempts SET finished_at=@finished,model_name=@model,raw_response=@raw,
          usage=@usage,latency_ms=@ms,error=@error,provider_status=@providerStatus,provider_code=@providerCode
          WHERE id=@id`).run({ ...audit, providerStatus, providerCode, finished: now(), id: claim.id });
        this.db.prepare(`UPDATE votes SET state=@state,vote=@vote,confidence=@confidence,core_reason=@reason,
          conditions=@conditions,risks=@risks,flip_condition=@flip,sources=@sources,raw_response=@raw,model_name=@model,
          error=@error,latency_ms=@ms,usage=@usage WHERE question_id=@id AND voter=@voter AND state='pending'`)
          .run({ ...audit, id, voter, state: valid ? 'valid' : retry ? 'pending' : 'absent',
            vote: valid?.vote ?? null, confidence: valid?.confidence ?? null, reason: valid?.core_reason ?? null,
            conditions: valid ? JSON.stringify(valid.conditions) : null, risks: valid ? JSON.stringify(valid.risks) : null,
            flip: valid?.flip_condition ?? null, sources: JSON.stringify(valid?.sources ?? []) });
      }).immediate();
      if (!retry) return;
    }
  }
}
