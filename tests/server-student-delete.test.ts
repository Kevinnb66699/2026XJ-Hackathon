// 学生账号（内测）的注销、长期没用自动删除、删除台账：POST /api/student/delete、到期清理里的账号部分。
// 照 server-consent.test.ts 删学号记录的写法：请求用 node:http 发，事件文件直接看。删除台账放在 DATA_DIR 外面的另一个临时目录。
// 邀请码文件平时由 scripts/student.mjs 写，这里直接写（码只存 sha256，都是测试用的假码）
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { DELETIONS_FILE, MIN_AGE, STUDENT_INACTIVE_MONTHS, createApp, loadConfig, sidHash } from '../server/index.mjs'
import type { ServerConfig } from '../server/index.mjs'

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zhishi-student-del-'))
const deletionsDir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'zhishi-deletions-')), 'ledger') // 还不存在：createApp 时建
const ledger = path.join(deletionsDir, DELETIONS_FILE)
const logs: string[] = []
const PASSWORD = 'correct-horse-9'
const sha = (s: string) => createHash('sha256').update(s).digest('hex')
const file = (name: string) => path.join(dataDir, name)
const readJson = (name: string) => JSON.parse(fs.readFileSync(file(name), 'utf8'))
const perm = (p: string) => fs.statSync(p).mode & 0o777
const CODES = Array.from({ length: 60 }, (_, i) => `TESTDELETE${String(i).padStart(4, '0')}`)
let nextCode = 0
const BIRTH = `${new Date().getUTCFullYear() - MIN_AGE - 3}-01`
const MONTH = 30 * 24 * 3600 * 1000
const sleep = (ms: number) => new Promise((ok) => setTimeout(ok, ms))

type App = { server: Server; port: number; app: ReturnType<typeof createApp> }
type Res = { status: number; body: any; headers: http.IncomingHttpHeaders }
const open: App[] = []
function listen(config: Partial<ServerConfig> = {}) {
  return new Promise<App>((resolve) => {
    const app = createApp({ dataDir, deletionsDir, authPerMinute: 1000, log: (l: string) => logs.push(l), ...config })
    const server = app.listen(0, '127.0.0.1', () => {
      const a = { server, port: (server.address() as AddressInfo).port, app }
      open.push(a)
      resolve(a)
    })
  })
}
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
const cookieOf = (r: Res) => r.headers['set-cookie']![0].split(';')[0]

let app: App
type Who = { cookie: string; sid: string; code: string; username: string }
async function register(username: string, a = app): Promise<Who> {
  const code = CODES[nextCode++]
  const r = await call(a, 'POST', '/api/student/register', { invite: code, username, password: PASSWORD, birth: BIRTH, agree: true })
  expect(r.status, JSON.stringify(r.body)).toBe(200)
  return { cookie: cookieOf(r), sid: r.body.student.sid, code, username }
}
const me = async (cookie: string) => (await call(app, 'GET', '/api/student/me', undefined, cookie)).body.student
const del = (cookie: string | undefined, body: unknown = { password: PASSWORD }) => call(app, 'POST', '/api/student/delete', body, cookie)
const ev = (sid: string, handoutId: string, ts: number, type = 'tap_word') => ({ sid, handoutId, type, ts })
const send = (cookie: string, list: unknown[]) => call(app, 'POST', '/api/events', list, cookie)
const stored = () => readJson('students.json')
const lines = (name: string) => (fs.existsSync(file(name)) ? fs.readFileSync(file(name), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [])
const ledgerLines = () => (fs.existsSync(ledger) ? fs.readFileSync(ledger, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [])
const today = () => new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10)
// 改 students.json 里某个账号（测长期没用）：服务器按 mtime、inode 重新读
function patchStudent(username: string, patch: Record<string, unknown>) {
  const data = stored()
  fs.writeFileSync(file('students.json.patch'), JSON.stringify({ ...data, students: data.students.map((s: { username: string }) => (s.username === username ? { ...s, ...patch } : s)) }))
  fs.renameSync(file('students.json.patch'), file('students.json'))
}

beforeAll(async () => {
  fs.writeFileSync(file('student-invites.json'), JSON.stringify({ invites: CODES.map((c) => ({ hash: sha(c), batch: 't1', createdAt: '' })) }))
  app = await listen()
})
afterAll(() => {
  for (const a of open) a.server.close()
})

describe('注销 POST /api/student/delete', () => {
  it('密码对了：200 {ok:true}，清掉 cookie；这个账号所有设备的旧 cookie 都不能用；账号、会话、students/<sid>.jsonl、事件文件里这个 sid 的行都删掉，别人的不动', async () => {
    const s = await register('del.ok')
    const t = await register('del.other')
    const phone = cookieOf(await call(app, 'POST', '/api/student/login', { username: 'del.ok', password: PASSWORD }))
    expect((await send(s.cookie, [ev(s.sid, 'up-a', 1), ev(s.sid, 'up-b', 2)])).body).toEqual({ ok: true, accepted: 2 })
    expect((await send(t.cookie, [ev(t.sid, 'up-a', 3)])).body).toEqual({ ok: true, accepted: 1 })
    // 页面报错照旧写进 events-<讲义>.jsonl，带着账号的 sid；存档文件也算
    expect((await send(s.cookie, [ev(s.sid, 'up-a', 4, 'client_error'), ev(t.sid, 'up-a', 5, 'client_error')])).body).toEqual({ ok: true, accepted: 2 })
    fs.writeFileSync(file('events-up-a.archive-20261101-000000.jsonl'), [ev(s.sid, 'up-a', 6, 'client_error'), '{broken'].map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join('\n') + '\n')
    const mine = path.join(dataDir, 'students', `${s.sid}.jsonl`)
    expect(fs.existsSync(mine)).toBe(true)

    const r = await del(s.cookie)
    expect(r).toMatchObject({ status: 200, body: { ok: true } })
    expect(r.body).toEqual({ ok: true })
    expect(r.headers['set-cookie']![0]).toMatch(/^zhishi_student=; Max-Age=0; Path=\/api; HttpOnly/)
    for (const c of [s.cookie, phone]) {
      expect(await me(c)).toBeNull()
      expect((await call(app, 'GET', '/api/student/export', undefined, c)).status).toBe(401)
      expect((await del(c)).status).toBe(401)
    }
    expect(fs.existsSync(mine)).toBe(false)
    expect(lines('events-up-a.jsonl')).toEqual([ev(t.sid, 'up-a', 5, 'client_error')])
    expect(fs.readFileSync(file('events-up-a.archive-20261101-000000.jsonl'), 'utf8')).toBe('{broken\n')
    const data = stored()
    expect(data.students.map((x: { username: string }) => x.username)).not.toContain('del.ok')
    expect(data).not.toHaveProperty('purge') // 全删完：待删列表里去掉了
    expect(JSON.stringify(data)).not.toContain(s.sid)
    expect(data.usedInvites).toContain(sha(s.code)) // 码照样记着用过
    expect(Object.values(readJson('student-sessions.json')).map((x: any) => x.student)).toHaveLength(1) // 只剩 del.other 的
    // 别人的不动
    expect(await me(t.cookie)).toMatchObject({ username: 'del.other' })
    expect(lines(`students/${t.sid}.jsonl`)).toEqual([ev(t.sid, 'up-a', 3)])
    // 日志：原因和条数，没有用户名和 sid
    expect(logs).toContain('student deleted self')
    expect(logs).toContain('events deleted 2 student')
    expect(logs.join('\n')).not.toMatch(new RegExp(`${s.sid}|del\\.ok`))
  })

  it('问卷答案（profile）在账号记录上，注销时跟着账号一起删；别人的不动', async () => {
    const s = await register('del.profile')
    const t = await register('del.profile2')
    for (const w of [s, t]) expect((await call(app, 'PUT', '/api/student/profile', { goal: 'gaokao', grade: '高二' }, w.cookie)).status).toBe(200)
    expect(stored().students.find((x: { username: string }) => x.username === 'del.profile').profile).toEqual({ goal: 'gaokao', grade: '高二' })
    expect((await del(s.cookie)).status).toBe(200)
    expect((await call(app, 'GET', '/api/student/profile', undefined, s.cookie)).status).toBe(401)
    const left = stored().students.filter((x: { profile?: unknown }) => x.profile)
    expect(left.map((x: { username: string }) => x.username)).toEqual(['del.profile2'])
    expect((await call(app, 'GET', '/api/student/profile', undefined, t.cookie)).body.profile).toEqual({ goal: 'gaokao', grade: '高二' })
  })

  it('删除台账：在 DATA_DIR 外面，目录 700、文件 600；一行一个 {sidHash, date}，没有用户名和 sid', async () => {
    const before = ledgerLines().length
    const s = await register('del.ledger')
    expect((await del(s.cookie)).status).toBe(200)
    const added = ledgerLines().slice(before)
    expect(added).toEqual([{ sidHash: sidHash(s.sid), date: today() }])
    expect(sidHash(s.sid)).toBe(sha(s.sid))
    expect(perm(deletionsDir)).toBe(0o700)
    expect(perm(ledger)).toBe(0o600)
    const text = fs.readFileSync(ledger, 'utf8')
    expect(text).not.toMatch(/u-[0-9a-f]{16}|del\./)
    expect(fs.readdirSync(dataDir)).not.toContain(DELETIONS_FILE)
  })

  it('密码不对、没带密码 401「密码不对」，什么都不删、不记台账；没登录、老师的 cookie 401「请先登录」；不是 JSON 415；同一用户名 15 分钟内错 10 次 429（和登录一起算）', async () => {
    const s = await register('del.wrong')
    expect((await send(s.cookie, [ev(s.sid, 'up-a', 1)])).body.accepted).toBe(1)
    const studentsBefore = fs.readFileSync(file('students.json'), 'utf8')
    const sessionsBefore = fs.readFileSync(file('student-sessions.json'), 'utf8')
    const ledgerBefore = ledgerLines().length
    for (const body of [{ password: 'wrong-password' }, {}, { password: 123 }]) expect(await del(s.cookie, body), JSON.stringify(body)).toMatchObject({ status: 401, body: { error: '密码不对' } })
    expect(fs.readFileSync(file('students.json'), 'utf8')).toBe(studentsBefore)
    expect(fs.readFileSync(file('student-sessions.json'), 'utf8')).toBe(sessionsBefore)
    expect(lines(`students/${s.sid}.jsonl`)).toEqual([ev(s.sid, 'up-a', 1)])
    expect(ledgerLines()).toHaveLength(ledgerBefore)
    expect(await me(s.cookie)).toMatchObject({ username: 'del.wrong' })

    expect(await del(undefined)).toMatchObject({ status: 401, body: { error: '请先登录' } })
    // 老师的 cookie：老师和学生互不相认
    const withTeacher = await listen({ uploadInvites: ['invite-teacher-del-1'] })
    const tr = await call(withTeacher, 'POST', '/api/auth/register', { invite: 'invite-teacher-del-1', username: 'del.wrong', password: PASSWORD })
    expect(tr.status).toBe(201)
    const teacher = cookieOf(tr)
    expect(await call(withTeacher, 'POST', '/api/student/delete', { password: PASSWORD }, teacher)).toMatchObject({ status: 401, body: { error: '请先登录' } })
    expect((await call(app, 'POST', '/api/student/delete', `password=${PASSWORD}`, s.cookie, { 'content-type': 'application/x-www-form-urlencoded' })).status).toBe(415)

    for (let i = 3; i < 10; i++) expect((await del(s.cookie, { password: 'wrong-password' })).status, String(i)).toBe(401)
    expect(await del(s.cookie)).toMatchObject({ status: 429, body: { error: '试错太多次了，请 15 分钟后再试' } })
    expect((await call(app, 'POST', '/api/student/login', { username: 'del.wrong', password: PASSWORD })).status).toBe(429)
    expect(await me(s.cookie)).toMatchObject({ username: 'del.wrong' })
  })

  it('并发发错误密码也只放进 10 个（先记失败再跑 scrypt），其余 429；密码对了清零，不影响之后登录', async () => {
    const s = await register('del.burst')
    const rs = await Promise.all(Array.from({ length: 20 }, () => del(s.cookie, { password: 'wrong-password' })))
    const count = (n: number) => rs.filter((r) => r.status === n).length
    expect(count(401)).toBeLessThanOrEqual(10)
    expect(count(401) + count(429)).toBe(20)
    expect(await del(s.cookie)).toMatchObject({ status: 429 })
    expect(await me(s.cookie)).toMatchObject({ username: 'del.burst' })

    // 错几次以后密码对了：失败次数清掉（账号也删了），同名重新注册的能照常登录
    const t = await register('del.burst2')
    for (let i = 0; i < 9; i++) expect((await del(t.cookie, { password: 'wrong-password' })).status).toBe(401)
    expect((await del(t.cookie)).status).toBe(200)
    await register('del.burst2')
    expect((await call(app, 'POST', '/api/student/login', { username: 'del.burst2', password: PASSWORD })).status).toBe(200)
  })

  it('注销后：同一个邀请码再注册 409（码不能再用）；用户名放出来，别人能用新码注册，拿到的是新 sid、看不到旧记录', async () => {
    const s = await register('del.again')
    expect((await send(s.cookie, [ev(s.sid, 'up-a', 1)])).body.accepted).toBe(1)
    expect((await del(s.cookie)).status).toBe(200)
    const again = await call(app, 'POST', '/api/student/register', { invite: s.code, username: 'del.again2', password: PASSWORD, birth: BIRTH, agree: true })
    expect(again).toMatchObject({ status: 409, body: { error: '这个邀请码已经用过了' } })
    const n = await register('del.again')
    expect(n.sid).not.toBe(s.sid)
    expect((await call(app, 'GET', '/api/student/events?h=up-a', undefined, n.cookie)).body).toEqual({ events: [] })
    expect((await call(app, 'POST', '/api/student/login', { username: 'del.again', password: PASSWORD })).status).toBe(200)
  })

  it('注销时有追加写进来：文件不会被写回来；注销以后这个 sid 的事件不认（和没选学号的一样 200、一条不写）', async () => {
    const s = await register('del.race')
    const t = await register('del.race.other')
    fs.mkdirSync(file('students'), { recursive: true })
    // 一个大的事件文件：删诊断事件那一步要改写它，注销拖得久一点
    fs.writeFileSync(file('events-up-big.jsonl'), Array.from({ length: 30000 }, (_, i) => JSON.stringify(ev(t.sid, 'up-big', i, 'client_error')) + '\n').join(''))
    let done = false
    const deleting = del(s.cookie).then((r) => ((done = true), r))
    const statuses = new Set<number>()
    for (let i = 0; !done || i < 5; i++) {
      const rs = await Promise.all([0, 1, 2].map((j) => send(s.cookie, [ev(s.sid, 'up-a', i * 3 + j)])))
      for (const r of rs) statuses.add(r.status)
    }
    expect((await deleting).status).toBe(200)
    expect([...statuses].every((x) => x === 200 || x === 401)).toBe(true)
    expect(fs.existsSync(file(`students/${s.sid}.jsonl`))).toBe(false)
    expect((await send(s.cookie, [ev(s.sid, 'up-a', 99)])).body).toEqual({ ok: true, accepted: 0 })
    expect(fs.existsSync(file(`students/${s.sid}.jsonl`))).toBe(false)
    expect(lines('events-up-big.jsonl')).toHaveLength(30000) // 别人的不动
    fs.rmSync(file('events-up-big.jsonl'))
  })

  it('排在注销前面、账号删掉以后才轮到的追加写：不写，回 401（文件写不回来）', async () => {
    const s = await register('del.queued')
    // 这个账号的事件文件先换成命名管道：第一批追加写打开它时一直等着，后面的写都排在它后面
    const fifo = file(`students/${s.sid}.jsonl`)
    fs.mkdirSync(path.dirname(fifo), { recursive: true })
    expect(spawnSync('mkfifo', [fifo]).status).toBe(0)
    // 放行：读写方式打开管道并一直拿着，之后的写都不再等（数据留在管道的缓冲里）
    let fd: number | null = null
    const unblock = () => (fd = fd ?? fs.openSync(fifo, fs.constants.O_RDWR | fs.constants.O_NONBLOCK))
    try {
      const first = send(s.cookie, [ev(s.sid, 'up-a', 1)])
      await sleep(100)
      const second = send(s.cookie, [ev(s.sid, 'up-a', 2)]) // 已经过了登录检查，排在第一批后面
      await sleep(100)
      const deleting = del(s.cookie)
      for (let i = 0; i < 200 && !stored().purge?.includes(s.sid); i++) await sleep(10)
      expect(stored().students.map((x: { username: string }) => x.username)).not.toContain('del.queued') // 账号已经删了，文件还没轮到删
      unblock()
      expect((await first).body).toEqual({ ok: true, accepted: 1 })
      expect(await second).toMatchObject({ status: 401, body: { ok: false, error: '请先登录' } })
      expect((await deleting).body).toEqual({ ok: true })
      expect(fs.existsSync(fifo)).toBe(false)
    } finally {
      if (fd === null && fs.existsSync(fifo)) unblock()
      await sleep(50)
      if (fd !== null) fs.closeSync(fd)
    }
  })

  it('有删不掉的（磁盘出错、读不了）：账号照样删了，200 带 incomplete，sid 留在 students.json 的待删列表里；到期清理补删，删完从列表去掉', async () => {
    const s = await register('del.fail')
    expect((await send(s.cookie, [ev(s.sid, 'up-a', 7, 'client_error')])).body.accepted).toBe(1)
    // 名字是这个账号的事件文件的目录：rm 删不掉
    const mine = file(`students/${s.sid}.jsonl`)
    fs.mkdirSync(mine, { recursive: true })
    const r = await del(s.cookie)
    expect(r).toMatchObject({ status: 200, body: { ok: true, incomplete: true } })
    expect(await me(s.cookie)).toBeNull()
    expect(stored().purge).toEqual([s.sid])
    expect(stored().students.map((x: { username: string }) => x.username)).not.toContain('del.fail')
    expect(lines('events-up-a.jsonl').map((e) => e.sid)).not.toContain(s.sid) // 诊断事件照样删了
    expect(logs.some((l) => /^student deleted self incomplete \S+$/.test(l))).toBe(true)
    expect(ledgerLines().map((x) => x.sidHash)).toContain(sidHash(s.sid))

    // 补删时还是删不掉：列表留着；文件出现在事件文件里的这个 sid 也删
    const cleaner = createApp({ dataDir, deletionsDir, cleanupAnonDays: 100000, cleanupCacheDays: 100000, log: () => {} })
    fs.appendFileSync(file('events-up-a.jsonl'), JSON.stringify(ev(s.sid, 'up-a', Date.now(), 'client_error')) + '\n')
    await cleaner.cleanup()
    expect(lines('events-up-a.jsonl').map((e) => e.sid)).not.toContain(s.sid)
    expect(stored().purge).toEqual([s.sid])
    // 删得掉了：下一次清理删掉文件，列表清掉
    fs.rmdirSync(mine)
    fs.writeFileSync(mine, JSON.stringify(ev(s.sid, 'up-a', 1)) + '\n')
    expect(await cleaner.cleanup()).toMatchObject({ files: 1 })
    expect(fs.existsSync(mine)).toBe(false)
    expect(stored()).not.toHaveProperty('purge')
    expect(fs.readFileSync(file('students.json'), 'utf8')).not.toContain(s.sid)
  })

  it('台账目录建不了：createApp 直接报错；台账写不成（台账文件的位置是个目录）：500，什么都不删', async () => {
    const blocked = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'zhishi-deletions-')), 'file')
    fs.writeFileSync(blocked, 'not a directory')
    expect(() => createApp({ dataDir, deletionsDir: path.join(blocked, 'ledger'), log: () => {} })).toThrow()
    const odd = fs.mkdtempSync(path.join(os.tmpdir(), 'zhishi-deletions-'))
    fs.mkdirSync(path.join(odd, DELETIONS_FILE))
    const broken = await listen({ deletionsDir: odd })
    const s = await register('del.noledger', broken)
    const before = fs.readFileSync(file('students.json'), 'utf8')
    expect(await call(broken, 'POST', '/api/student/delete', { password: PASSWORD }, s.cookie)).toMatchObject({ status: 500, body: { error: '注销没成功，请稍后再试' } })
    expect(fs.readFileSync(file('students.json'), 'utf8')).toBe(before)
    expect(await me(s.cookie)).toMatchObject({ username: 'del.noledger' })
  })
})

describe(`到期清理：${STUDENT_INACTIVE_MONTHS} 个月没用的账号自动删除`, () => {
  it(`最近一次用知适（lastSeenAt）早于 ${STUDENT_INACTIVE_MONTHS} 个月前的走注销同一套删除、记台账；11 个月的不动；没有 lastSeenAt 的按注册时间算；账号不在了的会话删掉`, async () => {
    const old = await register('idle.old')
    const recent = await register('idle.recent')
    const noSeen = await register('idle.noseen')
    for (const w of [old, recent]) expect((await send(w.cookie, [ev(w.sid, 'up-a', 1), ev(w.sid, 'up-a', 2, 'client_error')])).body.accepted).toBe(2)
    const now = Date.now()
    const yearAgo = new Date(now)
    yearAgo.setUTCMonth(yearAgo.getUTCMonth() - STUDENT_INACTIVE_MONTHS)
    patchStudent('idle.old', { lastSeenAt: yearAgo.getTime() - 24 * 3600 * 1000 })
    patchStudent('idle.recent', { lastSeenAt: now - 11 * MONTH })
    patchStudent('idle.noseen', { lastSeenAt: undefined, createdAt: new Date(yearAgo.getTime() - 1000).toISOString() })
    // 一个指向不存在账号的会话（比如注销时没作废成）
    const sessions = readJson('student-sessions.json')
    fs.writeFileSync(file('student-sessions.json'), JSON.stringify({ ...sessions, ['0'.repeat(64)]: { student: 'st-000000000000', createdAt: now, expiresAt: now + MONTH } }))
    const cleanLogs: string[] = []
    const cleaner = createApp({ dataDir, deletionsDir, cleanupAnonDays: 100000, cleanupCacheDays: 100000, log: (l: string) => cleanLogs.push(l) })
    const ledgerBefore = ledgerLines().length

    expect(await cleaner.cleanup()).toMatchObject({ students: 2 })
    const names = stored().students.map((x: { username: string }) => x.username)
    expect(names).toContain('idle.recent')
    expect(names).not.toContain('idle.old')
    expect(names).not.toContain('idle.noseen')
    expect(await me(old.cookie)).toBeNull()
    expect(await me(noSeen.cookie)).toBeNull()
    expect(await me(recent.cookie)).toMatchObject({ username: 'idle.recent' })
    expect(fs.existsSync(file(`students/${old.sid}.jsonl`))).toBe(false)
    expect(lines(`students/${recent.sid}.jsonl`)).toEqual([ev(recent.sid, 'up-a', 1)])
    expect(lines('events-up-a.jsonl').map((e) => e.sid)).not.toContain(old.sid)
    expect(lines('events-up-a.jsonl').map((e) => e.sid)).toContain(recent.sid)
    expect(ledgerLines().slice(ledgerBefore).map((x) => x.sidHash).sort()).toEqual([sidHash(old.sid), sidHash(noSeen.sid)].sort())
    expect(Object.values(readJson('student-sessions.json')).map((x: any) => x.student)).not.toContain('st-000000000000')
    expect(cleanLogs.filter((l) => l === 'student deleted inactive')).toHaveLength(2)
    expect(cleanLogs.join('\n')).not.toMatch(/idle\.|u-[0-9a-f]{16}/)
    expect(stored().usedInvites).toEqual(expect.arrayContaining([sha(old.code), sha(noSeen.code)]))
    // 再跑一次：没有要删的账号，返回里没有 students
    expect(await cleaner.cleanup()).not.toHaveProperty('students')
  })

  it('列出待删以后、轮到它之前登录了的账号不删：删之前按最新的 lastSeenAt 再判断一次，也不记台账', async () => {
    const a = await listen({ cleanupAnonDays: 100000, cleanupCacheDays: 100000 })
    const first = await register('idle.first', a)
    const second = await register('idle.second', a)
    const yearAgo = new Date()
    yearAgo.setUTCMonth(yearAgo.getUTCMonth() - STUDENT_INACTIVE_MONTHS)
    for (const w of [first, second]) patchStudent(w.username, { lastSeenAt: yearAgo.getTime() - 24 * 3600 * 1000 })
    // 先删的那个账号的事件文件换成命名管道：一批追加写打开它时一直等着，清理删到它的文件时卡住（排在这批追加写后面）
    const fifo = file(`students/${first.sid}.jsonl`)
    fs.mkdirSync(path.dirname(fifo), { recursive: true })
    expect(spawnSync('mkfifo', [fifo]).status).toBe(0)
    let fd: number | null = null
    const unblock = () => (fd = fd ?? fs.openSync(fifo, fs.constants.O_RDWR | fs.constants.O_NONBLOCK))
    const ledgerBefore = ledgerLines().length
    try {
      const sending = call(a, 'POST', '/api/events', [ev(first.sid, 'up-a', 1)], first.cookie)
      await sleep(100)
      const cleaning = a.app.cleanup()
      for (let i = 0; i < 200 && stored().students.some((x: { username: string }) => x.username === 'idle.first'); i++) await sleep(10)
      expect(stored().students.map((x: { username: string }) => x.username)).not.toContain('idle.first') // 第一个账号删了，清理卡在删它的文件
      // 这时 idle.second 登录：lastSeenAt 记成现在
      const login = await call(a, 'POST', '/api/student/login', { username: 'idle.second', password: PASSWORD })
      expect(login.status).toBe(200)
      unblock()
      await sending
      expect(await cleaning).toMatchObject({ students: 1 })
      expect(stored().students.map((x: { username: string }) => x.username)).toContain('idle.second')
      expect(await me(cookieOf(login))).toMatchObject({ username: 'idle.second' })
      expect(ledgerLines().slice(ledgerBefore).map((x) => x.sidHash)).toEqual([sidHash(first.sid)])
    } finally {
      if (fd === null && fs.existsSync(fifo)) unblock()
      await sleep(50)
      if (fd !== null) fs.closeSync(fd)
    }
  })
})

describe('删除台账的位置', () => {
  it('默认 server/deletions，DELETIONS_DIR 能改；在 DATA_DIR 里面（或就是 DATA_DIR）createApp 直接报错', () => {
    const ENV_FILE = path.join(dataDir, 'missing.env')
    expect(loadConfig({ ENV_FILE }).deletionsDir).toBe(path.resolve('server/deletions'))
    expect(loadConfig({ ENV_FILE, DELETIONS_DIR: 'some/where' }).deletionsDir).toBe(path.resolve('some/where'))
    for (const bad of [dataDir, path.join(dataDir, 'deletions'), path.join(dataDir, 'a', '..', 'b')]) {
      expect(() => createApp({ dataDir, deletionsDir: bad, log: () => {} }), bad).toThrow('deletionsDir 不能在 dataDir 里面')
    }
    expect(() => createApp({ dataDir, deletionsDir: `${dataDir}-deletions`, log: () => {} })).not.toThrow()
    expect(() => createApp({ dataDir, deletionsDir: path.dirname(dataDir), log: () => {} })).not.toThrow()
  })
})
