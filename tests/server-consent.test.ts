// 隐私前提四项（后端）：没选座号的学生学习事件不进服务器、写作不发给模型；老师按座号关 AI 写作检查；
// 座号的进班记录删掉时学习记录一起删；到期自动清理。请求用 node:http 发（同 server-classes.test.ts），模型是本地假的，只数调用次数
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createApp, loadConfig } from '../server/index.mjs'
import type { BuildArticle, ServerConfig } from '../server/index.mjs'

// 仓库没有 @types/express，假 LLM 用 require 拿到无类型的 express
const express = createRequire(import.meta.url)('express')

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zhishi-consent-'))
const logs: string[] = []
const INVITES = Array.from({ length: 30 }, (_, i) => `invite-consent-${String(i).padStart(4, '0')}`)
let nextInvite = 0
const DAY = 24 * 3600 * 1000
const classesFile = path.join(dataDir, 'classes.json')
const readJson = (f: string) => JSON.parse(fs.readFileSync(f, 'utf8'))
const stored = (id: string) => readJson(classesFile).classes.find((c: { id: string }) => c.id === id)
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const TEXT = 'Many schools are toying with the idea of banning phones in class. '.repeat(5).trim()
const build: BuildArticle = async (input, opts) => ({ handout: { id: opts.id, title: input.title }, report: { errors: 0 } })
const ROSTER = [{ n: 1, name: '张三' }, { n: 2, name: '李四' }, { n: 3, name: '王五' }]

// DATA_DIR 里的文件：lines 解析每行（文件不在是 []），rawLines 原样
const file = (name: string, dir = dataDir) => path.join(dir, name)
const rawLines = (name: string, dir = dataDir) => (fs.existsSync(file(name, dir)) ? fs.readFileSync(file(name, dir), 'utf8').split('\n').filter(Boolean) : [])
const lines = (name: string, dir = dataDir) => rawLines(name, dir).map((l) => JSON.parse(l))
const writeLines = (name: string, rows: unknown[], dir = dataDir) => fs.writeFileSync(file(name, dir), rows.map((r) => (typeof r === 'string' ? r : JSON.stringify(r)) + '\n').join(''))
const ev = (sid: string, handoutId: string, ts: number, type = 'tap_word') => ({ sid, handoutId, type, ts })

let llmCalls = 0
let llmBase = ''

type App = { server: Server; port: number }
type Res = { status: number; body: any; headers: http.IncomingHttpHeaders }
const open: { server: Server }[] = []
function listen(config: Partial<ServerConfig> = {}) {
  return new Promise<App>((resolve) => {
    const server = createApp({ dataDir, apiKey: 'sk-test-not-a-real-key', llmBaseUrl: `${llmBase}/v1`, llmTimeoutMs: 2000, writingPerSidPerHour: 1000, writingPerDay: 1000, uploadInvites: INVITES, authPerMinute: 1000, uploadsPerTeacherPerHour: 1000, uploadsPerDay: 1000, buildArticle: build, log: (l: string) => logs.push(l), ...config }).listen(0, '127.0.0.1', () => {
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

const CONFIRM = { school: true, consent: true } // 建班、换名单时老师勾的两项确认
const newClass = (who: Who, o: Record<string, unknown> = {}) => call(app, 'POST', '/api/classes', { name: '高一 3 班', roster: ROSTER, confirm: CONFIRM, ...o }, who.cookie)
const publish = (who: Who, h: string, classes: unknown) => call(app, 'POST', `/api/handouts/${h}/publish`, { classes }, who.cookie)
const join = (c: string, h: string, seat: unknown) => call(app, 'POST', `/api/join/${c}`, { h, seat, confirm: true })
const recover = (c: string, h: string, seat: unknown, code: unknown) => call(app, 'POST', `/api/join/${c}/recover`, { h, seat, code })
const progress = (h: string, c: string, token: string) => call(app, 'GET', `/api/my-progress?h=${h}&c=${c}`, undefined, undefined, { 'x-student-token': token })
const detail = async (c: string, who: Who) => (await call(app, 'GET', `/api/classes/${c}`, undefined, who.cookie)).body.class
const send = (events: unknown, a = app) => call(a, 'POST', '/api/events', events)
const setAi = (who: Who, c: string, n: unknown, enabled: unknown) => call(app, 'POST', `/api/classes/${c}/seats/${n}/ai`, { enabled }, who.cookie)
const clear = (who: Who, c: string, n: number) => call(app, 'POST', `/api/classes/${c}/seats/${n}/clear`, {}, who.cookie)
// 建一个班（1–3 号）、上传一份讲义、发布到这个班
async function setup(who: Who) {
  const c = (await newClass(who)).body.class.id as string
  const h = await upload(who)
  expect((await publish(who, h, [c])).status).toBe(200)
  return { c, h }
}
// 一个班、两份都发布到这个班的讲义；1 号、2 号已选座号
async function twoHandouts(who: Who) {
  const { c, h: h1 } = await setup(who)
  const h2 = await upload(who)
  expect((await publish(who, h2, [c])).status).toBe(200)
  const s1 = (await join(c, h1, 1)).body
  const s2 = (await join(c, h1, 2)).body
  return { c, h1, h2, s1, s2 }
}

let app: App
beforeAll(async () => {
  const fake = express()
  fake.post('/v1/chat/completions', express.json(), (_req: any, res: any) => {
    llmCalls++
    res.json({ model: 'fake-model', choices: [{ message: { content: JSON.stringify({ results: [{ id: 'E1', used: true, verdict: 'correct', reason: '用对了。' }], grammar: [] }) } }] })
  })
  const llm = await new Promise<Server>((resolve) => {
    const s = fake.listen(0, '127.0.0.1', () => resolve(s))
  })
  open.push({ server: llm })
  llmBase = `http://127.0.0.1:${(llm.address() as AddressInfo).port}`
  app = await listen()
})
afterAll(() => {
  for (const a of open) a.server.close()
})

describe('没选座号的学生：学习事件不进服务器', () => {
  it('没绑定座号的 sid：学习事件和 page_view 200 但不写盘（accepted 只算写进去的），client_error 照写；绑定的 sid 照写', async () => {
    const T = await register('ev.anon')
    const { c, h } = await setup(T)
    const s = (await join(c, h, 1)).body
    const r = await send([ev('anon-sid', h, 1), ev('anon-sid', h, 2, 'page_view'), ev('dev-abc12345', h, 3, 'answer_question'), ev('demo-a', h, 4, 'writing_submit'), ev('anon-sid', h, 5, 'client_error'), ev(s.sid, h, 6), ev(s.sid, h, 7, 'page_view')])
    expect(r).toMatchObject({ status: 200, body: { ok: true, accepted: 3 } })
    expect(lines(`events-${h}.jsonl`)).toEqual([ev('anon-sid', h, 5, 'client_error'), ev(s.sid, h, 6), ev(s.sid, h, 7, 'page_view')])
    // 一条都不留：照样 200，不建文件
    const h2 = await upload(T)
    await publish(T, h2, [c])
    expect(await send([ev('anon-sid', h2, 1), ev('anon-sid', h2, 2, 'page_view')])).toMatchObject({ status: 200, body: { ok: true, accepted: 0 } })
    expect(fs.existsSync(file(`events-${h2}.jsonl`))).toBe(false)
  })

  it('内置讲义（不是 up- 开头）的学习事件一律不写，选了座号的 sid 也不行；页面报错照写', async () => {
    const T = await register('ev.builtin')
    const { c, h } = await setup(T)
    const s = (await join(c, h, 1)).body
    const r = await send([ev(s.sid, 'mini-phones', 1), ev(s.sid, 'mini-phones', 2, 'page_view'), ev('anon-sid', 'mini-phones', 3, 'client_error')])
    expect(r.body).toEqual({ ok: true, accepted: 1 })
    expect(lines('events-mini-phones.jsonl')).toEqual([ev('anon-sid', 'mini-phones', 3, 'client_error')])
  })

  it('讲义不再发布到这个班、讲义改成没发布、班级和讲义不是同一位老师的：都不写', async () => {
    const T = await register('ev.target')
    const U = await register('ev.target.u')
    const { c, h } = await setup(T)
    const s = (await join(c, h, 1)).body
    expect((await send(ev(s.sid, h, 1))).body.accepted).toBe(1)
    // 改发布到别的班：这个班的座号不算了
    const c2 = (await newClass(T, { name: '别的班' })).body.class.id
    await publish(T, h, [c2])
    expect((await send(ev(s.sid, h, 2))).body).toEqual({ ok: true, accepted: 0 })
    // meta 改成没发布（班级还在 meta.classes 里）
    const h2 = await upload(T)
    await publish(T, h2, [c])
    const metaPath = path.join(dataDir, 'handouts', `${h2}.meta.json`)
    fs.writeFileSync(metaPath, JSON.stringify({ ...readJson(metaPath), published: false }))
    expect((await send(ev(s.sid, h2, 3))).body.accepted).toBe(0)
    // U 的班里选了座号的学生，T 的讲义 meta 硬写上 U 的班（正常发布不了）：老师不是同一位，不写；发给 U 自己讲义的照写
    const u = await setup(U)
    const su = (await join(u.c, u.h, 1)).body
    const forged = await upload(T)
    const forgedMeta = path.join(dataDir, 'handouts', `${forged}.meta.json`)
    fs.writeFileSync(forgedMeta, JSON.stringify({ ...readJson(forgedMeta), published: true, classes: [u.c] }))
    expect((await send([ev(su.sid, forged, 4), ev(su.sid, u.h, 5)])).body.accepted).toBe(1)
    expect(lines(`events-${h}.jsonl`)).toEqual([ev(s.sid, h, 1)])
    expect(fs.existsSync(file(`events-${h2}.jsonl`))).toBe(false)
    expect(fs.existsSync(file(`events-${forged}.jsonl`))).toBe(false)
    expect(lines(`events-${u.h}.jsonl`)).toEqual([ev(su.sid, u.h, 5)])
  })
})

describe('AI 写作检查只给选了座号、座号开着 AI 的学生', () => {
  const NO_SEAT = { fallback: true, results: [], error: '没有选座号时不用 AI 检查' }
  const OFF = { fallback: true, results: [], error: '老师关闭了这个座号的 AI 检查' }
  const check = (a: App, o: Record<string, unknown>) =>
    call(a, 'POST', '/api/writing-check', { text: 'I am toying with the idea of a trip.', expressions: [{ id: 'E1', text: 'toy with the idea', zh: '考虑', example: 'Schools are toying with the idea.' }], ...o })

  it('没带 sid、没绑定的 sid、内置讲义、讲义没发给这个班：403，不调用模型、不算次数；选了座号的照常', async () => {
    const limited = await listen({ writingPerSidPerHour: 1, writingPerDay: 1 })
    const T = await register('ai.noseat')
    const { c, h } = await setup(T)
    const other = await setup(T) // 别的班和讲义：s 不在那个班
    const s = (await join(c, h, 1)).body
    const before = llmCalls
    const cases: Record<string, unknown>[] = [{ handoutId: h }, { handoutId: h, sid: 'anon-sid' }, { handoutId: h, sid: '' }, { handoutId: h, sid: 42 }, { handoutId: 'mini-phones', sid: s.sid }, { handoutId: other.h, sid: s.sid }, { handoutId: 'up-missing', sid: s.sid }]
    for (const o of cases) {
      const r = await check(limited, o)
      expect({ status: r.status, body: r.body }, JSON.stringify(o)).toEqual({ status: 403, body: NO_SEAT })
    }
    expect(llmCalls).toBe(before)
    // 403 不算次数：每人每小时 1 次、全站每天 1 次，选了座号的第一次照常
    expect(await check(limited, { handoutId: h, sid: s.sid })).toMatchObject({ status: 200, body: { fallback: false, model: 'fake-model' } })
    expect(llmCalls).toBe(before + 1)
    expect((await check(limited, { handoutId: h, sid: s.sid })).status).toBe(429)
  })

  it('老师关了这个座号的 AI：403「老师关闭了这个座号的 AI 检查」，不调用模型、不算次数；别的座号照常；再打开就照常', async () => {
    const limited = await listen({ writingPerSidPerHour: 1, writingPerDay: 100 })
    const T = await register('ai.off')
    const { c, h } = await setup(T)
    const s1 = (await join(c, h, 1)).body
    const s2 = (await join(c, h, 2)).body
    expect(await setAi(T, c, 1, false)).toMatchObject({ status: 200, body: { ok: true, n: 1, ai: false } })
    const before = llmCalls
    for (let i = 0; i < 3; i++) {
      const r = await check(limited, { handoutId: h, sid: s1.sid })
      expect({ status: r.status, body: r.body }).toEqual({ status: 403, body: OFF })
    }
    expect(llmCalls).toBe(before)
    expect((await check(limited, { handoutId: h, sid: s2.sid })).status).toBe(200)
    expect(await setAi(T, c, 1, true)).toMatchObject({ status: 200, body: { ok: true, n: 1, ai: true } })
    expect((await check(limited, { handoutId: h, sid: s1.sid })).body.fallback).toBe(false)
    expect((await check(limited, { handoutId: h, sid: s1.sid })).status).toBe(429)
    expect(llmCalls).toBe(before + 2)
  })
})

describe('老师按座号关 AI 写作检查', () => {
  it('开关接口：没登录 401，别的老师 403，班级不存在 404，座号不在名单 400，enabled 不是布尔 400，不是 JSON 415；都不改文件', async () => {
    const T = await register('ai.perm')
    const U = await register('ai.perm.u')
    const c = (await newClass(T)).body.class.id
    const before = fs.readFileSync(classesFile, 'utf8')
    const url = `/api/classes/${c}/seats/1/ai`
    expect(await call(app, 'POST', url, { enabled: false })).toMatchObject({ status: 401, body: { error: '请先登录' } })
    expect(await setAi(U, c, 1, false)).toMatchObject({ status: 403, body: { error: '这个班不是你建的' } })
    for (const id of ['c-000000000000', 'nope']) expect(await setAi(T, id, 1, false), id).toMatchObject({ status: 404, body: { error: '没有这个班' } })
    for (const n of ['9', '0', 'x', '100']) expect(await setAi(T, c, n, false), n).toMatchObject({ status: 400, body: { error: '没有这个座号' } })
    for (const enabled of [undefined, 'false', 0, 1, null]) expect(await setAi(T, c, 1, enabled), String(enabled)).toMatchObject({ status: 400, body: { error: 'AI 开关的格式不对，请刷新页面后再试' } })
    const form = await call(app, 'POST', url, 'enabled=false', T.cookie, { 'content-type': 'application/x-www-form-urlencoded' })
    expect({ status: form.status, body: form.body }).toEqual({ status: 415, body: { error: '请求格式不对' } })
    expect(fs.readFileSync(classesFile, 'utf8')).toBe(before)
  })

  it('关掉记在名单的座号上（noAi），还没进班也能先关；详情、选座号、找回、my-progress 都带 ai；清空座号、重新进班不变；换名单留下的座号沿用，新座号开着；再打开去掉 noAi', async () => {
    const T = await register('ai.flow')
    const { c, h } = await setup(T)
    expect(await setAi(T, c, '2', false)).toMatchObject({ status: 200, body: { ok: true, n: 2, ai: false } })
    expect(stored(c).seats).toEqual([{ n: 1, name: '张三' }, { n: 2, name: '李四', noAi: true }, { n: 3, name: '王五' }])
    expect((await detail(c, T)).seats.map((s: { ai: boolean }) => s.ai)).toEqual([true, false, true])
    const j2 = (await join(c, h, 2)).body
    expect(j2.ai).toBe(false)
    expect((await join(c, h, 1)).body.ai).toBe(true)
    expect(await recover(c, h, 2, j2.recoveryCode)).toMatchObject({ status: 200, body: { seat: 2, ai: false } })
    expect((await progress(h, c, j2.token)).body).toEqual({ events: [], ai: false })
    // 清空座号、重新选：还是关着
    expect((await clear(T, c, 2)).status).toBe(200)
    expect(stored(c).seats[1]).toEqual({ n: 2, name: '李四', noAi: true })
    const again = (await join(c, h, 2)).body
    expect(again.ai).toBe(false)
    // 换名单：留下的 2 号还关着，新的 5 号开着；名单里传 noAi 也不认
    const r = await call(app, 'POST', `/api/classes/${c}`, { roster: [{ n: 2, name: '李四' }, { n: 5, name: '', noAi: true }], confirm: CONFIRM }, T.cookie)
    expect(r.status).toBe(200)
    expect(r.body.class.seats).toEqual([expect.objectContaining({ n: 2, joined: true, ai: false }), { n: 5, name: '', joined: false, ai: true }])
    expect(stored(c).seats).toEqual([{ n: 2, name: '李四', noAi: true }, { n: 5, name: '' }])
    // 再打开
    expect(await setAi(T, c, 2, true)).toMatchObject({ status: 200, body: { ok: true, n: 2, ai: true } })
    expect(stored(c).seats[0]).toEqual({ n: 2, name: '李四' })
    expect((await progress(h, c, again.token)).body.ai).toBe(true)
    expect(await setAi(T, c, 2, true)).toMatchObject({ status: 200, body: { ai: true } }) // 本来就开着也是 200
  })
})

describe('座号的进班记录删掉时，学习记录一起删', () => {
  it('清空座号：这个 sid 在所有讲义的事件文件、存档、.bak 里都删掉，别的 sid、解析不了的行、别的文件不动；删空的文件删掉；响应带 deletedEvents，日志只记条数', async () => {
    const T = await register('del.clear')
    const { c, h1, h2, s1, s2 } = await twoHandouts(T)
    await send([ev(s1.sid, h1, 1), ev(s2.sid, h1, 2), ev(s1.sid, h1, 3)])
    await send([ev(s1.sid, h2, 4), ev(s2.sid, h2, 5)])
    // deploy/archive-events.sh、archive-sessions.sh 留下的存档和备份；near 只比 s1 多一个字符，不算
    const arc = `events-${h1}.archive-20261001-120000.jsonl`
    const bak = `events-${h2}.bak-20261001-120000.jsonl`
    const only = `events-${h2}.archive-sessions-20261001-120000.jsonl`
    const near = `${s1.sid}0`
    writeLines(arc, [ev(s1.sid, h1, 6), '{broken', ev(near, h1, 7), ev(s2.sid, h1, 8)])
    writeLines(bak, [ev(s2.sid, h2, 9), ev(s1.sid, h2, 10)])
    writeLines(only, [ev(s1.sid, h2, 11), ev(s1.sid, h2, 12)])
    writeLines(`other-${h1}.jsonl`, [ev(s1.sid, h1, 13)])
    const r = await clear(T, c, 1)
    expect(r).toMatchObject({ status: 200, body: { ok: true, deletedEvents: 7 } })
    expect(lines(`events-${h1}.jsonl`)).toEqual([ev(s2.sid, h1, 2)])
    expect(lines(`events-${h2}.jsonl`)).toEqual([ev(s2.sid, h2, 5)])
    expect(rawLines(arc)).toEqual(['{broken', JSON.stringify(ev(near, h1, 7)), JSON.stringify(ev(s2.sid, h1, 8))])
    expect(lines(bak)).toEqual([ev(s2.sid, h2, 9)])
    expect(fs.existsSync(file(only))).toBe(false)
    expect(lines(`other-${h1}.jsonl`)).toEqual([ev(s1.sid, h1, 13)])
    expect(fs.readdirSync(dataDir).filter((f) => f.endsWith('.tmp'))).toEqual([])
    expect(logs).toContain('events deleted 7 clear')
    expect(logs.join('\n')).not.toContain(s1.sid)
    expect(readJson(classesFile)).not.toHaveProperty('purge') // 全删完：待删列表里去掉了
    expect(fs.readFileSync(classesFile, 'utf8')).not.toContain(s1.sid)
    // 没人选的座号再清空：0 条
    expect((await clear(T, c, 1)).body).toEqual({ ok: true, deletedEvents: 0 })
  })

  it('换名单删掉已进班的座号：这些座号的记录一起删，留下的不动；只改班名、删掉没进班的座号 deletedEvents 是 0', async () => {
    const T = await register('del.roster')
    const { c, h1, h2, s1, s2 } = await twoHandouts(T)
    await send([ev(s1.sid, h1, 1), ev(s2.sid, h1, 2), ev(s1.sid, h2, 3), ev(s2.sid, h2, 4)])
    const r = await call(app, 'POST', `/api/classes/${c}`, { roster: [{ n: 2, name: '李四' }, { n: 3, name: '王五' }], confirm: CONFIRM }, T.cookie)
    expect(r).toMatchObject({ status: 200, body: { deletedEvents: 2, class: { id: c } } })
    expect(lines(`events-${h1}.jsonl`)).toEqual([ev(s2.sid, h1, 2)])
    expect(lines(`events-${h2}.jsonl`)).toEqual([ev(s2.sid, h2, 4)])
    expect(logs).toContain('events deleted 2 roster')
    expect((await call(app, 'POST', `/api/classes/${c}`, { name: '新班名' }, T.cookie)).body).toMatchObject({ deletedEvents: 0, class: { name: '新班名' } })
    expect((await call(app, 'POST', `/api/classes/${c}`, { roster: [{ n: 2, name: '李四' }], confirm: CONFIRM }, T.cookie)).body.deletedEvents).toBe(0)
    expect(lines(`events-${h1}.jsonl`)).toEqual([ev(s2.sid, h1, 2)])
  })

  it('删除班级：这个班所有已进班座号在所有讲义里的记录都删掉，别的班的不动', async () => {
    const T = await register('del.class')
    const { c, h1, h2, s1, s2 } = await twoHandouts(T)
    const c2 = (await newClass(T, { name: '留着的班' })).body.class.id
    await publish(T, h1, [c, c2])
    const s3 = (await join(c2, h1, 1)).body
    await send([ev(s1.sid, h1, 1), ev(s3.sid, h1, 2), ev(s2.sid, h1, 3), ev(s1.sid, h2, 4), ev(s2.sid, h2, 5)])
    expect(await call(app, 'POST', `/api/classes/${c}/delete`, {}, T.cookie)).toMatchObject({ status: 200, body: { ok: true, deletedEvents: 4 } })
    expect(lines(`events-${h1}.jsonl`)).toEqual([ev(s3.sid, h1, 2)])
    expect(fs.existsSync(file(`events-${h2}.jsonl`))).toBe(false)
    expect(logs).toContain('events deleted 4 class')
  })

  it('删除期间并发追加的事件不丢', async () => {
    const T = await register('del.race')
    const { c, h1, s1, s2 } = await twoHandouts(T)
    fs.appendFileSync(file(`events-${h1}.jsonl`), Array.from({ length: 30000 }, (_, i) => JSON.stringify(ev(s1.sid, h1, i)) + '\n').join(''))
    // 清空座号（改写这个大文件）的同时，2 号不停地发事件，直到清空完成后再多发几批
    let done = false
    const clearing = clear(T, c, 1).then((r) => ((done = true), r))
    const sent: number[] = []
    for (let i = 0; !done || i < 5; i++) {
      const batch = [0, 1, 2].map((j) => ev(s2.sid, h1, 100000 + i * 3 + j))
      sent.push(...batch.map((e) => e.ts))
      const rs = await Promise.all(batch.map((e) => send(e)))
      for (const r of rs) expect(r.body).toEqual({ ok: true, accepted: 1 })
    }
    expect((await clearing).body).toEqual({ ok: true, deletedEvents: 30000 })
    expect(lines(`events-${h1}.jsonl`).map((e) => e.ts).sort((a, b) => a - b)).toEqual(sent)
  })

  it('有一个事件文件改不了（磁盘满、读不了）：别的文件照删，响应带 incomplete，日志只记条数和错误类型；没删完的 sid 记在待删列表里，到期清理不看天数再删，删完从列表去掉', async () => {
    const T = await register('del.fail')
    const { c, h1, h2, s1, s2 } = await twoHandouts(T)
    await send([ev(s1.sid, h1, 1), ev(s2.sid, h1, 2), ev(s1.sid, h2, 3)])
    // 名字像事件文件的目录：读的时候 EISDIR，不管排在哪个文件前面
    const bad = file(`events-${h1}.bak-broken.jsonl`)
    fs.mkdirSync(bad)
    const cleanLogs: string[] = []
    // 共用的 DATA_DIR 里有别的用例留下的旧事件：天数设得很大，只看待删列表
    const other = createApp({ dataDir, cleanupAnonDays: 100000, cleanupCacheDays: 100000, log: (l: string) => cleanLogs.push(l) })
    try {
      expect(await clear(T, c, 1)).toMatchObject({ status: 200, body: { ok: true, deletedEvents: 2, incomplete: true } })
      expect(lines(`events-${h1}.jsonl`)).toEqual([ev(s2.sid, h1, 2)])
      expect(fs.existsSync(file(`events-${h2}.jsonl`))).toBe(false)
      expect(logs).toContain('events deleted 2 clear incomplete EISDIR')
      expect(readJson(classesFile).purge).toEqual([s1.sid])
      expect(stored(c).bindings[1]).toBeUndefined() // 绑定照样删了
      // 删班同样：别的文件照删，sid 加进待删列表
      expect(await call(app, 'POST', `/api/classes/${c}/delete`, {}, T.cookie)).toMatchObject({ status: 200, body: { ok: true, deletedEvents: 1, incomplete: true } })
      expect(fs.existsSync(file(`events-${h1}.jsonl`))).toBe(false)
      expect(readJson(classesFile).purge).toEqual([s1.sid, s2.sid])
      expect(logs.join('\n')).not.toMatch(new RegExp(`${s1.sid}|${s2.sid}`))
      // 这次没删到的记录（比如在改不了的文件里）：到期清理不看天数删掉；那个文件还是改不了，列表留着
      const left = `events-${h2}.archive-left.jsonl`
      writeLines(left, [ev(s1.sid, h2, Date.now()), ev('other-sid', h2, Date.now()), ev(s2.sid, h2, Date.now())])
      expect(await other.cleanup()).toEqual({ files: 1, events: 2, cacheFiles: 0 })
      expect(lines(left).map((e) => e.sid)).toEqual(['other-sid'])
      expect(readJson(classesFile).purge).toEqual([s1.sid, s2.sid])
      expect(cleanLogs).toEqual(['cleanup 1 files 2 events 0 cache files error EISDIR'])
    } finally {
      fs.rmSync(bad, { recursive: true, force: true })
    }
    // 改得了了：下一次清理把列表清掉
    writeLines(`events-${h1}.archive-left.jsonl`, [ev(s2.sid, h1, Date.now())])
    expect(await other.cleanup()).toEqual({ files: 1, events: 1, cacheFiles: 0 })
    expect(readJson(classesFile)).not.toHaveProperty('purge')
    expect(fs.readFileSync(classesFile, 'utf8')).not.toMatch(new RegExp(`${s1.sid}|${s2.sid}`))
    expect(await other.cleanup()).toEqual({ files: 0, events: 0, cacheFiles: 0 })
  })
})

describe('到期清理', () => {
  it('删掉旧的页面报错和旧的没绑定座号的事件，近期的和绑定的保留；删掉旧缓存文件；删空的文件删掉；不动账号、会话、班级、讲义；日志只有个数', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zhishi-cleanup-'))
    const now = Date.now()
    const old = now - 11 * DAY
    const recent = now - 9 * DAY
    const bound = { sid: 'bound-sid', recoveryHash: '0'.repeat(64), tokens: [], boundAt: 1 }
    const keep = { 'classes.json': JSON.stringify({ classes: [{ id: 'c-0123456789ab', owner: 't-1', name: '班', createdAt: '', seats: [{ n: 1, name: '张三' }], bindings: { 1: bound } }] }), 'accounts.json': '{"teachers":[]}', 'sessions.json': '{}' }
    for (const [name, text] of Object.entries(keep)) fs.writeFileSync(file(name, dir), text)
    fs.mkdirSync(file('handouts', dir))
    fs.writeFileSync(file('handouts/up-x.meta.json', dir), '{}')
    for (const f of [...Object.keys(keep), 'handouts/up-x.meta.json']) fs.utimesSync(file(f, dir), new Date(old), new Date(old))
    const main = 'events-up-x.jsonl'
    writeLines(main, [
      ev('anon', 'up-x', old, 'client_error'), // 删
      ev('bound-sid', 'up-x', old, 'client_error'), // 删：页面报错不看绑定
      ev('anon', 'up-x', old), // 删
      ev('bound-sid', 'up-x', old), // 留：绑定在座号上
      ev('anon', 'up-x', recent), // 留：还没到期
      ev('anon', 'up-x', recent, 'client_error'), // 留
      '{broken', // 留
      { sid: 'anon', ts: 'x' }, // 留：ts 不是数字
    ], dir)
    const arc = 'events-mini-phones.archive-20260101-000000.jsonl'
    writeLines(arc, [ev('demo-a', 'mini-phones', old), ev('anon', 'mini-phones', old, 'page_view')], dir) // 全删，文件删掉
    const bak = 'events-up-x.bak-20260101-000000.jsonl'
    writeLines(bak, [ev('anon', 'up-x', old), ev('anon', 'up-x', recent)], dir)
    const untouched = 'events-up-y.jsonl'
    writeLines(untouched, [ev('anon', 'up-y', recent)], dir)
    for (const sub of ['llm-cache', 'advice-cache']) {
      fs.mkdirSync(file(sub, dir))
      for (const [name, age] of [['old.json', 6], ['new.json', 4]] as const) {
        fs.writeFileSync(file(`${sub}/${name}`, dir), '{}')
        fs.utimesSync(file(`${sub}/${name}`, dir), new Date(now - age * DAY), new Date(now - age * DAY))
      }
    }
    const before = Object.fromEntries(Object.keys(keep).map((f) => [f, fs.readFileSync(file(f, dir), 'utf8')]))
    const cleanLogs: string[] = []
    const a = createApp({ dataDir: dir, cleanupAnonDays: 10, cleanupCacheDays: 5, log: (l: string) => cleanLogs.push(l) })

    expect(await a.cleanup()).toEqual({ files: 3, events: 6, cacheFiles: 2 })
    expect(rawLines(main, dir)).toEqual([ev('bound-sid', 'up-x', old), ev('anon', 'up-x', recent), ev('anon', 'up-x', recent, 'client_error'), '{broken', { sid: 'anon', ts: 'x' }].map((r) => (typeof r === 'string' ? r : JSON.stringify(r))))
    expect(fs.existsSync(file(arc, dir))).toBe(false)
    expect(lines(bak, dir)).toEqual([ev('anon', 'up-x', recent)])
    expect(lines(untouched, dir)).toEqual([ev('anon', 'up-y', recent)])
    for (const sub of ['llm-cache', 'advice-cache']) expect(fs.readdirSync(file(sub, dir))).toEqual(['new.json'])
    for (const [f, text] of Object.entries(before)) expect(fs.readFileSync(file(f, dir), 'utf8')).toBe(text)
    expect(fs.existsSync(file('handouts/up-x.meta.json', dir))).toBe(true)
    expect(fs.readdirSync(dir).filter((f) => f.endsWith('.tmp'))).toEqual([])
    expect(cleanLogs).toEqual(['cleanup 3 files 6 events 2 cache files'])
    // 再跑一次没有要删的
    expect(await a.cleanup()).toEqual({ files: 0, events: 0, cacheFiles: 0 })
  })

  it('页面报错的 ts 写盘时不超过收到的时间（手机时间往后调了、伪造的未来时间也按 30 天删）；学习事件的 ts 照存', async () => {
    const T = await register('ev.future')
    const { c, h } = await setup(T)
    const s = (await join(c, h, 1)).body
    const future = 4102444800000 // 2100 年
    const before = Date.now()
    expect(await send([ev('anon-sid', h, future, 'client_error'), ev('anon-sid', h, 5, 'client_error'), ev(s.sid, h, future)])).toMatchObject({ status: 200, body: { ok: true, accepted: 3 } })
    const [late, early, learn] = lines(`events-${h}.jsonl`)
    expect(late.ts).toBeGreaterThanOrEqual(before)
    expect(late.ts).toBeLessThanOrEqual(Date.now())
    expect(early).toEqual(ev('anon-sid', h, 5, 'client_error')) // 过去的时间照存
    expect(learn).toEqual(ev(s.sid, h, future))
  })

  it('createApp 默认不启动定时清理；startCleanup 先跑一次，定时器不挡进程退出', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zhishi-cleanup-timer-'))
    const name = 'events-mini-phones.jsonl'
    writeLines(name, [ev('anon', 'mini-phones', Date.now() - 40 * DAY, 'client_error')], dir)
    const timerLogs: string[] = []
    const a = createApp({ dataDir: dir, log: (l: string) => timerLogs.push(l) })
    await sleep(50)
    expect(rawLines(name, dir)).toHaveLength(1)
    expect(timerLogs.filter((l) => l.startsWith('cleanup'))).toEqual([])
    const timer = a.startCleanup()
    try {
      expect(timer.hasRef()).toBe(false)
      for (let i = 0; i < 100 && fs.existsSync(file(name, dir)); i++) await sleep(10)
      expect(fs.existsSync(file(name, dir))).toBe(false)
      expect(timerLogs).toContain('cleanup 1 files 1 events 0 cache files')
    } finally {
      clearInterval(timer)
    }
  })

  it('配置：默认 30 天、30 天、每 24 小时；CLEANUP_ANON_DAYS、CLEANUP_CACHE_DAYS 可以覆盖，不是正整数就忽略（日志记一行，不记别的）', () => {
    const ENV_FILE = path.join(dataDir, 'missing.env')
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {})
    try {
      expect(loadConfig({ ENV_FILE })).toMatchObject({ cleanupAnonDays: 30, cleanupCacheDays: 30, cleanupIntervalHours: 24 })
      expect(loadConfig({ ENV_FILE, CLEANUP_ANON_DAYS: '7', CLEANUP_CACHE_DAYS: ' 90 ' })).toMatchObject({ cleanupAnonDays: 7, cleanupCacheDays: 90 })
      expect(spy).not.toHaveBeenCalled()
      for (const v of ['0', '-1', 'abc', '1.5', '', '7d']) {
        expect(loadConfig({ ENV_FILE, CLEANUP_ANON_DAYS: v, CLEANUP_CACHE_DAYS: v }), v).toMatchObject({ cleanupAnonDays: 30, cleanupCacheDays: 30 })
      }
      expect(spy).toHaveBeenCalledTimes(12)
      expect(String(spy.mock.calls[0][0])).toBe('CLEANUP_ANON_DAYS 不是正整数，已忽略，用默认的 30 天')
    } finally {
      spy.mockRestore()
    }
  })
})
