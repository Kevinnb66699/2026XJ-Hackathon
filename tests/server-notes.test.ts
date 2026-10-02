// AI 起草讲解：建任务马上返回、前端查进度；只给还没有讲解的句子起草、只回给老师当草稿（不写进讲义）、输出清洗、重试、限次、
// 出错时给统一提示（用本地假 LLM，不连真模型）
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

const KEY = 'sk-test-not-a-real-key'
const FAIL = 'AI 起草暂时不可用，可以先自己写'
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zhishi-notes-'))
const logs: string[] = []
const ID = 'up-notes1'
const DEVICE = 'dev-test-0001'

// 上传生成的讲义（只放后端用到的字段）：S01 已有讲解，S02、S03 没有
const handout = {
  id: ID,
  title: '测试',
  sentences: [
    { id: 'S01', paragraph: 1, text: 'Many schools ban phones.', teacherNote: '老师自己写的。' },
    { id: 'S02', paragraph: 1, text: 'Painted crossings at the most dangerous junction have been tried.', question: { id: 'S02-q' } },
    { id: 'S03', paragraph: 2, text: 'The walkers insist it is the best part of their day.' },
  ],
  words: [
    { lemma: 'junction', forms: ['junction', 'junctions'], sentenceIds: ['S02'] },
    { lemma: 'insist', forms: ['insists', 'insist'], sentenceIds: ['S03'] },
    { lemma: 'walker', forms: ['walkers'], sentenceIds: ['S09'] }, // 词表只记了别的句子，但 S03 原文里也有：照样算（和学生端「给你」便签一样）
  ],
}
const KEY_EDIT = 'a'.repeat(32) // 上传时生成的编辑口令（见 server-upload.test.ts）
const file = path.join(dataDir, 'handouts', `${ID}.json`)
fs.mkdirSync(path.dirname(file), { recursive: true })
fs.writeFileSync(file, JSON.stringify(handout))
const writeMeta = (id: string) => fs.writeFileSync(path.join(dataDir, 'handouts', `${id}.meta.json`), JSON.stringify({ id, editKey: KEY_EDIT }))
writeMeta(ID)

const good2 = '这句说的是路口的几项改动已经试过了。如果不认识 junction 一词，很可能读不懂这句话。'
const good3 = '这句先说走路的人，再说他们坚持的看法：这段路是一天里最好的时光。'

// 假 LLM：行为由各测试设置
let llmMode: 'ok' | 'slow' | 'error' | 'e400' | 'garbage' | 'flaky' = 'ok'
let llmReply: unknown = { notes: [] }
let lastReq: any
let llmCalls = 0
let flakyLeft = 0 // 'flaky'：前几次报错，之后正常
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
    lastReq = { auth: req.headers.authorization, body: JSON.parse(text) }
    llmCalls++
    if (llmMode === 'error' || llmMode === 'e400' || (llmMode === 'flaky' && flakyLeft-- > 0)) {
      res.statusCode = llmMode === 'e400' ? 400 : 500
      return res.end('{"error":"boom"}')
    }
    const content = llmMode === 'garbage' ? '抱歉，我不能输出 JSON' : '```json\n' + JSON.stringify(llmReply) + '\n```'
    const send = () => res.end(JSON.stringify({ model: 'fake-model', choices: [{ message: { content } }] }))
    setTimeout(send, llmMode === 'slow' ? 1000 : 20)
  })
})

function call(app: Srv, url: string, b?: unknown, method = 'POST') {
  return new Promise<{ status: number; body: any }>((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: app.port, path: url, method, headers: { 'content-type': 'application/json' } }, (res) => {
      let text = ''
      res.setEncoding('utf8')
      res.on('data', (c) => (text += c))
      res.on('end', () => resolve({ status: res.statusCode!, body: JSON.parse(text) }))
    })
    req.on('error', reject)
    req.end(b === undefined ? undefined : JSON.stringify(b))
  })
}
const start202 = (app: Srv, id = ID, b: unknown = { device: DEVICE, key: KEY_EDIT }) => call(app, `/api/handouts/${id}/notes/draft`, b)
// 起草：建任务（202 + draftId）后查进度，直到不是 running；结果换成「200 草稿 / 502 出错」，建任务被拒就原样返回
async function draft(app: Srv, id = ID, b?: unknown) {
  const r = await start202(app, id, b)
  if (r.status !== 202) return r
  expect(r.body.draftId).toMatch(/^[0-9a-f]{24}$/)
  for (let i = 0; i < 300; i++) {
    const s = await call(app, `/api/notes-drafts/${r.body.draftId}`, undefined, 'GET')
    if (s.body.status === 'done') return { status: 200, body: { notes: s.body.notes, model: s.body.model } }
    if (s.body.status === 'error') return { status: 502, body: { error: s.body.error } }
    await new Promise((ok) => setTimeout(ok, 10))
  }
  throw new Error('draft did not finish')
}

let llm: Srv
let app: Srv
const open: Srv[] = []
const start = async (o: Partial<ServerConfig> = {}) => {
  const config: Partial<ServerConfig> = {
    dataDir,
    apiKey: KEY,
    llmBaseUrl: `http://127.0.0.1:${llm.port}/v1`,
    pipelineModel: 'm-pipe',
    pipelineFallbacks: ['m-p1'],
    notesTimeoutMs: 300,
    notesPerDevicePerHour: 1000,
    notesPerDay: 1000,
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
  llmReply = { notes: [{ id: 'S02', note: good2 }] }
})

describe('AI 起草讲解', () => {
  it('只把还没有讲解的句子发给模型（带这一句里的注释词形和有没有题），草稿只回给老师，不写进讲义', async () => {
    const before = fs.readFileSync(file, 'utf8')
    llmReply = { notes: [{ id: 'S02', note: good2 }, { id: 'S03', note: good3 }] }
    const r = await draft(app)
    expect(r.status).toBe(200)
    expect(r.body).toEqual({ notes: { S02: good2, S03: good3 }, model: 'fake-model' })
    expect(lastReq.auth).toBe(`Bearer ${KEY}`)
    expect(lastReq.body).toMatchObject({ model: 'm-pipe', models: ['m-p1'], enable_thinking: false, response_format: { type: 'json_object' } })
    expect(lastReq.body.messages[0].content).toMatch(/如果不认识 X 一词/)
    expect(JSON.parse(lastReq.body.messages[1].content)).toEqual([
      { id: 'S02', paragraph: 1, text: handout.sentences[1].text, words: ['junction'], hasQuestion: true },
      { id: 'S03', paragraph: 2, text: handout.sentences[2].text, words: ['insist', 'walkers'], hasQuestion: false }, // insists 不是整词出现，用 insist
    ])
    expect(fs.readFileSync(file, 'utf8')).toBe(before)
  })

  it('模型说没有要起草的（空数组）：照常返回空草稿，不算出错', async () => {
    llmReply = { notes: [] }
    expect(await draft(app)).toEqual({ status: 200, body: { notes: {}, model: 'fake-model' } })
  })

  it('带「如果」的小句只能是「如果不认识 X 一词……」：别的「如果」（会在答题前透露词义）整条丢掉', async () => {
    llmReply = {
      notes: [
        { id: 'S02', note: '这句列了几项改动。如果把 junction 理解成连接，就读偏了，它是路口。如果不认识 junction 一词，很可能读不懂这句话。' },
        { id: 'S03', note: '这句话说走路的人坚持认为那段路最好。如果不认识 insist 这个词，很可能看不懂这句。' },
      ],
    }
    expect((await draft(app)).body.notes).toEqual({ S03: '这句话说走路的人坚持认为那段路最好。如果不认识 insist 这个词，很可能看不懂这句。' })
  })

  it('已有讲解的、讲义里没有的、重复的、太短太长的、有语法术语的整条丢掉；一条都不剩就出错', async () => {
    llmReply = {
      notes: [
        { id: 'S01', note: '老师已经写了这一句，模型又写了一遍，应该丢掉。' },
        { id: 'S99', note: '讲义里没有这一句，模型编出来的编号，应该丢掉。' },
        { id: 'S02', note: good2 },
        { id: 'S02', note: '同一句第二条，丢掉。同一句第二条，丢掉。' },
        { id: 'S03', note: '太短' },
        { id: 'S03', note: '这句的主语是 the walkers，后面是他们坚持的看法，读的时候先找主语。' },
      ],
    }
    expect((await draft(app)).body).toEqual({ notes: { S02: good2 }, model: 'fake-model' })
    llmReply = { notes: [{ id: 'S03', note: 'x'.repeat(301) }] }
    expect(await draft(app)).toEqual({ status: 502, body: { error: FAIL } })
  })

  it('建任务马上返回 202 和 draftId，查进度先是 running；不认识的 draftId 404', async () => {
    llmMode = 'slow'
    const r = await start202(app)
    expect(r.status).toBe(202)
    expect((await call(app, `/api/notes-drafts/${r.body.draftId}`, undefined, 'GET')).body).toEqual({ status: 'running' })
    for (const bad of ['0'.repeat(24), 'abc', '..%2Fx']) expect((await call(app, `/api/notes-drafts/${bad}`, undefined, 'GET')).status, bad).toBe(404)
    // 等这次（会超时的）任务结束，免得它的日志落进下一个测试
    while ((await call(app, `/api/notes-drafts/${r.body.draftId}`, undefined, 'GET')).body.status === 'running') await new Promise((ok) => setTimeout(ok, 20))
  })

  it('出错、不是 JSON：很快失败的再试一次，还不行就出错；超时和 4xx 不再试；统一提示，日志只记错误类型、不带内容', async () => {
    const from = logs.length
    for (const mode of ['error', 'slow', 'garbage', 'e400'] as const) {
      llmMode = mode
      const n = llmCalls
      expect(await draft(app), mode).toEqual({ status: 502, body: { error: FAIL } })
      expect(llmCalls - n, mode).toBe(mode === 'slow' || mode === 'e400' ? 1 : 2)
    }
    expect(logs.slice(from).filter((l) => l.startsWith('notes draft fail')).map((l) => l.split(' ').slice(4).join(' '))).toEqual(['http 500', 'timeout', 'no json', 'http 400'])
    expect(logs.join('\n')).not.toContain('junction')
  })

  it('第一次上游报错、第二次成功：照常返回草稿', async () => {
    llmMode = 'flaky'
    flakyLeft = 1
    expect((await draft(app)).body).toEqual({ notes: { S02: good2 }, model: 'fake-model' })
  })

  it('讲义不存在 404；编辑口令不对 403；设备 id 不对 400；没配置 Key 503；每一句都有讲解 400', async () => {
    expect((await draft(app, 'up-missing')).status).toBe(404)
    expect((await draft(app, '..%2Fsecret')).status).toBe(404)
    expect((await draft(app, ID, { device: DEVICE })).status).toBe(403)
    expect((await draft(app, ID, { device: DEVICE, key: 'b'.repeat(32) })).status).toBe(403)
    expect((await draft(app, ID, { key: KEY_EDIT })).status).toBe(400)
    expect((await draft(app, ID, { device: 'x', key: KEY_EDIT })).status).toBe(400)
    expect(await draft(await start({ apiKey: '' }))).toEqual({ status: 503, body: { error: FAIL } })
    const full = 'up-notesfull'
    fs.writeFileSync(path.join(dataDir, 'handouts', `${full}.json`), JSON.stringify({ ...handout, id: full, sentences: [handout.sentences[0]] }))
    writeMeta(full)
    expect(await draft(app, full)).toEqual({ status: 400, body: { error: '每一句都已经有讲解了' } })
  })

  it('限次：同一设备一小时、同一篇一小时、全站一天，超了 429，不调用模型', async () => {
    const a = await start({ notesPerDevicePerHour: 2, notesPerDay: 4 })
    expect((await draft(a)).status).toBe(200)
    expect((await draft(a)).status).toBe(200)
    const third = await draft(a)
    expect(third.status).toBe(429)
    expect(third.body.error).toMatch(/一小时最多起草 2 次/)
    const perHandout = await draft(a, ID, { device: 'dev-test-0002', key: KEY_EDIT })
    expect(perHandout.status).toBe(429)
    expect(perHandout.body.error).toMatch(/每篇文章一小时最多起草 2 次/)
    const other = 'up-notes2'
    fs.writeFileSync(path.join(dataDir, 'handouts', `${other}.json`), JSON.stringify({ ...handout, id: other }))
    writeMeta(other)
    expect((await draft(a, other, { device: 'dev-test-0002', key: KEY_EDIT })).status).toBe(200)
    expect((await draft(a, other, { device: 'dev-test-0003', key: KEY_EDIT })).status).toBe(200)
    const day = await draft(a, other, { device: 'dev-test-0004', key: KEY_EDIT })
    expect(day.status).toBe(429)
    expect(day.body.error).toMatch(/今天的 AI 起草名额已经用完了/)
  })
})
