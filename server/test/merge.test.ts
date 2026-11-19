import { describe,expect,it } from 'vitest';
import { merge } from '../src/magi/merge.js';
import type { Answer, Vote } from '../src/magi/schema.js';
import { absent,risk,vote } from './helpers.js';

describe('计票矩阵', () => {
  it.each([
    ['是','是','是','decided','是',[]], ['否','否','否','decided','否',[]],
    ['否','是','否','decided','否',['gpt']], ['是','否','否','needs_confirmation',null,['user']],
    ['是',null,'是','decided','是',[]], ['是','否',null,'needs_confirmation',null,[]],
    ['否',null,null,'failed',null,[]],
  ] as const)('%s / %s / %s', (a,b,c,status,conclusion,dissenters) => {
    const votes = [vote('user',a),b ? vote('gpt',b) : absent('gpt'),c ? vote('deepseek',c) : absent('deepseek')];
    const result = merge({ reversibility: '可逆' },votes);
    expect(result).toMatchObject({ status,conclusion,nextStatus: null,tally: { dissenters,userInMinority: dissenters.includes('user' as never),
      yes: [a,b,c].filter(v => v === '是').length,no: [a,b,c].filter(v => v === '否').length } });
  });
});
it.each([
  ['不可逆','致命','paused'],['可逆','致命','decided'],['不可逆','高','decided'],
] as const)('%s + %s', (reversibility,severity,status) => {
  const result = merge({ reversibility },[vote('user'),vote('gpt','是',[risk(severity)]),vote('deepseek')]);
  expect(result.status).toBe(status);
  expect(result.pausedBy).toEqual(status === 'paused' ? ['gpt-0'] : []);
  expect(result.nextStatus).toBe(status === 'paused' ? 'decided' : null);
});
it('保留风险原文，按不同来源计数、标记反对票、排序并折叠', () => {
  const u = { ...vote('user','是',[risk('高'),risk('高','财务','第二条财务风险'),risk('低','关系')]), conditions: ['预算获批'] };
  const g = { ...vote('gpt','是',[risk('高'),risk('高','健康'),risk('致命','法律')]), conditions: ['核对合同'] };
  const d = vote('deepseek','否',[risk('高'),risk('低','关系'),risk('低','其他')]);
  const result = merge({ reversibility: '不可逆' },[u,g,d]);
  expect(result.risks.map(r => r.id)).toEqual(['gpt-2','user-0','user-1','gpt-0','deepseek-0','gpt-1','user-2','deepseek-1','deepseek-2']);
  expect(result.risks.filter(r => r.visible)).toHaveLength(5);
  expect(result.risks[2]).toMatchObject({risk:'第二条财务风险',categoryMentions:3,mentionLabel:'三方都提到此类'});
  expect(result.risks[4].fromDissent).toBe(true);
  expect(result.risks[6]).toMatchObject({categoryMentions:2,mentionLabel:'两方提到此类',visible:false});
  expect(result.risks[8].mentionLabel).toBe('仅DeepSeek提到');
  expect(result.conditions).toEqual([{voter:'user',text:'预算获批'},{voter:'gpt',text:'核对合同'}]);
});
it('一个人的两条同类风险只算一方提及', () => {
  const result = merge({reversibility:'可逆'},[vote('user','否',[risk(),risk()]),absent('gpt'),absent('deepseek')]);
  expect(result.risks.map(r => r.categoryMentions)).toEqual([1,1]);
});
