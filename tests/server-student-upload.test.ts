// 学生上传（阶段 3）：POST /api/student/uploads、GET /api/uploads/:jobId、GET /api/upload-status、GET /api/student/library，
// 学生讲义的读权限、同篇复用、每周次数和失败上限、内容检查、内容安全拦截、注销和到期清理。
// 管线注入假的（不连真模型），内容检查注入 pipeline/article.ts 的 checkArticle，推算注入 src/lib/notebook.ts。请求用 node:http 发。
// 邀请码文件平时由 scripts/student.mjs 写，这里直接写（码只存 sha256，都是测试用的假码）。样本文章都是为测试新写的
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { checkArticle, toParagraphs } from '../pipeline/article'
import { Handout } from '../shared/schema'
import * as notebook from '../src/lib/notebook'
import { MIN_AGE, STUDENT_HANDOUT_DAYS, articleKeys, createApp, loadConfig, paragraphsOf } from '../server/index.mjs'
import type { BuildArticle, ServerConfig } from '../server/index.mjs'
import { miniHandout } from './fixtures/mini-handout'

const KEY = 'sk-test-not-a-real-key'
const PASSWORD = 'correct-horse-9'
const TEACHER_INVITE = 'invite-teacher-up01'
const CODES = Array.from({ length: 80 }, (_, i) => `TESTUPLOAD${String(i).padStart(4, '0')}`)
let nextCode = 0
const BIRTH = `${new Date().getUTCFullYear() - MIN_AGE - 3}-01`
const DAY = 24 * 3600 * 1000
const H = 3600 * 1000
const sleep = (ms: number) => new Promise((ok) => setTimeout(ok, ms))
const UNSAFE = '这篇文章里有不适合在这里读的内容，换一篇吧'

// 样本：三段，每段两句，都能过内容检查
const para = (topic: string, i: number) =>
  `${topic} have become a common sight in many towns over the last few years, and people talk about them often (part ${i}). Some residents of district ${i} think they make life better, while others worry about the town's budget and the noise they bring.`
const article = (topic: string) => [1, 2, 3].map((i) => para(topic, i)).join('\n\n')
const TREES = article('Street trees')

// 假管线：每个测试设置 build；calls 记收到的参数。生成的讲义用迷你讲义（推算单词本要真的讲义格式），标题换成这篇的
let build: BuildArticle
let calls: Parameters<BuildArticle>[] = []
const quick: BuildArticle = async (_input, opts) => {
  opts.onProgress({ stage: 'draft', done: 0, total: 3 })
  await sleep(5)
  return { handout: Handout.parse({ ...miniHandout, id: opts.id, title: 'Street Trees' }), report: { errors: 0 } }
}
// 拦住管线，测试里 release() 才放行
function gated() {
  let release!: () => void
  const wait = new Promise<void>((ok) => (release = ok))
  const fn: BuildArticle = async (input, opts) => {
    opts.onProgress({ stage: 'draft', done: 1, total: 3 })
    await wait
    return quick(input, opts)
  }
  return { fn, release: () => release() }
}

type App = { server: Server; port: number; app: ReturnType<typeof createApp>; dataDir: string }
type Res = { status: number; body: any; headers: http.IncomingHttpHeaders; text: string }
const open: App[] = []
const newDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'zhishi-st-upload-'))
const deletionsDir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'zhishi-st-upload-del-')), 'ledger')
function prepare(dataDir: string) {
  if (!fs.existsSync(path.join(dataDir, 'student-invites.json')))
    fs.writeFileSync(path.join(dataDir, 'student-invites.json'), JSON.stringify({ invites: CODES.map((c) => ({ hash: createHash('sha256').update(c).digest('hex'), batch: 't', createdAt: '' })) }))
}
function listen(config: Partial<ServerConfig> = {}, dataDir = newDir()) {
  prepare(dataDir)
  return new Promise<App>((resolve) => {
    const app = createApp({
      dataDir,
      deletionsDir,
      apiKey: KEY,
      studentUpload: true,
      uploadInvites: [TEACHER_INVITE],
      uploadsPerTeacherPerHour: 1000,
      uploadsPerDay: 1000,
      authPerMinute: 1000,
      notebook,
      checkArticle,
      buildArticle: ((input, opts) => {
        calls.push([input, opts])
        return build(input, opts)
      }) as BuildArticle,
      log: () => {},
      ...config,
    })
    const server = app.listen(0, '127.0.0.1', () => {
      const a = { server, port: (server.address() as AddressInfo).port, app, dataDir }
      open.push(a)
      resolve(a)
    })
  })
}
function call(a: App, method: string, url: string, body?: unknown, cookie?: string) {
  return new Promise<Res>((resolve, reject) => {
    const h: Record<string, string> = { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }
    const req = http.request({ host: '127.0.0.1', port: a.port, path: url, method, headers: h }, (res) => {
      let text = ''
      res.setEncoding('utf8')
      res.on('data', (c) => (text += c))
      res.on('end', () => resolve({ status: res.statusCode!, body: JSON.parse(text), headers: res.headers, text }))
    })
    req.on('error', reject)
    req.end(body === undefined ? undefined : JSON.stringify(body))
  })
}
const cookieOf = (r: Res) => r.headers['set-cookie']![0].split(';')[0]
type Who = { cookie: string; sid: string; id: string; username: string }
async function register(a: App, username: string): Promise<Who> {
  const r = await call(a, 'POST', '/api/student/register', { invite: CODES[nextCode++], username, password: PASSWORD, birth: BIRTH, agree: true })
  expect(r.status, JSON.stringify(r.body)).toBe(200)
  const st = JSON.parse(fs.readFileSync(path.join(a.dataDir, 'students.json'), 'utf8')).students.find((s: { username: string }) => s.username === username)
  return { cookie: cookieOf(r), sid: r.body.student.sid, id: st.id, username }
}
const post = (a: App, who: Who | undefined, text: string, o: Record<string, unknown> = {}) => call(a, 'POST', '/api/student/uploads', { text, confirm: true, ...o }, who?.cookie)
const progress = (a: App, who: Who | undefined, jobId: string) => call(a, 'GET', `/api/uploads/${jobId}`, undefined, who?.cookie)
async function waitJob(a: App, who: Who, jobId: string) {
  for (let i = 0; i < 300; i++) {
    const r = await progress(a, who, jobId)
    if (r.body.status !== 'running') return r
    await sleep(10)
  }
  throw new Error('job did not finish')
}
// 提交并等生成完，返回讲义 id
async function make(a: App, who: Who, text: string) {
  const r = await post(a, who, text)
  expect(r.status, JSON.stringify(r.body)).toBe(202)
  const done = await waitJob(a, who, r.body.jobId)
  expect(done.body, JSON.stringify(done.body)).toMatchObject({ status: 'done' })
  return done.body.handoutId as string
}
const json = (a: App, name: string) => JSON.parse(fs.readFileSync(path.join(a.dataDir, name), 'utf8'))
const meta = (a: App, id: string) => json(a, `handouts/${id}.meta.json`)
const status = (a: App, who?: Who) => call(a, 'GET', '/api/upload-status', undefined, who?.cookie)
const library = (a: App, who?: Who) => call(a, 'GET', '/api/student/library', undefined, who?.cookie)
const read = (a: App, id: string, cookie?: string) => call(a, 'GET', `/api/handouts/${id}`, undefined, cookie)
// 下周一北京时间 0 点（ISO）
const nextMonday = (now = Date.now()) => {
  const d = new Date(now + 8 * H)
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - ((d.getUTCDay() + 6) % 7) + 7) - 8 * H).toISOString()
}

beforeEach(() => {
  build = quick
  calls = []
})
afterAll(() => {
  for (const a of open) a.server.close()
})

describe('同一篇的两个键（后端照写的分段和管线一致）', () => {
  it('paragraphsOf 和 pipeline/article.ts 的 toParagraphs 切出来一样（空行、单个换行、\\r\\n、段内换行、首尾空白）', () => {
    const P = ['Cities are planting more trees.  The shade helps.', 'Not everyone is pleased.\tSome worry.', 'Planners say yes.']
    const inputs = [
      P.join('\n\n'),
      P.join('\n'),
      `  ${P.join('\r\n\r\n')}\r\n`,
      P.join('\n \n\n'),
      `${P[0]}\nwrapped here\n\n${P[1]}`,
      `${P[0]}\n  wrapped   here\n${P[1]}`,
      P[0],
      `\n\n${P.join('\n\t\n')}\n\n`,
    ]
    for (const t of inputs) expect(paragraphsOf(t), JSON.stringify(t)).toEqual(toParagraphs(t.replace(/\r\n?/g, '\n').trim()))
  })

  it('精确键：只差空白、空行、分段方式（空行或单个换行）、NFC 的算同一篇；近似键：只差标点、弯直引号、大小写的算近似', () => {
    const base = articleKeys(TREES)
    const same = [TREES.replace(/\n\n/g, '\n'), TREES.replace(/\n\n/g, '\n\n\n  \n'), `  ${TREES.replace(/ /g, '  ')}\n`, TREES.replace(/\n\n/g, '\r\n\r\n'), TREES.replace(/, /g, ',\n')]
    for (const t of same) expect(articleKeys(t)).toEqual(base)
    expect(articleKeys('Café menu.').exact).toBe(articleKeys('Café menu.').exact) // NFD 和 NFC
    const near = [TREES.replace(/'/g, '’'), TREES.replace(/,/g, ''), TREES.toUpperCase(), TREES.replace('(part 1)', '“part 1”')]
    for (const t of near) {
      expect(articleKeys(t).exact).not.toBe(base.exact)
      expect(articleKeys(t).near).toBe(base.near)
    }
    expect(articleKeys(article('Bike lanes')).near).not.toBe(base.near)
    expect(base.exact).toMatch(/^[0-9a-f]{64}$/)
    // 全角的字母、数字算近似；夹了中文、带重音的字母留在近似键里：英文一样、另外夹了中文笔记的不算近似
    expect(articleKeys(TREES.replace('part 1', 'ｐａｒｔ １')).near).toBe(base.near)
    for (const t of [`${TREES}\n\n高二三班的笔记：我家住在和平路十二号`, TREES.replace('district', '区 district'), TREES.replace('residents', 'résidents')]) expect(articleKeys(t).near, t.slice(-30)).not.toBe(base.near)
  })
})

describe('开关、登录和请求体', () => {
  let a: App
  let s: Who
  beforeAll(async () => {
    a = await listen()
    s = await register(a, 'up.basic')
  })

  it('STUDENT_UPLOAD 没开：上传 403，upload-status 是 enabled:false、open:false；没登录 401（上传、状态、我的文章）；老师的 cookie 查状态、列表也 401', async () => {
    const off = await listen({ studentUpload: false }, a.dataDir)
    expect(await post(off, s, TREES)).toMatchObject({ status: 403, body: { error: '贴文章生成讲义还没开放' } })
    expect((await status(off, s)).body).toEqual({ enabled: false, open: false, weekUsed: 0, weekLimit: 2, resetsAt: nextMonday() })
    expect(await post(a, undefined, TREES)).toMatchObject({ status: 401, body: { error: '请先登录' } })
    expect(await status(a)).toMatchObject({ status: 401, body: { error: '请先登录' } })
    expect(await library(a)).toMatchObject({ status: 401, body: { error: '请先登录' } })
    const t = await call(a, 'POST', '/api/auth/register', { invite: TEACHER_INVITE, username: 'up.teacher', password: 'teacher-pass-1' })
    expect(t.status).toBe(201)
    for (const r of [await status(a, { cookie: cookieOf(t) } as Who), await library(a, { cookie: cookieOf(t) } as Who)]) expect(r.status).toBe(401)
    expect(calls).toHaveLength(0)
  })

  it('没勾 confirm 400；长度不是 200–8000 字符 400（reason length）；都不跑管线', async () => {
    for (const confirm of [undefined, false, 'yes']) expect(await call(a, 'POST', '/api/student/uploads', { text: TREES, confirm }, s.cookie)).toMatchObject({ status: 400, body: { error: '请先勾选上面三项' } })
    expect(await post(a, s, 'Too short.')).toMatchObject({ status: 400, body: { error: '文章长度要在 200 到 8000 个字符之间（现在 10 个）', reason: 'length' } })
    expect((await post(a, s, 'a'.repeat(8001))).body.reason).toBe('length')
    expect(calls).toHaveLength(0)
  })

  it('学生填的标题、必练词、重点句、教学重点都不收，管线只拿到原文（标题空着，由 AI 起）', async () => {
    const id = await make(a, s, TREES)
    expect(calls).toHaveLength(1)
    expect(calls[0][0]).toEqual({ title: '', text: TREES })
    expect(id).toMatch(/^up-[0-9a-f]{20}$/)
    calls = []
    const r = await post(a, s, article('Bike lanes'), { title: 'Mine', mustWords: ['lanes'], checkIns: ['Bike lanes'], focus: '细节' })
    expect(r.status).toBe(202)
    await waitJob(a, s, r.body.jobId)
    expect(calls[0][0]).toEqual({ title: '', text: article('Bike lanes') })
  })

  it('讲义 id 纯随机：看不出时间，两次不一样', async () => {
    const t = await register(a, 'up.ids')
    const ids = [await make(a, t, article('Night markets')), await make(a, t, article('Food trucks'))]
    expect(ids[0]).not.toBe(ids[1])
    const now36 = Date.now().toString(36)
    for (const id of ids) {
      expect(id).toMatch(/^up-[0-9a-f]{20}$/)
      expect(id.slice(3)).not.toContain(now36.slice(0, 5))
    }
  })
})

describe('生成、读权限和我的文章', () => {
  let a: App
  let s: Who
  let o: Who
  let teacher: string
  let id: string
  beforeAll(async () => {
    a = await listen()
    s = await register(a, 'up.owner')
    o = await register(a, 'up.other')
    const t = await call(a, 'POST', '/api/auth/register', { invite: TEACHER_INVITE, username: 'up.teacher2', password: 'teacher-pass-1' })
    teacher = cookieOf(t)
  })

  it('202 {jobId}；进度是一句中文（用「提示」不用「梯子」）；做好了 {status:done, handoutId}；只有提交的人查得到，别的学生 404（不带 lost）；没有学生会话 401（页面留着任务，登录后接着查）', async () => {
    const g = gated()
    build = g.fn
    const r = await post(a, s, TREES)
    expect(r.status).toBe(202)
    expect(r.body).toEqual({ jobId: expect.stringMatching(/^up-[0-9a-f]{20}$/) })
    await sleep(20)
    const running = await progress(a, s, r.body.jobId)
    expect(running.body).toEqual({ status: 'running', progress: 'AI 在写第 2 / 3 段的提示和题目' })
    expect(running.headers['cache-control']).toBe('no-store')
    expect(await progress(a, o, r.body.jobId)).toEqual(expect.objectContaining({ status: 404, body: { error: '找不到这个生成任务，请重新提交' } }))
    for (const cookie of [undefined, teacher, 'zhishi_student=junk']) expect(await call(a, 'GET', `/api/uploads/${r.body.jobId}`, undefined, cookie), String(cookie)).toEqual(expect.objectContaining({ status: 401, body: { error: '请先登录' } }))
    // 不在任务表里的 id：没登录照旧 404
    expect((await progress(a, undefined, 'up-0123456789abcdef0123')).status).toBe(404)
    g.release()
    const done = await waitJob(a, s, r.body.jobId)
    expect(done.body).toEqual({ status: 'done', handoutId: r.body.jobId })
    id = done.body.handoutId
  })

  it('meta：source student、createdBy（账号 id）、精确键和近似键；讲义文件和 meta 只给本用户读写', async () => {
    const m = meta(a, id)
    expect(m).toMatchObject({ id, title: 'Street Trees', source: 'student', createdBy: s.id, exactKey: articleKeys(TREES).exact, nearKey: articleKeys(TREES).near })
    expect(m).not.toHaveProperty('owner')
    expect(m).not.toHaveProperty('published')
    for (const f of [`handouts/${id}.json`, `handouts/${id}.meta.json`, 'library.json', 'upload-counts.json']) expect((fs.statSync(path.join(a.dataDir, f)).mode & 0o777).toString(8), f).toBe('600')
  })

  it('我的文章：{handouts:[{id, title, addedAt}]}，只有自己的，标题只有本人看得到；这周用了 1 篇', async () => {
    const r = await library(a, s)
    expect(r.body).toEqual({ handouts: [{ id, title: 'Street Trees', addedAt: expect.any(String) }] })
    expect(r.headers['cache-control']).toBe('no-store')
    expect((await library(a, o)).body).toEqual({ handouts: [] })
    expect((await status(a, s)).body).toEqual({ enabled: true, open: true, weekUsed: 1, weekLimit: 2, resetsAt: nextMonday() })
    expect((await status(a, o)).body.weekUsed).toBe(0)
  })

  it('读讲义：在本人列表里能读；别的学生、老师 404（和不存在一样）；没登录 401；返回体里搜不到上传人', async () => {
    const mine = await read(a, id, s.cookie)
    expect(mine.status).toBe(200)
    expect(mine.body).toMatchObject({ id, title: 'Street Trees' })
    const missing = { status: 404, body: { error: '没有这份讲义' } }
    expect(await read(a, id, o.cookie)).toMatchObject(missing)
    expect(await read(a, id, teacher)).toMatchObject(missing)
    expect(await read(a, 'up-0000000000aaaaaaaaaa', o.cookie)).toMatchObject(missing)
    expect((await read(a, id)).status).toBe(401)
    for (const body of [mine.text, JSON.stringify((await library(a, s)).body), JSON.stringify((await status(a, s)).body)]) {
      for (const leak of [s.id, s.sid, 'up.owner', 'createdBy', 'exactKey']) expect(body).not.toContain(leak)
    }
  })

  it('学生讲义一律不开放发布、讲解、改题、AI 起草、看全班记录：老师 cookie 404，学生 cookie 401', async () => {
    const urls: [string, string, unknown][] = [
      ['POST', `/api/handouts/${id}/publish`, { classes: [] }],
      ['POST', `/api/handouts/${id}/notes`, { notes: {} }],
      ['POST', `/api/handouts/${id}/edits`, { sentences: {} }],
      ['POST', `/api/handouts/${id}/notes/draft`, {}],
      ['GET', `/api/events?handoutId=${id}&classId=c-000000000000`, undefined],
    ]
    for (const [method, url, body] of urls) {
      expect((await call(a, method, url, body, teacher)).status, url).toBe(404)
      expect((await call(a, method, url, body, s.cookie)).status, url).toBe(401)
    }
    expect(await call(a, 'GET', '/api/my/handouts', undefined, teacher)).toMatchObject({ body: { handouts: [] } })
  })

  it('学习记录、单词本：本人列表里的学生讲义算「能读的讲义」；不在列表里的学生发了这一篇的事件也不算', async () => {
    const ev = (who: Who, ts: number) => ({ sid: who.sid, handoutId: id, type: 'tap_word', lemma: 'pending', ts })
    for (const who of [s, o]) expect((await call(a, 'POST', '/api/events', [ev(who, 1000)], who.cookie)).body).toEqual({ ok: true, accepted: 1 })
    const rec = await call(a, 'GET', '/api/student/records', undefined, s.cookie)
    expect(rec.body.records.map((r: { handoutId: string; title: string }) => [r.handoutId, r.title])).toEqual([[id, 'Street Trees']])
    expect((await call(a, 'GET', '/api/student/notebook', undefined, s.cookie)).body.words.map((w: { lemma: string }) => w.lemma)).toContain('pending')
    expect((await call(a, 'GET', '/api/student/records', undefined, o.cookie)).body.records).toEqual([])
    expect((await call(a, 'GET', '/api/student/notebook', undefined, o.cookie)).body.words).toEqual([])
  })

  it('下载我的数据带上「我的文章」（讲义 id、标题、加入时间），没有上传人、键', async () => {
    const r = await call(a, 'GET', '/api/student/export', undefined, s.cookie)
    expect(r.body.articles).toEqual([{ id, title: 'Street Trees', addedAt: expect.any(String) }])
    for (const leak of ['createdBy', 'exactKey', 'nearKey', s.id]) expect(r.text).not.toContain(leak)
    expect((await call(a, 'GET', '/api/student/export', undefined, o.cookie)).body.articles).toEqual([])
  })
})

describe('同一篇复用', () => {
  let a: App
  beforeAll(async () => {
    a = await listen()
  })

  it('只差空白、空行、分段方式：200 {handoutId, reused:true}，加进本人列表，不跑管线、不占次数；两个人都能读；第三个人直接拿 id 读 404', async () => {
    const s = await register(a, 're.first')
    const t = await register(a, 're.second')
    const u = await register(a, 're.third')
    const id = await make(a, s, TREES)
    calls = []
    for (const text of [TREES.replace(/\n\n/g, '\n'), `  ${TREES.replace(/\n\n/g, '\n\n\n')}  `]) {
      expect(await post(a, t, text)).toMatchObject({ status: 200, body: { handoutId: id, reused: true } })
    }
    expect(calls).toHaveLength(0)
    expect((await library(a, t)).body.handouts.map((x: { id: string }) => x.id)).toEqual([id]) // 已经在列表里的不重复加
    expect((await status(a, t)).body.weekUsed).toBe(0)
    for (const who of [s, t]) expect((await read(a, id, who.cookie)).status).toBe(200)
    expect((await read(a, id, u.cookie)).status).toBe(404)
  })

  it('只差弯直引号、标点：回 200 {similar:{handoutId, title}}，学生自己选；use 直接读那一份，ignore 按贴的生成', async () => {
    const s = await register(a, 'sim.first')
    const t = await register(a, 'sim.second')
    const text = article('Night buses')
    const id = await make(a, s, text)
    calls = []
    const curly = text.replace(/'/g, '’').replace('(part 2)', '“part 2”')
    expect(await post(a, t, curly)).toMatchObject({ status: 200, body: { similar: { handoutId: id, title: 'Street Trees' } } })
    expect((await library(a, t)).body.handouts).toEqual([])
    expect(await post(a, t, curly, { similar: 'use' })).toMatchObject({ status: 200, body: { handoutId: id, reused: true } })
    expect((await library(a, t)).body.handouts.map((x: { id: string }) => x.id)).toEqual([id])
    const u = await register(a, 'sim.third')
    const own = await post(a, u, curly, { similar: 'ignore' })
    expect(own.status).toBe(202)
    const done = await waitJob(a, u, own.body.jobId)
    expect(done.body.handoutId).not.toBe(id)
    expect(calls).toHaveLength(1)
    // 自己生成的那份精确键和贴的一样：下一个贴同样内容的直接复用它
    const v = await register(a, 'sim.fourth')
    expect((await post(a, v, curly)).body).toEqual({ handoutId: done.body.handoutId, reused: true })
  })

  it('英文一样、另外夹了中文的不算近似：不回 similar，按贴的生成，读不到别人那一份', async () => {
    const s = await register(a, 'near.notes')
    const t = await register(a, 'near.plain')
    const text = article('Ferry docks')
    const id = await make(a, s, `${text}\n\n高二三班的笔记：这篇是老师布置的，我家住在和平路十二号。`)
    const r = await post(a, t, text)
    expect(r.status, JSON.stringify(r.body)).toBe(202)
    expect((await waitJob(a, t, r.body.jobId)).body.handoutId).not.toBe(id)
    expect((await read(a, id, t.cookie)).status).toBe(404)
  })

  it('生成中第二个人贴同一篇：拿到同一个 jobId（joined），两个人都能查进度、做好后都进了各自的列表；第二个人不占次数；第三个人查不到', async () => {
    const s = await register(a, 'join.first')
    const t = await register(a, 'join.second')
    const u = await register(a, 'join.third')
    const g = gated()
    build = g.fn
    const text = article('Rooftop gardens')
    const first = await post(a, s, text)
    expect(first.status).toBe(202)
    const second = await post(a, t, text.replace(/\n\n/g, '\n'))
    expect(second).toMatchObject({ status: 202, body: { jobId: first.body.jobId, joined: true } })
    expect(await post(a, s, text)).toMatchObject({ status: 202, body: { jobId: first.body.jobId, joined: true } }) // 自己再交一次也一样
    for (const who of [s, t]) expect((await progress(a, who, first.body.jobId)).body.status).toBe('running')
    expect((await progress(a, u, first.body.jobId)).status).toBe(404)
    g.release()
    const done = await waitJob(a, t, first.body.jobId)
    expect(calls).toHaveLength(1)
    for (const who of [s, t]) expect((await library(a, who)).body.handouts.map((x: { id: string }) => x.id)).toEqual([done.body.handoutId])
    expect((await status(a, s)).body.weekUsed).toBe(1)
    expect((await status(a, t)).body.weekUsed).toBe(0)
    expect(meta(a, done.body.handoutId).createdBy).toBe(s.id)
  })

  it('不拿老师讲义来复用：老师上传过的同一篇，学生贴照样生成新的', async () => {
    const tr = await call(a, 'POST', '/api/auth/register', { invite: TEACHER_INVITE, username: 'up.teacher3', password: 'teacher-pass-1' })
    const teacher = cookieOf(tr)
    const text = article('Library hours')
    const tj = await call(a, 'POST', '/api/uploads', { title: 'T', text }, teacher)
    expect(tj.status).toBe(202)
    for (let i = 0; i < 100 && (await call(a, 'GET', `/api/uploads/${tj.body.jobId}`, undefined, teacher)).body.status === 'running'; i++) await sleep(10)
    expect(meta(a, tj.body.jobId)).toMatchObject({ owner: expect.any(String), published: false })
    expect(meta(a, tj.body.jobId)).not.toHaveProperty('source')
    const s = await register(a, 'up.vs.teacher')
    calls = []
    const r = await post(a, s, text)
    expect(r.status).toBe(202)
    expect(r.body.jobId).not.toBe(tj.body.jobId)
    expect((await waitJob(a, s, r.body.jobId)).body.status).toBe('done')
    expect(calls).toHaveLength(1)
  })
})

describe('次数、熔断和失败', () => {
  it('同一人第二个任务（不是同一篇）429 busy；跑完就能交下一篇', async () => {
    const a = await listen()
    const s = await register(a, 'busy.a')
    const g = gated()
    build = g.fn
    const first = await post(a, s, article('Bike sharing'))
    expect(await post(a, s, article('Car sharing'))).toEqual(expect.objectContaining({ status: 429, body: { error: '你有一篇文章正在生成，等它做好再贴下一篇', kind: 'busy' } }))
    // 别人照样能交（学生之间不用排队）
    const t = await register(a, 'busy.b')
    const other = await post(a, t, article('Scooter sharing'))
    expect(other.status).toBe(202)
    g.release()
    await waitJob(a, s, first.body.jobId)
    await waitJob(a, t, other.body.jobId)
    build = quick
    expect((await post(a, s, article('Car sharing'))).status).toBe(202)
  })

  it('每周上限：用完 429 week（resetsAt 是下周一北京时间 0 点）；计数落盘，重启后还在；周一清零；复用照样能读', async () => {
    const a = await listen({ studentUploadsPerWeek: 1 })
    const s = await register(a, 'week.a')
    const first = article('School lunches')
    await make(a, s, first)
    const over = await post(a, s, article('School buses'))
    expect(over).toEqual(expect.objectContaining({ status: 429, body: { error: '这周能生成的 1 篇已经用完了，下周一恢复', kind: 'week', resetsAt: nextMonday() } }))
    expect(new Date(new Date(over.body.resetsAt).getTime() + 8 * H).toISOString()).toMatch(/T00:00:00\.000Z$/)
    expect(new Date(new Date(over.body.resetsAt).getTime() + 8 * H).getUTCDay()).toBe(1)
    expect((await status(a, s)).body).toMatchObject({ open: false, weekUsed: 1, weekLimit: 1 })
    // 重启：照样用完
    const again = await listen({ studentUploadsPerWeek: 1 }, a.dataDir)
    expect((await post(again, s, article('School buses'))).body.kind).toBe('week')
    // 用完了照样能复用（另一个人贴同一篇）
    const t = await register(again, 'week.b')
    expect((await post(again, t, first)).body.reused).toBe(true)
    // 周一清零：计数文件里记的是上一周
    const counts = json(a, 'upload-counts.json')
    expect(counts[s.id]).toEqual({ week: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/), used: 1, day: expect.any(String), fails: 0 })
    fs.writeFileSync(path.join(a.dataDir, 'upload-counts.json'), JSON.stringify({ ...counts, [s.id]: { ...counts[s.id], week: '2000-01-03' } }))
    expect((await status(again, s)).body).toMatchObject({ open: true, weekUsed: 0 })
    expect((await post(again, s, article('School buses'))).status).toBe(202)
  })

  it('失败不计周次数、计今天的失败次数；到了每天的上限 429 fails（重启后还在）；失败的讲义文件不留', async () => {
    const a = await listen({ studentUploadFailsPerDay: 2 })
    const s = await register(a, 'fail.a')
    build = async () => {
      throw new Error('upstream 500')
    }
    for (const topic of ['Fail one', 'Fail two']) {
      const r = await post(a, s, article(topic))
      expect(r.status).toBe(202)
      expect((await waitJob(a, s, r.body.jobId)).body).toEqual({ status: 'failed', error: '生成失败，请稍后再试' })
      expect(fs.existsSync(path.join(a.dataDir, 'handouts', `${r.body.jobId}.json`))).toBe(false)
    }
    // 管线的 ArticleError 原样给原因
    expect((await status(a, s)).body.weekUsed).toBe(0)
    const limited = { status: 429, body: { error: '今天没生成成功的次数有点多，明天再试吧', kind: 'fails' } }
    expect(await post(a, s, article('Fail three'))).toEqual(expect.objectContaining(limited))
    expect(await post(await listen({ studentUploadFailsPerDay: 2 }, a.dataDir), s, article('Fail three'))).toEqual(expect.objectContaining(limited))
    expect(json(a, 'upload-counts.json')[s.id]).toMatchObject({ used: 0, fails: 2 })
  })

  it('管线抛 ArticleError：任务 failed，原样给原因', async () => {
    const a = await listen()
    const s = await register(a, 'fail.article')
    build = async () => {
      throw Object.assign(new Error('句子太多：最多 60 句（现在 61 句）'), { name: 'ArticleError', reason: 'length' })
    }
    const r = await post(a, s, TREES)
    expect((await waitJob(a, s, r.body.jobId)).body).toEqual({ status: 'failed', error: '句子太多：最多 60 句（现在 61 句）' })
  })

  it('全站花费到上限：新的生成 429 spend（resumesAt 是 ISO，提示里有恢复的日期），upload-status 带 paused、open:false；已有讲义照样复用', async () => {
    const a = await listen()
    const s = await register(a, 'spend.a')
    const id = await make(a, s, TREES)
    const stopped = await listen({ spendDayYuan: 0 }, a.dataDir)
    const t = await register(stopped, 'spend.b')
    calls = []
    expect(await post(stopped, t, TREES)).toMatchObject({ status: 200, body: { handoutId: id, reused: true } })
    const r = await post(stopped, t, article('Ferry routes'))
    const d = new Date(Date.now() + 8 * H)
    const tomorrow = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1) - 8 * H)
    const md = `${new Date(tomorrow.getTime() + 8 * H).getUTCMonth() + 1} 月 ${new Date(tomorrow.getTime() + 8 * H).getUTCDate()} 日`
    expect(r).toEqual(expect.objectContaining({ status: 429, body: { error: `这几天的免费生成名额用完了，${md}恢复。已经生成过的文章照常能读；贴进来的文章如果已经有现成讲义，也能直接读。`, kind: 'spend', resumesAt: tomorrow.toISOString() } }))
    expect(calls).toHaveLength(0)
    const st = (await status(stopped, t)).body
    expect(st).toEqual({ enabled: true, open: false, weekUsed: 0, weekLimit: 2, resetsAt: nextMonday(), paused: { resumesAt: tomorrow.toISOString() } })
    expect(JSON.stringify(st)).not.toMatch(/cost|yuan|元/)
  })

  it('几篇同时生成时，花费上限把还在跑的估计额算上；只是被它占着才超的回 crowded（过几分钟再试，没有恢复时间），upload-status 不算停；老师上传也算上它', async () => {
    const dir = newDir()
    const a = await listen({ spendDayYuan: 1 }, dir) // 一篇约 0.6 元（这里的文章约 800 字符）
    const s = await register(a, 'inflight.a')
    const t = await register(a, 'inflight.b')
    const g = gated()
    build = g.fn
    const r = await post(a, s, article('Tram lines'))
    expect(r.status).toBe(202)
    expect(await post(a, t, article('Cable cars'))).toEqual(expect.objectContaining({ status: 429, body: { error: '现在同时在生成的文章有点多，过几分钟再试', kind: 'crowded' } }))
    const st = (await status(a, t)).body
    expect(st.open).toBe(true)
    expect(st).not.toHaveProperty('paused')
    const teacher = cookieOf(await call(a, 'POST', '/api/auth/register', { invite: TEACHER_INVITE, username: 'inflight.teacher', password: 'teacher-pass-1' }))
    expect(await call(a, 'POST', '/api/uploads', { title: 'T', text: article('Ski lifts') }, teacher)).toEqual(expect.objectContaining({ status: 429, body: { error: '现在有别的文章正在生成，请几分钟后再试' } }))
    g.release()
    await waitJob(a, s, r.body.jobId)
    expect((await post(a, t, article('Cable cars'))).status).toBe(202) // 跑完就放开（假管线没报用量，合计还是 0）
  })
})

describe('内容检查和内容安全拦截', () => {
  it('内容检查不过 400，reason 和中文原因；不跑管线、不算失败', async () => {
    const a = await listen({ studentUploadFailsPerDay: 1 })
    const s = await register(a, 'check.a')
    const cases: [string, string][] = [
      ["Le matin, les enfants vont à l'école en vélo. Ils traversent le parc où les arbres sont encore couverts de rosée. La ville a décidé de construire de nouvelles pistes cyclables pour que les élèves puissent circuler en sécurité.", 'not_english'],
      [`${para('Exams', 1)}\nA. They are lazy.\nB. Their clocks change.\nC. They use phones.\nD. Schools start late.`, 'exam'],
      [`${TREES} Call the organiser on 13800000000 to join.`, 'personal_info'],
      [`${'We should all read more books every day. '.repeat(3)}${para('Books', 1)}`, 'repeated'],
    ]
    for (const [text, reason] of cases) {
      const r = await post(a, s, text)
      expect(r.status, reason).toBe(400)
      expect(r.body.reason).toBe(reason)
      expect(r.body.error).toMatch(/[一-龥]/)
    }
    expect(calls).toHaveLength(0)
    expect((await post(a, s, TREES)).status).toBe(202) // 失败上限是 1，上面的不算
  })

  it('被内容安全拦截：任务 failed，reason unsafe 和专门的提示；不算周次数、算失败次数；同一篇（精确键）不让再交，换个空白也不行', async () => {
    const a = await listen()
    const s = await register(a, 'unsafe.a')
    const text = article('Night clubs')
    build = async () => {
      throw Object.assign(new Error(UNSAFE), { name: 'ArticleError', reason: 'unsafe' })
    }
    const r = await post(a, s, text)
    expect((await waitJob(a, s, r.body.jobId)).body).toEqual({ status: 'failed', error: UNSAFE, reason: 'unsafe' })
    expect(json(a, 'upload-counts.json')[s.id]).toMatchObject({ used: 0, fails: 1 })
    expect(json(a, 'upload-blocked.json')).toEqual({ keys: [articleKeys(text).exact] })
    expect((fs.statSync(path.join(a.dataDir, 'upload-blocked.json')).mode & 0o777).toString(8)).toBe('600')
    calls = []
    const t = await register(a, 'unsafe.b')
    for (const again of [text, text.replace(/\n\n/g, '\n')]) expect(await post(a, t, again)).toMatchObject({ status: 400, body: { error: UNSAFE, reason: 'unsafe' } })
    expect(calls).toHaveLength(0)
    // 管线没认出来、错误里带着百炼的错误码：后端也按拦截处理
    build = async () => {
      throw new Error('起草失败：\n第 1 段：Error: 模型接口返回 400: {"error":{"code":"data_inspection_failed"}}')
    }
    const r2 = await post(a, t, article('Dark alleys'))
    expect((await waitJob(a, t, r2.body.jobId)).body).toEqual({ status: 'failed', error: UNSAFE, reason: 'unsafe' })
  })
})

describe('写作检查被内容安全拦截', () => {
  it('上游回 400 data_inspection_failed：照旧回落到规则检查，多给一句专门的提示（reason unsafe）；别的 400 照旧只回落', async () => {
    let reply = { error: { code: 'data_inspection_failed', message: 'Input data may contain inappropriate content.', type: 'data_inspection_failed' } }
    const llm = http.createServer((req, res) => {
      req.resume()
      req.on('end', () => res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify(reply)))
    })
    await new Promise<void>((ok) => llm.listen(0, '127.0.0.1', () => ok()))
    try {
      const a = await listen({ studentAi: true, llmBaseUrl: `http://127.0.0.1:${(llm.address() as AddressInfo).port}/v1` })
      const s = await register(a, 'writing.unsafe')
      const body = { handoutId: 'up-anything', sid: s.sid, text: 'I toyed with the idea.', expressions: [{ id: 'E1', text: 'toy with the idea', zh: '考虑', example: 'x' }] }
      expect((await call(a, 'POST', '/api/writing-check', body, s.cookie)).body).toEqual({ fallback: true, results: [], error: '这几句里有不适合在这里写的内容，换个说法再试吧', reason: 'unsafe' })
      reply = { error: { code: 'invalid_parameter_error', message: 'bad', type: 'invalid_request_error' } }
      expect((await call(a, 'POST', '/api/writing-check', body, s.cookie)).body).toEqual({ fallback: true, results: [] })
    } finally {
      llm.close()
    }
  })
})

describe('任务丢了', () => {
  it('重启以后查进度：404 {error, lost:true}，提示重新提交；重新提交，生成好的直接复用', async () => {
    const a = await listen()
    const s = await register(a, 'lost.a')
    const r = await post(a, s, TREES)
    await waitJob(a, s, r.body.jobId)
    const restarted = await listen({}, a.dataDir)
    expect(await progress(restarted, s, r.body.jobId)).toEqual(expect.objectContaining({ status: 404, body: { error: '这次生成的进度找不到了，重新提交一次，已经生成好的会直接复用', lost: true } }))
    expect((await progress(restarted, undefined, r.body.jobId)).body).not.toHaveProperty('lost')
    const t = await register(restarted, 'lost.b')
    expect((await post(restarted, t, TREES)).body).toEqual({ handoutId: r.body.jobId, reused: true })
  })
})

describe('注销和到期清理', () => {
  it('注销：library.json、upload-counts.json 里没有这个账号；别人在用的讲义还在、去掉 createdBy；没人用的记 unusedSince；30 天后删，老师讲义不动', async () => {
    const a = await listen()
    const s = await register(a, 'del.creator')
    const t = await register(a, 'del.reuser')
    const shared = await make(a, s, TREES)
    const alone = await make(a, s, article('Water fountains'))
    expect((await post(a, t, TREES)).body.reused).toBe(true)
    // 老师的讲义（没有 source）：清理不动，哪怕放了很久
    const tr = await call(a, 'POST', '/api/auth/register', { invite: TEACHER_INVITE, username: 'del.teacher', password: 'teacher-pass-1' })
    const tj = await call(a, 'POST', '/api/uploads', { title: 'T', text: article('Old maps') }, cookieOf(tr))
    for (let i = 0; i < 100 && (await call(a, 'GET', `/api/uploads/${tj.body.jobId}`, undefined, cookieOf(tr))).body.status === 'running'; i++) await sleep(10)

    expect((await call(a, 'POST', '/api/student/delete', { password: PASSWORD }, s.cookie)).body).toEqual({ ok: true })
    expect(json(a, 'library.json')).not.toHaveProperty(s.id)
    expect(json(a, 'upload-counts.json')).not.toHaveProperty(s.id)
    expect(meta(a, shared)).not.toHaveProperty('createdBy')
    expect(meta(a, shared)).not.toHaveProperty('unusedSince')
    expect(meta(a, alone)).not.toHaveProperty('createdBy')
    expect(meta(a, alone).unusedSince).toEqual(expect.any(Number))
    expect((await read(a, shared, t.cookie)).status).toBe(200)
    for (const f of fs.readdirSync(path.join(a.dataDir, 'handouts'))) expect(fs.readFileSync(path.join(a.dataDir, 'handouts', f), 'utf8'), f).not.toContain(s.id)

    // 没到 30 天：不删
    expect(await a.app.cleanup()).not.toHaveProperty('handouts')
    expect(fs.existsSync(path.join(a.dataDir, 'handouts', `${alone}.json`))).toBe(true)
    // 改成 31 天前：讲义和 meta 一起删；有人用的、老师的不动
    const old = Date.now() - (STUDENT_HANDOUT_DAYS + 1) * DAY
    for (const id of [alone, tj.body.jobId]) fs.writeFileSync(path.join(a.dataDir, 'handouts', `${id}.meta.json`), JSON.stringify({ ...meta(a, id), unusedSince: old }))
    fs.writeFileSync(path.join(a.dataDir, 'handouts', `${shared}.meta.json`), JSON.stringify({ ...meta(a, shared), unusedSince: old }))
    expect(await a.app.cleanup()).toMatchObject({ handouts: 1 })
    for (const f of [`${alone}.json`, `${alone}.meta.json`]) expect(fs.existsSync(path.join(a.dataDir, 'handouts', f)), f).toBe(false)
    expect(meta(a, shared)).not.toHaveProperty('unusedSince') // 有人用：去掉
    expect(meta(a, tj.body.jobId)).toMatchObject({ unusedSince: old, owner: expect.any(String) }) // 老师的原样不动
    expect(fs.existsSync(path.join(a.dataDir, 'handouts', `${tj.body.jobId}.json`))).toBe(true)
  })

  it('清理兜底：没人用、还没记时间的记上现在；createdBy、列表、次数里账号已经不在的去掉；过期的次数去掉', async () => {
    const a = await listen()
    const s = await register(a, 'clean.a')
    const id = await make(a, s, TREES)
    // 模拟注销时没删成：账号已经不在了，列表、次数、createdBy 还在
    const students = json(a, 'students.json')
    fs.writeFileSync(path.join(a.dataDir, 'students.json.tmp'), JSON.stringify({ ...students, students: students.students.filter((x: { id: string }) => x.id !== s.id) }))
    fs.renameSync(path.join(a.dataDir, 'students.json.tmp'), path.join(a.dataDir, 'students.json'))
    const keep = await register(a, 'clean.b')
    fs.writeFileSync(path.join(a.dataDir, 'upload-counts.json'), JSON.stringify({ ...json(a, 'upload-counts.json'), [keep.id]: { week: '2000-01-03', used: 2, day: '2000-01-04', fails: 1 } }))
    await a.app.cleanup()
    expect(json(a, 'library.json')).toEqual({})
    expect(json(a, 'upload-counts.json')).toEqual({})
    expect(meta(a, id)).not.toHaveProperty('createdBy')
    expect(meta(a, id).unusedSince).toBeGreaterThan(Date.now() - 60000)
    // 又有人贴了同一篇：清理时去掉 unusedSince
    expect((await post(a, keep, TREES)).body.reused).toBe(true)
    await a.app.cleanup()
    expect(meta(a, id)).not.toHaveProperty('unusedSince')
  })
})

describe('命令行 scripts/student.mjs', () => {
  const cli = (dataDir: string, ...args: string[]) =>
    spawnSync(process.execPath, ['scripts/student.mjs', ...args], { cwd: process.cwd(), encoding: 'utf8', env: { ...process.env, DATA_DIR: dataDir, DELETIONS_DIR: deletionsDir, ENV_FILE: path.join(dataDir, 'missing.env') } })

  it('shelf add 不收学生上传的讲义（只有贴过同一篇的人能读，不上架）', async () => {
    const a = await listen()
    const s = await register(a, 'cli.shelf')
    const id = await make(a, s, TREES)
    const r = cli(a.dataDir, 'shelf', 'add', id)
    expect(r.status).not.toBe(0)
    expect(r.stderr).toContain(`${id} 是学生上传的讲义，不能上架。`)
    expect(fs.existsSync(path.join(a.dataDir, 'shelf.json'))).toBe(false)
  })

  it('apply-deletions：从备份恢复出来的目录里，已注销账号的「我的文章」、上传次数、讲义的 createdBy 一起去掉，别人的不动', async () => {
    const a = await listen()
    const s = await register(a, 'cli.gone')
    const t = await register(a, 'cli.kept')
    const id = await make(a, s, TREES)
    await make(a, t, article('Park benches'))
    const restored = newDir()
    fs.cpSync(a.dataDir, restored, { recursive: true }) // 注销之前的一份（当作备份）
    expect((await call(a, 'POST', '/api/student/delete', { password: PASSWORD }, s.cookie)).body).toEqual({ ok: true })
    const r = cli(a.dataDir, 'apply-deletions', restored)
    expect(r.status, r.stderr).toBe(0)
    const at = (name: string) => JSON.parse(fs.readFileSync(path.join(restored, name), 'utf8'))
    expect(Object.keys(at('library.json'))).toEqual([t.id])
    expect(Object.keys(at('upload-counts.json'))).toEqual([t.id])
    expect(at(`handouts/${id}.meta.json`)).not.toHaveProperty('createdBy')
    expect(at(`handouts/${id}.meta.json`)).toMatchObject({ source: 'student', exactKey: articleKeys(TREES).exact })
    for (const f of fs.readdirSync(path.join(restored, 'handouts'))) expect(fs.readFileSync(path.join(restored, 'handouts', f), 'utf8'), f).not.toContain(s.id)
  })
})

describe('读取配置', () => {
  it('STUDENT_UPLOAD=1 才开放；STUDENT_UPLOADS_PER_WEEK 默认 2、STUDENT_UPLOAD_FAILS_PER_DAY 默认 3，0–999 的整数才用', () => {
    const ENV_FILE = path.join(newDir(), 'missing.env')
    const logged: string[] = []
    const spy = vi.spyOn(console, 'log').mockImplementation((l) => void logged.push(String(l)))
    try {
      expect(loadConfig({ ENV_FILE })).toMatchObject({ studentUpload: false, studentUploadsPerWeek: 2, studentUploadFailsPerDay: 3 })
      expect(loadConfig({ ENV_FILE, STUDENT_UPLOAD: '1', STUDENT_UPLOADS_PER_WEEK: ' 5 ', STUDENT_UPLOAD_FAILS_PER_DAY: '0' })).toMatchObject({ studentUpload: true, studentUploadsPerWeek: 5, studentUploadFailsPerDay: 0 })
      expect(loadConfig({ ENV_FILE, STUDENT_UPLOAD: 'yes' }).studentUpload).toBe(false)
      expect(logged).toEqual([])
      expect(loadConfig({ ENV_FILE, STUDENT_UPLOADS_PER_WEEK: '-1', STUDENT_UPLOAD_FAILS_PER_DAY: '3篇' })).toMatchObject({ studentUploadsPerWeek: 2, studentUploadFailsPerDay: 3 })
      expect(logged).toEqual(['STUDENT_UPLOADS_PER_WEEK 不是整数，已忽略，用默认的 2', 'STUDENT_UPLOAD_FAILS_PER_DAY 不是整数，已忽略，用默认的 3'])
    } finally {
      spy.mockRestore()
    }
  })
})
