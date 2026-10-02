// 教学建议：输入只收全班汇总、依据里的数字要对得上、缓存、限次、出错时给统一提示（用本地假 LLM，不连真模型）
// 请求用 node:http 发（同 server-upload.test.ts）；后端调用假 LLM 用 undici，这个文件也用子进程跑（见 vite.config.ts）
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createApp } from '../server/index.mjs'
import type { ServerConfig } from '../server/index.mjs'
import { StructureTag } from '../shared/schema'
import { snapshotEvents } from '../src/data/presets'
import { classSummary } from '../src/lib/classSummary'
import { replay } from '../src/lib/replay'
import { miniHandout as h } from './fixtures/mini-handout'

const KEY = 'sk-test-not-a-real-key'
const FAIL = 'AI 建议暂时生成不了，上面的全班情况不受影响'
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zhishi-advice-'))
const logs: string[] = []

// 示例班级的汇总：S01 7/12 人卡在中以上，倒装 7/12 人
const events = snapshotEvents(h)
const summary = classSummary(h, replay(h, events), events)
let n = 0
const fresh = () => ({ ...summary, students: 12, reached: { ...summary.reached, writing: ++n } }) // 每次一份新的汇总，避开缓存
const body = (s: unknown = fresh(), o: Record<string, unknown> = {}) => ({ handoutId: h.id, mode: 'demo', device: 'dev-test-0001', summary: s, ...o })

const good = { title: '精讲 S01 倒装', action: '先让学生找 so are 后面省略的部分，再请自己读懂的同学讲一遍。', evidence: 'S01：7/12 人卡在中以上，5 人自己读懂' }

// 假 LLM：行为由各测试设置
let llmMode: 'ok' | 'slow' | 'error' | 'garbage' = 'ok'
let llmReply: unknown = { suggestions: [good] }
let llmCalls = 0
let lastReq: any
type Srv = { server: Server; port: number }
function listen(make: (cb: () => void) => Server) {
  return new Promise<Srv>((resolve) => {
    const server = make(() => resolve({ server, port: (server.address() as AddressInfo).port }))
  })
}
const fake = http.createServer((req, res) => {
  let text = ''
  req.on('data', (c) => (text += c))
  req.on('end', () => {
    llmCalls++
    lastReq = { auth: req.headers.authorization, body: JSON.parse(text) }
    if (llmMode === 'error') {
      res.statusCode = 500
      return res.end('{"error":"boom"}')
    }
    const content = llmMode === 'garbage' ? '抱歉，我不能输出 JSON' : '```json\n' + JSON.stringify(llmReply) + '\n```'
    const send = () => res.end(JSON.stringify({ model: 'fake-model', choices: [{ message: { content } }] }))
    setTimeout(send, llmMode === 'slow' ? 1000 : 50)
  })
})

function call(app: Srv, url: string, b?: unknown) {
  return new Promise<{ status: number; body: any }>((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: app.port, path: url, method: 'POST', headers: { 'content-type': 'application/json' } }, (res) => {
      let text = ''
      res.setEncoding('utf8')
      res.on('data', (c) => (text += c))
      res.on('end', () => resolve({ status: res.statusCode!, body: JSON.parse(text) }))
    })
    req.on('error', reject)
    req.end(JSON.stringify(b))
  })
}
const advise = (app: Srv, b: unknown = body()) => call(app, '/api/advice', b)

let llm: Srv
let app: Srv
const open: Srv[] = []
const start = async (o: Partial<ServerConfig> = {}) => {
  const config: Partial<ServerConfig> = {
    dataDir,
    apiKey: KEY,
    llmBaseUrl: `http://127.0.0.1:${llm.port}/v1`,
    llmModel: 'm-main',
    llmFallbacks: ['m-b1', 'm-b2'],
    adviceTimeoutMs: 300,
    advicePerDevicePerHour: 1000,
    advicePerDay: 1000,
    log: (l: string) => logs.push(l),
    ...o,
  }
  const a = await listen((cb) => createApp(config).listen(0, '127.0.0.1', cb))
  open.push(a)
  return a
}

beforeAll(async () => {
  llm = await listen((cb) => fake.listen(0, '127.0.0.1', cb))
  app = await start()
})

afterAll(() => {
  for (const s of [...open, llm]) s.server.close()
})

beforeEach(() => {
  llmMode = 'ok'
  llmReply = { suggestions: [good] }
})

describe('教学建议', () => {
  it('正常路径：只把汇总发给模型，只回传三个字段', async () => {
    const s = fresh()
    llmReply = { suggestions: [{ ...good, score: 9, student: '同学 01' }] }
    const r = await advise(app, body(s))
    expect(r.status).toBe(200)
    expect(r.body).toEqual({ suggestions: [good], model: 'fake-model', cached: false })
    expect(lastReq.auth).toBe(`Bearer ${KEY}`)
    expect(lastReq.body).toMatchObject({ model: 'm-main', models: ['m-b1', 'm-b2'], temperature: 0, enable_thinking: false, response_format: { type: 'json_object' } })
    expect(lastReq.body.messages[0].content).toMatch(/JSON/)
    expect(lastReq.body.messages[1].content).toBe(JSON.stringify(s))
  })

  it('依据里有汇总里没有的数字、没有数字、字段不全或太长：整条丢掉，其余照常返回', async () => {
    llmReply = {
      suggestions: [
        good,
        { ...good, title: '编了人数', evidence: 'S01：987/12 人卡在中以上' },
        { ...good, title: '编了句子', evidence: 'S99：7/12 人卡在中以上' },
        { ...good, title: '全角也查', evidence: 'S01：９８７ 人卡住' },
        { ...good, title: '全角对得上', evidence: 'S01：７/１２ 人卡在中以上' },
        { ...good, title: '没有数字', evidence: '很多人卡住' },
        { ...good, title: '标题太长'.repeat(10) },
        { title: '缺依据', action: '讲一遍' },
      ],
    }
    const r = await advise(app)
    expect(r.status).toBe(200)
    expect(r.body.suggestions.map((x: any) => x.title)).toEqual([good.title, '全角对得上'])
  })

  it('全部不合格、不是 JSON、上游报错、超时：502，统一提示；不缓存', async () => {
    const b = body()
    llmReply = { suggestions: [{ ...good, evidence: '987 人' }] }
    for (const mode of ['ok', 'garbage', 'error', 'slow'] as const) {
      llmMode = mode
      const t0 = Date.now()
      const r = await advise(app, b)
      expect(r.status, mode).toBe(502)
      expect(r.body).toEqual({ error: FAIL })
      expect(Date.now() - t0).toBeLessThan(900)
    }
    llmMode = 'ok'
    llmReply = { suggestions: [good] }
    expect((await advise(app, b)).body.cached).toBe(false) // 失败没有留下缓存
  })

  it('没有 Key：503 统一提示，不调用模型；有缓存的照样返回', async () => {
    const noKey = await start({ apiKey: '' })
    const before = llmCalls
    const r = await advise(noKey)
    expect(r.status).toBe(503)
    expect(r.body).toEqual({ error: FAIL })
    const b = body()
    await advise(app, b)
    const calls = llmCalls
    expect((await advise(noKey, b)).body).toMatchObject({ suggestions: [good], cached: true })
    expect(llmCalls).toBe(calls)
    expect(before).toBe(calls - 1)
  })

  it('缓存：同一份汇总只调用一次模型（同时点两次也一样），重启后从磁盘读', async () => {
    const b = body()
    llmMode = 'slow'
    const before = llmCalls
    const app2 = await start({ adviceTimeoutMs: 3000 })
    const [r1, r2] = await Promise.all([advise(app2, b), advise(app2, b)])
    expect(llmCalls - before).toBe(1)
    expect([r1.body.suggestions, r2.body.suggestions]).toEqual([[good], [good]])
    const t0 = Date.now()
    const r3 = await advise(app2, b)
    expect(r3.body).toEqual({ suggestions: [good], model: 'fake-model', cached: true })
    expect(Date.now() - t0).toBeLessThan(500)
    // 换个演示模式、换台设备，汇总一样也算同一份
    expect((await advise(app2, { ...b, mode: 'live', device: 'dev-other-0002' })).body.cached).toBe(true)
    // 重启：新的进程从 advice-cache 读
    const restarted = await start()
    expect((await advise(restarted, b)).body).toMatchObject({ suggestions: [good], cached: true })
    expect(llmCalls - before).toBe(1)
    expect(fs.readdirSync(path.join(dataDir, 'advice-cache')).length).toBeGreaterThan(0)
  })

  it('限次：每台设备每小时 N 次、全站每天 M 次，只算真正调用模型的', async () => {
    const limited = await start({ advicePerDevicePerHour: 2, advicePerDay: 3 })
    const first = body()
    expect((await advise(limited, first)).status).toBe(200)
    expect((await advise(limited, body())).status).toBe(200)
    const third = await advise(limited, body())
    expect(third.status).toBe(429)
    expect(third.body.error).toBe('每台设备一小时最多生成 2 次教学建议，请稍后再试')
    expect((await advise(limited, first)).body.cached).toBe(true) // 命中缓存不算次数
    expect((await advise(limited, body(undefined, { device: 'dev-bbbb-0002' }))).status).toBe(200) // 全站第 3 次
    const over = await advise(limited, body(undefined, { device: 'dev-cccc-0003' }))
    expect(over.status).toBe(429)
    expect(over.body.error).toMatch(/今天的 AI 建议名额已经用完了/)
  })

  it('输入校验：只收汇总里那几个字段，带学生编号、称呼、写作原文的一律 400，不调用模型', async () => {
    const s = fresh()
    const hs = s.hardSentences[0]
    const bad = [
      body(s, { sids: ['stu-abc'] }),
      body({ ...s, students: [{ sid: 'stu-abc', alias: '同学 01' }] }),
      body({ ...s, writing: ['My school is toying with the idea…'] }),
      body({ ...s, feedback: ['太难了'] }),
      body({ ...s, hardSentences: [{ ...hs, who: ['同学 01'] }] }),
      body({ ...s, words: [{ ...s.words[0], sids: ['stu-abc'] }] }),
      body({ ...s, hardSentences: Array(6).fill(hs) }),
      body({ ...s, hardSentences: [{ ...hs, text: 'x'.repeat(601) }] }),
      body({ ...s, hardTag: { tag: 'hack', n: 1, of: 2 } }),
      body({ ...s, firstTry: { ...s.firstTry, pct: 1.5 } }),
      body(s, { handoutId: '../etc' }),
      body(s, { mode: 'prod' }),
      body(s, { device: undefined }),
      body(s, { device: 'short' }),
      { handoutId: h.id, mode: 'demo', device: 'dev-test-0001' },
    ]
    const before = llmCalls
    for (const b of bad) {
      const r = await advise(app, b)
      expect(r.status, JSON.stringify(b).slice(0, 120)).toBe(400)
      expect(r.body.error).toBe('数据格式不对，请刷新页面后再试')
    }
    expect(llmCalls).toBe(before)
    // 纯汇总（没有学生编号）照收
    expect((await advise(app, body(s))).status).toBe(200)
  })

  it('数据契约里的每个结构标签都收；日志只有计数、耗时和模式，不出现 Key', async () => {
    for (const tag of StructureTag.options) expect((await advise(app, body({ ...fresh(), hardTag: { tag, n: 7, of: 12 } }))).status, tag).toBe(200)
    for (const l of logs) {
      expect(l).not.toContain(KEY)
      expect(l).toMatch(/^#\d+ POST \/api\/advice \d{3} \d+ms$|^advice (ok \S+|fail) \d+ms( timeout| error)? (live|demo)$/)
    }
  })
})
