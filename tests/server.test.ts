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

async function call(base: string, method: string, url: string, body?: unknown) {
  const r = await fetch(base + url, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  })
  return { status: r.status, body: (await r.json()) as any }
}

let llm: { server: Server; base: string }
let app: { server: Server; base: string }
let noKey: { server: Server; base: string }

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
  const common = { dataDir, llmBaseUrl: `${llm.base}/v1`, llmModel: 'm-main', llmFallbacks: ['m-b1', 'm-b2'], llmTimeoutMs: 200, log: (l: string) => logs.push(l) }
  app = await listen(createApp({ ...common, apiKey: KEY }))
  noKey = await listen(createApp({ ...common, apiKey: '' }))
})

afterAll(() => {
  for (const s of [app, noKey, llm]) s.server.close()
})

const ev = (o: Record<string, unknown> = {}) => ({ sid: 's1', handoutId: 'mini-phones', type: 'tap_word', ts: 1000, ...o })

describe('事件', () => {
  it('事件类型与数据契约一致', () => {
    expect(EVENT_TYPES).toEqual(EventType.options)
  })

  it('单个和数组都能写入，按讲义读回，since 只返回更新的', async () => {
    expect((await call(app.base, 'POST', '/api/events', ev({ lemma: 'pending' }))).body).toEqual({ ok: true, accepted: 1 })
    const r = await call(app.base, 'POST', '/api/events', [ev({ ts: 2000, type: 'open_ladder', level: 2 }), ev({ sid: 's2', ts: 3000, type: 'feedback', value: 'hard' })])
    expect(r.body).toEqual({ ok: true, accepted: 2 })

    const all = await call(app.base, 'GET', '/api/events?handoutId=mini-phones')
    expect(all.body).toHaveLength(3)
    expect(all.body[0]).toEqual(ev({ lemma: 'pending' }))
    const later = await call(app.base, 'GET', '/api/events?handoutId=mini-phones&since=1000')
    expect(later.body.map((e: any) => e.ts)).toEqual([2000, 3000])

    const lines = fs.readFileSync(path.join(dataDir, 'events-mini-phones.jsonl'), 'utf8').trim().split('\n')
    expect(lines).toHaveLength(3)
    expect((await call(app.base, 'GET', '/api/events?handoutId=nobody')).body).toEqual([])
  })

  it('诊断事件 page_view、client_error 照常写入读回', async () => {
    const diag = [ev({ handoutId: 'diag', type: 'page_view', value: '粗读' }), ev({ handoutId: 'diag', ts: 2000, type: 'client_error', value: 'TypeError: x is undefined' })]
    expect((await call(app.base, 'POST', '/api/events', diag)).body).toEqual({ ok: true, accepted: 2 })
    expect((await call(app.base, 'GET', '/api/events?handoutId=diag')).body).toEqual(diag)
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

  it('handoutId 碰上对象原型属性名（constructor）也能原样写入读回', async () => {
    expect((await call(app.base, 'POST', '/api/events', ev({ handoutId: 'constructor' }))).body).toEqual({ ok: true, accepted: 1 })
    expect((await call(app.base, 'GET', '/api/events?handoutId=constructor')).body).toEqual([ev({ handoutId: 'constructor' })])
  })

  it('读取时校验 handoutId 和 since；坏 JSON 返回 JSON 错误', async () => {
    expect((await call(app.base, 'GET', '/api/events?handoutId=..%2Fx')).status).toBe(400)
    expect((await call(app.base, 'GET', '/api/events')).status).toBe(400)
    expect((await call(app.base, 'GET', '/api/events?handoutId=mini-phones&since=abc')).status).toBe(400)
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
  const body = { handoutId: 'mini-phones', text, expressions }

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
