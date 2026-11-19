import { afterEach,expect,it,vi } from 'vitest';
import { mkdtempSync,writeFileSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { APIConnectionTimeoutError } from 'openai';
import { createProviders } from '../src/magi/providers/responses.js';
import { createQuestion } from '../src/db/questions.js';
import { ballot,config,origin,output,provider,risk,setup,submission } from './helpers.js';

let h: Awaited<ReturnType<typeof setup>>;
afterEach(async () => { if (h) await h.close(); });

it('两家 SDK 并行发送独立盲票，先完成的一方在详情及列表保持隐藏', async () => {
  const sent: {url: string; body: any}[] = [];
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const fetcher: typeof fetch = async (request,init) => {
    const url = request.toString();
    const body = JSON.parse(String(init!.body));
    sent.push({url,body});
    if (url.includes('deepseek')) await gate;
    const text = JSON.stringify({...ballot(),core_reason:'MODEL_PRIVATE_REASON'});
    return Response.json({ id:'resp_magi',object:'response',model:body.model,status:'completed',usage:{total_tokens:50},
      output:[{type:'message',role:'assistant',content:[{type:'output_text',text}]}] });
  };
  h = await setup(createProviders(config,fetcher));
  try {
    const created = await h.post('/questions',submission);
    expect(created.statusCode).toBe(201);
    const {id} = created.json();
    await vi.waitFor(() => {
      expect(sent).toHaveLength(2);
      expect(h.db.prepare("SELECT state FROM votes WHERE voter='gpt'").pluck().get()).toBe('valid');
    });
    expect(sent.map(s => s.url).sort()).toEqual(['https://api.openai.com/v1/responses','https://deepseek.test/responses']);
    for (const {body} of sent) {
      expect(body).toMatchObject({store:false,reasoning:{effort:'max'},text:{format:{type:'json_schema'}}});
      expect(body.input).toBe('【问题】本月是否订阅？\n【背景】月费 30 元\n【目标与约束】控制预算\n【可逆性】可逆');
      expect(body).not.toHaveProperty('previous_response_id');
      expect(JSON.stringify(body)).not.toMatch(/USER_PRIVATE|MODEL_PRIVATE|userVote/);
    }
    expect(sent[0].body.instructions).toBe(sent[1].body.instructions);
    const snap = (await h.get('/questions/'+id)).json();
    expect(snap.result).toBeNull();
    expect(snap.votes.slice(1)).toEqual([{voter:'gpt',state:'pending'},{voter:'deepseek',state:'pending'}]);
    expect((await h.get('/questions')).body).not.toContain('MODEL_PRIVATE');
    expect((await h.post('/questions/'+id+'/retry-absent')).statusCode).toBe(409);
    release(); await h.runner.idle();
    const final = (await h.get('/questions/'+id)).json();
    expect(final).toMatchObject({status:'decided',result:{finalDecision:'是',tally:{yes:3}}});
    expect(final.votes[1].core_reason).toBe('MODEL_PRIVATE_REASON');
    expect(final.votes[1]).not.toHaveProperty('raw_response');
    expect(final.votes.map((v: { model?: string }) => v.model)).toEqual([undefined, 'model-a', 'model-b']);
    expect(h.db.prepare('SELECT COUNT(*) FROM model_attempts WHERE raw_response IS NOT NULL AND usage IS NOT NULL').pluck().get()).toBe(2);
  } finally { release(); }
});

it('网络超时和非法 JSON 至多两次，两方缺席后只接受一次并发技术重试', async () => {
  let fixed = false;
  const g = vi.fn(async () => output(fixed ? JSON.stringify(ballot()) : 'broken'));
  const d = vi.fn(async () => { if (!fixed) throw new APIConnectionTimeoutError({}); return output(); });
  h = await setup({gpt:provider(g),deepseek:provider(d)});
  const {id} = (await h.post('/questions',submission)).json();
  await h.runner.idle();
  const failed = (await h.get('/questions/'+id)).json();
  expect(failed.status).toBe('failed');
  expect(failed.votes.slice(1)).toEqual([{voter:'gpt',state:'absent',error:'INVALID_JSON',model:'resolved-model'},
    {voter:'deepseek',state:'absent',error:'TIMEOUT',model:'model'}]);
  expect(g).toHaveBeenCalledTimes(2); expect(d).toHaveBeenCalledTimes(2);
  fixed = true;
  const replies = await Promise.all([h.post('/questions/'+id+'/retry-absent'),h.post('/questions/'+id+'/retry-absent')]);
  expect(replies.map(r=>r.statusCode).sort()).toEqual([200,409]);
  await h.runner.idle();
  expect((await h.get('/questions/'+id)).json().status).toBe('decided');
  expect(g).toHaveBeenCalledTimes(3); expect(d).toHaveBeenCalledTimes(3);
  expect(h.db.prepare('SELECT count(*) FROM model_attempts').pluck().get()).toBe(6);
  expect(() => h.db.prepare("UPDATE votes SET vote='否' WHERE question_id=? AND voter='user'").run(id)).toThrow();
  expect((await h.app.inject({method:'PATCH',url:'/api/questions/'+id,headers:h.headers,payload:{vote:'否'}})).statusCode).toBe(404);
});

it('并发重复提交、换票重复提交均返回原问题 ID，模型各调用一次', async () => {
  const call = vi.fn(async () => output());
  h = await setup({gpt:provider(call),deepseek:provider(call)});
  const replies = await Promise.all([h.post('/questions',submission),h.post('/questions',submission)]);
  const created = replies.find(r => r.statusCode === 201)!;
  const duplicate = replies.find(r => r.statusCode === 409)!;
  const id = created.json().id;
  expect(duplicate.json()).toMatchObject({error:{code:'DUPLICATE_QUESTION'},existingId:id});
  expect((await h.post('/questions',{...submission,userVote:ballot('否')})).json().existingId).toBe(id);
  await h.runner.idle();
  expect(call).toHaveBeenCalledTimes(2);
  expect((await h.get('/questions/'+id)).json().votes[0].vote).toBe('是');
});

it('自动裁决在解除停机后发布，缺席方不进入准确率样本', async () => {
  h = await setup({gpt:provider(async () => output(JSON.stringify(ballot('是',[risk('致命')])))),
    deepseek:provider(async () => output('invalid'))});
  const {id} = (await h.post('/questions',{...submission,reversibility:'不可逆'})).json();
  const path = '/questions/'+id;
  await h.runner.idle();
  expect((await h.get(path)).json()).toMatchObject({status:'paused',nextStatus:'decided',result:{conclusion:'是',finalDecision:null}});
  await h.post(path+'/checks/gpt-0',{done:true});
  expect((await h.get(path)).json()).toMatchObject({status:'decided',nextStatus:null,result:{finalDecision:'是',pausedBy:[]}});
  expect((await h.post(path+'/retry-absent')).statusCode).toBe(409);
  await h.post(path+'/outcome',{correctAnswer:'是'});
  expect((await h.get('/stats')).json().voters.map((v:any)=>v.judged)).toEqual([1,1,0]);
});

it('服务端校验模型字段、去除代码围栏、按 Unicode 字符截断并保留原始响应', async () => {
  const raw = JSON.stringify({...ballot('是',[{...risk(),check:'检'.repeat(41)}]),core_reason:'🟢'.repeat(52)});
  const g = vi.fn().mockResolvedValueOnce(output(JSON.stringify({...ballot(),confidence:101}))).mockResolvedValue(output('```json\n'+raw+'\n```'));
  h = await setup({gpt:provider(g),deepseek:provider(async () => output(JSON.stringify({...ballot(),risks:[risk(),risk(),risk(),risk()]})))});
  const {id} = (await h.post('/questions',submission)).json();
  await h.runner.idle();
  const q = (await h.get('/questions/'+id)).json();
  expect(q.votes[1].core_reason).toBe('🟢'.repeat(49)+'…');
  expect(q.votes[1].risks[0].check).toBe('检'.repeat(39)+'…');
  expect(q.votes[2].error).toBe('INVALID_SCHEMA');
  expect(g).toHaveBeenCalledTimes(2);
  expect(h.db.prepare("SELECT raw_response FROM votes WHERE voter='gpt'").pluck().get()).toContain(raw);
});

it('全部致命风险解除后才能确认，事后记录更新统计，追问只发送新问题素材', async () => {
  const g = vi.fn(async () => output(JSON.stringify({...ballot('否',[risk('致命','健康')]),core_reason:'PARENT_REASON'})));
  h = await setup({gpt:provider(g),deepseek:provider(async () => output(JSON.stringify(ballot('否',[risk('致命')]))))});
  const {id} = (await h.post('/questions',{...submission,reversibility:'不可逆'})).json();
  await h.runner.idle();
  const path = '/questions/'+id;
  const paused = (await h.get(path)).json();
  expect(paused).toMatchObject({status:'paused',nextStatus:'needs_confirmation',result:{pausedBy:['gpt-0','deepseek-0'],finalDecision:null}});
  expect((await h.post(path+'/confirm',{final:'否',reason:'adopt_majority'})).statusCode).toBe(409);
  expect((await h.post(path+'/outcome',{correctAnswer:'否'})).statusCode).toBe(409);
  expect((await h.post('/questions',{...submission,parentId:id,newInfo:'出现了足够详细的新增信息'})).statusCode).toBe(422);
  await h.post(path+'/checks/gpt-0',{done:true});
  expect((await h.get(path)).json().status).toBe('paused');
  await h.post(path+'/checks/deepseek-0',{done:true});
  expect((await h.get(path)).json().status).toBe('needs_confirmation');
  expect((await h.post(path+'/confirm',{final:'是',reason:'adopt_majority'})).statusCode).toBe(422);
  expect((await h.post(path+'/confirm',{final:'是',reason:'keep_mine',note:'我已核对报价'})).statusCode).toBe(200);
  await h.post(path+'/outcome',{correctAnswer:'说不清'});
  expect((await h.get('/stats')).json().voters[0].judged).toBe(0);
  await h.post(path+'/outcome',{correctAnswer:'否'});
  const stats = (await h.get('/stats')).json().voters;
  expect(stats.map((s:any)=>s.accuracy)).toEqual([0,1,1]);
  expect(stats[1].calibration[2]).toMatchObject({min:70,max:79,judged:1,correct:1,avgConfidence:75});
  expect((await h.post('/questions',{...submission,parentId:id,newInfo:''})).statusCode).toBe(422);
  const child = await h.post('/questions',{...submission,question:'下月是否签约？',parentId:id,newInfo:'新的书面报价已经送达并确认'});
  expect(child.statusCode).toBe(201);
  await h.runner.idle();
  const prompt = String(g.mock.calls.at(-1)?.[0]);
  expect(prompt).toContain('【新增信息】新的书面报价已经送达并确认');
  expect(prompt).not.toMatch(/PARENT_REASON|USER_PRIVATE|本月是否订阅|已核对报价/);
  const page = (await h.get('/questions?limit=1')).json();
  const next = (await h.get('/questions?limit=1&cursor='+page.nextCursor)).json();
  expect(page.items[0].id).toBe(child.json().id);
  expect(next).toMatchObject({items:[{id}],nextCursor:null});
});

it('背景软提醒不产生记录，确认后创建；无需给用户票填写空数组', async () => {
  h = await setup();
  const text = {question:'我觉得',background:'我认为，显然要这样做。',goals:'我打算'};
  const warnings = [{field:'background',phrase:'我认为'},{field:'background',phrase:'显然'}];
  expect((await h.post('/questions/lint',text)).json()).toEqual({warnings});
  const body = {...submission,...text,userVote:{vote:'是',confidence:50,core_reason:'工期足够'}};
  expect((await h.post('/questions',body)).json()).toMatchObject({error:{code:'LINT_WARNINGS'},warnings});
  expect(h.db.prepare('SELECT count(*) FROM questions').pluck().get()).toBe(0);
  expect((await h.post('/questions',{...body,acknowledgeWarnings:true})).statusCode).toBe(201);
});

it('进程中断时保留有效票、归档不确定的请求、恢复尚未派发的请求', async () => {
  const g = vi.fn(async () => output()); const d = vi.fn(async () => output());
  h = await setup({gpt:provider(g),deepseek:provider(d)});
  const id = createQuestion(h.db,submission);
  h.db.prepare("UPDATE votes SET attempts=1 WHERE voter='gpt' AND question_id=?").run(id);
  h.db.prepare("INSERT INTO model_attempts(question_id,voter,started_at,model_name,model_params) VALUES (?,'gpt',?,'test','{}')").run(id,new Date().toISOString());
  const other = createQuestion(h.db,{...submission,question:'另一项尚未完成的表决？'});
  h.db.prepare(`UPDATE votes SET state='valid',vote='否',confidence=50,core_reason='已投票',conditions='[]',risks='[]',flip_condition=''
    WHERE question_id=? AND voter='deepseek'`).run(other);
  h.runner.recover(); await h.runner.idle();
  expect((await h.get('/questions/'+id)).json().votes[1].error).toBe('INTERRUPTED');
  expect((await h.get('/questions/'+other)).json().votes[2].core_reason).toBe('已投票');
  expect(g).toHaveBeenCalledTimes(1); expect(d).toHaveBeenCalledTimes(1);
  h.runner.recover(); await h.runner.idle();
  expect(g).toHaveBeenCalledTimes(1);
});
it('致命用户风险在双缺席时也会暂停，技术重试保留已完成检查', async () => {
  const broken = provider(async () => output('x'));
  h = await setup({gpt:broken,deepseek:broken});
  const {id} = (await h.post('/questions',{...submission,reversibility:'不可逆',userVote:ballot('否',[risk('致命')])})).json();
  await h.runner.idle();
  const path = '/questions/'+id;
  expect((await h.get(path)).json()).toMatchObject({status:'paused',nextStatus:'failed'});
  await h.post(path+'/checks/user-0',{done:true});
  await h.post(path+'/retry-absent'); await h.runner.idle();
  expect((await h.get(path)).json()).toMatchObject({status:'failed',result:{risks:[{checkDone:true}]}});
});
it('未登录的业务接口统一 401，写请求精确校验 Origin', async () => {
  h = await setup();
  for (const url of ['/api/questions','/api/questions/abc','/api/stats','/api/auth/credentials','/api/auth/me']) {
    expect((await h.app.inject({url})).statusCode).toBe(401);
  }
  for (const url of ['/api/questions','/api/questions/lint','/api/questions/abc/outcome','/api/questions/abc/confirm','/api/questions/abc/checks/gpt-0','/api/questions/abc/retry-absent','/api/auth/logout']) {
    expect((await h.app.inject({method:'POST',url,headers:{origin}})).statusCode).toBe(401);
    expect((await h.app.inject({method:'POST',url,headers:{cookie:h.headers.cookie}})).statusCode).toBe(403);
  }
  expect((await h.app.inject({method:'POST',url:'/api/auth/login/options',headers:{origin:'https://other.test'}})).statusCode).toBe(403);
});
it('正式静态文件、SPA 回退、保留的 API 前缀和安全标头', async () => {
  const dir = mkdtempSync(join(tmpdir(),'magi-spa-'));
  try {
    writeFileSync(join(dir,'index.html'),'MAGI app');
    writeFileSync(join(dir,'asset.js'),'ok');
    h = await setup(undefined,dir);
    expect((await h.app.inject('/asset.js')).body).toBe('ok');
    const spa = await h.app.inject('/setup?token=example');
    expect(spa.body).toBe('MAGI app');
    expect(spa.headers['referrer-policy']).toBe('no-referrer');
    expect(spa.headers['content-security-policy']).toContain("frame-ancestors 'none'");
    expect((await h.get('/missing')).statusCode).toBe(404);
  } finally { rmSync(dir,{recursive:true,force:true}); }
});
