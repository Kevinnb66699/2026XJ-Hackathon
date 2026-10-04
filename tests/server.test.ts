// 极小后端：事件写入读取、校验、写作检查（用本地假 LLM，不连真模型）
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createRequire } from 'node:module'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { fetch } from 'undici'
import { EventType } from '../shared/schema'
import { createApp, EVENT_TYPES, readEnvFile } from '../server/index.mjs'
import type { ServerConfig } from '../server/index.mjs'

// 仓库没有 @types/express，假 LLM 用 require 拿到无类型的 express
const express = createRequire(import.meta.url)('express')

const KEY = 'sk-test-not-a-real-key'
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zhishi-server-'))
const logs: string[] = []

// 假 LLM 的行为由各测试设置
let llmMode: 'ok' | 'slow' | 'error' | 'garbage' = 'ok'
let llmReply: unknown = { results: [] }
let llmCalls = 0
let lastReq: { auth?: string; body?: any } = {}

function listen(app: { listen(port: number, host: string, cb?: () => void): Server }) {
  return new Promise<{ server: Server; base: string }>((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve({ server, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}` }))
  })
}

async function call(base: string, method: string, url: string, body?: unknown, headers: Record<string, string> = {}) {
  const r = await fetch(base + url, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  })
  return { status: r.status, body: (await r.json()) as any }
}

let llm: { server: Server; base: string }
let app: { server: Server; base: string }
let noKey: { server: Server; base: string }
let common: Partial<ServerConfig>

beforeAll(async () => {
  const fake = express()
  fake.post('/v1/chat/completions', express.json(), (req: any, res: any) => {
    llmCalls++
    lastReq = { auth: req.headers.authorization, body: req.body }
    if (llmMode === 'error') return res.status(500).json({ error: { message: 'boom' } })
    const content = llmMode === 'garbage' ? '抱歉，我不能输出 JSON' : '```json\n' + JSON.stringify(llmReply) + '\n```'
    const send = () => res.json({ model: 'fake-model', choices: [{ message: { content } }] })
    if (llmMode === 'slow') setTimeout(send, 1000)
    else send()
  })
  llm = await listen(fake)
  // 写作检查限次放宽，免得这些测试互相占次数；限次另起几个实例测
  common = { dataDir, llmBaseUrl: `${llm.base}/v1`, llmModel: 'm-main', llmFallbacks: ['m-b1', 'm-b2'], llmTimeoutMs: 200, writingPerSidPerHour: 1000, writingPerDay: 1000, log: (l: string) => logs.push(l) }
  app = await listen(createApp({ ...common, apiKey: KEY }))
  noKey = await listen(createApp({ ...common, apiKey: '' }))
})

afterAll(() => {
  for (const s of [app, noKey, llm]) s.server.close()
})

// 上传的讲义：读全班记录要带它的编辑口令（请求头 X-Edit-Key）。UP_EMPTY 还没有事件，LEGACY 是没有口令的旧 meta
const UP = 'up-events1'
const UP_EMPTY = 'up-events0'
const LEGACY = 'up-eventsold'
const EDIT = 'e'.repeat(32)
fs.mkdirSync(path.join(dataDir, 'handouts'), { recursive: true })
for (const id of [UP, UP_EMPTY]) fs.writeFileSync(path.join(dataDir, 'handouts', `${id}.meta.json`), JSON.stringify({ id, editKey: EDIT }))
fs.writeFileSync(path.join(dataDir, 'handouts', `${LEGACY}.meta.json`), JSON.stringify({ id: LEGACY }))
const readEvents = (q: string, key: string | null = EDIT) => call(app.base, 'GET', `/api/events?${q}`, undefined, key === null ? {} : { 'x-edit-key': key }) // null：不带请求头
const stored = (id: string) => fs.readFileSync(path.join(dataDir, `events-${id}.jsonl`), 'utf8').trim().split('\n').map((l) => JSON.parse(l))

const ev = (o: Record<string, unknown> = {}) => ({ sid: 's1', handoutId: UP, type: 'tap_word', ts: 1000, ...o })

describe('事件', () => {
  it('事件类型与数据契约一致', () => {
    expect(EVENT_TYPES).toEqual(EventType.options)
  })

  it('单个和数组都能写入，按讲义读回，since 只返回更新的', async () => {
    expect((await call(app.base, 'POST', '/api/events', ev({ lemma: 'pending' }))).body).toEqual({ ok: true, accepted: 1 })
    const r = await call(app.base, 'POST', '/api/events', [ev({ ts: 2000, type: 'open_ladder', level: 2 }), ev({ sid: 's2', ts: 3000, type: 'feedback', value: '太难' })])
    expect(r.body).toEqual({ ok: true, accepted: 2 })

    const all = await readEvents(`handoutId=${UP}`)
    expect(all.body).toHaveLength(3)
    expect(all.body[0]).toEqual(ev({ lemma: 'pending' }))
    expect(all.body[2]).toEqual(ev({ sid: 's2', ts: 3000, type: 'feedback', value: '太难' }))
    const later = await readEvents(`handoutId=${UP}&since=1000`)
    expect(later.body.map((e: any) => e.ts)).toEqual([2000, 3000])

    expect(stored(UP)).toHaveLength(3)
    expect((await readEvents(`handoutId=${UP_EMPTY}`)).body).toEqual([])
  })

  it('读全班记录要口令：内置讲义 403；没带、带错、旧讲义没有口令 403；查询串里的 key 不认；讲义不存在 404；带对的请求头 200', async () => {
    await call(app.base, 'POST', '/api/events', ev({ handoutId: 'mini-phones' }))
    expect(await readEvents('handoutId=mini-phones')).toEqual({ status: 403, body: { ok: false, error: '内置演示讲义不开放学习记录' } })
    const denied = { status: 403, body: { ok: false, error: '只有上传这篇文章的那台设备能看全班的学习记录' } }
    for (const key of [null, '', 'f'.repeat(32), EDIT + '0', EDIT.slice(1)]) expect(await readEvents(`handoutId=${UP}`, key), String(key)).toEqual(denied)
    expect(await readEvents(`handoutId=${UP}&key=${EDIT}`, null)).toEqual(denied)
    expect(await readEvents(`handoutId=${LEGACY}`)).toEqual(denied)
    expect(await readEvents(`handoutId=${LEGACY}`, '')).toEqual(denied)
    expect(await readEvents('handoutId=up-missing')).toEqual({ status: 404, body: { ok: false, error: '没有这份讲义' } })
    expect((await readEvents(`handoutId=${UP}`)).status).toBe(200)
  })

  it('诊断事件 page_view、client_error 照常写入读回', async () => {
    const diag = [ev({ handoutId: UP_EMPTY, type: 'page_view', value: '粗读' }), ev({ handoutId: UP_EMPTY, ts: 2000, type: 'client_error', value: 'TypeError: x is undefined' })]
    expect((await call(app.base, 'POST', '/api/events', diag)).body).toEqual({ ok: true, accepted: 2 })
    expect((await readEvents(`handoutId=${UP_EMPTY}`)).body).toEqual(diag)
  })

  it('写盘按字段白名单：写作原文、反馈理由、未知字段去掉，反馈评分保留；类型不对的可选字段丢掉，字符串截短', async () => {
    const id = 'whitelist'
    const raw = [
      ev({ handoutId: id, ts: 1, type: 'writing_submit', value: 'My secret essay about my family.', sentenceId: 'S01' }),
      ev({ handoutId: id, ts: 2, type: 'feedback', value: '太难｜我卡在第三段，因为家里的事' }),
      ev({ handoutId: id, ts: 3, type: 'feedback', value: '刚好' }),
      ev({ handoutId: id, ts: 4, type: 'feedback', value: '我叫张三' }),
      ev({ handoutId: id, ts: 5, type: 'feedback', value: '太简单 ' }),
      ev({ handoutId: id, ts: 6, type: 'answer_question', sentenceId: 'S'.repeat(80), paragraph: 2.5, level: '2', correct: 'yes', firstTry: true, lemma: 'x'.repeat(80), name: '张三', extra: { a: 1 } }),
      ev({ handoutId: id, ts: 7, type: 'page_view', value: 'v'.repeat(300), paragraph: 3, level: 2, correct: false, firstTry: 0 }),
      ev({ handoutId: id, ts: 8, type: 'client_error', value: 42, lemma: 7, sentenceId: null }),
    ]
    expect((await call(app.base, 'POST', '/api/events', raw)).body).toEqual({ ok: true, accepted: raw.length })
    const base = { sid: 's1', handoutId: id }
    expect(stored(id)).toEqual([
      { ...base, ts: 1, type: 'writing_submit', sentenceId: 'S01' },
      { ...base, ts: 2, type: 'feedback', value: '太难' },
      { ...base, ts: 3, type: 'feedback', value: '刚好' },
      { ...base, ts: 4, type: 'feedback' },
      { ...base, ts: 5, type: 'feedback' },
      { ...base, ts: 6, type: 'answer_question', sentenceId: 'S'.repeat(64), lemma: 'x'.repeat(64), firstTry: true },
      { ...base, ts: 7, type: 'page_view', paragraph: 3, level: 2, correct: false, value: 'v'.repeat(200) },
      { ...base, ts: 8, type: 'client_error' },
    ])
    const file = fs.readFileSync(path.join(dataDir, `events-${id}.jsonl`), 'utf8')
    for (const leak of ['secret essay', '卡在', '张三', 'extra', 'name']) expect(file).not.toContain(leak)
  })

  it('任何一条不合格，整批拒收，不写文件', async () => {
    const bad = [
      ev({ sid: 42 }),
      ev({ sid: '' }),
      ev({ sid: 'x'.repeat(65) }),
      ev({ handoutId: '../etc' }),
      ev({ handoutId: 'Mini' }),
      ev({ type: 'hack' }),
      ev({ ts: '1000' }),
      ev({ ts: undefined }),
      'not an object',
    ]
    for (const b of bad) {
      const r = await call(app.base, 'POST', '/api/events', [ev({ handoutId: 'bad-batch' }), b])
      expect(r.status).toBe(400)
      expect(r.body.ok).toBe(false)
    }
    expect((await call(app.base, 'POST', '/api/events', [])).status).toBe(400)
    const tooMany = Array.from({ length: 201 }, () => ev({ handoutId: 'bad-batch' }))
    expect((await call(app.base, 'POST', '/api/events', tooMany)).status).toBe(400)
    expect(fs.existsSync(path.join(dataDir, 'events-bad-batch.jsonl'))).toBe(false)
  })

  it('handoutId 碰上对象原型属性名（constructor）也能原样写入', async () => {
    expect((await call(app.base, 'POST', '/api/events', ev({ handoutId: 'constructor' }))).body).toEqual({ ok: true, accepted: 1 })
    expect(stored('constructor')).toEqual([ev({ handoutId: 'constructor' })])
  })

  it('读取时校验 handoutId 和 since；坏 JSON 返回 JSON 错误', async () => {
    expect((await call(app.base, 'GET', '/api/events?handoutId=..%2Fx')).status).toBe(400)
    expect((await call(app.base, 'GET', '/api/events')).status).toBe(400)
    expect((await readEvents(`handoutId=${UP}&since=abc`)).status).toBe(400)
    const r = await call(app.base, 'POST', '/api/events', '{bad json')
    expect(r.status).toBe(400)
    expect(r.body.ok).toBe(false)
  })
})

describe('写作检查', () => {
  const text = 'My school is toying with the idea of banning phones. I feel very counterproductive in class.'
  const expressions = [
    { id: 'E2', text: 'counterproductive', zh: '适得其反的', example: 'A blanket ban may prove counterproductive.' },
    { id: 'E3', text: 'blanket ban', zh: '全面禁令', example: 'A blanket ban may prove counterproductive.' },
  ]
  const body = { handoutId: 'mini-phones', sid: 's1', text, expressions }

  beforeEach(() => {
    llmMode = 'ok'
  })

  it('正常路径：按约定发请求，只回传请求里的表达和四个字段', async () => {
    llmReply = {
      results: [
        { id: 'E2', used: true, verdict: 'incorrect', reason: '这个词形容做法，不形容人的感受。', fixed: 'I think the ban is counterproductive.', score: 9 },
        { id: 'E3', used: false, verdict: 'maybe', reason: '没有用上。' },
        { id: 'E9', used: true, verdict: 'correct', reason: '请求里没有这个表达' },
      ],
      grammar: [{ quote: 'I feel very counterproductive', type: '词性', hint: '你看看这个词能不能用来说人的感受。', fixed: 'I feel frustrated' }],
    }
    const r = await call(app.base, 'POST', '/api/writing-check', body)
    expect(r.status).toBe(200)
    expect(r.body).toEqual({
      results: [
        { id: 'E2', used: true, verdict: 'incorrect', reason: '这个词形容做法，不形容人的感受。' },
        { id: 'E3', used: false, verdict: 'unsure', reason: '没有用上。' },
      ],
      grammar: [{ quote: 'I feel very counterproductive', type: '词性', hint: '你看看这个词能不能用来说人的感受。' }],
      model: 'fake-model',
      fallback: false,
    })
    expect(lastReq.auth).toBe(`Bearer ${KEY}`)
    expect(lastReq.body).toMatchObject({ model: 'm-main', models: ['m-b1', 'm-b2'], temperature: 0, response_format: { type: 'json_object' } })
    expect(lastReq.body.messages[1].content).toContain(text)
  })

  it('理由里有语法术语或改写后的句子，换成通用理由；引用学生原话可以保留', async () => {
    llmReply = {
      results: [
        { id: 'E2', used: true, verdict: 'incorrect', reason: '说「I feel very counterproductive」不通，这个词不形容人。' },
        { id: 'E3', used: true, verdict: 'correct', reason: '放在主语位置，意思对。' },
      ],
    }
    let r = await call(app.base, 'POST', '/api/writing-check', body)
    expect(r.body.results[0].reason).toBe('说「I feel very counterproductive」不通，这个词不形容人。')
    expect(r.body.results[1].reason).not.toMatch(/主语/)

    // 与管线校验器同一份术语表：定语、状语、表语也要换掉
    for (const term of ['定语', '状语', '表语']) {
      llmReply = { results: [{ id: 'E3', used: true, verdict: 'correct', reason: `这里作${term}，意思对。` }] }
      r = await call(app.base, 'POST', '/api/writing-check', body)
      expect(r.body.results[0].reason).toBe('意思和搭配都对，和原文例句的用法一致。')
    }

    llmReply = { results: [{ id: 'E2', used: true, verdict: 'incorrect', reason: '可以改成 the ban would be counterproductive for us。' }] }
    r = await call(app.base, 'POST', '/api/writing-check', body)
    expect(r.body.results).toEqual([{ id: 'E2', used: true, verdict: 'incorrect', reason: '意思或搭配和原文例句不一样，对照例句再想想。' }])
  })

  it('语法问题：引用不在原文里、类型不是中文短标签的整条丢掉；提示里有原文没有的英文词、改法说法或术语只去掉提示；最多 3 条', async () => {
    const results = [{ id: 'E2', used: true, verdict: 'correct', reason: '用对了。' }]
    llmReply = {
      results,
      grammar: [
        { quote: 'ban phones', type: '单复数', hint: '原文里没有这几个词' },
        { quote: 'toying', type: 'tense', hint: '英文标签' },
        { quote: 'My school is', type: '时态', hint: '这里应该用 was。' },
        { quote: 'in class', type: '介词', hint: '想想主语是谁。' },
        { quote: 'ban', type: '拼写', hint: '你把这个词改成过去的说法。' },
        { quote: ' I feel ', type: '主谓一致', hint: '你看看 feel 和 I 搭不搭。' },
        { quote: 'phones', type: '单复数', hint: '第四条合格的，超过 3 条不要' },
      ],
    }
    let r = await call(app.base, 'POST', '/api/writing-check', body)
    expect(r.body.grammar).toEqual([
      { quote: 'My school is', type: '时态', hint: '' },
      { quote: 'in class', type: '介词', hint: '' },
      { quote: 'ban', type: '拼写', hint: '' },
    ])
    expect(lastReq.body.messages[0].content).toContain('grammar')

    // 模型常把整个短句当引用：80 个字符以内照收
    llmReply = { results, grammar: [{ quote: 'I feel very counterproductive in class.', type: '词性', hint: '想想这个词能不能这样用来说人的感受。' }] }
    r = await call(app.base, 'POST', '/api/writing-check', body)
    expect(r.body.grammar).toEqual([{ quote: 'I feel very counterproductive in class.', type: '词性', hint: '想想这个词能不能这样用来说人的感受。' }])
    llmReply = { results, grammar: [{ quote: text, type: '词性', hint: '' }] } // 整段（超过 80 个字符）还是丢掉
    r = await call(app.base, 'POST', '/api/writing-check', body)
    expect(r.body.grammar).toBeNull()

    // 没有问题：空数组；模型没给 grammar，或给了但一条都不合格：null（前端显示「没查成」），表达检查照常
    for (const [grammar, want] of [[[], []], [undefined, null], ['none', null], [[{ quote: 'not in text', type: '时态', hint: '' }], null]]) {
      llmReply = { results, grammar }
      r = await call(app.base, 'POST', '/api/writing-check', body)
      expect(r.body).toEqual({ results: [{ ...results[0] }], grammar: want, model: 'fake-model', fallback: false })
    }
  })

  it('超时降级：8 秒（测试里 200ms）没回就返回 fallback', async () => {
    llmMode = 'slow'
    const t0 = Date.now()
    const r = await call(app.base, 'POST', '/api/writing-check', body)
    expect(r.body).toEqual({ fallback: true, results: [] })
    expect(Date.now() - t0).toBeLessThan(900)
  })

  it('上游报错或输出不是 JSON：降级', async () => {
    llmMode = 'error'
    expect((await call(app.base, 'POST', '/api/writing-check', body)).body).toEqual({ fallback: true, results: [] })
    llmMode = 'garbage'
    expect((await call(app.base, 'POST', '/api/writing-check', body)).body).toEqual({ fallback: true, results: [] })
  })

  it('没有 Key：直接降级，不调用模型', async () => {
    const before = llmCalls
    expect((await call(noKey.base, 'POST', '/api/writing-check', body)).body).toEqual({ fallback: true, results: [] })
    expect(llmCalls).toBe(before)
  })

  describe('限次', () => {
    const ok = { results: [{ id: 'E2', used: true, verdict: 'correct', reason: '用对了。' }] }
    const limLogs: string[] = []
    const open: { server: Server; base: string }[] = []
    const start = async (o: Partial<ServerConfig>) => {
      const a = await listen(createApp({ ...common, apiKey: KEY, log: (l: string) => limLogs.push(l), ...o }))
      open.push(a)
      return (b: Record<string, unknown>) => call(a.base, 'POST', '/api/writing-check', b)
    }
    afterAll(() => {
      for (const s of open) s.server.close()
    })
    beforeEach(() => {
      llmReply = ok
    })

    it('同一 sid 一小时超过上限 429（带 fallback，不调用模型）；换 sid 不受影响；没带 sid 或格式不对算同一个共享桶', async () => {
      const send = await start({ writingPerSidPerHour: 2, writingPerDay: 100 })
      for (let i = 0; i < 2; i++) expect((await send({ ...body, sid: 'stu-a' })).status).toBe(200)
      const before = llmCalls
      const over = await send({ ...body, sid: 'stu-a' })
      expect(over.status).toBe(429)
      expect(over.body).toEqual({ fallback: true, results: [], error: '每位同学一小时最多用 2 次 AI 写作检查，先看规则检查的反馈吧' })
      expect(llmCalls).toBe(before)
      expect((await send({ ...body, sid: 'stu-b' })).body.fallback).toBe(false)

      const { sid: _, ...noSid } = body
      expect((await send(noSid)).status).toBe(200)
      expect((await send({ ...body, sid: '' })).status).toBe(200)
      for (const sid of ['x'.repeat(65), 42, null, undefined]) expect((await send({ ...body, sid })).status, String(sid)).toBe(429)
      expect(limLogs.filter((l) => l === 'llm limited sid')).toHaveLength(5)
      for (const l of limLogs) {
        expect(l).not.toContain('stu-a')
        expect(l).not.toContain(text)
      }
    })

    it('全站当天超过上限 429，不调用模型', async () => {
      const send = await start({ writingPerSidPerHour: 100, writingPerDay: 2 })
      expect((await send({ ...body, sid: 'stu-a' })).status).toBe(200)
      expect((await send({ ...body, sid: 'stu-b' })).status).toBe(200)
      const before = llmCalls
      const over = await send({ ...body, sid: 'stu-c' })
      expect(over.status).toBe(429)
      expect(over.body).toEqual({ fallback: true, results: [], error: '今天的 AI 写作检查名额已经用完了，先看规则检查的反馈吧' })
      expect(llmCalls).toBe(before)
      expect(limLogs).toContain('llm limited day')
    })

    it('只有真要调用模型才算次数：输入不合格、没有 Key 都不算', async () => {
      const send = await start({ writingPerSidPerHour: 1, writingPerDay: 1 })
      for (let i = 0; i < 3; i++) expect((await send({ ...body, text: '  ' })).status).toBe(400)
      expect((await send(body)).status).toBe(200)
      expect((await send(body)).status).toBe(429)

      const before = llmCalls
      const sendNoKey = await start({ apiKey: '', writingPerSidPerHour: 1, writingPerDay: 1 })
      for (let i = 0; i < 3; i++) expect(await sendNoKey(body)).toEqual({ status: 200, body: { fallback: true, results: [] } })
      expect(llmCalls).toBe(before)
    })
  })

  it('输入校验', async () => {
    const bad = [
      { ...body, text: 'x'.repeat(1201) },
      { ...body, text: '  ' },
      { ...body, handoutId: 'A/B' },
      { ...body, expressions: [] },
      { ...body, expressions: [{ text: 'no id' }] },
      { handoutId: 'mini-phones', text },
    ]
    for (const b of bad) expect((await call(app.base, 'POST', '/api/writing-check', b)).status).toBe(400)
  })
})

describe('其他', () => {
  it('health', async () => {
    expect((await call(app.base, 'GET', '/api/health')).body).toEqual({ ok: true, llm: true, model: 'm-main' })
  })

  it('日志只有计数和耗时，不出现 Key', () => {
    expect(logs.length).toBeGreaterThan(0)
    for (const l of logs) {
      expect(l).not.toContain(KEY)
      expect(l).toMatch(/^#\d+ (GET|POST) \/api\/[\w-]+ \d{3} \d+ms$|^llm (ok \S+|fallback) \d+ms/)
    }
  })

  it('.env 解析：注释、export、引号、空值', () => {
    const file = path.join(dataDir, 'test.env')
    fs.writeFileSync(file, '# 注释\nexport A=1\ntokenspace_apikey="abc def"\nB = \'x\'\nEMPTY=\n')
    expect(readEnvFile(file)).toEqual({ A: '1', tokenspace_apikey: 'abc def', B: 'x', EMPTY: '' })
    expect(readEnvFile(path.join(dataDir, 'missing.env'))).toEqual({})
  })
})
