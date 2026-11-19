import type { Db } from './index.js';
import { voters, type Voter } from '../magi/schema.js';

function round(value: number) { return Math.round(value*100)/100; }
export function stats(db: Db) {
  const rows = db.prepare(`SELECT v.voter,v.confidence,COUNT(*) AS judged,SUM(v.vote=o.correct_answer) AS correct
    FROM votes v JOIN outcomes o ON o.question_id=v.question_id WHERE v.state='valid' AND o.correct_answer IN ('是','否')
    GROUP BY v.voter,v.confidence`).all() as {voter: Voter; confidence: number; judged: number; correct: number}[];
  return { voters: voters.map(voter => {
    const sample = rows.filter(r => r.voter === voter);
    function summarize(group: typeof rows) {
      const judged = group.reduce((s,r) => s+r.judged, 0);
      const correct = group.reduce((s,r) => s+r.correct, 0);
      const confidence = group.reduce((s,r) => s+r.confidence*r.judged, 0);
      return { judged, correct, accuracy: judged ? round(correct/judged) : null,
        avgConfidence: judged ? round(confidence/judged) : null };
    }
    const calibration = [50,60,70,80,90].map(min => {
      const max = min === 90 ? 100 : min+9;
      return { min, max, ...summarize(sample.filter(r => r.confidence >= min && r.confidence <= max)) };
    });
    return { voter, ...summarize(sample), calibration };
  }) };
}
