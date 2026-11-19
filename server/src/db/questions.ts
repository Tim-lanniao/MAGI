import { monotonicFactory } from 'ulid';
import type { z } from 'zod';
import { now, type Db } from './index.js';
import { snapshotModelSettings } from './model-settings.js';
import { conflict, HttpError, invalid, missing } from '../errors.js';
import { merge, type MergedRisk } from '../magi/merge.js';
import { compareSources } from '../magi/sources.js';
import { models, type Answer, type Ballot, type confirmation, type outcomeBody, type Reversibility,
  type Status, type Submission, type Vote, type Voter } from '../magi/schema.js';

const nextId = monotonicFactory();
interface Question {
  id: string; question: string; background: string; goals: string; reversibility: Reversibility;
  parentId: string | null; newInfo: string | null; status: Status; nextStatus: Status | null;
  createdAt: string; decidedAt: string | null;
}
export function getQuestion(db: Db, id: string) {
  const row = db.prepare(`SELECT id, question, background, goals, reversibility, parent_id AS parentId,
    new_info AS newInfo, needs_web AS needsWeb, status, next_status AS nextStatus, created_at AS createdAt, decided_at AS decidedAt
    FROM questions WHERE id=?`).get(id) as (Question & { needsWeb: number }) | undefined;
  if (!row) throw missing();
  return { ...row, needsWeb: Boolean(row.needsWeb) };
}
interface VoteRow extends Omit<Ballot, 'conditions' | 'risks' | 'sources'> {
  voter: Voter; state: Vote['state']; error: string; conditions: string; risks: string; sources: string;
}
export function readVotes(db: Db, id: string, blind = false): Vote[] {
  const rows = db.prepare(`SELECT voter,state,vote,confidence,core_reason,conditions,risks,flip_condition,sources,error
    FROM votes WHERE question_id=? AND (?=0 OR voter='user')
    ORDER BY CASE voter WHEN 'user' THEN 0 WHEN 'gpt' THEN 1 ELSE 2 END`).all(id, Number(blind)) as VoteRow[];
  const votes: Vote[] = rows.map(({voter, state, vote, confidence, core_reason, conditions, risks, flip_condition, sources, error}) => {
    if (state === 'valid') return { voter, state, vote, confidence, core_reason, conditions: JSON.parse(conditions),
      risks: JSON.parse(risks), flip_condition, sources: JSON.parse(sources) };
    if (voter === 'user') throw new Error('用户票状态异常。');
    return state === 'absent' ? { voter, state, error } : { voter, state };
  });
  if (blind) for (const voter of models) votes.push({ voter, state: 'pending' });
  return votes;
}
export function createQuestion(db: Db, input: Submission): string {
  return db.transaction(() => {
    if (input.parentId && (db.prepare('SELECT status FROM questions WHERE id=?').get(input.parentId) as {status: Status} | undefined)?.status !== 'decided') {
      throw invalid('父问题必须存在且已决定。');
    }
    const existing = db.prepare(`SELECT id FROM questions WHERE question=? AND background=? AND goals=?
      AND reversibility=? AND ifnull(parent_id,'')=? AND ifnull(new_info,'')=?`)
      .get(input.question,input.background,input.goals,input.reversibility,input.parentId ?? '',input.newInfo ?? '') as {id: string} | undefined;
    if (existing) throw new HttpError(409,'DUPLICATE_QUESTION','这组问题材料已经提交。',{ existingId: existing.id });
    const id = nextId();
    const t = now();
    db.prepare(`INSERT INTO questions(id,question,background,goals,reversibility,parent_id,new_info,needs_web,status,created_at)
      VALUES (?,?,?,?,?,?,?,?,'running',?)`).run(id,input.question,input.background,input.goals,input.reversibility,input.parentId ?? null,
      input.newInfo || null,Number(input.needsWeb),t);
    const v = input.userVote;
    db.prepare(`INSERT INTO votes(question_id,voter,state,vote,confidence,core_reason,conditions,risks,flip_condition,sources,created_at)
      VALUES (?,'user','valid',?,?,?,?,?,?,?,?)`).run(id,v.vote,v.confidence,v.core_reason,JSON.stringify(v.conditions),JSON.stringify(v.risks),
      v.flip_condition,JSON.stringify(v.sources),t);
    for (const model of models) db.prepare("INSERT INTO votes(question_id,voter,state,created_at) VALUES (?,?,'pending',?)").run(id,model,t);
    snapshotModelSettings(db, id);
    return id;
  }).immediate();
}
function completedChecks(db: Db, id: string) {
  const rows = db.prepare('SELECT risk_id FROM risk_checks WHERE question_id=?').all(id) as {risk_id: string}[];
  return new Set(rows.map(r => r.risk_id));
}
export function settle(db: Db, id: string) {
  db.transaction(() => {
    const q = getQuestion(db,id);
    if (q.status !== 'running') return;
    const votes = readVotes(db,id);
    if (votes.some(v => v.state === 'pending')) return;
    const merged = merge(q, votes);
    const done = completedChecks(db,id);
    const status = merged.nextStatus && merged.pausedBy.every(r => done.has(r)) ? merged.nextStatus : merged.status;
    const overlap = q.needsWeb ? compareSources(votes) : null;
    db.prepare(`INSERT INTO results(question_id,tally,merged_risks,conditions,conclusion,final_decision,source_overlap)
      VALUES (?,?,?,?,?,?,?)`).run(id,JSON.stringify(merged.tally),JSON.stringify(merged.risks),JSON.stringify(merged.conditions),
      merged.conclusion,status === 'decided' ? merged.conclusion : null,overlap && JSON.stringify(overlap));
    db.prepare('UPDATE questions SET status=?, next_status=?, decided_at=? WHERE id=?')
      .run(status,status === 'paused' ? merged.nextStatus : null,status === 'decided' ? now() : null,id);
  }).immediate();
}
interface StoredResult {
  tally: string; merged_risks: string; conditions: string; conclusion: Answer | null;
  final_decision: Answer | null; final_reason: string | null; final_note: string | null;
  source_overlap: string | null;
}
// 揭晓后给模型票附上实际使用的模型名。运行中不附带，避免暴露哪家已先完成。
function withModelNames(db: Db, id: string, votes: Vote[]) {
  const rows = db.prepare(`SELECT voter, model_name AS model FROM votes
    WHERE question_id=? AND voter<>'user' AND model_name IS NOT NULL`).all(id) as { voter: Voter; model: string }[];
  const names = new Map(rows.map(r => [r.voter, r.model]));
  return votes.map(v => (v.voter !== 'user' && names.has(v.voter) ? { ...v, model: names.get(v.voter)! } : v));
}
export function detail(db: Db, id: string) {
  const q = getQuestion(db,id);
  const running = q.status === 'running';
  const votes = running ? readVotes(db,id,true) : withModelNames(db,id,readVotes(db,id));
  const row = db.prepare('SELECT * FROM results WHERE question_id=?').get(id) as StoredResult | undefined;
  let result = null;
  if (row && q.status !== 'running') {
    const done = completedChecks(db,id);
    const risks = (JSON.parse(row.merged_risks) as MergedRisk[]).map(r => ({ ...r, checkDone: done.has(r.id) }));
    result = { tally: JSON.parse(row.tally), conclusion: row.conclusion, finalDecision: row.final_decision,
      finalReason: row.final_reason, finalNote: row.final_note, conditions: JSON.parse(row.conditions), risks,
      sourceOverlap: row.source_overlap ? JSON.parse(row.source_overlap) : null,
      pausedBy: q.status === 'paused' ? risks.filter(r => r.severity === '致命').map(r => r.id) : [] };
  }
  const outcome = db.prepare('SELECT correct_answer AS correctAnswer,note,recorded_at AS recordedAt FROM outcomes WHERE question_id=?').get(id) ?? null;
  return { ...q, votes, result, outcome };
}
export function history(db: Db, limit: number, cursor?: string) {
  const rows = db.prepare(`SELECT q.id,q.question,q.reversibility,q.status,q.created_at AS createdAt,
    q.decided_at AS decidedAt,q.parent_id AS parentId,r.final_decision AS finalDecision
    FROM questions q LEFT JOIN results r ON r.question_id=q.id WHERE q.id < ?
    ORDER BY q.id DESC LIMIT ?`).all(cursor ?? 'Z', limit+1) as {id: string}[];
  const items = rows.slice(0,limit);
  return { items, nextCursor: rows.length > limit ? items[limit-1].id : null };
}
export function confirm(db: Db, id: string, input: z.output<typeof confirmation>) {
  db.transaction(() => {
    if (getQuestion(db,id).status !== 'needs_confirmation') throw conflict();
    const user = db.prepare("SELECT vote FROM votes WHERE question_id=? AND voter='user'").get(id) as {vote: Answer};
    if ((input.reason === 'keep_mine') !== (input.final === user.vote)) throw invalid('最终答案与所选原因不一致。');
    db.prepare('UPDATE results SET final_decision=?,final_reason=?,final_note=? WHERE question_id=?')
      .run(input.final,input.reason,input.note ?? null,id);
    db.prepare("UPDATE questions SET status='decided',decided_at=? WHERE id=?").run(now(),id);
  }).immediate();
}
export function checkRisk(db: Db, id: string, riskId: string) {
  db.transaction(() => {
    const q = getQuestion(db,id);
    if (q.status === 'running') throw conflict();
    const row = db.prepare('SELECT merged_risks FROM results WHERE question_id=?').get(id) as StoredResult;
    const risks = JSON.parse(row.merged_risks) as MergedRisk[];
    if (!risks.some(r => r.id === riskId)) throw missing();
    db.prepare('INSERT OR IGNORE INTO risk_checks VALUES (?,?,?)').run(id,riskId,now());
    if (q.status !== 'paused') return;
    const done = completedChecks(db,id);
    if (risks.some(r => r.severity === '致命' && !done.has(r.id))) return;
    db.prepare(`UPDATE questions SET status=next_status,next_status=NULL,decided_at=? WHERE id=?`)
      .run(q.nextStatus === 'decided' ? now() : null,id);
    if (q.nextStatus === 'decided') db.prepare('UPDATE results SET final_decision=conclusion WHERE question_id=?').run(id);
  }).immediate();
}
export function retryAbsent(db: Db, id: string) {
  db.transaction(() => {
    if (getQuestion(db,id).status !== 'failed') throw conflict();
    const changed = db.prepare(`UPDATE votes SET state='pending', error=NULL, attempts=0, raw_response=NULL,
      usage=NULL, latency_ms=NULL, model_name=NULL, model_params=NULL, requested_model=NULL, requested_effort=NULL
      WHERE question_id=? AND state='absent'`).run(id).changes;
    if (changed !== 2) throw conflict();
    snapshotModelSettings(db, id);
    db.prepare('DELETE FROM results WHERE question_id=?').run(id);
    db.prepare("UPDATE questions SET status='running',next_status=NULL WHERE id=?").run(id);
  }).immediate();
}
export function recordOutcome(db: Db, id: string, input: z.output<typeof outcomeBody>) {
  db.transaction(() => {
    if (getQuestion(db,id).status !== 'decided') throw conflict();
    db.prepare(`INSERT INTO outcomes VALUES (?,?,?,?) ON CONFLICT(question_id) DO UPDATE SET
      correct_answer=excluded.correct_answer,note=excluded.note,recorded_at=excluded.recorded_at`)
      .run(id,input.correctAnswer,input.note ?? null,now());
  }).immediate();
}
