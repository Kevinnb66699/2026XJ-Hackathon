// 老师上传文章：开关、登录和限次、输入校验、生成任务、讲义读取、发布和老师讲解（注入假管线，不连真模型）。
// 账号本身（注册、登录、会话、越权）见 server-auth.test.ts；这里用登录后的 cookie 发请求
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
const INVITES = Array.from({ length: 10 }, (_, i) => `invite-test-${String(i).padStart(4, '0')}`)
let nextInvite = 0
const article = (o: Record<string, unknown> = {}) => ({ title: '  Phones in Class ', text: TEXT, ...o })

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

// cookie：登录后 Set-Cookie 里的「名=值」，不传就是没登录
function call(app: App, method: string, url: string, body?: unknown, cookie?: string, headers: Record<string, string> = {}) {
  return new Promise<{ status: number; body: any }>((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: app.port, path: url, method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}), ...headers } }, (res) => {
      let text = ''
      res.setEncoding('utf8')
      res.on('data', (c) => (text += c))
      res.on('end', () => resolve({ status: res.statusCode!, body: JSON.parse(text) }))
    })
    req.on('error', reject)
    req.end(body === undefined ? undefined : JSON.stringify(body))
  })
}

// 用下一个邀请码注册一位老师，返回登录的 cookie 和老师 id（所有实例共用同一个数据目录，账号和会话通用）
async function register(app: App, username: string) {
  const r = await new Promise<{ cookie: string; body: any }>((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: app.port, path: '/api/auth/register', method: 'POST', headers: { 'content-type': 'application/json' } }, (res) => {
      let text = ''
      res.setEncoding('utf8')
      res.on('data', (c) => (text += c))
      res.on('end', () => resolve({ cookie: String(res.headers['set-cookie']?.[0]).split(';')[0], body: JSON.parse(text) }))
    })
    req.on('error', reject)
    req.end(JSON.stringify({ invite: INVITES[nextInvite++], username, password: 'password-for-tests' }))
  })
  expect(r.body.teacher?.username).toBe(username)
  return { cookie: r.cookie, id: r.body.teacher.id as string }
}

async function waitJob(app: App, jobId: string, cookie = T.cookie) {
  for (let i = 0; i < 300; i++) {
    const r = await call(app, 'GET', `/api/uploads/${jobId}`, undefined, cookie)
    if (r.body.status !== 'running') return r
    await sleep(10)
  }
  throw new Error('job did not finish')
}

// 提交并等任务结束（默认是老师 T）
async function upload(app: App, o: Record<string, unknown> = {}, cookie = T.cookie) {
  const r = await call(app, 'POST', '/api/uploads', article(o), cookie)
  expect(r.status).toBe(202)
  return waitJob(app, r.body.jobId, cookie)
}

let up: App
let noKey: App
let T: { cookie: string; id: string } // 主要用的老师
let U: { cookie: string; id: string } // 另一位老师

beforeAll(async () => {
  const common = {
    dataDir,
    apiKey: KEY,
    uploadInvites: INVITES,
    uploadsPerTeacherPerHour: 1000,
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
  T = await register(up, 'teacher.t')
  U = await register(up, 'teacher.u')
})

afterAll(() => {
  for (const s of [up, noKey]) s.server.close()
})

beforeEach(() => {
  build = quick
  calls = []
})

describe('开关和限次', () => {
  it('没配置 Key：503（先于登录检查）；没登录、会话不认识：401；都不建任务', async () => {
    for (const c of [undefined, T.cookie]) {
      const r = await call(noKey, 'POST', '/api/uploads', article(), c)
      expect(r.status).toBe(503)
      expect(typeof r.body.error).toBe('string')
    }
    for (const c of [undefined, `zhishi_session=${'a'.repeat(64)}`]) expect(await call(up, 'POST', '/api/uploads', article(), c)).toEqual({ status: 401, body: { error: '请先登录' } })
    // 没登录也不查输入
    expect((await call(up, 'POST', '/api/uploads', article({ text: 'Too short.' }))).status).toBe(401)
    expect(calls).toHaveLength(0)
  })

  it('同一位老师一小时最多 N 篇，换老师不受影响；全站每天最多 M 篇', async () => {
    const limited = await listen({ dataDir, apiKey: KEY, uploadInvites: INVITES, uploadsPerTeacherPerHour: 2, uploadsPerDay: 3, buildArticle: quick, log: () => {} })
    const send = (cookie: string) => call(limited, 'POST', '/api/uploads', article(), cookie)
    const finish = async (r: { body: any }, cookie: string) => waitJob(limited, r.body.jobId, cookie)
    for (let i = 0; i < 2; i++) await finish(await send(T.cookie), T.cookie)
    const third = await send(T.cookie)
    expect(third.status).toBe(429)
    expect(third.body.error).toBe('每位老师一小时最多上传 2 篇，请稍后再试')
    await finish(await send(U.cookie), U.cookie) // 全站第 3 篇
    const V = await register(limited, 'teacher.v')
    const over = await send(V.cookie)
    expect(over.status).toBe(429)
    expect(over.body.error).toMatch(/今天全站的上传名额/)
    limited.server.close()
  })

  it('读取配置：PIPELINE_MODEL、PIPELINE_FALLBACKS；限次用默认值；默认没有邀请码', () => {
    const ENV_FILE = path.join(dataDir, 'missing.env')
    expect(loadConfig({ ENV_FILE })).toMatchObject({
      pipelineModel: 'deepseek-v4-pro',
      pipelineFallbacks: ['qwen3.7-max', 'glm-5.2'],
      uploadsPerTeacherPerHour: 5,
      notesPerTeacherPerHour: 10,
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

describe('请求体', () => {
  it('登录了就能传：202 只有 jobId（不再有编辑口令）；请求体不用再带设备 id 和邀请码，带了也不进 meta、任务，不交给管线；日志不记老师', async () => {
    const from = logs.length
    const sub = await call(up, 'POST', '/api/uploads', article({ device: 'dev-test-0001', invite: INVITES[9] }), T.cookie)
    expect(sub.status).toBe(202)
    expect(Object.keys(sub.body)).toEqual(['jobId'])
    const done = await waitJob(up, sub.body.jobId)
    expect(done.body.status).toBe('done')
    const meta = fs.readFileSync(path.join(dataDir, 'handouts', `${sub.body.jobId}.meta.json`), 'utf8')
    for (const leak of ['invite', 'device', 'editKey']) expect(meta).not.toContain(leak)
    expect(JSON.stringify([done.body, calls])).not.toMatch(/invite|device/)
    expect(logs.slice(from).join('\n')).not.toMatch(/teacher\.t|t-[0-9a-f]{12}/)
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
      const r = await call(up, 'POST', '/api/uploads', article(b), T.cookie)
      expect(r.status, JSON.stringify(b).slice(0, 80)).toBe(400)
      expect(r.body.error).toMatch(/[一-龥]/)
    }
    // 长度不对时带上现在的字数
    expect((await call(up, 'POST', '/api/uploads', article({ text: 'Too short.' }), T.cookie)).body.error).toBe('文章长度要在 200 到 8000 个字符之间（现在 10 个）')
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
    const r = await call(up, 'POST', '/api/uploads', article({ focus: ' 细节理解 ' }), T.cookie)
    expect(r.status).toBe(202)
    const { jobId } = r.body
    expect(jobId).toMatch(/^up-[a-z0-9]+$/)
    expect(jobId.length).toBeLessThanOrEqual(64)

    expect((await call(up, 'GET', `/api/uploads/${jobId}`, undefined, T.cookie)).body).toEqual({ status: 'running', progress: { stage: 'draft', done: 1, total: 3 } })
    // 同一时间只跑一个（别的老师也要等）
    const busy = await call(up, 'POST', '/api/uploads', article(), U.cookie)
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
    const done = await waitJob(up, jobId)
    expect(done.body).toEqual({ status: 'done', handoutId: jobId, title: 'Phones in Class', report: { ladders: 4, errors: 0 } })
    const dir = path.join(dataDir, 'handouts')
    expect(JSON.parse(fs.readFileSync(path.join(dir, `${jobId}.json`), 'utf8'))).toEqual({ id: jobId, title: 'Phones in Class', paragraphs: [] })
    const meta = JSON.parse(fs.readFileSync(path.join(dir, `${jobId}.meta.json`), 'utf8'))
    expect(meta).toEqual({ id: jobId, title: 'Phones in Class', createdAt: expect.any(String), published: false, report: { ladders: 4, errors: 0 }, owner: T.id })

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
    const { jobId } = (await call(up, 'POST', '/api/uploads', article(), T.cookie)).body
    expect((await waitJob(up, jobId)).body).toEqual({ status: 'error', error: '生成失败，请稍后再试' })
    expect((await call(up, 'GET', `/api/handouts/${jobId}`, undefined, T.cookie)).status).toBe(404)

    for (const l of logs) {
      expect(l).not.toContain(KEY)
      expect(l).not.toContain(TEXT)
    }
  })

  it('任务只保留最近 20 个；不存在的任务 404', async () => {
    const { jobId: first } = (await call(up, 'POST', '/api/uploads', article(), T.cookie)).body
    await waitJob(up, first)
    for (let i = 0; i < 20; i++) await upload(up)
    expect((await call(up, 'GET', `/api/uploads/${first}`, undefined, T.cookie)).status).toBe(404)
    expect((await call(up, 'GET', '/api/uploads/up-nope', undefined, T.cookie)).status).toBe(404)
    // 任务记录没了，讲义还在
    expect((await call(up, 'GET', `/api/handouts/${first}`, undefined, T.cookie)).status).toBe(200)
  })

  it('查进度只有提交的老师能查：没登录、别的老师、会话不认识都 404；返回的任务对象里没有 owner', async () => {
    let finish!: () => void
    build = async (input, opts) => {
      await new Promise<void>((r) => (finish = r))
      return quick(input, opts)
    }
    const { jobId } = (await call(up, 'POST', '/api/uploads', article(), T.cookie)).body
    const lost = { status: 404, body: { error: '找不到这个生成任务，请重新提交' } }
    for (const c of [undefined, U.cookie, `zhishi_session=${'b'.repeat(64)}`]) {
      expect(await call(up, 'GET', `/api/uploads/${jobId}`, undefined, c), String(c)).toEqual(lost)
    }
    const running = await call(up, 'GET', `/api/uploads/${jobId}`, undefined, T.cookie)
    expect(running.status).toBe(200)
    expect(running.body.status).toBe('running')
    finish()
    const done = await waitJob(up, jobId)
    expect(done.body).toEqual({ status: 'done', handoutId: jobId, title: 'Phones in Class', report: { errors: 0 } })
    expect(JSON.stringify([running.body, done.body])).not.toContain(T.id)
    expect(await call(up, 'GET', `/api/uploads/${jobId}`, undefined, U.cookie)).toEqual(lost)
  })
})

describe('讲义读取和发布', () => {
  it('没发布的讲义：没登录、别的老师都 404（和不存在一样），上传的老师能读；发布只有他能做；发布后谁都能读；没有公开列表', async () => {
    const { body: A } = await upload(up, { title: 'First' })
    const { body: B } = await upload(up, { title: 'Second' })
    const [a, b] = [A.handoutId, B.handoutId]
    const missing = { status: 404, body: { error: '没有这份讲义' } }

    for (const c of [undefined, U.cookie]) expect(await call(up, 'GET', `/api/handouts/${a}`, undefined, c), String(c)).toEqual(missing)
    const got = await call(up, 'GET', `/api/handouts/${a}`, undefined, T.cookie)
    expect(got).toEqual({ status: 200, body: { id: a, title: 'First' } })
    expect((await call(up, 'GET', '/api/handouts')).status).toBe(404)

    const meta = (id: string) => JSON.parse(fs.readFileSync(path.join(dataDir, 'handouts', `${id}.meta.json`), 'utf8'))
    expect(await call(up, 'POST', `/api/handouts/${a}/publish`, {})).toEqual({ status: 401, body: { error: '请先登录' } })
    expect(await call(up, 'POST', `/api/handouts/${a}/publish`, {}, U.cookie)).toEqual({ status: 403, body: { error: '只有上传这篇文章的老师能发布' } })
    expect(meta(a).published).toBe(false)
    expect((await call(up, 'POST', `/api/handouts/${a}/publish`, {}, T.cookie)).body).toEqual({ ok: true })
    expect(meta(a)).toMatchObject({ published: true, owner: T.id })
    expect(meta(b).published).toBe(false)
    expect(fs.readdirSync(path.join(dataDir, 'handouts')).filter((f) => f.endsWith('.tmp'))).toEqual([])

    expect(await call(up, 'GET', `/api/handouts/${a}`)).toEqual({ status: 200, body: { id: a, title: 'First' } })
    expect((await call(up, 'GET', `/api/handouts/${a}`, undefined, U.cookie)).status).toBe(200)
    expect(await call(up, 'GET', `/api/handouts/${b}`)).toEqual(missing)
  })

  it('不存在的讲义：读 404；发布登录了 404、没登录 401', async () => {
    expect((await call(up, 'GET', '/api/handouts/up-missing')).status).toBe(404)
    expect((await call(up, 'GET', '/api/handouts/up-missing', undefined, T.cookie)).status).toBe(404)
    expect(await call(up, 'POST', '/api/handouts/up-missing/publish', {}, T.cookie)).toEqual({ status: 404, body: { error: '没有这份讲义' } })
    expect((await call(up, 'POST', '/api/handouts/up-missing/publish', {})).status).toBe(401)
  })

  it('老师讲解：给了的句子写进去、空字符串删掉、没给的不动；句子 id 不对、不是字符串、太长都 400，不改文件', async () => {
    build = async (input, opts) => ({
      handout: { id: opts.id, title: input.title, sentences: [{ id: 'S01', text: 'A.' }, { id: 'S02', text: 'B.', teacherNote: '旧讲解' }, { id: 'S03', text: 'C.', teacherNote: '留着' }] },
      report: { errors: 0 },
    })
    const id = (await upload(up)).body.handoutId
    const notes = async () => Object.fromEntries((await call(up, 'GET', `/api/handouts/${id}`, undefined, T.cookie)).body.sentences.map((x: any) => [x.id, x.teacherNote]))

    const r = await call(up, 'POST', `/api/handouts/${id}/notes`, { notes: { S01: '  如果不认识 A，就读不懂这句。 ', S02: '' } }, T.cookie)
    expect(r.body).toEqual({ ok: true, count: 2 })
    expect(await notes()).toEqual({ S01: '如果不认识 A，就读不懂这句。', S02: undefined, S03: '留着' })

    for (const body of [{ notes: { S99: 'x' } }, { notes: { S01: 3 } }, { notes: ['x'] }, {}, { notes: { S01: 'x'.repeat(601) } }]) {
      const bad = await call(up, 'POST', `/api/handouts/${id}/notes`, body, T.cookie)
      expect(bad.status, JSON.stringify(body).slice(0, 40)).toBe(400)
      expect(bad.body.error).toMatch(/讲解/)
    }
    expect(await notes()).toEqual({ S01: '如果不认识 A，就读不懂这句。', S02: undefined, S03: '留着' })
    expect((await call(up, 'POST', `/api/handouts/${id}/notes`, { notes: { S01: 'x'.repeat(600) } }, T.cookie)).status).toBe(200)
    expect(fs.readdirSync(path.join(dataDir, 'handouts')).filter((f) => f.endsWith('.tmp'))).toEqual([])
    expect((await call(up, 'POST', '/api/handouts/up-missing/notes', { notes: {} }, T.cookie)).status).toBe(404)
  })

  it('讲解只有上传的老师能写：没登录 401、别的老师 403；meta 里没有 owner 的旧讲义（包括带编辑口令的）谁都 403，也不能发布，没发布就谁都读不到', async () => {
    build = async (input, opts) => ({ handout: { id: opts.id, title: input.title, sentences: [{ id: 'S01', text: 'A.' }] }, report: { errors: 0 } })
    const id = (await upload(up)).body.handoutId
    expect(await call(up, 'POST', `/api/handouts/${id}/notes`, { notes: { S01: '改掉' } })).toEqual({ status: 401, body: { error: '请先登录' } })
    expect(await call(up, 'POST', `/api/handouts/${id}/notes`, { notes: { S01: '改掉' } }, U.cookie)).toEqual({ status: 403, body: { error: '只有上传这篇文章的老师能写讲解' } })
    const metaPath = path.join(dataDir, 'handouts', `${id}.meta.json`)
    const { owner: _, ...legacy } = JSON.parse(fs.readFileSync(metaPath, 'utf8'))
    for (const old of [legacy, { ...legacy, editKey: 'a'.repeat(32) }]) {
      fs.writeFileSync(metaPath, JSON.stringify(old))
      for (const c of [T.cookie, U.cookie]) {
        expect((await call(up, 'POST', `/api/handouts/${id}/notes`, { notes: { S01: '改掉' } }, c)).status).toBe(403)
        expect((await call(up, 'POST', `/api/handouts/${id}/publish`, {}, c)).status).toBe(403)
        expect((await call(up, 'GET', `/api/handouts/${id}`, undefined, c, { 'x-edit-key': 'a'.repeat(32) })).status).toBe(404)
      }
    }
    expect(JSON.parse(fs.readFileSync(path.join(dataDir, 'handouts', `${id}.json`), 'utf8')).sentences[0].teacherNote).toBeUndefined()
  })

  // 并发的请求先过登录和 owner 检查（要读账号、会话和 meta 文件）才排进保存的队，排队的先后不一定是发出的先后，
  // 所以下面两条都不断言哪一次最后保存
  it('同一份讲义并发保存：讲义文件始终是完整的 JSON，保存中途和最后都是某一次的全部内容，不会混在一起', async () => {
    const sentences = Array.from({ length: 20 }, (_, i) => ({ id: `S${String(i + 1).padStart(2, '0')}`, text: 'A.' }))
    build = async (input, opts) => ({ handout: { id: opts.id, title: input.title, sentences }, report: { errors: 0 } })
    const id = (await upload(up)).body.handoutId
    const file = path.join(dataDir, 'handouts', `${id}.json`)
    const bodies = Array.from({ length: 30 }, (_, i) => ({ notes: Object.fromEntries(sentences.map((x) => [x.id, i % 2 ? `第 ${i} 次`.padEnd(500, '长') : ''])) }))
    // 每一次保存完讲义该有的讲解（空字符串是删掉）；还没保存时一条都没有，和偶数次一样
    const states = bodies.map((b) => sentences.map((x) => b.notes[x.id] || undefined))
    // 保存的同时一直读讲义文件：读到半份 JSON.parse 就抛错，测试失败
    const seen: any[] = []
    let done = false
    const watch = (async () => {
      while (!done) seen.push(JSON.parse(await fs.promises.readFile(file, 'utf8')))
    })()
    const rs = await Promise.all(bodies.map((b) => call(up, 'POST', `/api/handouts/${id}/notes`, b, T.cookie)))
    done = true
    await watch
    expect(rs).toEqual(bodies.map((_, i) => ({ status: 200, body: { ok: true, count: i % 2 ? 20 : 0 } })))
    for (const saved of [...seen, JSON.parse(fs.readFileSync(file, 'utf8'))]) {
      expect(saved.sentences.map((x: any) => x.id)).toEqual(sentences.map((x) => x.id))
      expect(states).toContainEqual(saved.sentences.map((x: any) => x.teacherNote))
    }
    expect(fs.readdirSync(path.join(dataDir, 'handouts')).filter((f) => f.endsWith('.tmp'))).toEqual([])
  })

  it('同一份讲义并发保存不同的句子：读、改、写完一次再下一次，谁写的讲解都不丢', async () => {
    const sentences = Array.from({ length: 30 }, (_, i) => ({ id: `S${String(i + 1).padStart(2, '0')}`, text: 'A.' }))
    build = async (input, opts) => ({ handout: { id: opts.id, title: input.title, sentences }, report: { errors: 0 } })
    const id = (await upload(up)).body.handoutId
    // 每个请求只写自己那一句：两次保存要是同时读了旧文件再各自写回，先写回的那句就丢了
    const rs = await Promise.all(sentences.map((x, i) => call(up, 'POST', `/api/handouts/${id}/notes`, { notes: { [x.id]: `第 ${i} 次` } }, T.cookie)))
    expect(rs.map((r) => r.status)).toEqual(sentences.map(() => 200))
    // 排队的话第 k 个保存的看得到前面 k-1 次，count 正好是 1 到 30 各一次
    expect(rs.map((r) => r.body.count).sort((a, b) => a - b)).toEqual(sentences.map((_, i) => i + 1))
    const saved = JSON.parse(fs.readFileSync(path.join(dataDir, 'handouts', `${id}.json`), 'utf8'))
    expect(saved.sentences.map((x: any) => x.teacherNote)).toEqual(sentences.map((_, i) => `第 ${i} 次`))
  })

  it('路径穿越和不合规的 id 一律拒绝，不读不写外面的文件', async () => {
    fs.writeFileSync(path.join(dataDir, 'secret.json'), '{"secret":true}')
    fs.writeFileSync(path.join(dataDir, 'secret.meta.json'), '{"published":false}')
    const ids = ['..%2Fsecret', '..%2F..%2Fpackage', '%2e%2e%2fsecret', 'up-abc%2F..%2F..%2Fsecret', 'UP-ABC', 'up-', 'mini-phones', `up-${'a'.repeat(41)}`]
    for (const id of ids) {
      for (const c of [undefined, T.cookie]) {
        expect((await call(up, 'GET', `/api/handouts/${id}`, undefined, c)).status, id).toBe(404)
        expect((await call(up, 'GET', `/api/uploads/${id}`, undefined, c)).status, id).toBe(404)
      }
      expect((await call(up, 'POST', `/api/handouts/${id}/publish`, {}, T.cookie)).status, id).toBe(404)
      expect((await call(up, 'POST', `/api/handouts/${id}/notes`, { notes: {} }, T.cookie)).status, id).toBe(404)
      expect((await call(up, 'POST', `/api/handouts/${id}/publish`, {})).status, id).toBe(401)
    }
    expect(fs.readFileSync(path.join(dataDir, 'secret.json'), 'utf8')).toBe('{"secret":true}')
    expect(fs.readFileSync(path.join(dataDir, 'secret.meta.json'), 'utf8')).toBe('{"published":false}')
  })
})
