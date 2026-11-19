import type { Db } from './index.js';
import { models, type Model } from '../magi/schema.js';
import type { Providers } from '../magi/providers/responses.js';
import type { ModelSelection } from '../magi/providers/model-options.js';

export type ModelSettings = Record<Model, ModelSelection>;

const snapshotSql = `UPDATE votes SET (requested_model, requested_effort) =
  (SELECT model, effort FROM model_settings WHERE voter=votes.voter)
  WHERE state='pending' AND voter IN ('gpt','deepseek') AND requested_model IS NULL`;

export function initializeModelSettings(db: Db, providers: Providers) {
  db.transaction(() => {
    const seed = db.prepare(`INSERT INTO model_settings(voter,model,effort) VALUES (?,?,?)
      ON CONFLICT(voter) DO UPDATE SET model=excluded.model, effort=excluded.effort
      WHERE model_settings.user_selected=0`);
    for (const voter of models) seed.run(voter, providers[voter].model, providers[voter].params.reasoning.effort);
    // Includes unfinished votes created before this migration.
    db.exec(snapshotSql);
  }).immediate();
}

export function snapshotModelSettings(db: Db, questionId: string) {
  db.prepare(snapshotSql + ' AND question_id=?').run(questionId);
}

export function readModelSettings(db: Db): ModelSettings {
  const rows = db.prepare('SELECT voter, model, effort FROM model_settings').all() as (ModelSelection & { voter: Model })[];
  return Object.fromEntries(rows.map(({ voter, model, effort }) => [voter, { model, effort }])) as ModelSettings;
}

export function saveModelSettings(db: Db, changes: Partial<ModelSettings>) {
  return db.transaction(() => {
    const save = db.prepare('UPDATE model_settings SET model=?, effort=?, user_selected=1 WHERE voter=?');
    for (const voter of models) {
      const selection = changes[voter];
      if (selection) save.run(selection.model, selection.effort, voter);
    }
    return readModelSettings(db);
  }).immediate();
}
