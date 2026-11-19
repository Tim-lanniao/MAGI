import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { openDb } from '../src/db/index.js';
import { detail } from '../src/db/questions.js';
import { createProviders } from '../src/magi/providers/responses.js';
import { ChatGPTPlan } from '../src/magi/providers/chatgpt-plan.js';
import { compareSources, pageKey } from '../src/magi/sources.js';
import { ballot, config, output, provider, setup, submission, vote } from './helpers.js';

let h: Awaited<ReturnType<typeof setup>> | undefined;
afterEach(async () => { await h?.close(); h = undefined; });
const page = (url: string, claim = '该网页公布了本期数据。') => ({ url, claim });
const makeText = (urls: string[]) => JSON.stringify({ ...ballot(), sources: urls.map(url => page(url)) });
const message = (text: string) => ({ type: 'message', role: 'assistant',
  content: [{ type: 'output_text', text, annotations: [] }] });
const search = (urls: string[]) => ({ type: 'web_search_call', status: 'completed', action: { type: 'search',
  sources: urls.map(url => ({ type: 'url', url })) } });

it('defaults each question to offline, sends no search tools, validates the switch and accepts old clients', async () => {
  const requests: Record<string,unknown>[] = [];
  h = await setup(createProviders(config, async (_url, init) => {
    const body = JSON.parse(String(init!.body));
    requests.push(body);
    return Response.json({ object: 'response', status: 'completed', model: body.model, output: [message(makeText([]))] });
  }));
  const { needsWeb, userVote, ...fields } = submission;
  const { sources, ...oldVote } = userVote;
  const old = { ...fields, userVote: oldVote };
  expect((await h.post('/questions', { ...old, needsWeb: 'true' })).statusCode).toBe(422);
  expect((await h.post('/questions', { ...old, userVote: { ...oldVote, sources: [page('javascript:alert(1)')] } })).statusCode).toBe(422);
  expect(requests).toHaveLength(0);
  const created = await h.post('/questions', old);
  expect(created.statusCode).toBe(201);
  await h.runner.idle();
  expect(requests).toHaveLength(2);
  for (const req of requests) expect(req).not.toHaveProperty('tools');
  const final = (await h.get('/questions/'+created.json().id)).json();
  expect(final.needsWeb).toBe(false);
  expect(final.result.sourceOverlap).toBeNull();
  for (const v of final.votes) expect(v.sources).toEqual([]);
  expect((await h.post('/questions', { ...old, needsWeb: true })).statusCode).toBe(409);
});

it('independently searches, hides early sources and saves only the cited sites and claims', async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const requests: Record<string, any>[] = [];
  const gpt = ['https://press.bbc.co.uk/a?utm_source=web','https://esa.int/first'];
  const deepseek = ['https://www.bbc.co.uk/b','https://www.esa.int/second','https://example.de/c'];
  const fetcher: typeof fetch = async (url, init) => {
    const b = JSON.parse(String(init!.body)); requests.push(b);
    const isGpt = url.toString().includes('openai');
    const pages = isGpt ? gpt : deepseek;
    if (!isGpt) await gate;
    return Response.json({ object: 'response', model: b.model, status: 'completed', output: [
      message('检索中。'), search([...pages,'https://unused.example.org/result']),
      message(makeText(isGpt ? ['https://press.bbc.co.uk/a#section', gpt[1]] : pages)),
    ] });
  };
  h = await setup(createProviders({ ...config, DEEPSEEK_MODEL: 'deepseek-v4-pro' }, fetcher));
  try {
    const created = await h.post('/questions', { ...submission, needsWeb: true, userVote: {
      ...submission.userVote, sources: [page('https://private.example.org/human','私人来源论点')],
    } });
    expect(created.statusCode).toBe(201);
    const path = '/questions/'+created.json().id;
    await vi.waitFor(() => expect(h!.db.prepare("SELECT state FROM votes WHERE voter='gpt'").pluck().get()).toBe('valid'));
    const blind = (await h.get(path)).json();
    expect(blind.result).toBeNull();
    expect(blind.votes.slice(1)).toEqual([{ voter: 'gpt', state: 'pending' }, { voter: 'deepseek', state: 'pending' }]);
    expect(requests).toHaveLength(2);
    for (const req of requests) {
      expect(req.tools[0].type).toBe('web_search');
      expect(JSON.stringify(req)).not.toMatch(/private\.example|私人来源论点|press\.bbc|USER_PRIVATE/);
    }
    release(); await h.runner.idle();
    const final = (await h.get(path)).json();
    expect(final).toMatchObject({ needsWeb: true, status: 'decided', result: { finalDecision: '是',
      sourceOverlap: { sharedSites: ['bbc.co.uk','esa.int'], totalSites: 3, score: 2/3, warning: '两方信源重叠，独立性低' } } });
    expect(final.votes[1].sources).toEqual(gpt.map(url => page(url)));
    expect(final.votes[2].sources).toEqual(deepseek.map(url => page(url)));
  } finally { release(); }
});

it('refuses invented pages even on the same site, empty sources, and citations without a successful search', async () => {
  const real = 'https://www.example.com/real';
  const other = 'https://www.example.com/invented';
  const g = vi.fn(async () => ({ ...output(makeText([other])), webPages: [real] }));
  const d = vi.fn(async () => ({ ...output(makeText([])), webPages: [real] }));
  h = await setup({ gpt: provider(g), deepseek: provider(d) });
  const created = await h.post('/questions', { ...submission, needsWeb: true });
  const path = '/questions/'+created.json().id;
  await h.runner.idle();
  const failed = (await h.get(path)).json();
  expect(failed.status).toBe('failed');
  expect(failed.votes.slice(1).map((v: {error: string}) => v.error)).toEqual(Array(2).fill('WEB_SOURCES_UNVERIFIED'));
  expect(failed.result.sourceOverlap).toBeNull();
  expect(g).toHaveBeenCalledTimes(2);
  g.mockResolvedValue({ ...output(makeText([real])), webPages: [real] });
  d.mockResolvedValue({ ...output(makeText([real])), webPages: [real] });
  expect((await h.post(path+'/retry-absent')).statusCode).toBe(200);
  await h.runner.idle();
  expect((await h.get(path)).json().result.sourceOverlap.score).toBe(1);
  const flash = createProviders({ ...config, DEEPSEEK_MODEL: 'deepseek-flash' }, async (_url, init) => {
    const req = JSON.parse(String(init!.body));
    expect(req.tools).toEqual([{ type: 'deepseek_web_search' }]);
    expect(req).not.toHaveProperty('text');
    return Response.json({ object: 'response', model: req.model, status: 'completed', output: [
      { ...search([real]), status: 'failed' }, { type: 'message', content: [
        { type: 'output_text', text: makeText([real]), annotations: [{ type: 'url_citation', url: real }] },
      ] },
    ] });
  });
  expect((await flash.deepseek.call('检索', AbortSignal.timeout(2000), undefined, true)).webPages).toEqual([]);
});

it('keeps ChatGPT plan search evidence delivered only in the stream and ignores preliminary messages', async () => {
  const url = 'https://esa.int/mission';
  const plan = new ChatGPTPlan();
  vi.spyOn(plan, 'access').mockResolvedValue('test');
  const providers = createProviders({ ...config, OPENAI_AUTH_MODE: 'chatgpt_plan' }, async (_url, init) => {
    const body = JSON.parse(String(init!.body));
    expect(body).toMatchObject({ stream: true, store: false, tools: [{ type: 'web_search', external_web_access: true }] });
    const events = [
      { type:'response.output_item.done', output_index: 1, item: search([url]) },
      { type:'response.completed', response: { status:'completed', model:'gpt', output:[message(makeText([url]))] } },
    ];
    return new Response(events.map(e => 'data: '+JSON.stringify(e)+'\n\n').join('')+'data: [DONE]\n\n',
      { headers: { 'content-type': 'text/event-stream' } });
  }, plan);
  const result = await providers.gpt.call('独立检索', AbortSignal.timeout(2000), undefined, true);
  expect(result).toMatchObject({ complete: true, raw: makeText([url]), webPages: [url] });
});

it('compares distinct registrable sites including private suffixes and ignores URL tracking but preserves article IDs', () => {
  const votes = (gpt: string[], ds: string[]) => [vote('user'),
    { ...ballot(), voter: 'gpt' as const, state: 'valid' as const, sources: gpt.map(url => page(url)) },
    { ...ballot(), voter: 'deepseek' as const, state: 'valid' as const, sources: ds.map(url => page(url)) }];
  const overlap = compareSources(votes(['https://a.github.io/x','https://a.github.io/y','https://news.bbc.co.uk/a'],
    ['https://b.github.io/z','https://www.bbc.co.uk/b']));
  expect(overlap).toEqual({ sharedSites: ['bbc.co.uk'], totalSites: 3, score: 1/3, warning: null });
  expect(compareSources(votes([],[]))).toBeNull();
  expect(compareSources(votes(['https://esa.int/a'],['https://nasa.gov/a']))).toMatchObject({ score: 0, warning: null });
  expect(pageKey('HTTPS://EXAMPLE.ORG.:443/p?id=2&utm_source=one#first')).toBe('https://example.org/p?id=2');
  expect(pageKey('https://example.org/p?id=3')).not.toBe(pageKey('https://example.org/p?id=2'));
  for (const unsafe of ['javascript:alert(1)','file:///a','https://user:pwd@example.org','/relative']) expect(pageKey(unsafe)).toBeNull();
});

it('migrates locked historical ballots and results as offline without changing their decisions', () => {
  const dir = mkdtempSync(join(tmpdir(),'magi-sources-'));
  try {
    const dbPath = join(dir,'legacy.db');
    const legacy = new Database(dbPath);
    try {
      legacy.exec('CREATE TABLE migrations(name TEXT PRIMARY KEY,applied_at TEXT NOT NULL)');
      for (const name of ['001_initial.sql','002_invite_ip.sql','003_model_settings.sql']) {
        legacy.exec(readFileSync('server/src/db/migrations/'+name, 'utf8'));
        legacy.prepare('INSERT INTO migrations VALUES (?,?)').run(name,'then');
      }
      legacy.exec(`INSERT INTO questions(id,question,background,goals,reversibility,status,created_at) VALUES ('q','Q','','','可逆','decided','then');
        INSERT INTO votes(question_id,voter,state,vote,confidence,core_reason,conditions,risks,flip_condition,created_at)
          VALUES ('q','user','valid','是',70,'原理由','[]','[]','','then');
        INSERT INTO results(question_id,tally,merged_risks,conditions,final_decision) VALUES ('q','{}','[]','[]','是');`);
    } finally { legacy.close(); }
    const db = openDb(dbPath);
    try {
      expect(detail(db,'q')).toMatchObject({ needsWeb: false, votes: [{ sources: [], core_reason: '原理由' }],
        result: { finalDecision: '是', sourceOverlap: null } });
    } finally { db.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
