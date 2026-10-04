// 老师上传文章：开关、邀请码和限次、输入校验、生成任务、讲义读取、发布和老师讲解（注入假管线，不连真模型）
// 请求用 node:http 发：不用 undici，免得 Node 16 的 worker 退出时卡住（见 vite.config.ts），也能发出未规范化的路径
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { deriveTitle } from '../pipeline/article'
import { createApp, loadConfig } from '../server/index.mjs'
import type { BuildArticle } from '../server/index.mjs'

const KEY = 'sk-test-not-a-real-key'
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zhishi-upload-'))
const logs: string[] = []

const TEXT = 'Many schools are toying with the idea of banning phones in class. '.repeat(5).trim()
const DEVICE = 'dev-test-0001'
const INVITE = 'invite-test-0001'
const article = (o: Record<string, unknown> = {}) => ({ device: DEVICE, invite: INVITE, title: '  Phones in Class ', text: TEXT, ...o })

// 假管线：每个测试设置 build；calls 记录收到的参数
let build: BuildArticle
let calls: Parameters<BuildArticle>[] = []
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const quick: BuildArticle = async (input, opts) => {
  await sleep(5) // createdAt 至少差几毫秒，列表排序才确定
  return { handout: { id: opts.id, title: input.title }, report: { errors: 0 } }
}

type App = { server: Server; port: number }
function listen(config: Parameters<typeof createApp>[0]) {
  return new Promise<App>((resolve) => {
    const server = createApp(config).listen(0, '127.0.0.1', () => resolve({ server, port: (server.address() as AddressInfo).port }))
  })
}

function call(app: App, method: string, url: string, body?: unknown, headers: Record<string, string> = {}) {
  return new Promise<{ status: number; body: any }>((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: app.port, path: url, method, headers: { 'content-type': 'application/json', ...headers } }, (res) => {
      let text = ''
      res.setEncoding('utf8')
      res.on('data', (c) => (text += c))
      res.on('end', () => resolve({ status: res.statusCode!, body: JSON.parse(text) }))
    })
    req.on('error', reject)
    req.end(body === undefined ? undefined : JSON.stringify(body))
  })
}

// 查进度、读没发布的讲义：带请求头 X-Edit-Key（上传时拿到的口令）
const withKey = (key: string) => ({ 'x-edit-key': key })

async function waitJob(app: App, jobId: string, key: string) {
  for (let i = 0; i < 300; i++) {
    const r = await call(app, 'GET', `/api/uploads/${jobId}`, undefined, withKey(key))
    if (r.body.status !== 'running') return r
    await sleep(10)
  }
  throw new Error('job did not finish')
}

// 提交并等任务结束；key 是这篇的编辑口令
async function upload(app: App, o: Record<string, unknown> = {}) {
  const r = await call(app, 'POST', '/api/uploads', article(o))
  expect(r.status).toBe(202)
  return { ...(await waitJob(app, r.body.jobId, r.body.editKey)), key: r.body.editKey as string }
}

let up: App
let noKey: App

beforeAll(async () => {
  const common = {
    dataDir,
    apiKey: KEY,
    uploadInvites: [INVITE, 'invite-test-0002'],
    uploadsPerDevicePerHour: 1000,
    uploadsPerDay: 1000,
    llmBaseUrl: 'http://llm.invalid/v1',
    pipelineModel: 'm-pipe',
    pipelineFallbacks: ['m-p1'],
    buildArticle: ((input, opts) => {
      calls.push([input, opts])
      return build(input, opts)
    }) as BuildArticle,
    log: (l: string) => logs.push(l),
  }
  up = await listen(common)
  noKey = await listen({ ...common, apiKey: '' })
})

afterAll(() => {
  for (const s of [up, noKey]) s.server.close()
})

beforeEach(() => {
  build = quick
  calls = []
})

describe('开关和限次', () => {
  it('没配置 Key：503；不带设备 id 或格式不对：400；都不建任务', async () => {
    const r = await call(noKey, 'POST', '/api/uploads', article())
    expect(r.status).toBe(503)
    expect(typeof r.body.error).toBe('string')
    for (const device of [undefined, '', 'short', 'UPPER-CASE-ID', 'a/b/c/d/e/f', 123]) {
      const bad = await call(up, 'POST', '/api/uploads', article({ device }))
      expect(bad.status, String(device)).toBe(400)
      expect(bad.body.error).toMatch(/刷新/)
    }
    expect(calls).toHaveLength(0)
  })

  it('同一设备一小时最多 N 篇，换设备不受影响；全站每天最多 M 篇', async () => {
    const limited = await listen({ dataDir, apiKey: KEY, uploadInvites: [INVITE], uploadsPerDevicePerHour: 2, uploadsPerDay: 3, buildArticle: quick, log: () => {} })
    const send = (device: string) => call(limited, 'POST', '/api/uploads', article({ device }))
    const finish = async (r: { body: any }) => waitJob(limited, r.body.jobId, r.body.editKey)
    for (let i = 0; i < 2; i++) await finish(await send('dev-aaaa-0001'))
    const third = await send('dev-aaaa-0001')
    expect(third.status).toBe(429)
    expect(third.body.error).toMatch(/一小时最多上传 2 篇/)
    await finish(await send('dev-bbbb-0002')) // 全站第 3 篇
    const over = await send('dev-cccc-0003')
    expect(over.status).toBe(429)
    expect(over.body.error).toMatch(/今天全站的上传名额/)
    limited.server.close()
  })

  it('读取配置：PIPELINE_MODEL、PIPELINE_FALLBACKS；限次用默认值；默认没有邀请码', () => {
    const ENV_FILE = path.join(dataDir, 'missing.env')
    expect(loadConfig({ ENV_FILE })).toMatchObject({
      pipelineModel: 'deepseek-v4-pro',
      pipelineFallbacks: ['qwen3.7-max', 'glm-5.2'],
      uploadsPerDevicePerHour: 5,
      uploadsPerDay: 60,
      uploadInvites: [],
      writingPerSidPerHour: 20,
      writingPerDay: 1500,
    })
    const cfg = loadConfig({ ENV_FILE, PIPELINE_MODEL: 'm1', PIPELINE_FALLBACKS: 'a, b,' })
    expect(cfg).toMatchObject({ pipelineModel: 'm1', pipelineFallbacks: ['a', 'b'] })
  })

  it('读取配置：UPLOAD_INVITES 逗号分隔、去空白、去空项；少于 8 个字符的丢掉，日志只记个数、不记码', () => {
    const ENV_FILE = path.join(dataDir, 'missing.env')
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {})
    try {
      expect(loadConfig({ ENV_FILE, UPLOAD_INVITES: ' 0123456789abcdef , ,abcdefgh,' }).uploadInvites).toEqual(['0123456789abcdef', 'abcdefgh'])
      expect(spy).not.toHaveBeenCalled()
      expect(loadConfig({ ENV_FILE, UPLOAD_INVITES: 'short7x,0123456789abcdef,tiny' }).uploadInvites).toEqual(['0123456789abcdef'])
      expect(spy).toHaveBeenCalledTimes(1)
      const line = String(spy.mock.calls[0][0])
      expect(line).toMatch(/2 个/)
      for (const code of ['short7x', 'tiny', '0123456789abcdef']) expect(line).not.toContain(code)
    } finally {
      spy.mockRestore()
    }
  })
})

describe('邀请码', () => {
  it('没配置邀请码：带什么码都 403，不建任务', async () => {
    const closed = await listen({ dataDir, apiKey: KEY, buildArticle: quick, log: () => {} })
    for (const invite of [undefined, INVITE, '']) {
      expect(await call(closed, 'POST', '/api/uploads', article({ invite })), String(invite)).toEqual({ status: 403, body: { error: '上传目前只对受邀老师开放' } })
    }
    closed.server.close()
  })

  it('邀请码缺失、不对、类型不对 403，不建任务；先查 Key（503）和设备 id（400）', async () => {
    for (const invite of [undefined, '', 'invite-test-000', INVITE + '1', INVITE.toUpperCase(), ` ${INVITE}`, 123, [INVITE]]) {
      const r = await call(up, 'POST', '/api/uploads', article({ invite }))
      expect(r, JSON.stringify(invite)).toEqual({ status: 403, body: { error: '邀请码不对，请向知适团队确认' } })
    }
    expect((await call(noKey, 'POST', '/api/uploads', article({ invite: 'wrong' }))).status).toBe(503)
    expect((await call(up, 'POST', '/api/uploads', article({ device: 'short', invite: 'wrong' }))).status).toBe(400)
    // 邀请码对了才查输入
    expect((await call(up, 'POST', '/api/uploads', article({ invite: 'wrong', text: 'Too short.' }))).status).toBe(403)
    expect(calls).toHaveLength(0)
  })

  it('邀请码对：202；列表里哪个码都行；邀请码不进响应、任务、meta、日志，也不交给管线', async () => {
    const from = logs.length
    const sub = await call(up, 'POST', '/api/uploads', article())
    expect(sub.status).toBe(202)
    expect(Object.keys(sub.body).sort()).toEqual(['editKey', 'jobId'])
    const done = await waitJob(up, sub.body.jobId, sub.body.editKey)
    expect(done.body.status).toBe('done')
    const second = await upload(up, { invite: 'invite-test-0002' })
    expect(second.body.status).toBe('done')
    for (const id of [sub.body.jobId, second.body.handoutId]) {
      const meta = fs.readFileSync(path.join(dataDir, 'handouts', `${id}.meta.json`), 'utf8')
      expect(meta).not.toContain('invite')
    }
    expect(JSON.stringify([sub.body, done.body, second.body, calls])).not.toContain('invite')
    expect(logs.slice(from).join('\n')).not.toContain('invite')
  })
})

describe('输入校验', () => {
  it('不合格的输入 400，带中文 error，不建任务', async () => {
    const bad = [
      { title: 'x'.repeat(101) },
      { text: undefined },
      { text: 'Too short.' },
      { text: 'a'.repeat(8001) },
      { mustWords: 'pending' },
      { mustWords: [1] },
      { mustWords: Array.from({ length: 21 }, (_, i) => `w${i}`) },
      { checkIns: Array.from({ length: 9 }, (_, i) => `s${i}`) },
      { checkIns: ['x'.repeat(401)] },
      { focus: 42 },
      { focus: 'x'.repeat(501) },
    ]
    for (const b of bad) {
      const r = await call(up, 'POST', '/api/uploads', article(b))
      expect(r.status, JSON.stringify(b).slice(0, 80)).toBe(400)
      expect(r.body.error).toMatch(/[一-龥]/)
    }
    // 长度不对时带上现在的字数
    expect((await call(up, 'POST', '/api/uploads', article({ text: 'Too short.' }))).body.error).toBe('文章长度要在 200 到 8000 个字符之间（现在 10 个）')
    expect(calls).toHaveLength(0)
  })

  it('8000 字符的文章能提交；可选项去掉空项，原文原样交给管线', async () => {
    const text = `${'Long article text here. '.repeat(400)}`.slice(0, 7999) + '.'
    expect(text).toHaveLength(8000)
    const r = await upload(up, { text, mustWords: [' blanket ban ', '', 'pending'], checkIns: ['  ', 'Long article text here.'], focus: '  ' })
    expect(r.body.status).toBe('done')
    expect(calls[0][0]).toEqual({ title: 'Phones in Class', text, mustWords: ['blanket ban', 'pending'], checkIns: ['Long article text here.'] })
  })

  it('标题可以不填：空标题交给管线，任务结果和 meta 用管线生成的标题', async () => {
    build = async (input, opts) => ({ handout: { id: opts.id, title: input.title || deriveTitle(input.text) }, report: { errors: 0 } })
    for (const title of [undefined, '   ']) {
      calls = []
      const r = await upload(up, { title })
      expect(calls[0][0].title).toBe('')
      expect(r.body).toEqual({ status: 'done', handoutId: r.body.handoutId, title: 'Many schools are toying with the idea of banning phones in…', report: { errors: 0 } })
      const meta = JSON.parse(fs.readFileSync(path.join(dataDir, 'handouts', `${r.body.handoutId}.meta.json`), 'utf8'))
      expect(meta.title).toBe(r.body.title)
    }
  })
})

describe('生成任务', () => {
  it('进度 → 完成：落盘讲义和 meta，模型配置按约定', async () => {
    let finish!: () => void
    build = async (input, opts) => {
      opts.onProgress({ stage: 'draft', done: 1, total: 3 })
      await new Promise<void>((r) => (finish = r))
      return { handout: { id: opts.id, title: input.title, paragraphs: [] }, report: { ladders: 4, errors: 0 } }
    }
    const r = await call(up, 'POST', '/api/uploads', article({ focus: ' 细节理解 ' }))
    expect(r.status).toBe(202)
    const { jobId } = r.body
    expect(jobId).toMatch(/^up-[a-z0-9]+$/)
    expect(jobId.length).toBeLessThanOrEqual(64)

    expect((await call(up, 'GET', `/api/uploads/${jobId}`, undefined, withKey(r.body.editKey))).body).toEqual({ status: 'running', progress: { stage: 'draft', done: 1, total: 3 } })
    // 同一时间只跑一个
    const busy = await call(up, 'POST', '/api/uploads', article())
    expect(busy.status).toBe(429)
    expect(busy.body.error).toBe('有其他老师正在生成，请 1 分钟后再试')

    const [input, opts] = calls[0]
    expect(input).toEqual({ title: 'Phones in Class', text: TEXT, focus: '细节理解' })
    expect(opts.id).toBe(jobId)
    expect(opts.llm).toEqual({
      baseUrl: 'http://llm.invalid/v1',
      apiKey: KEY,
      model: 'm-pipe',
      fallbacks: ['m-p1'],
      cacheDir: path.join(dataDir, 'llm-cache'),
      replay: false,
      timeoutMs: 90000,
      thinking: false,
    })

    finish()
    const done = await waitJob(up, jobId, r.body.editKey)
    expect(done.body).toEqual({ status: 'done', handoutId: jobId, title: 'Phones in Class', report: { ladders: 4, errors: 0 } })
    const dir = path.join(dataDir, 'handouts')
    expect(JSON.parse(fs.readFileSync(path.join(dir, `${jobId}.json`), 'utf8'))).toEqual({ id: jobId, title: 'Phones in Class', paragraphs: [] })
    const meta = JSON.parse(fs.readFileSync(path.join(dir, `${jobId}.meta.json`), 'utf8'))
    expect(meta).toEqual({ id: jobId, title: 'Phones in Class', createdAt: expect.any(String), published: false, report: { ladders: 4, errors: 0 }, editKey: r.body.editKey })

    // 跑完就能提交下一篇
    build = quick
    expect((await upload(up)).body.status).toBe('done')
  })

  it('ArticleError：原样把 message 给老师；其他异常只给通用提示，日志不带 Key 和整篇原文', async () => {
    build = async () => {
      const e = new Error('文章里的段落太多了，最多 12 段')
      e.name = 'ArticleError'
      throw e
    }
    expect((await upload(up)).body).toEqual({ status: 'error', error: '文章里的段落太多了，最多 12 段' })

    build = async () => {
      throw new Error(`upstream 500 with ${KEY}: ${TEXT}`)
    }
    expect((await upload(up)).body).toEqual({ status: 'error', error: '生成失败，请稍后再试' })
    expect(logs.some((l) => /^upload up-[a-z0-9]+ failed \d+ms Error: upstream 500/.test(l))).toBe(true)

    // 落盘失败也算其他异常；出错的任务不留讲义
    build = async () => ({ handout: { n: 1n }, report: {} }) // BigInt 不能转 JSON
    const { jobId, editKey } = (await call(up, 'POST', '/api/uploads', article())).body
    expect((await waitJob(up, jobId, editKey)).body).toEqual({ status: 'error', error: '生成失败，请稍后再试' })
    expect((await call(up, 'GET', `/api/handouts/${jobId}`, undefined, withKey(editKey))).status).toBe(404)

    for (const l of logs) {
      expect(l).not.toContain(KEY)
      expect(l).not.toContain(TEXT)
    }
  })

  it('任务只保留最近 20 个；不存在的任务 404', async () => {
    const { jobId: first, editKey } = (await call(up, 'POST', '/api/uploads', article())).body
    await waitJob(up, first, editKey)
    for (let i = 0; i < 20; i++) await upload(up)
    expect((await call(up, 'GET', `/api/uploads/${first}`, undefined, withKey(editKey))).status).toBe(404)
    expect((await call(up, 'GET', '/api/uploads/up-nope', undefined, withKey(editKey))).status).toBe(404)
    // 任务记录没了，讲义还在
    expect((await call(up, 'GET', `/api/handouts/${first}`, undefined, withKey(editKey))).status).toBe(200)
  })

  it('查进度要带对请求头 X-Edit-Key，否则 404；返回的任务对象里没有口令', async () => {
    let finish!: () => void
    build = async (input, opts) => {
      await new Promise<void>((r) => (finish = r))
      return quick(input, opts)
    }
    const { jobId, editKey } = (await call(up, 'POST', '/api/uploads', article())).body
    const other = 'b'.repeat(32)
    const lost = { status: 404, body: { error: '找不到这个生成任务，请重新提交' } }
    for (const h of [{}, withKey(''), withKey(other), withKey(editKey + '0'), withKey(editKey.toUpperCase())]) {
      expect(await call(up, 'GET', `/api/uploads/${jobId}`, undefined, h), JSON.stringify(h)).toEqual(lost)
    }
    expect(await call(up, 'GET', `/api/uploads/${jobId}?key=${editKey}`)).toEqual(lost)
    const running = await call(up, 'GET', `/api/uploads/${jobId}`, undefined, withKey(editKey))
    expect(running.status).toBe(200)
    expect(running.body.status).toBe('running')
    finish()
    const done = await waitJob(up, jobId, editKey)
    expect(done.body).toEqual({ status: 'done', handoutId: jobId, title: 'Phones in Class', report: { errors: 0 } })
    expect(JSON.stringify([running.body, done.body])).not.toContain(editKey)
    expect(await call(up, 'GET', `/api/uploads/${jobId}`)).toEqual(lost)
  })
})

describe('讲义读取和发布', () => {
  it('没发布的讲义：不带口令或口令不对都 404（和不存在一样），带对请求头 X-Edit-Key 能读；发布要口令；发布后谁都能读；没有公开列表', async () => {
    const { body: A, key: keyA } = await upload(up, { title: 'First' })
    const { body: B, key: keyB } = await upload(up, { title: 'Second' })
    const [a, b] = [A.handoutId, B.handoutId]
    const missing = { status: 404, body: { error: '没有这份讲义' } }

    for (const h of [{}, withKey(''), withKey(keyB), withKey(keyA + '0')]) expect(await call(up, 'GET', `/api/handouts/${a}`, undefined, h), JSON.stringify(h)).toEqual(missing)
    expect(await call(up, 'GET', `/api/handouts/${a}?key=${keyA}`)).toEqual(missing)
    const got = await call(up, 'GET', `/api/handouts/${a}`, undefined, withKey(keyA))
    expect(got).toEqual({ status: 200, body: { id: a, title: 'First' } })
    expect((await call(up, 'GET', '/api/handouts')).status).toBe(404)

    const meta = (id: string) => JSON.parse(fs.readFileSync(path.join(dataDir, 'handouts', `${id}.meta.json`), 'utf8'))
    for (const body of [{}, { key: '' }, { key: keyB }, { key: keyA + '0' }]) {
      expect(await call(up, 'POST', `/api/handouts/${a}/publish`, body), JSON.stringify(body)).toEqual({ status: 403, body: { error: '只有上传这篇文章的那台设备能发布' } })
    }
    expect(meta(a).published).toBe(false)
    expect((await call(up, 'POST', `/api/handouts/${a}/publish`, { key: keyA })).body).toEqual({ ok: true })
    expect(meta(a)).toMatchObject({ published: true, editKey: keyA })
    expect(meta(b).published).toBe(false)

    expect(await call(up, 'GET', `/api/handouts/${a}`)).toEqual({ status: 200, body: { id: a, title: 'First' } })
    expect((await call(up, 'GET', `/api/handouts/${a}`, undefined, withKey('x'))).status).toBe(200)
    expect(await call(up, 'GET', `/api/handouts/${b}`)).toEqual(missing)
  })

  it('不存在的讲义 404', async () => {
    expect((await call(up, 'GET', '/api/handouts/up-missing')).status).toBe(404)
    expect((await call(up, 'GET', '/api/handouts/up-missing', undefined, withKey('a'.repeat(32)))).status).toBe(404)
    for (const body of [{}, { key: 'a'.repeat(32) }]) expect(await call(up, 'POST', '/api/handouts/up-missing/publish', body)).toEqual({ status: 404, body: { error: '没有这份讲义' } })
  })

  it('老师讲解：给了的句子写进去、空字符串删掉、没给的不动；句子 id 不对、不是字符串、太长都 400，不改文件', async () => {
    build = async (input, opts) => ({
      handout: { id: opts.id, title: input.title, sentences: [{ id: 'S01', text: 'A.' }, { id: 'S02', text: 'B.', teacherNote: '旧讲解' }, { id: 'S03', text: 'C.', teacherNote: '留着' }] },
      report: { errors: 0 },
    })
    const sub = await call(up, 'POST', '/api/uploads', article())
    const { jobId: id, editKey: key } = sub.body
    expect(key).toMatch(/^[0-9a-f]{32}$/)
    await waitJob(up, id, key)
    const notes = async () => Object.fromEntries((await call(up, 'GET', `/api/handouts/${id}`, undefined, withKey(key))).body.sentences.map((x: any) => [x.id, x.teacherNote]))

    const r = await call(up, 'POST', `/api/handouts/${id}/notes`, { key, notes: { S01: '  如果不认识 A，就读不懂这句。 ', S02: '' } })
    expect(r.body).toEqual({ ok: true, count: 2 })
    expect(await notes()).toEqual({ S01: '如果不认识 A，就读不懂这句。', S02: undefined, S03: '留着' })

    for (const body of [{ notes: { S99: 'x' } }, { notes: { S01: 3 } }, { notes: ['x'] }, {}, { notes: { S01: 'x'.repeat(601) } }]) {
      const bad = await call(up, 'POST', `/api/handouts/${id}/notes`, { key, ...body })
      expect(bad.status, JSON.stringify(body).slice(0, 40)).toBe(400)
      expect(bad.body.error).toMatch(/讲解/)
    }
    expect(await notes()).toEqual({ S01: '如果不认识 A，就读不懂这句。', S02: undefined, S03: '留着' })
    expect((await call(up, 'POST', `/api/handouts/${id}/notes`, { key, notes: { S01: 'x'.repeat(600) } })).status).toBe(200)
    expect(fs.readdirSync(path.join(dataDir, 'handouts')).filter((f) => f.endsWith('.tmp'))).toEqual([])
    expect((await call(up, 'POST', '/api/handouts/up-missing/notes', { key, notes: {} })).status).toBe(404)
  })

  it('讲解要编辑口令：口令只在提交时给上传的设备，查进度、读讲义都拿不到；没带、带错、更早上传的讲义（没有口令）都 403', async () => {
    build = async (input, opts) => ({ handout: { id: opts.id, title: input.title, sentences: [{ id: 'S01', text: 'A.' }] }, report: { errors: 0 } })
    const sub = await call(up, 'POST', '/api/uploads', article())
    const { jobId: id, editKey: key } = sub.body
    const job = await waitJob(up, id, key)
    const got = await call(up, 'GET', `/api/handouts/${id}`, undefined, withKey(key))
    expect(JSON.stringify([job.body, got.body])).not.toContain(key)
    for (const k of [undefined, '', 'x', key.replace(/.$/, (c: string) => (c === '0' ? '1' : '0')), key + '0']) {
      const r = await call(up, 'POST', `/api/handouts/${id}/notes`, { key: k, notes: { S01: '改掉' } })
      expect(r.status, String(k)).toBe(403)
      expect(r.body.error).toBe('只有上传这篇文章的那台设备能写讲解')
    }
    const metaPath = path.join(dataDir, 'handouts', `${id}.meta.json`)
    const { editKey: _, ...legacy } = JSON.parse(fs.readFileSync(metaPath, 'utf8'))
    fs.writeFileSync(metaPath, JSON.stringify(legacy))
    expect((await call(up, 'POST', `/api/handouts/${id}/notes`, { key, notes: { S01: '改掉' } })).status).toBe(403)
    expect(JSON.parse(fs.readFileSync(path.join(dataDir, 'handouts', `${id}.json`), 'utf8')).sentences[0].teacherNote).toBeUndefined()
    // 没有口令的旧讲义：也不能发布，没发布就谁都读不到
    expect((await call(up, 'POST', `/api/handouts/${id}/publish`, { key })).status).toBe(403)
    expect((await call(up, 'GET', `/api/handouts/${id}`, undefined, withKey(key))).status).toBe(404)
  })

  it('同一份讲义并发保存：排队执行，讲义文件始终是完整的 JSON，最后一次为准', async () => {
    const sentences = Array.from({ length: 20 }, (_, i) => ({ id: `S${String(i + 1).padStart(2, '0')}`, text: 'A.' }))
    build = async (input, opts) => ({ handout: { id: opts.id, title: input.title, sentences }, report: { errors: 0 } })
    const sub = await call(up, 'POST', '/api/uploads', article())
    const { jobId: id, editKey: key } = sub.body
    await waitJob(up, id, key)
    const bodies = Array.from({ length: 30 }, (_, i) => ({ key, notes: Object.fromEntries(sentences.map((x) => [x.id, i % 2 ? `第 ${i} 次`.padEnd(500, '长') : ''])) }))
    const rs = await Promise.all(bodies.map((b) => call(up, 'POST', `/api/handouts/${id}/notes`, b)))
    expect(rs.map((r) => r.status)).toEqual(bodies.map(() => 200))
    const saved = JSON.parse(fs.readFileSync(path.join(dataDir, 'handouts', `${id}.json`), 'utf8'))
    expect(saved.sentences[0].teacherNote).toBe('第 29 次'.padEnd(500, '长'))
    expect(fs.readdirSync(path.join(dataDir, 'handouts')).filter((f) => f.endsWith('.tmp'))).toEqual([])
  })

  it('路径穿越和不合规的 id 一律拒绝，不读不写外面的文件', async () => {
    fs.writeFileSync(path.join(dataDir, 'secret.json'), '{"secret":true}')
    fs.writeFileSync(path.join(dataDir, 'secret.meta.json'), '{"published":false}')
    const ids = ['..%2Fsecret', '..%2F..%2Fpackage', '%2e%2e%2fsecret', 'up-abc%2F..%2F..%2Fsecret', 'UP-ABC', 'up-', 'mini-phones', `up-${'a'.repeat(41)}`]
    for (const id of ids) {
      expect((await call(up, 'GET', `/api/handouts/${id}`)).status, id).toBe(404)
      expect((await call(up, 'GET', `/api/uploads/${id}`)).status, id).toBe(404)
      expect((await call(up, 'POST', `/api/handouts/${id}/publish`, {})).status, id).toBe(404)
      expect((await call(up, 'POST', `/api/handouts/${id}/publish`, { key: 'a'.repeat(32) })).status, id).toBe(404)
      expect((await call(up, 'POST', `/api/handouts/${id}/notes`, { notes: {} })).status, id).toBe(404)
    }
    expect(fs.readFileSync(path.join(dataDir, 'secret.json'), 'utf8')).toBe('{"secret":true}')
    expect(fs.readFileSync(path.join(dataDir, 'secret.meta.json'), 'utf8')).toBe('{"published":false}')
  })
})
