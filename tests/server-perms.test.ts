// 数据文件权限：后端在 DATA_DIR 下新建的文件一律 600、目录一律 700（事件文件、讲义和 meta、教学建议缓存、改写事件文件、账号 / 会话 / 班级），
// 上传管线写的 llm-cache 也一样；已经存在的文件追加时不改权限。模型是本地假的。
// 后端和管线调用假 LLM 用 undici，这个文件用子进程跑（见 vite.config.ts）
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { chatJson } from '../pipeline/llm'
import { createApp } from '../server/index.mjs'
import type { App as ServerApp, BuildArticle } from '../server/index.mjs'
import { snapshotEvents } from '../src/data/presets'
import { classSummary } from '../src/lib/classSummary'
import { replay } from '../src/lib/replay'
import { miniHandout } from './fixtures/mini-handout'

const DAY = 24 * 3600 * 1000
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zhishi-perms-'))
const dataDir = path.join(root, 'srv', 'data') // 还不存在：createApp 建
const INVITE = 'invite-perms-0001'
const mode = (p: string) => fs.statSync(path.join(dataDir, p)).mode & 0o777
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const TEXT = 'Many schools are toying with the idea of banning phones in class. '.repeat(5).trim()
const build: BuildArticle = async (input, opts) => ({ handout: { id: opts.id, title: input.title, sentences: [{ id: 'S01', text: TEXT }] }, report: { errors: 0 } })

// 教学建议的汇总和一条对得上汇总的建议（同 server-advice.test.ts）
const events = snapshotEvents(miniHandout)
const summary = { ...classSummary(miniHandout, replay(miniHandout, events), events), students: 12 }
const good = { title: '精讲 S01 倒装', action: '先让学生找 so are 后面省略的部分，再请自己读懂的同学讲一遍。', evidence: 'S01：7/12 人卡在中以上，5 人自己读懂' }
const fake = http.createServer((req, res) => {
  let text = ''
  req.on('data', (c) => (text += c))
  req.on('end', () => {
    const system = JSON.parse(text).messages[0].content
    const content = JSON.stringify(system === 'perm-test' ? { ok: true } : { suggestions: [good] })
    res.end(JSON.stringify({ model: 'fake-model', choices: [{ message: { content } }] }))
  })
})

type Srv = { server: Server; port: number }
const listen = (make: (cb: () => void) => Server) =>
  new Promise<Srv>((resolve) => {
    const server = make(() => resolve({ server, port: (server.address() as AddressInfo).port }))
  })
function call(a: Srv, method: string, url: string, body?: unknown, cookie?: string) {
  return new Promise<{ status: number; body: any; headers: http.IncomingHttpHeaders }>((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: a.port, path: url, method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) } }, (res) => {
      let text = ''
      res.setEncoding('utf8')
      res.on('data', (c) => (text += c))
      res.on('end', () => resolve({ status: res.statusCode!, body: JSON.parse(text), headers: res.headers }))
    })
    req.on('error', reject)
    req.end(body === undefined ? undefined : JSON.stringify(body))
  })
}

let llm: Srv
let app: ServerApp
let srv: Srv
beforeAll(async () => {
  llm = await listen((cb) => fake.listen(0, '127.0.0.1', cb))
  app = createApp({ dataDir, apiKey: 'sk-test-not-a-real-key', llmBaseUrl: `http://127.0.0.1:${llm.port}/v1`, uploadInvites: [INVITE], buildArticle: build, log: () => {} })
  srv = await listen((cb) => app.listen(0, '127.0.0.1', cb))
})
afterAll(() => {
  for (const s of [srv, llm]) s.server.close()
})

describe('数据文件权限', () => {
  it('DATA_DIR（连同还不存在的上级目录）建成 700', () => {
    expect(fs.statSync(dataDir).mode & 0o777).toBe(0o700)
    expect(fs.statSync(path.join(root, 'srv')).mode & 0o777).toBe(0o700)
  })

  it('账号、会话、班级、讲义和 meta 是 600，handouts 目录 700；发布、写讲解改写 meta 和讲义后也是 600', async () => {
    const reg = await call(srv, 'POST', '/api/auth/register', { invite: INVITE, username: 'perms.a', password: 'password-for-tests' })
    expect(reg.status).toBe(201)
    const cookie = String(reg.headers['set-cookie']?.[0]).split(';')[0]
    const c = await call(srv, 'POST', '/api/classes', { name: '高一 3 班', roster: [{ n: 1, name: '张三' }], confirm: { school: true, consent: true } }, cookie)
    expect(c.status).toBe(201)
    const up = await call(srv, 'POST', '/api/uploads', { title: 'Phones', text: TEXT }, cookie)
    expect(up.status).toBe(202)
    const h = up.body.jobId as string
    for (let i = 0; i < 300 && (await call(srv, 'GET', `/api/uploads/${h}`, undefined, cookie)).body.status !== 'done'; i++) await sleep(5)
    expect({ accounts: mode('accounts.json'), sessions: mode('sessions.json'), classes: mode('classes.json') }).toEqual({ accounts: 0o600, sessions: 0o600, classes: 0o600 })
    expect({ dir: mode('handouts'), handout: mode(`handouts/${h}.json`), meta: mode(`handouts/${h}.meta.json`) }).toEqual({ dir: 0o700, handout: 0o600, meta: 0o600 })

    // 发布、写讲解都是写临时文件再改名：哪怕原来的文件被改成了 644，换上去的新文件也是 600
    fs.chmodSync(path.join(dataDir, 'handouts', `${h}.meta.json`), 0o644)
    fs.chmodSync(path.join(dataDir, 'handouts', `${h}.json`), 0o644)
    expect((await call(srv, 'POST', `/api/handouts/${h}/publish`, { classes: [c.body.class.id] }, cookie)).status).toBe(200)
    expect((await call(srv, 'POST', `/api/handouts/${h}/notes`, { notes: { S01: '先找谁做了什么。' } }, cookie)).status).toBe(200)
    expect({ handout: mode(`handouts/${h}.json`), meta: mode(`handouts/${h}.meta.json`) }).toEqual({ handout: 0o600, meta: 0o600 })
    expect(fs.readdirSync(path.join(dataDir, 'handouts')).filter((f) => f.endsWith('.tmp'))).toEqual([])
  })

  it('事件文件新建时 600；已经存在的文件追加时不改权限；到期清理改写之后是 600', async () => {
    const ev = (handoutId: string, ts = Date.now()) => ({ sid: 's-anyone', handoutId, type: 'client_error', ts, value: 'boom' })
    expect((await call(srv, 'POST', '/api/events', [ev('perm-new')])).body).toEqual({ ok: true, accepted: 1 })
    expect(mode('events-perm-new.jsonl')).toBe(0o600)

    fs.writeFileSync(path.join(dataDir, 'events-perm-old.jsonl'), JSON.stringify(ev('perm-old', Date.now() - 40 * DAY)) + '\n', { mode: 0o644 })
    fs.chmodSync(path.join(dataDir, 'events-perm-old.jsonl'), 0o644) // 不受 umask 影响
    expect((await call(srv, 'POST', '/api/events', [ev('perm-old')])).body).toEqual({ ok: true, accepted: 1 })
    expect(mode('events-perm-old.jsonl')).toBe(0o644)
    // 清理删掉 40 天前的那条页面报错，剩下的写临时文件再改名
    expect(await app.cleanup()).toMatchObject({ files: 1, events: 1 })
    expect(fs.readFileSync(path.join(dataDir, 'events-perm-old.jsonl'), 'utf8').split('\n').filter(Boolean)).toHaveLength(1)
    expect(mode('events-perm-old.jsonl')).toBe(0o600)
  })

  it('教学建议缓存：advice-cache 目录 700，缓存文件 600', async () => {
    const r = await call(srv, 'POST', '/api/advice', { handoutId: miniHandout.id, mode: 'demo', device: 'dev-perms-0001', summary })
    expect(r.status, JSON.stringify(r.body)).toBe(200)
    expect(r.body).toMatchObject({ suggestions: [good], cached: false })
    expect(mode('advice-cache')).toBe(0o700)
    const files = fs.readdirSync(path.join(dataDir, 'advice-cache'))
    expect(files).toHaveLength(1)
    expect(mode(`advice-cache/${files[0]}`)).toBe(0o600)
  })

  it('上传管线的模型缓存（pipeline/llm.ts，后端给的是 DATA_DIR/llm-cache）：目录 700，文件 600', async () => {
    const cacheDir = path.join(dataDir, 'llm-cache')
    const cfg = { baseUrl: `http://127.0.0.1:${llm.port}/v1`, apiKey: 'sk-test', model: 'm', fallbacks: [], cacheDir, replay: false, timeoutMs: 2000 }
    const r = await chatJson(cfg, { system: 'perm-test', user: 'u', promptVersion: 'v1' }, z.object({ ok: z.boolean() }))
    expect(r).toMatchObject({ data: { ok: true }, cached: false })
    expect(mode('llm-cache')).toBe(0o700)
    expect(mode(`llm-cache/${r.cacheKey}.json`)).toBe(0o600)
  })
})
