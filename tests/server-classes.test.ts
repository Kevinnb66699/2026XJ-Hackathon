// 班级和座号：老师建班、导入名单（姓名只有建班的老师登录后能看）、发布到班；学生扫码选座号、用找回码找回、拿回自己的作答；老师按班看学习记录。
// 请求用 node:http 发（同 server-auth.test.ts）；这里不调用模型
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createApp } from '../server/index.mjs'
import type { BuildArticle, ServerConfig } from '../server/index.mjs'

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zhishi-classes-'))
const logs: string[] = []
const INVITES = Array.from({ length: 20 }, (_, i) => `invite-class-${String(i).padStart(4, '0')}`)
let nextInvite = 0
const classesFile = path.join(dataDir, 'classes.json')
const readJson = (f: string) => JSON.parse(fs.readFileSync(f, 'utf8'))
const stored = (id: string) => readJson(classesFile).classes.find((c: { id: string }) => c.id === id)
const sha = (s: string) => createHash('sha256').update(s).digest('hex')
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const TEXT = 'Many schools are toying with the idea of banning phones in class. '.repeat(5).trim()
const build: BuildArticle = async (input, opts) => ({ handout: { id: opts.id, title: input.title }, report: { errors: 0 } })
const NAMES = ['张三', '李四', '王小五', '赵六']
const ROSTER = NAMES.map((name, i) => ({ n: i + 1, name })) // 1–4 号
const NO_CLASS = { error: '找不到这个班，请重新扫老师发的二维码' }
const CODE = /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{6}$/
const secrets: string[] = [] // 发给学生的 sid、token、找回码：最后查日志里一个都没有

type App = { server: Server; port: number }
type Res = { status: number; body: any; headers: http.IncomingHttpHeaders }
const open: App[] = []
function listen(config: Partial<ServerConfig> = {}) {
  return new Promise<App>((resolve) => {
    const server = createApp({ dataDir, apiKey: 'sk-test-not-a-real-key', uploadInvites: INVITES, authPerMinute: 1000, uploadsPerTeacherPerHour: 1000, uploadsPerDay: 1000, buildArticle: build, log: (l: string) => logs.push(l), ...config }).listen(0, '127.0.0.1', () => {
      const a = { server, port: (server.address() as AddressInfo).port }
      open.push(a)
      resolve(a)
    })
  })
}

// body 是字符串就原样发（测请求格式），否则发 JSON；cookie 是登录后 Set-Cookie 里的「名=值」
function call(a: App, method: string, url: string, body?: unknown, cookie?: string, headers: Record<string, string> = {}) {
  return new Promise<Res>((resolve, reject) => {
    const h: Record<string, string> = { 'content-type': 'application/json', ...(cookie ? { cookie } : {}), ...headers }
    const req = http.request({ host: '127.0.0.1', port: a.port, path: url, method, headers: h }, (res) => {
      let text = ''
      res.setEncoding('utf8')
      res.on('data', (c) => (text += c))
      res.on('end', () => resolve({ status: res.statusCode!, body: JSON.parse(text), headers: res.headers }))
    })
    req.on('error', reject)
    req.end(body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body))
  })
}

type Who = { cookie: string; id: string }
async function register(username: string): Promise<Who> {
  const r = await call(app, 'POST', '/api/auth/register', { invite: INVITES[nextInvite++], username, password: 'password-for-tests' })
  expect(r.status, JSON.stringify(r.body)).toBe(201)
  return { cookie: String(r.headers['set-cookie']?.[0]).split(';')[0], id: r.body.teacher.id }
}

// 上传一份讲义（假管线），等生成完，返回讲义 id
async function upload(who: Who, title = 'Phones') {
  const r = await call(app, 'POST', '/api/uploads', { title, text: TEXT }, who.cookie)
  expect(r.status).toBe(202)
  for (let i = 0; i < 300; i++) {
    const s = await call(app, 'GET', `/api/uploads/${r.body.jobId}`, undefined, who.cookie)
    if (s.body.status === 'done') return r.body.jobId as string
    await sleep(5)
  }
  throw new Error('job did not finish')
}

const newClass = (who: Who, o: Record<string, unknown> = {}) => call(app, 'POST', '/api/classes', { name: '高一 3 班', roster: ROSTER, ...o }, who.cookie)
const publish = (who: Who, h: string, classes: unknown) => call(app, 'POST', `/api/handouts/${h}/publish`, { classes }, who.cookie)
// 建一个班、上传一份讲义、发布到这个班
async function setup(who: Who, roster = ROSTER) {
  const c = (await newClass(who, { roster })).body.class.id as string
  const h = await upload(who)
  expect((await publish(who, h, [c])).status).toBe(200)
  return { c, h }
}
async function join(c: string, h: string, seat: unknown, a = app) {
  const r = await call(a, 'POST', `/api/join/${c}`, { h, seat })
  if (r.status === 201) secrets.push(r.body.sid, r.body.token, r.body.recoveryCode)
  return r
}
async function recover(c: string, h: string, seat: unknown, code: unknown) {
  const r = await call(app, 'POST', `/api/join/${c}/recover`, { h, seat, code })
  if (r.status === 200) secrets.push(r.body.token)
  return r
}
const progress = (h: string, c: string, token?: string) => call(app, 'GET', `/api/my-progress?h=${h}&c=${c}`, undefined, undefined, token === undefined ? {} : { 'x-student-token': token })
const detail = async (c: string, who = A) => (await call(app, 'GET', `/api/classes/${c}`, undefined, who.cookie)).body.class
// 和真码不一样的找回码（同样 6 位）
const wrongCode = (code: string) => (code[0] === 'A' ? 'B' : 'A') + code.slice(1)

let app: App
let A: Who // 主要用的老师
let B: Who // 另一位老师
beforeAll(async () => {
  app = await listen()
  A = await register('class.a')
  B = await register('class.b')
})
afterAll(() => {
  for (const a of open) a.server.close()
})

describe('建班和名单', () => {
  it('没登录 401；建班 201 返回详情：去掉首尾空白、按座号排，姓名可以不填；列表只有人数，新建的在前，只列自己的；classes.json 只给本用户读写', async () => {
    const login = { status: 401, body: { error: '请先登录' } }
    expect(await call(app, 'POST', '/api/classes', { name: '高一 3 班', roster: ROSTER })).toMatchObject(login)
    expect(await call(app, 'GET', '/api/classes')).toMatchObject(login)
    expect(await call(app, 'GET', '/api/classes', undefined, `zhishi_session=${'f'.repeat(64)}`)).toMatchObject(login)
    const C = await register('list.c')
    const r = await call(app, 'POST', '/api/classes', { name: ' 高一 3 班 ', roster: [{ n: 12, name: ' 李四 ' }, { n: 3, name: '张三' }, { n: 7 }, { n: 8, name: null }, { n: 9, name: '  ' }] }, C.cookie)
    expect(r.status).toBe(201)
    const empty = (n: number) => ({ n, name: '', joined: false })
    expect(r.body).toEqual({ class: { id: expect.stringMatching(/^c-[0-9a-f]{12}$/), name: '高一 3 班', createdAt: expect.any(String), seats: [{ n: 3, name: '张三', joined: false }, empty(7), empty(8), empty(9), { n: 12, name: '李四', joined: false }] } })
    expect(stored(r.body.class.id)).toEqual({ id: r.body.class.id, owner: C.id, name: '高一 3 班', createdAt: r.body.class.createdAt, seats: r.body.class.seats.map((s: { n: number; name: string }) => ({ n: s.n, name: s.name })), bindings: {} })
    await sleep(5)
    const second = (await newClass(C, { name: '高一 4 班' })).body.class
    const list = await call(app, 'GET', '/api/classes', undefined, C.cookie)
    expect(list.headers['cache-control']).toBe('no-store')
    expect(list.body).toEqual({
      classes: [
        { id: second.id, name: '高一 4 班', createdAt: expect.any(String), seats: 4, joined: 0 },
        { id: r.body.class.id, name: '高一 3 班', createdAt: expect.any(String), seats: 5, joined: 0 },
      ],
    })
    for (const name of NAMES) expect(JSON.stringify(list.body)).not.toContain(name)
    expect((await call(app, 'GET', '/api/classes', undefined, B.cookie)).body.classes.map((c: { id: string }) => c.id)).not.toContain(second.id)
    expect(fs.statSync(classesFile).mode & 0o777).toBe(0o600)
    expect(fs.readdirSync(dataDir).filter((f) => f.endsWith('.tmp'))).toEqual([])
  })

  it('字段不对 400，按字段给中文提示（座号重复、超出 1–99、超过 80 人、姓名超过 20 字……），不建班；正好 80 人、20 字可以', async () => {
    const NAME = '班级名要 1 到 20 个字'
    const FORMAT = '名单的格式不对，请刷新页面后再试'
    const SEAT = '座号要是 1 到 99 的整数'
    const bad: [Record<string, unknown>, string, string][] = [
      [{ name: '' }, 'name', NAME],
      [{ name: '   ' }, 'name', NAME],
      [{ name: '一'.repeat(21) }, 'name', NAME],
      [{ name: 42 }, 'name', NAME],
      [{ name: '高一\n3 班' }, 'name', '班级名里不能有换行之类的特殊字符'],
      [{ roster: undefined }, 'roster', FORMAT],
      [{ roster: 'x' }, 'roster', FORMAT],
      [{ roster: [1, 2] }, 'roster', FORMAT],
      [{ roster: [{ n: 1 }, null] }, 'roster', FORMAT],
      [{ roster: [] }, 'roster', '名单里至少要有 1 个座号'],
      [{ roster: Array.from({ length: 81 }, (_, i) => ({ n: i + 1 })) }, 'roster', '一个班最多 80 人'],
      [{ roster: [{ n: 0 }] }, 'roster', SEAT],
      [{ roster: [{ n: 100 }] }, 'roster', SEAT],
      [{ roster: [{ n: 1.5 }] }, 'roster', SEAT],
      [{ roster: [{ n: '1' }] }, 'roster', SEAT],
      [{ roster: [{ name: '张三' }] }, 'roster', SEAT],
      [{ roster: [{ n: 3 }, { n: 5 }, { n: 3 }] }, 'roster', '座号 3 重复了'],
      [{ roster: [{ n: 3, name: '一'.repeat(21) }] }, 'roster', '3 号的姓名不超过 20 个字'],
      [{ roster: [{ n: 3, name: 7 }] }, 'roster', FORMAT],
      [{ roster: [{ n: 3, name: '张\t三' }] }, 'roster', '3 号的姓名里不能有换行之类的特殊字符'],
    ]
    const before = (await call(app, 'GET', '/api/classes', undefined, A.cookie)).body
    for (const [o, field, msg] of bad) {
      const r = await newClass(A, o)
      expect(r, JSON.stringify(o).slice(0, 60)).toMatchObject({ status: 400, body: { error: '有 1 处要改，见标红的地方', fields: { [field]: msg } } })
      expect(Object.keys(r.body.fields)).toEqual([field])
    }
    expect(await call(app, 'POST', '/api/classes', {}, A.cookie)).toMatchObject({ status: 400, body: { error: '有 2 处要改，见标红的地方', fields: { name: NAME, roster: FORMAT } } })
    expect((await call(app, 'GET', '/api/classes', undefined, A.cookie)).body).toEqual(before)
    const full = await newClass(A, { name: '一'.repeat(20), roster: Array.from({ length: 80 }, (_, i) => ({ n: 99 - i, name: '名'.repeat(20) })) })
    expect(full.status).toBe(201)
    expect(full.body.class.seats.map((s: { n: number }) => s.n)).toEqual(Array.from({ length: 80 }, (_, i) => 20 + i))
    expect(await call(app, 'POST', `/api/classes/${full.body.class.id}/delete`, {}, A.cookie)).toMatchObject({ status: 200, body: { ok: true } })
  })

  it('每位老师最多 20 个班（同时建也不会超过）；别的老师不受影响', async () => {
    const D = await register('many.d')
    const rs = await Promise.all(Array.from({ length: 23 }, (_, i) => newClass(D, { name: `班 ${i}` })))
    expect(rs.filter((r) => r.status === 201)).toHaveLength(20)
    expect(rs.filter((r) => r.status !== 201)).toEqual(Array.from({ length: 3 }, () => expect.objectContaining({ status: 400, body: { error: '每位老师最多建 20 个班' } })))
    expect((await call(app, 'GET', '/api/classes', undefined, D.cookie)).body.classes).toHaveLength(20)
    expect((await newClass(D)).status).toBe(400)
    const E = await register('few.e')
    expect((await newClass(E)).status).toBe(201)
  })

  it('班级只有建它的老师能读、改、删、重置找回码、清空座号：没登录 401，别的老师 403（看不到姓名），不存在 404；都不改文件', async () => {
    const { c, h } = await setup(A)
    expect((await join(c, h, 1)).status).toBe(201)
    const actions = (id: string) => [
      ['GET', `/api/classes/${id}`, undefined],
      ['POST', `/api/classes/${id}`, { name: '改名', roster: [{ n: 9 }] }],
      ['POST', `/api/classes/${id}/delete`, {}],
      ['POST', `/api/classes/${id}/seats/1/reset-code`, {}],
      ['POST', `/api/classes/${id}/seats/1/clear`, {}],
    ] as const
    const before = fs.readFileSync(classesFile, 'utf8')
    for (const [m, u, b] of actions(c)) {
      expect(await call(app, m, u, b), u).toMatchObject({ status: 401, body: { error: '请先登录' } })
      const r = await call(app, m, u, b, B.cookie)
      expect(r, u).toMatchObject({ status: 403, body: { error: '这个班不是你建的' } })
      expect(Object.keys(r.body)).toEqual(['error'])
    }
    for (const id of ['c-000000000000', 'nope', '..%2Fclasses', 'C-0123456789AB']) {
      for (const [m, u, b] of actions(id)) expect(await call(app, m, u, b, A.cookie), u).toMatchObject({ status: 404, body: { error: '没有这个班' } })
    }
    expect(fs.readFileSync(classesFile, 'utf8')).toBe(before)
    // 建班的老师看得到姓名和 sid（用来把事件对上座号），不缓存
    const own = await call(app, 'GET', `/api/classes/${c}`, undefined, A.cookie)
    expect(own.headers['cache-control']).toBe('no-store')
    expect(own.body.class.seats[0]).toEqual({ n: 1, name: '张三', joined: true, joinedAt: expect.any(Number), sid: expect.stringMatching(/^s-[0-9a-f]{16}$/) })
    expect(own.body.class.seats[1]).toEqual({ n: 2, name: '李四', joined: false })
    expect((await call(app, 'GET', '/api/classes', undefined, A.cookie)).body.classes.find((x: { id: string }) => x.id === c)).toMatchObject({ seats: 4, joined: 1 })
  })

  it('改班名、换名单：留下的座号绑定不变、姓名可以改，删掉的座号连绑定一起删（学生端也找不回了）；只改一样也行；字段不对 400', async () => {
    const { c, h } = await setup(A)
    const s1 = (await join(c, h, 1)).body
    const s2 = (await join(c, h, 2)).body
    const r = await call(app, 'POST', `/api/classes/${c}`, { roster: [{ n: 5, name: '新同学' }, { n: 1, name: ' 张三丰 ' }] }, A.cookie)
    expect(r.status).toBe(200)
    expect(r.body.class).toMatchObject({ id: c, name: '高一 3 班' })
    expect(r.body.class.seats).toEqual([{ n: 1, name: '张三丰', joined: true, joinedAt: expect.any(Number), sid: s1.sid }, { n: 5, name: '新同学', joined: false }])
    expect(await detail(c)).toEqual(r.body.class)
    expect(Object.keys(stored(c).bindings)).toEqual(['1'])
    expect(await recover(c, h, 2, s2.recoveryCode)).toMatchObject({ status: 400, body: { error: '没有这个座号' } })
    expect((await progress(h, c, s2.token)).status).toBe(401)
    expect((await progress(h, c, s1.token)).status).toBe(200)
    expect((await call(app, 'GET', `/api/join/${c}?h=${h}`)).body.seats).toEqual([{ n: 1, taken: true }, { n: 5, taken: false }])

    const renamed = await call(app, 'POST', `/api/classes/${c}`, { name: ' 高一 3 班（理） ' }, A.cookie)
    expect(renamed.body.class).toMatchObject({ name: '高一 3 班（理）', seats: [{ n: 1, joined: true }, { n: 5, joined: false }] })
    expect(await call(app, 'POST', `/api/classes/${c}`, {}, A.cookie)).toMatchObject({ status: 400, body: { error: '没有要保存的改动' } })
    expect(await call(app, 'POST', `/api/classes/${c}`, { roster: [{ n: 1 }, { n: 1 }] }, A.cookie)).toMatchObject({ status: 400, body: { fields: { roster: '座号 1 重复了' } } })
    expect(await call(app, 'POST', `/api/classes/${c}`, { name: '', roster: [] }, A.cookie)).toMatchObject({ status: 400, body: { error: '有 2 处要改，见标红的地方' } })
    expect((await detail(c)).name).toBe('高一 3 班（理）')
  })
})

describe('发布到班', () => {
  it('要选至少一个班，只能选自己的班；meta.classes 是这次给的（去重），再发布一次可以增减；我上传过的带 classes，删掉的班不列', async () => {
    const h = await upload(A, 'Publish to classes')
    const c1 = (await newClass(A, { name: '一班' })).body.class.id
    const c2 = (await newClass(A, { name: '二班' })).body.class.id
    const cb = (await newClass(B, { name: 'B 的班' })).body.class.id
    const meta = () => readJson(path.join(dataDir, 'handouts', `${h}.meta.json`))
    for (const body of [{}, { classes: [] }, { classes: c1 }, { classes: null }]) {
      expect(await call(app, 'POST', `/api/handouts/${h}/publish`, body, A.cookie), JSON.stringify(body)).toMatchObject({ status: 400, body: { error: '请至少选一个班' } })
    }
    for (const classes of [[cb], [c1, cb], ['c-000000000000'], [c1, 42], [c1, { id: c1 }]]) {
      expect(await publish(A, h, classes), JSON.stringify(classes)).toMatchObject({ status: 400, body: { error: '有的班不存在或不是你建的，请刷新后再选' } })
    }
    expect(meta().published).toBe(false)
    expect(meta().classes).toBeUndefined()
    expect(await publish(B, h, [cb])).toMatchObject({ status: 403, body: { error: '只有上传这篇文章的老师能发布' } })

    expect(await publish(A, h, [c2, c1, c2])).toMatchObject({ status: 200, body: { ok: true, classes: [c2, c1] } })
    expect(meta()).toMatchObject({ published: true, owner: A.id, classes: [c2, c1] })
    expect((await publish(A, h, [c1])).body).toEqual({ ok: true, classes: [c1] })
    expect(meta()).toMatchObject({ published: true, classes: [c1] })
    expect(fs.readdirSync(path.join(dataDir, 'handouts')).filter((f) => f.endsWith('.tmp'))).toEqual([])

    const listed = async () => (await call(app, 'GET', '/api/my/handouts', undefined, A.cookie)).body.handouts.find((x: { id: string }) => x.id === h)
    expect(await listed()).toEqual({ id: h, title: 'Publish to classes', createdAt: expect.any(String), published: true, classes: [c1] })
    await publish(A, h, [c1, c2])
    expect((await listed()).classes).toEqual([c1, c2])
    await call(app, 'POST', `/api/classes/${c2}/delete`, {}, A.cookie)
    expect((await listed()).classes).toEqual([c1])
    expect(meta().classes).toEqual([c1, c2]) // meta 里留着，读的时候忽略
  })
})

describe('学生选座号', () => {
  let c: string
  let h: string
  beforeAll(async () => {
    ;({ c, h } = await setup(A))
  })

  it('GET：班级名和座号格子（已有人），没有姓名；不用登录、不缓存', async () => {
    const r = await call(app, 'GET', `/api/join/${c}?h=${h}`)
    expect(r.status).toBe(200)
    expect(r.headers['cache-control']).toBe('no-store')
    expect(r.body).toEqual({ className: '高一 3 班', seats: ROSTER.map((s) => ({ n: s.n, taken: false })) })
    const text = JSON.stringify(r.body)
    for (const name of NAMES) expect(text).not.toContain(name)
  })

  it('找不到一律 404：班级不存在或格式不对、没带讲义、讲义没发布、讲义没发布到这个班、别的老师的班配自己的讲义、内置讲义', async () => {
    const draft = await upload(A, 'Not published')
    const elsewhere = await upload(A, 'Published elsewhere')
    const other = (await newClass(A, { name: '别的班' })).body.class.id
    await publish(A, elsewhere, [other])
    const bClass = (await newClass(B)).body.class.id
    // A 的讲义：meta 里硬写上 B 的班（正常发布不了），班级和讲义不是同一位老师的，照样 404
    const forged = await upload(A, 'Forged')
    const metaPath = path.join(dataDir, 'handouts', `${forged}.meta.json`)
    fs.writeFileSync(metaPath, JSON.stringify({ ...readJson(metaPath), published: true, classes: [bClass] }))
    const cases: [string, string | undefined][] = [
      ['c-000000000000', h],
      ['nope', h],
      ['C-' + c.slice(2).toUpperCase(), h],
      [c, undefined],
      [c, 'up-missing'],
      [c, draft],
      [c, elsewhere],
      [c, 'mini-phones'],
      [bClass, h],
      [bClass, forged],
    ]
    for (const [cls, hid] of cases) {
      const q = hid === undefined ? '' : `?h=${hid}`
      const what = `${cls} ${hid}`
      expect(await call(app, 'GET', `/api/join/${cls}${q}`), what).toMatchObject({ status: 404, body: NO_CLASS })
      expect(await join(cls, hid as string, 1), what).toMatchObject({ status: 404, body: NO_CLASS })
      expect(await recover(cls, hid as string, 1, 'ABCDEF'), what).toMatchObject({ status: 404, body: NO_CLASS })
      expect(await call(app, 'GET', `/api/my-progress?c=${cls}${hid === undefined ? '' : `&h=${hid}`}`, undefined, undefined, { 'x-student-token': 'a'.repeat(64) }), what).toMatchObject({ status: 404, body: NO_CLASS })
    }
    expect(stored(bClass).bindings).toEqual({})
  })

  it('选座号：201 {seat, sid, token, recoveryCode}；classes.json 里只有 sha256，没有明文找回码和 token；格子显示已有人；老师端看到已进班', async () => {
    const r = await join(c, h, 2)
    expect(r.status).toBe(201)
    expect(r.body).toEqual({ seat: 2, sid: expect.stringMatching(/^s-[0-9a-f]{16}$/), token: expect.stringMatching(/^[0-9a-f]{64}$/), recoveryCode: expect.stringMatching(CODE) })
    const { sid, token, recoveryCode } = r.body
    expect(stored(c).bindings).toEqual({ 2: { sid, recoveryHash: sha(recoveryCode), tokens: [sha(token)], boundAt: expect.any(Number) } })
    const file = fs.readFileSync(classesFile, 'utf8')
    expect(file).not.toContain(token)
    expect(file).not.toContain(`"${recoveryCode}"`)
    expect(fs.statSync(classesFile).mode & 0o777).toBe(0o600)
    expect((await call(app, 'GET', `/api/join/${c}?h=${h}`)).body.seats).toEqual([{ n: 1, taken: false }, { n: 2, taken: true }, { n: 3, taken: false }, { n: 4, taken: false }])
    expect((await detail(c)).seats[1]).toEqual({ n: 2, name: '李四', joined: true, joinedAt: stored(c).bindings[2].boundAt, sid })
    // 座号也认数字字符串
    expect(await join(c, h, '3')).toMatchObject({ status: 201, body: { seat: 3 } })
  })

  it('座号被占 409（带 taken）；不在名单、格式不对 400；都不建绑定', async () => {
    const before = stored(c).bindings
    expect(await join(c, h, 2)).toEqual(expect.objectContaining({ status: 409, body: { error: '这个座号已经有人选了。如果是你换了手机，点「用找回码找回」', taken: true } }))
    for (const seat of [5, 0, 100, -1, 1.5, 'x', '', null, undefined, [1], { n: 1 }]) {
      expect(await join(c, h, seat), JSON.stringify(seat)).toMatchObject({ status: 400, body: { error: '没有这个座号' } })
    }
    expect(stored(c).bindings).toEqual(before)
  })

  it('同时选同一个座号只有一个成功，其余 409', async () => {
    const rs = await Promise.all(Array.from({ length: 10 }, () => join(c, h, 4)))
    expect(rs.filter((r) => r.status === 201)).toHaveLength(1)
    expect(rs.filter((r) => r.status === 409)).toHaveLength(9)
    const winner = rs.find((r) => r.status === 201)!.body
    expect(stored(c).bindings[4]).toMatchObject({ sid: winner.sid, tokens: [sha(winner.token)] })
  })

  it('同一个班每小时最多 N 次选座号请求（不管成没成），超了 429；别的班不受影响', async () => {
    const limited = await listen({ joinsPerClassPerHour: 3 })
    const x = await setup(A, [{ n: 1, name: '' }, { n: 2, name: '' }, { n: 3, name: '' }])
    const y = await setup(A, [{ n: 1, name: '' }])
    expect((await join(x.c, x.h, 1, limited)).status).toBe(201)
    expect((await join(x.c, x.h, 1, limited)).status).toBe(409)
    expect((await join(x.c, x.h, 9, limited)).status).toBe(400)
    expect(await join(x.c, x.h, 2, limited)).toMatchObject({ status: 429, body: { error: '现在选座号的人太多了，请稍后再试' } })
    expect(stored(x.c).bindings[2]).toBeUndefined()
    expect((await join(y.c, y.h, 1, limited)).status).toBe(201)
    // 找不到的班不算次数
    for (let i = 0; i < 5; i++) expect((await join('c-000000000000', x.h, 1, limited)).status).toBe(404)
  })
})

describe('找回码', () => {
  it('码对：200 {seat, sid, token}，sid 和选座号时一样，换新 token；不分大小写、可以带空格和 -；每个座号只留最新 5 个 token', async () => {
    const { c, h } = await setup(A)
    const first = (await join(c, h, 1)).body
    const code: string = first.recoveryCode
    const tokens: string[] = [first.token]
    for (const typed of [code, code.toLowerCase(), `${code.slice(0, 3)}-${code.slice(3)}`, ` ${code.slice(0, 2)} ${code.slice(2, 4)}\t${code.slice(4)} `, `${code.slice(0, 3).toLowerCase()} - ${code.slice(3)}`]) {
      const r = await recover(c, h, 1, typed)
      expect(r, typed).toEqual(expect.objectContaining({ status: 200, body: { seat: 1, sid: first.sid, token: expect.stringMatching(/^[0-9a-f]{64}$/) } }))
      tokens.push(r.body.token)
    }
    expect(new Set(tokens).size).toBe(6)
    expect(stored(c).bindings[1]).toMatchObject({ sid: first.sid, recoveryHash: sha(code), tokens: tokens.slice(-5).map(sha) })
    expect((await progress(h, c, tokens[0])).status).toBe(401) // 最早的设备挤掉了
    for (const t of tokens.slice(1)) expect((await progress(h, c, t)).status).toBe(200)
    expect(fs.readFileSync(classesFile, 'utf8')).not.toContain(tokens[5])
  })

  it('码错 403；没带码 403；座号还没人选 400；不在名单 400', async () => {
    const { c, h } = await setup(A)
    const first = (await join(c, h, 1)).body
    const WRONG = { status: 403, body: { error: '找回码不对。找不到找回码的话，请老师在老师端给你重置' } }
    expect(await recover(c, h, 1, wrongCode(first.recoveryCode))).toMatchObject(WRONG)
    expect(await recover(c, h, 1, undefined)).toMatchObject(WRONG)
    expect(await recover(c, h, 2, first.recoveryCode)).toMatchObject({ status: 400, body: { error: '这个座号还没有人选，直接选座号就行' } })
    expect(await recover(c, h, 7, first.recoveryCode)).toMatchObject({ status: 400, body: { error: '没有这个座号' } })
    expect(stored(c).bindings[1].tokens).toEqual([sha(first.token)])
  })

  it('同一个座号 15 分钟内失败 5 次就 429（码对也不行），并发请求绕不过去；别的座号不受影响；老师重置找回码后清零，旧码不行、新码行，已经进来的设备照常能用', async () => {
    const { c, h } = await setup(A)
    const s1 = (await join(c, h, 1)).body
    const s2 = (await join(c, h, 2)).body
    const rs = await Promise.all(Array.from({ length: 12 }, () => recover(c, h, 1, wrongCode(s1.recoveryCode))))
    expect(rs.filter((r) => r.status === 403)).toHaveLength(5)
    expect(rs.filter((r) => r.status === 429)).toHaveLength(7)
    const LOCKED = { status: 429, body: { error: '试错太多次了，请 15 分钟后再试，或者请老师给你重置找回码' } }
    expect(await recover(c, h, 1, s1.recoveryCode)).toMatchObject(LOCKED)
    expect((await recover(c, h, 2, s2.recoveryCode)).status).toBe(200)

    const reset = await call(app, 'POST', `/api/classes/${c}/seats/1/reset-code`, {}, A.cookie)
    expect(reset).toMatchObject({ status: 200, body: { recoveryCode: expect.stringMatching(CODE) } })
    const fresh: string = reset.body.recoveryCode
    secrets.push(fresh)
    expect(Object.keys(reset.body)).toEqual(['recoveryCode'])
    expect(stored(c).bindings[1]).toMatchObject({ sid: s1.sid, recoveryHash: sha(fresh), tokens: [sha(s1.token)] })
    expect(fs.readFileSync(classesFile, 'utf8')).not.toContain(`"${fresh}"`)
    if (fresh !== s1.recoveryCode) expect((await recover(c, h, 1, s1.recoveryCode)).status).toBe(403)
    expect(await recover(c, h, 1, fresh.toLowerCase())).toMatchObject({ status: 200, body: { seat: 1, sid: s1.sid } })
    expect((await progress(h, c, s1.token)).status).toBe(200)
    // 还没人选、不在名单的座号不能重置
    expect(await call(app, 'POST', `/api/classes/${c}/seats/3/reset-code`, {}, A.cookie)).toMatchObject({ status: 400, body: { error: '这个座号还没有学生进来' } })
    for (const n of ['9', '0', 'x']) expect(await call(app, 'POST', `/api/classes/${c}/seats/${n}/reset-code`, {}, A.cookie)).toMatchObject({ status: 400, body: { error: '没有这个座号' } })
  })

  it('同一个班 15 分钟内失败 30 次就整个班 429；老师重置找回码的座号不受整个班这层限制（照旧按座号限 5 次），别的座号还是 429', async () => {
    const roster = Array.from({ length: 8 }, (_, i) => ({ n: i + 1, name: '' }))
    const { c, h } = await setup(A, roster)
    const codes: string[] = []
    const sids: string[] = []
    for (const s of roster) {
      const r = (await join(c, h, s.n)).body
      codes.push(r.recoveryCode)
      sids.push(r.sid)
    }
    for (let n = 1; n <= 6; n++) for (let i = 0; i < 5; i++) expect((await recover(c, h, n, wrongCode(codes[n - 1]))).status).toBe(403)
    const LOCKED = { status: 429, body: { error: '试错太多次了，请 15 分钟后再试，或者请老师给你重置找回码' } }
    expect(await recover(c, h, 7, codes[6])).toMatchObject(LOCKED)

    const reset = await call(app, 'POST', `/api/classes/${c}/seats/7/reset-code`, {}, A.cookie)
    expect(reset.status).toBe(200)
    const fresh: string = reset.body.recoveryCode
    secrets.push(fresh)
    expect(await recover(c, h, 7, fresh)).toMatchObject({ status: 200, body: { seat: 7, sid: sids[6] } })
    expect(await recover(c, h, 8, codes[7])).toMatchObject(LOCKED) // 没重置的座号还锁着

    // 重置过的座号照旧按座号限 5 次：并发也绕不过去
    const again = (await call(app, 'POST', `/api/classes/${c}/seats/7/reset-code`, {}, A.cookie)).body.recoveryCode as string
    secrets.push(again)
    const rs = await Promise.all(Array.from({ length: 8 }, () => recover(c, h, 7, wrongCode(again))))
    expect(rs.filter((r) => r.status === 403)).toHaveLength(5)
    expect(rs.filter((r) => r.status === 429)).toHaveLength(3)
    expect(await recover(c, h, 7, again)).toMatchObject(LOCKED)
  })

  it('码对了的找回同一个座号每小时最多 10 次（并发也一样），超了 429、不改文件；别的座号不受影响', async () => {
    const { c, h } = await setup(A)
    const s1 = (await join(c, h, 1)).body
    const s2 = (await join(c, h, 2)).body
    const rs = await Promise.all(Array.from({ length: 14 }, () => recover(c, h, 1, s1.recoveryCode)))
    expect(rs.filter((r) => r.status === 200)).toHaveLength(10)
    expect(rs.filter((r) => r.status === 429)).toHaveLength(4)
    for (const r of rs.filter((x) => x.status === 429)) expect(r.body).toEqual({ error: '找回太频繁了，请过一会儿再试' })
    const before = fs.readFileSync(classesFile, 'utf8')
    expect((await recover(c, h, 1, s1.recoveryCode)).status).toBe(429)
    expect(fs.readFileSync(classesFile, 'utf8')).toBe(before)
    expect(stored(c).bindings[1].tokens).toHaveLength(5)
    expect((await recover(c, h, 2, s2.recoveryCode)).status).toBe(200)
  })

  it('老师清空座号：找回 400，旧设备的 token 不能用了；座号空出来，重新选是新的 sid；还没人选的座号清空也 200，不在名单 400', async () => {
    const { c, h } = await setup(A)
    const s1 = (await join(c, h, 1)).body
    expect(await call(app, 'POST', `/api/classes/${c}/seats/1/clear`, {}, A.cookie)).toMatchObject({ status: 200, body: { ok: true } })
    expect(stored(c).bindings).toEqual({})
    expect(await recover(c, h, 1, s1.recoveryCode)).toMatchObject({ status: 400, body: { error: '这个座号还没有人选，直接选座号就行' } })
    expect((await progress(h, c, s1.token)).status).toBe(401)
    expect((await call(app, 'GET', `/api/join/${c}?h=${h}`)).body.seats[0]).toEqual({ n: 1, taken: false })
    const again = (await join(c, h, 1)).body
    expect(again.sid).not.toBe(s1.sid)
    expect((await detail(c)).seats[0]).toMatchObject({ n: 1, joined: true, sid: again.sid })
    expect(await call(app, 'POST', `/api/classes/${c}/seats/2/clear`, {}, A.cookie)).toMatchObject({ status: 200, body: { ok: true } })
    expect(await call(app, 'POST', `/api/classes/${c}/seats/9/clear`, {}, A.cookie)).toMatchObject({ status: 400, body: { error: '没有这个座号' } })
    expect(stored(c).bindings[1].sid).toBe(again.sid)
  })
})

describe('拿回自己的作答', () => {
  it('my-progress：只返回自己 sid 在这份讲义里的事件；token 不对、格式不对、没带、别的班的都 401；不缓存', async () => {
    const { c, h } = await setup(A)
    const h2 = await upload(A, 'Second')
    await publish(A, h2, [c])
    const other = await setup(A)
    const s1 = (await join(c, h, 1)).body
    const s2 = (await join(c, h, 2)).body
    const elsewhere = (await join(other.c, other.h, 1)).body
    const ev = (sid: string, handoutId: string, ts: number) => ({ sid, handoutId, type: 'tap_word', ts, lemma: 'pending' })
    await call(app, 'POST', '/api/events', [ev(s1.sid, h, 1), ev(s2.sid, h, 2), ev(s1.sid, h, 3), ev(s1.sid, h2, 4), ev('anon-sid', h, 5)])
    const r = await progress(h, c, s1.token)
    expect(r.status).toBe(200)
    expect(r.headers['cache-control']).toBe('no-store')
    expect(r.body).toEqual({ events: [ev(s1.sid, h, 1), ev(s1.sid, h, 3)] })
    expect((await progress(h2, c, s1.token)).body).toEqual({ events: [ev(s1.sid, h2, 4)] })
    expect((await progress(h, c, s2.token)).body).toEqual({ events: [ev(s2.sid, h, 2)] })
    const LOST = { status: 401, body: { error: '找不到你的座号记录，请重新扫码' } }
    for (const t of [undefined, '', 'abc', 'a'.repeat(64), s1.token.toUpperCase(), sha(s1.token), elsewhere.token]) expect(await progress(h, c, t), String(t)).toMatchObject(LOST)
    // 恢复后的新设备也能拿回
    const back = (await recover(c, h, 1, s1.recoveryCode)).body
    expect((await progress(h, c, back.token)).body.events).toHaveLength(2)
  })
})

describe('老师按班看学习记录', () => {
  it('要带 classId：缺失、不是这份讲义发布到的班、不是自己的班都 400；只返回这个班已选座号的 sid 的事件；没登录、别的老师照旧 401、403', async () => {
    const h = await upload(A, 'By class')
    const c1 = (await newClass(A, { name: '一班' })).body.class.id
    const c2 = (await newClass(A, { name: '二班' })).body.class.id
    const c3 = (await newClass(A, { name: '三班' })).body.class.id
    const cb = (await newClass(B)).body.class.id
    await publish(A, h, [c1, c2])
    const a = (await join(c1, h, 1)).body
    const b = (await join(c2, h, 1)).body
    const ev = (sid: string, ts: number) => ({ sid, handoutId: h, type: 'tap_word', ts })
    await call(app, 'POST', '/api/events', [ev(a.sid, 1), ev(b.sid, 2), ev('anon-sid', 3), ev(a.sid, 4)])
    const read = (q: string, who: Who | null = A) => call(app, 'GET', `/api/events?handoutId=${h}${q}`, undefined, who?.cookie)
    const PICK = { status: 400, body: { ok: false, error: '请选一个班' } }
    for (const q of ['', `&classId=${c3}`, `&classId=${cb}`, '&classId=nope', `&classId=${c1}&classId=${c2}`]) expect(await read(q), q).toMatchObject(PICK)
    expect(await read(`&classId=${c1}`)).toMatchObject({ status: 200, body: [ev(a.sid, 1), ev(a.sid, 4)] })
    expect((await read(`&classId=${c1}&since=1`)).body).toEqual([ev(a.sid, 4)])
    expect((await read(`&classId=${c2}`)).body).toEqual([ev(b.sid, 2)])
    expect(await read(`&classId=${c1}`, null)).toMatchObject({ status: 401, body: { ok: false, error: '请先登录' } })
    expect(await read(`&classId=${c1}`, B)).toMatchObject({ status: 403, body: { ok: false, error: '只有上传这篇文章的老师能看全班的学习记录' } })
    expect(await call(app, 'GET', `/api/events?handoutId=mini-phones&classId=${c1}`, undefined, A.cookie)).toMatchObject({ status: 403 })
  })

  it('删除班级：名单和座号绑定一起删，学生接口一律 404，老师读这个班的记录 400；别的班不受影响', async () => {
    const { c, h } = await setup(A, [{ n: 1, name: '要删的名字' }, { n: 2, name: '另一个名字' }])
    const other = (await newClass(A, { name: '留着的班' })).body.class.id
    await publish(A, h, [c, other])
    const s1 = (await join(c, h, 1)).body
    const kept = (await join(other, h, 1)).body
    expect(await call(app, 'POST', `/api/classes/${c}/delete`, {}, A.cookie)).toMatchObject({ status: 200, body: { ok: true } })
    const file = fs.readFileSync(classesFile, 'utf8')
    for (const leak of [c, '要删的名字', '另一个名字', s1.sid, sha(s1.token)]) expect(file).not.toContain(leak)
    expect(await call(app, 'GET', `/api/join/${c}?h=${h}`)).toMatchObject({ status: 404, body: NO_CLASS })
    expect(await join(c, h, 2)).toMatchObject({ status: 404, body: NO_CLASS })
    expect(await recover(c, h, 1, s1.recoveryCode)).toMatchObject({ status: 404, body: NO_CLASS })
    expect(await progress(h, c, s1.token)).toMatchObject({ status: 404, body: NO_CLASS })
    expect((await call(app, 'GET', `/api/classes/${c}`, undefined, A.cookie)).status).toBe(404)
    expect((await call(app, 'POST', `/api/classes/${c}/delete`, {}, A.cookie)).status).toBe(404)
    expect((await call(app, 'GET', `/api/events?handoutId=${h}&classId=${c}`, undefined, A.cookie)).status).toBe(400)
    expect((await progress(h, other, kept.token)).status).toBe(200)
    expect((await call(app, 'GET', `/api/events?handoutId=${h}&classId=${other}`, undefined, A.cookie)).status).toBe(200)
  })
})

describe('请求格式和日志', () => {
  it('改东西的 POST 不是 JSON 一律 415，不处理', async () => {
    const { c, h } = await setup(A)
    const urls = ['/api/classes', `/api/classes/${c}`, `/api/classes/${c}/delete`, `/api/classes/${c}/seats/1/reset-code`, `/api/classes/${c}/seats/1/clear`, `/api/join/${c}`, `/api/join/${c}/recover`]
    for (const url of urls) {
      const r = await call(app, 'POST', url, `h=${h}&seat=1&name=x`, A.cookie, { 'content-type': 'application/x-www-form-urlencoded' })
      expect({ status: r.status, body: r.body }, url).toEqual({ status: 415, body: { error: '请求格式不对' } })
    }
    expect(stored(c)).toMatchObject({ name: '高一 3 班', bindings: {} })
  })

  it('日志只有请求序号、路径、状态码、耗时：没有姓名、找回码、token、sid', () => {
    const text = logs.join('\n')
    expect(logs.some((l) => / POST \/api\/join\/c-[0-9a-f]{12}\/recover (200|403|429) /.test(l))).toBe(true)
    expect(secrets.length).toBeGreaterThan(50)
    for (const leak of [...NAMES, '要删的名字', ...secrets]) expect(text).not.toContain(leak)
  })
})
