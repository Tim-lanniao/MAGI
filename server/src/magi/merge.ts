import { severities, voters, voterNames, type Answer, type Model, type Reversibility, type Risk,
  type Vote, type Voter } from './schema.js';

export interface MergedRisk extends Risk {
  id: string; voter: Voter; categoryMentions: number; mentionLabel: string; fromDissent: boolean; visible: boolean;
}
export function merge(question: { reversibility: Reversibility }, votes: Vote[]) {
  const ordered = [...votes].sort((a,b) => voters.indexOf(a.voter) - voters.indexOf(b.voter));
  const valid = ordered.filter(v => v.state === 'valid');
  const user = valid.find(v => v.voter === 'user');
  if (!user || votes.length !== 3 || new Set(votes.map(v => v.voter)).size !== 3 || votes.some(v => v.state === 'pending')) {
    throw new Error('需要三方的终态票。');
  }
  const yes = valid.filter(v => v.vote === '是').length;
  const no = valid.length - yes;
  const absent = ordered.filter(v => v.state === 'absent').map(v => v.voter as Model);
  const majority: Answer | null = yes === no ? null : yes > no ? '是' : '否';
  const dissenters = valid.filter(v => majority !== null && v.vote !== majority).map(v => v.voter);
  const userInMinority = dissenters.includes('user');
  const baseStatus = absent.length === 2 ? 'failed' : majority && !userInMinority ? 'decided' : 'needs_confirmation';
  const conclusion = baseStatus === 'decided' ? majority : null;
  const categoryVoters = new Map<string, Set<Voter>>();
  for (const v of valid) {
    for (const r of v.risks) {
      if (!categoryVoters.has(r.category)) categoryVoters.set(r.category, new Set());
      categoryVoters.get(r.category)!.add(v.voter);
    }
  }
  const risks: MergedRisk[] = valid.flatMap(v => v.risks.map((risk, i) => {
    const count = categoryVoters.get(risk.category)!.size;
    return { ...risk, id: v.voter + '-' + i, voter: v.voter, categoryMentions: count,
      mentionLabel: count === 3 ? '三方都提到此类' : count === 2 ? '两方提到此类' : '仅' + voterNames[v.voter] + '提到',
      fromDissent: dissenters.includes(v.voter), visible: false };
  }));
  risks.sort((a,b) => severities.indexOf(a.severity) - severities.indexOf(b.severity)
    || b.categoryMentions - a.categoryMentions || voters.indexOf(a.voter) - voters.indexOf(b.voter));
  risks.forEach((r,i) => { r.visible = i < 5; });
  const pausedBy = question.reversibility === '不可逆' ? risks.filter(r => r.severity === '致命').map(r => r.id) : [];
  const conditions = valid.filter(v => v.vote === '是').flatMap(v => v.conditions.map(text => ({ voter: v.voter, text })));
  const label = Math.max(yes,no) + ':' + Math.min(yes,no)
    + (absent.length ? '（' + absent.map(v => voterNames[v]).join('、') + ' 缺席）' : '');
  return {
    status: pausedBy.length ? 'paused' as const : baseStatus, nextStatus: pausedBy.length ? baseStatus : null,
    tally: { yes, no, absent, label, userInMinority, dissenters }, conclusion, conditions, risks, pausedBy,
  };
}
