// 老师上传文章：口令、输入校验、生成任务、讲义读取和发布（注入假管线，不连真模型）
// 请求用 node:http 发：不用 undici，免得 Node 16 的 worker 退出时卡住（见 vite.config.ts），也能发出未规范化的路径
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createApp, loadConfig } from '../server/index.mjs'
import type { BuildArticle } from '../server/index.mjs'

const KEY = 'sk-test-not-a-real-key'
const PASS = 'open-sesame'
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zhishi-upload-'))
const logs: string[] = []

const TEXT = 'Many schools are toying with the idea of banning phones in class. '.repeat(5).trim()
const article = (o: Record<string, unknown> = {}) => ({ passcode: PASS, title: '  Phones in Class ', text: TEXT, ...o })

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

function call(app: App, method: string, url: string, body?: unknown) {
  return new Promise<{ status: number; body: any }>((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: app.port, path: url, method, headers: { 'content-type': 'application/json' } }, (res) => {
      let text = ''
      res.setEncoding('utf8')
      res.on('data', (c) => (text += c))
      res.on('end', () => resolve({ status: res.statusCode!, body: JSON.parse(text) }))
    })
    req.on('error', reject)
    req.end(body === undefined ? undefined : JSON.stringify(body))
  })
}

async function waitJob(app: App, jobId: string) {
  for (let i = 0; i < 300; i++) {
    const r = await call(app, 'GET', `/api/uploads/${jobId}`)
    if (r.body.status !== 'running') return r
    await sleep(10)
  }
  throw new Error('job did not finish')
}

async function upload(app: App, o: Record<string, unknown> = {}) {
  const r = await call(app, 'POST', '/api/uploads', article(o))
  expect(r.status).toBe(202)
  return waitJob(app, r.body.jobId)
}

let up: App
let noPass: App
let noKey: App

beforeAll(async () => {
  const common = {
    dataDir,
    apiKey: KEY,
    uploadPasscode: PASS,
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
  noPass = await listen({ ...common, uploadPasscode: '' })
  noKey = await listen({ ...common, apiKey: '' })
})

afterAll(() => {
  for (const s of [up, noPass, noKey]) s.server.close()
})

beforeEach(() => {
  build = quick
  calls = []
})

describe('口令和开关', () => {
  it('没配置口令：上传和发布都是 503；没配置 Key：上传 503', async () => {
    expect((await call(noPass, 'POST', '/api/uploads', article())).status).toBe(503)
    expect((await call(noPass, 'POST', '/api/handouts/up-abc/publish', { passcode: '' })).status).toBe(503)
    const r = await call(noKey, 'POST', '/api/uploads', article())
    expect(r.status).toBe(503)
    expect(typeof r.body.error).toBe('string')
    expect(calls).toHaveLength(0)
  })

  it('口令缺失、错误、类型不对：401，不建任务', async () => {
    for (const passcode of [undefined, '', 'wrong', 123, [PASS]]) {
      const r = await call(up, 'POST', '/api/uploads', article({ passcode }))
      expect(r.status).toBe(401)
      expect(typeof r.body.error).toBe('string')
    }
    expect(calls).toHaveLength(0)
  })

  it('读取配置：UPLOAD_PASSCODE、PIPELINE_MODEL、PIPELINE_FALLBACKS', () => {
    const ENV_FILE = path.join(dataDir, 'missing.env')
    expect(loadConfig({ ENV_FILE })).toMatchObject({ uploadPasscode: '', pipelineModel: 'deepseek-v4-pro', pipelineFallbacks: ['qwen3.7-max', 'glm-5.2'] })
    const cfg = loadConfig({ ENV_FILE, UPLOAD_PASSCODE: 'p', PIPELINE_MODEL: 'm1', PIPELINE_FALLBACKS: 'a, b,' })
    expect(cfg).toMatchObject({ uploadPasscode: 'p', pipelineModel: 'm1', pipelineFallbacks: ['a', 'b'] })
  })
})

describe('输入校验', () => {
  it('不合格的输入 400，带中文 error，不建任务', async () => {
    const bad = [
      { title: undefined },
      { title: '   ' },
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
    expect(calls).toHaveLength(0)
  })

  it('8000 字符的文章能提交；可选项去掉空项，原文原样交给管线', async () => {
    const text = `${'Long article text here. '.repeat(400)}`.slice(0, 7999) + '.'
    expect(text).toHaveLength(8000)
    const r = await upload(up, { text, mustWords: [' blanket ban ', '', 'pending'], checkIns: ['  ', 'Long article text here.'], focus: '  ' })
    expect(r.body.status).toBe('done')
    expect(calls[0][0]).toEqual({ title: 'Phones in Class', text, mustWords: ['blanket ban', 'pending'], checkIns: ['Long article text here.'] })
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

    expect((await call(up, 'GET', `/api/uploads/${jobId}`)).body).toEqual({ status: 'running', progress: { stage: 'draft', done: 1, total: 3 } })
    // 同一时间只跑一个
    const busy = await call(up, 'POST', '/api/uploads', article())
    expect(busy.status).toBe(429)
    expect(typeof busy.body.error).toBe('string')

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
      timeoutMs: 180000,
      thinking: false,
    })

    finish()
    const done = await waitJob(up, jobId)
    expect(done.body).toEqual({ status: 'done', handoutId: jobId, report: { ladders: 4, errors: 0 } })
    const dir = path.join(dataDir, 'handouts')
    expect(JSON.parse(fs.readFileSync(path.join(dir, `${jobId}.json`), 'utf8'))).toEqual({ id: jobId, title: 'Phones in Class', paragraphs: [] })
    const meta = JSON.parse(fs.readFileSync(path.join(dir, `${jobId}.meta.json`), 'utf8'))
    expect(meta).toEqual({ id: jobId, title: 'Phones in Class', createdAt: expect.any(String), published: false, report: { ladders: 4, errors: 0 } })

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
    const { jobId } = (await call(up, 'POST', '/api/uploads', article())).body
    expect((await waitJob(up, jobId)).body).toEqual({ status: 'error', error: '生成失败，请稍后再试' })
    expect((await call(up, 'GET', `/api/handouts/${jobId}`)).status).toBe(404)

    for (const l of logs) {
      expect(l).not.toContain(KEY)
      expect(l).not.toContain(PASS)
      expect(l).not.toContain(TEXT)
    }
  })

  it('任务只保留最近 20 个；不存在的任务 404', async () => {
    const first = (await call(up, 'POST', '/api/uploads', article())).body.jobId
    await waitJob(up, first)
    for (let i = 0; i < 20; i++) await upload(up)
    expect((await call(up, 'GET', `/api/uploads/${first}`)).status).toBe(404)
    expect((await call(up, 'GET', '/api/uploads/up-nope')).status).toBe(404)
    // 任务记录没了，讲义还在
    expect((await call(up, 'GET', `/api/handouts/${first}`)).status).toBe(200)
  })
})

describe('讲义读取和发布', () => {
  it('读取、列表（新的在前）、发布', async () => {
    const a = (await upload(up, { title: 'First' })).body.handoutId
    const b = (await upload(up, { title: 'Second' })).body.handoutId

    const got = await call(up, 'GET', `/api/handouts/${a}`)
    expect(got.status).toBe(200)
    expect(got.body).toEqual({ id: a, title: 'First' })

    let list = (await call(up, 'GET', '/api/handouts')).body.handouts
    expect(list.slice(0, 2)).toEqual([
      { id: b, title: 'Second', published: false, createdAt: expect.any(String) },
      { id: a, title: 'First', published: false, createdAt: expect.any(String) },
    ])
    for (let i = 1; i < list.length; i++) expect(list[i - 1].createdAt >= list[i].createdAt).toBe(true)

    expect((await call(up, 'POST', `/api/handouts/${a}/publish`, { passcode: 'wrong' })).status).toBe(401)
    expect((await call(up, 'POST', `/api/handouts/${a}/publish`, {})).status).toBe(401)
    expect((await call(up, 'POST', `/api/handouts/${a}/publish`, { passcode: PASS })).body).toEqual({ ok: true })
    list = (await call(up, 'GET', '/api/handouts')).body.handouts
    expect(list.find((h: any) => h.id === a).published).toBe(true)
    expect(list.find((h: any) => h.id === b).published).toBe(false)
  })

  it('没有上传过时列表为空；不存在的讲义 404', async () => {
    const empty = await listen({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'zhishi-upload-empty-')), log: () => {} })
    expect((await call(empty, 'GET', '/api/handouts')).body).toEqual({ handouts: [] })
    empty.server.close()
    expect((await call(up, 'GET', '/api/handouts/up-missing')).status).toBe(404)
    expect((await call(up, 'POST', '/api/handouts/up-missing/publish', { passcode: PASS })).status).toBe(404)
  })

  it('路径穿越和不合规的 id 一律拒绝，不读不写外面的文件', async () => {
    fs.writeFileSync(path.join(dataDir, 'secret.json'), '{"secret":true}')
    fs.writeFileSync(path.join(dataDir, 'secret.meta.json'), '{"published":false}')
    const ids = ['..%2Fsecret', '..%2F..%2Fpackage', '%2e%2e%2fsecret', 'up-abc%2F..%2F..%2Fsecret', 'UP-ABC', 'up-', 'mini-phones', `up-${'a'.repeat(41)}`]
    for (const id of ids) {
      expect((await call(up, 'GET', `/api/handouts/${id}`)).status, id).toBe(404)
      expect((await call(up, 'GET', `/api/uploads/${id}`)).status, id).toBe(404)
      expect((await call(up, 'POST', `/api/handouts/${id}/publish`, { passcode: PASS })).status, id).toBe(404)
    }
    expect(fs.readFileSync(path.join(dataDir, 'secret.meta.json'), 'utf8')).toBe('{"published":false}')
  })
})
