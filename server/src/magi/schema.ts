import { z } from 'zod';
import { pageUrl } from './sources.js';

export const voters = ['user', 'gpt', 'deepseek'] as const;
export const models = ['gpt', 'deepseek'] as const;
export type Voter = typeof voters[number];
export type Model = typeof models[number];
export const voterNames = { user: '我', gpt: 'GPT', deepseek: 'DeepSeek' };
export const categories = ['财务','时间','健康','关系','职业','法律','机会成本','信息不足','其他'] as const;
export const severities = ['致命','高','中','低'] as const;
export const answer = z.enum(['是','否']);
export const reversibility = z.enum(['可逆','不可逆']);
export type Answer = z.infer<typeof answer>;
export type Reversibility = z.infer<typeof reversibility>;
export type Status = 'running' | 'needs_confirmation' | 'paused' | 'decided' | 'failed';

function limitedText(limit: number) {
  return z.string().trim().min(1).transform(s => {
    const chars = Array.from(s);
    return chars.length <= limit ? s : chars.slice(0, limit - 1).join('') + '…';
  });
}
const risk = z.strictObject({
  category: z.enum(categories), risk: limitedText(40), check: limitedText(40), severity: z.enum(severities),
});
const source = z.strictObject({
  url: z.string().trim().refine(value => pageUrl(value) !== null),
  claim: limitedText(300),
});
const sources = z.array(source).max(8);
const voteFields = z.strictObject({
  vote: answer, confidence: z.number().int().min(50).max(100), core_reason: limitedText(50),
  conditions: z.array(z.string().trim().min(1)), risks: z.array(risk).max(3), flip_condition: z.string(), sources,
});
const conditionsMatch = (v: { vote: string; conditions: string[] }) => v.vote === '是' || v.conditions.length === 0;
export const ballot = voteFields.refine(conditionsMatch, { message: '投否时 conditions 应为空。' });
const userBallot = voteFields.extend({
  conditions: voteFields.shape.conditions.default([]), risks: voteFields.shape.risks.default([]),
  flip_condition: voteFields.shape.flip_condition.default(''), sources: sources.default([]),
}).refine(conditionsMatch, { message: '投否时 conditions 应为空。' });
export type Ballot = z.output<typeof ballot>;
export type Risk = z.output<typeof risk>;
export type Vote = ({ voter: Voter; state: 'valid' } & Ballot)
  | { voter: Model; state: 'absent'; error: string }
  | { voter: Model; state: 'pending' };

const nonempty = z.string().trim().min(1);
export const ulidText = z.string().regex(/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/);
export const questionBody = z.strictObject({
  question: nonempty, background: z.string(), goals: z.string(), reversibility,
  parentId: ulidText.nullish(), newInfo: z.string().trim().nullish(),
  acknowledgeWarnings: z.boolean().default(false), needsWeb: z.boolean().default(false), userVote: userBallot,
}).refine(q => q.parentId ? Array.from(q.newInfo ?? '').length >= 10 : !q.newInfo,
  { message: '追问需要已决定的父问题和至少十个字的新增信息。', path: ['newInfo'] });
export type Submission = z.output<typeof questionBody>;
export const lintBody = z.strictObject({ question: z.string(), background: z.string(), goals: z.string(), needsWeb: z.boolean().optional() });
export const confirmation = z.strictObject({
  final: answer, reason: z.enum(['adopt_majority','keep_mine']), note: z.string().optional(),
});
export const outcomeBody = z.strictObject({
  correctAnswer: z.enum(['是','否','说不清']), note: z.string().optional(),
});

const stringSchema = { type: 'string' };
export const voteJsonSchema = {
  type: 'object', additionalProperties: false,
  required: ['vote','confidence','core_reason','conditions','risks','flip_condition','sources'],
  properties: {
    vote: { type: 'string', enum: answer.options }, confidence: { type: 'integer', minimum: 50, maximum: 100 },
    core_reason: stringSchema, conditions: { type: 'array', items: stringSchema },
    risks: { type: 'array', maxItems: 3, items: {
      type: 'object', additionalProperties: false, required: ['category','risk','check','severity'],
      properties: { category: { type: 'string', enum: categories }, risk: stringSchema, check: stringSchema,
        severity: { type: 'string', enum: severities } },
    } }, flip_condition: stringSchema,
    sources: { type: 'array', maxItems: 8, items: { type: 'object', additionalProperties: false,
      required: ['url','claim'], properties: { url: stringSchema, claim: stringSchema } } },
  },
};
