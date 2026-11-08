// 学生账号（内测）：邀请码注册、年龄门槛、用户名 + 密码登录、会话 cookie（zhishi_student）、退出、找回码改密码、设置、
// 上架列表、本账号的事件、最小导出；老师账号和学生账号互不相认。照 server-auth.test.ts 的写法，请求用 node:http 发，不调用模型。
// 邀请码文件 student-invites.json 平时由 scripts/student.mjs 写，这里直接写（码只存 sha256，见 student-cli.test.ts）
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { MIN_AGE, createApp, loadConfig, studentInviteHash, verifyPassword } from '../server/index.mjs'
import type { ServerConfig } from '../server/index.mjs'

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zhishi-student-'))
const logs: string[] = []
const PASSWORD = 'correct-horse-9'
const sha = (s: string) => createHash('sha256').update(s).digest('hex')
const studentsFile = path.join(dataDir, 'students.json')
const sessionsFile = path.join(dataDir, 'student-sessions.json')
const invitesFile = path.join(dataDir, 'student-invites.json')
const readJson = (f: string) => JSON.parse(fs.readFileSync(f, 'utf8'))
const TEACHER_INVITE = 'invite-teacher-0001'
const TEACHER_PASSWORD = 'teacher-pass-1'

// 测试用的码：12 位大写字母和数字（不是真码）。哈希按约定算：去掉空白和「-」、转大写后的 sha256
const CODES = Array.from({ length: 150 }, (_, i) => `TESTCODE${String(i).padStart(4, '0')}`)
let nextCode = 0
const code = () => CODES[nextCode++]
const REVOKED = 'TESTREVOKED1'
function writeInvites() {
  const invites = [...CODES.map((c) => ({ hash: sha(c), batch: 't1', createdAt: new Date().toISOString() })), { hash: sha(REVOKED), batch: 'old', createdAt: '', revokedAt: new Date().toISOString() }]
  fs.writeFileSync(invitesFile, JSON.stringify({ invites }))
}

// 出生年月：往前推 n 个月（按北京时间的这个月）
function monthsAgo(n: number) {
  const now = new Date(Date.now() + 8 * 3600 * 1000)
  const t = now.getUTCFullYear() * 12 + now.getUTCMonth() - n
  return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, '0')}`
}
const BIRTH = monthsAgo(MIN_AGE * 12 + 30)

type App = { server: Server; port: number }
type Res = { status: number; body: any; headers: http.IncomingHttpHeaders; text: string }
const open: App[] = []
function listen(config: Partial<ServerConfig> = {}) {
  return new Promise<App>((resolve) => {
    const server = createApp({ dataDir, apiKey: 'sk-test-not-a-real-key', uploadInvites: [TEACHER_INVITE], authPerMinute: 1000, log: (l: string) => logs.push(l), ...config }).listen(0, '127.0.0.1', () => {
      const a = { server, port: (server.address() as AddressInfo).port }
      open.push(a)
      resolve(a)
    })
  })
}

// body 是字符串就原样发（测请求格式），否则发 JSON；cookie 是上一次 Set-Cookie 里的「名=值」
function call(app: App, method: string, url: string, body?: unknown, cookie?: string, headers: Record<string, string> = {}) {
  return new Promise<Res>((resolve, reject) => {
    const h: Record<string, string> = { 'content-type': 'application/json', ...(cookie ? { cookie } : {}), ...headers }
    const req = http.request({ host: '127.0.0.1', port: app.port, path: url, method, headers: h }, (res) => {
      let text = ''
      res.setEncoding('utf8')
      res.on('data', (c) => (text += c))
      res.on('end', () => resolve({ status: res.statusCode!, body: JSON.parse(text), headers: res.headers, text }))
    })
    req.on('error', reject)
    req.end(body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body))
  })
}
const setCookie = (r: Res) => {
  const c = r.headers['set-cookie']
  expect(c, 'Set-Cookie').toHaveLength(1)
  return c![0]
}
const cookieOf = (r: Res) => setCookie(r).split(';')[0]
const tokenOf = (cookie: string) => cookie.split('=')[1]

type Who = { cookie: string; student: { username: string; sid: string; ai: boolean; aiAvailable: boolean }; recoveryCode: string; code: string }
const reg = (app: App, o: Record<string, unknown>) => call(app, 'POST', '/api/student/register', { invite: 'invite' in o ? o.invite : code(), username: 'x', password: PASSWORD, birth: BIRTH, agree: true, ...o })
async function register(app: App, username: string, o: Record<string, unknown> = {}): Promise<Who> {
  const invite = code()
  const r = await call(app, 'POST', '/api/student/register', { invite, username, password: PASSWORD, birth: BIRTH, agree: true, ...o })
  expect(r.status, JSON.stringify(r.body)).toBe(200)
  return { cookie: cookieOf(r), student: r.body.student, recoveryCode: r.body.recoveryCode, code: invite }
}
const login = (app: App, username: unknown, password: unknown) => call(app, 'POST', '/api/student/login', { username, password })
const me = async (app: App, cookie?: string) => (await call(app, 'GET', '/api/student/me', undefined, cookie)).body.student
const stored = (username: string) => readJson(studentsFile).students.find((s: { username: string }) => s.username === username)

let app: App
beforeAll(async () => {
  app = await listen()
})
afterAll(() => {
  for (const a of open) a.server.close()
})

describe('注册', () => {
  it('还没有学生邀请码：带什么码都 403，老师的邀请码也不认；不建账号', async () => {
    for (const invite of [undefined, '', CODES[149], TEACHER_INVITE]) {
      expect(await reg(app, { invite, username: 'nobody' }), String(invite)).toMatchObject({ status: 403, body: { error: '邀请码不对，请向知适团队确认' } })
    }
    expect(fs.existsSync(studentsFile)).toBe(false)
    writeInvites()
  })

  it('邀请码缺失、不对、作废、类型不对 403，而且先于字段校验；不 Set-Cookie', async () => {
    const c = CODES[149]
    for (const bad of [undefined, '', 'TESTCODE007', c + '1', REVOKED, TEACHER_INVITE, 123, [c]]) {
      for (const fields of [{ username: 'okname', password: PASSWORD, birth: BIRTH, agree: true }, { username: 'x', password: '1' }]) {
        const r = await call(app, 'POST', '/api/student/register', { invite: bad, ...fields })
        expect(r, JSON.stringify(bad)).toMatchObject({ status: 403, body: { error: '邀请码不对，请向知适团队确认' } })
        expect(r.body.fields).toBeUndefined()
        expect(r.headers['set-cookie']).toBeUndefined()
      }
    }
  })

  it('成功：200 {student, recoveryCode}，同时登录；用户名去空白转小写；码不分大小写、空格和「-」都不要紧；AI 写作检查默认开着（11-07 队长定）', async () => {
    const raw = code()
    const typed = ` ${raw.slice(0, 4).toLowerCase()}-${raw.slice(4, 8)} ${raw.slice(8)} `
    const r = await call(app, 'POST', '/api/student/register', { invite: typed, username: '  Xiao.Ming ', password: PASSWORD, birth: BIRTH, agree: true })
    expect(r.status).toBe(200)
    expect(r.body).toEqual({ student: { username: 'xiao.ming', sid: expect.stringMatching(/^u-[0-9a-f]{16}$/), ai: true, aiAvailable: false }, recoveryCode: expect.stringMatching(/^[A-HJKMNP-Z2-9]{8}$/) })
    expect(await me(app, cookieOf(r))).toEqual(r.body.student)
    expect(studentInviteHash(typed)).toBe(sha(raw))
  })

  it('字段不合格 400，按字段给提示；没勾隐私说明 400；码都没被用掉', async () => {
    const c = code()
    const send = (o: Record<string, unknown>) => call(app, 'POST', '/api/student/register', { invite: c, username: 'li_tongxue', password: PASSWORD, birth: BIRTH, agree: true, ...o })
    const fields = async (o: Record<string, unknown>) => {
      const r = await send(o)
      expect(r.status, JSON.stringify(o)).toBe(400)
      expect(r.headers['set-cookie']).toBeUndefined()
      return r.body.fields
    }
    for (const username of [undefined, 'ab', 'x'.repeat(33)]) expect(await fields({ username }), String(username)).toEqual({ username: '用户名要 3 到 32 个字符' })
    for (const username of ['_li', 'li tongxue', '李同学', 'li@school']) expect(await fields({ username }), username).toEqual({ username: '用户名只能用字母、数字和 _ . -，开头要是字母或数字' })
    // 手机号那样的用户名：11 位以上连着的数字
    for (const username of ['13812345678', 'li13812345678', '138123456789', 'a12345678901b']) expect(await fields({ username }), username).toEqual({ username: '用户名不要用手机号' })
    for (const password of [undefined, 12345678, '1234567', 'x'.repeat(129)]) expect(await fields({ password }), String(password)).toEqual({ password: '密码要 8 到 128 个字符' })
    expect(await fields({ username: 'Li.Tongxue', password: 'li.TONGXUE' })).toEqual({ password: '密码不能和用户名一样' })
    for (const birth of [undefined, '', '2010', '2010-13', '2010-00', '2010-1', '1899-12', monthsAgo(-1), 201001, '2010-01-01']) expect(await fields({ birth }), String(birth)).toEqual({ birth: '请选出生年月' })
    expect((await send({ username: 'a', password: 'short', birth: 'x' })).body).toEqual({ error: '有 3 处要改，见标红的地方', fields: { username: '用户名要 3 到 32 个字符', password: '密码要 8 到 128 个字符', birth: '请选出生年月' } })
    for (const agree of [undefined, false, 'true', 1]) expect(await send({ agree }), String(agree)).toMatchObject({ status: 400, body: { error: '请先读隐私说明并勾选' } })
    // 10 位数字可以；这个码之前没被用掉
    expect((await send({ username: 'li1234567890' })).status).toBe(200)
  })

  it(`年龄：正好满 ${MIN_AGE} 周岁的那个月按还没满算，400、不建账号、这个码作废（再注册 409）；满门槛的下一个月可以`, async () => {
    expect(MIN_AGE).toBe(12)
    const YOUNG = { error: '知适内测暂时只对年满 12 周岁的同学开放' }
    const c = code()
    const r = await call(app, 'POST', '/api/student/register', { invite: c, username: 'young.one', password: PASSWORD, birth: monthsAgo(MIN_AGE * 12), agree: true })
    expect({ status: r.status, body: r.body }).toEqual({ status: 400, body: YOUNG })
    expect(r.headers['set-cookie']).toBeUndefined()
    for (const birth of [monthsAgo(MIN_AGE * 12 - 1), monthsAgo(0)]) expect((await reg(app, { username: 'young.two', birth })).body, birth).toEqual(YOUNG)
    // 换一个满门槛的出生年月也不行：码已经作废
    expect(await call(app, 'POST', '/api/student/register', { invite: c, username: 'young.one', password: PASSWORD, birth: BIRTH, agree: true })).toMatchObject({ status: 409, body: { error: '这个邀请码已经用过了' } })
    expect(stored('young.one')).toBeUndefined()
    const data = readJson(studentsFile)
    expect(data.usedInvites).toContain(sha(c))
    expect(JSON.stringify(data)).not.toContain(monthsAgo(MIN_AGE * 12))
    // 满门槛的下一个月
    const ok = await register(app, 'just.twelve', { birth: monthsAgo(MIN_AGE * 12 + 1) })
    expect(ok.student.username).toBe('just.twelve')
  })

  it('一个邀请码只能注册一个账号：再用就 409（先于字段校验）', async () => {
    const { code: c } = await register(app, 'zhao')
    for (const o of [{ username: 'zhao2', password: PASSWORD, birth: BIRTH, agree: true }, { username: 'x', password: '1' }]) {
      expect(await call(app, 'POST', '/api/student/register', { invite: c, ...o }), JSON.stringify(o)).toMatchObject({ status: 409, body: { error: '这个邀请码已经用过了' } })
    }
  })

  it('用户名不分大小写，已经有人用了 409，带 fields.username；码没被用掉；和老师的用户名不冲突', async () => {
    await register(app, 'qian')
    const c = code()
    for (const username of ['QIAN', ' Qian ']) {
      expect(await call(app, 'POST', '/api/student/register', { invite: c, username, password: PASSWORD, birth: BIRTH, agree: true }), username).toMatchObject({ status: 409, body: { error: '这个用户名已经有人用了', fields: { username: expect.stringMatching(/已经有人用了/) } } })
    }
    expect((await call(app, 'POST', '/api/student/register', { invite: c, username: 'qian2', password: PASSWORD, birth: BIRTH, agree: true })).status).toBe(200)
    // 老师账号里有同名的，学生照样能注册
    expect((await call(app, 'POST', '/api/auth/register', { invite: TEACHER_INVITE, username: 'same.name', password: TEACHER_PASSWORD })).status).toBe(201)
    await register(app, 'same.name')
  })

  it('同时用同一个码注册两次、或同时注册同一个用户名：只成功一个', async () => {
    const c = code()
    const body = (invite: string, username: string) => ({ invite, username, password: PASSWORD, birth: BIRTH, agree: true })
    const [a, b] = await Promise.all([call(app, 'POST', '/api/student/register', body(c, 'race-a')), call(app, 'POST', '/api/student/register', body(c, 'race-b'))])
    expect([a.status, b.status].sort()).toEqual([200, 409])
    const [x, y] = await Promise.all([call(app, 'POST', '/api/student/register', body(code(), 'race-same')), call(app, 'POST', '/api/student/register', body(code(), 'Race-Same'))])
    expect([x.status, y.status].sort()).toEqual([200, 409])
    const list = readJson(studentsFile).students
    expect(list.filter((s: { inviteHash: string }) => s.inviteHash === sha(c))).toHaveLength(1)
    expect(list.filter((s: { username: string }) => s.username === 'race-same')).toHaveLength(1)
  })

  it('students.json 里没有明文密码、邀请码、出生年月、找回码；只存确认满门槛的时间；文件只给本用户读写；日志不记用户名、密码、码、token', async () => {
    const from = logs.length
    const c = code()
    const pw = 'very-secret-pass-77'
    const birth = monthsAgo(MIN_AGE * 12 + 17)
    const before = Date.now()
    const r = await call(app, 'POST', '/api/student/register', { invite: c, username: 'sun.tongxue', password: pw, birth, agree: true })
    const token = tokenOf(cookieOf(r))
    await login(app, 'sun.tongxue', pw)
    const text = fs.readFileSync(studentsFile, 'utf8')
    for (const secret of [pw, c, token, birth, r.body.recoveryCode]) expect(text).not.toContain(secret)
    const s = stored('sun.tongxue')
    expect(s).toEqual({
      id: expect.stringMatching(/^st-[0-9a-f]{12}$/),
      username: 'sun.tongxue',
      passwordHash: expect.stringMatching(/^scrypt\$16384\$8\$1\$[0-9a-f]{32}\$[0-9a-f]{128}$/),
      createdAt: expect.any(String),
      inviteHash: sha(c),
      sid: r.body.student.sid,
      ageOkAt: expect.any(Number),
      agreedAt: expect.any(Number),
      ai: true,
      recoveryHash: sha(r.body.recoveryCode),
      lastSeenAt: expect.any(Number),
    })
    expect(s.ageOkAt).toBeGreaterThanOrEqual(before)
    expect(new Date(s.createdAt).toISOString()).toBe(s.createdAt)
    expect(await verifyPassword(pw, s.passwordHash)).toBe(true)
    expect(readJson(studentsFile).usedInvites).toContain(sha(c))
    if (process.platform !== 'win32') for (const f of [studentsFile, sessionsFile]) expect(fs.statSync(f).mode & 0o077).toBe(0)
    const lines = logs.slice(from).join('\n')
    for (const secret of [pw, c, token, 'sun.tongxue', birth, r.body.recoveryCode, s.sid, s.id]) expect(lines).not.toContain(secret)
    expect(fs.readdirSync(dataDir).filter((f) => f.endsWith('.tmp'))).toEqual([])
  })
})

describe('会话 cookie', () => {
  it('名字是 zhishi_student；HttpOnly、SameSite=Lax、Path=/api、30 天、Secure；cookieSecure 关掉时没有 Secure；退出时 Max-Age=0', async () => {
    const r = await reg(app, { username: 'cookie.a' })
    const c = setCookie(r)
    expect(c).toMatch(/^zhishi_student=[0-9a-f]{64}; /)
    const attrs = c.split('; ').slice(1)
    expect(attrs.sort()).toEqual(['HttpOnly', 'Max-Age=2592000', 'Path=/api', 'SameSite=Lax', 'Secure'])
    expect(setCookie(await login(app, 'cookie.a', PASSWORD)).split('; ').slice(1).sort()).toEqual(attrs)
    const out = setCookie(await call(app, 'POST', '/api/student/logout', {}, cookieOf(r)))
    expect(out.split('; ').sort()).toEqual(['HttpOnly', 'Max-Age=0', 'Path=/api', 'SameSite=Lax', 'Secure', 'zhishi_student='])

    const insecure = await listen({ cookieSecure: false })
    const r2 = await reg(insecure, { username: 'cookie.b' })
    expect(setCookie(r2).split('; ').slice(1).sort()).toEqual(['HttpOnly', 'Max-Age=2592000', 'Path=/api', 'SameSite=Lax'])
  })
})

describe('登录', () => {
  let zhou: Who
  beforeAll(async () => {
    zhou = await register(app, 'zhou')
  })

  it('成功：200 {student}，Set-Cookie 一个新会话；用户名不分大小写、去首尾空白；sid 不变', async () => {
    const r = await login(app, ' ZHOU ', PASSWORD)
    expect(r.status).toBe(200)
    expect(r.body).toEqual({ student: zhou.student })
    expect(cookieOf(r)).not.toBe(zhou.cookie)
    expect(await me(app, cookieOf(r))).toEqual(zhou.student)
    expect(await me(app, zhou.cookie)).toEqual(zhou.student)
  })

  it('密码不对、用户名不存在、类型不对：一律 401「用户名或密码不对」，不 Set-Cookie；老师账号登不进来', async () => {
    const denied = { status: 401, body: { error: '用户名或密码不对' } }
    // 最后一组是老师账号 same.name 的密码（学生 same.name 的密码不一样）
    for (const [u, p] of [['zhou', PASSWORD + 'x'], ['zhou', ''], ['nobody-here', PASSWORD], [42, PASSWORD], [undefined, undefined], ['same.name', TEACHER_PASSWORD]]) {
      const r = await login(app, u, p)
      expect({ status: r.status, body: r.body }, JSON.stringify([u, p])).toEqual(denied)
      expect(r.headers['set-cookie']).toBeUndefined()
    }
  })

  it('同一用户名失败 10 次后 429（密码对了也不行），别的用户名不受影响；老师那边的失败次数不算在学生这里', async () => {
    await register(app, 'wuu')
    for (let i = 0; i < 10; i++) expect((await call(app, 'POST', '/api/auth/login', { username: 'wuu', password: 'wrong' })).status).toBe(401)
    expect((await login(app, 'wuu', PASSWORD)).status).toBe(200)
    for (let i = 0; i < 10; i++) expect((await login(app, 'WUU', 'wrong-password')).status, String(i)).toBe(401)
    for (const p of ['wrong-password', PASSWORD]) expect(await login(app, 'wuu', p)).toMatchObject({ status: 429, body: { error: '试错太多次了，请 15 分钟后再试' } })
    expect((await login(app, 'zhou', PASSWORD)).status).toBe(200)
  })

  it('全站登录 + 注册（老师和学生一起）每分钟限次，超了 429', async () => {
    const busy = await listen({ authPerMinute: 3 })
    expect((await login(busy, 'zhou', PASSWORD)).status).toBe(200)
    expect((await call(busy, 'POST', '/api/auth/login', { username: 'nobody', password: PASSWORD })).status).toBe(401)
    expect((await reg(busy, { invite: 'WRONGCODE000', username: 'x1y' })).status).toBe(403)
    expect(await login(busy, 'zhou', PASSWORD)).toMatchObject({ status: 429, body: { error: '现在登录的人太多了，请稍后再试' } })
    expect(await reg(busy, { username: 'x2y' })).toMatchObject({ status: 429 })
    expect(await call(busy, 'POST', '/api/student/reset', { username: 'zhou', code: 'X', newPassword: 'new-password-1' })).toMatchObject({ status: 429 })
    expect(await me(busy, zhou.cookie)).toMatchObject({ username: 'zhou' })
  })
})

describe('会话', () => {
  it('没登录、cookie 格式不对、不认识的 token：me 都是 {student:null}；不缓存', async () => {
    const r = await call(app, 'GET', '/api/student/me')
    expect(r.body).toEqual({ student: null })
    expect(r.headers['cache-control']).toBe('no-store')
    for (const c of ['zhishi_student=', 'zhishi_student=abc', `zhishi_student=${'A'.repeat(64)}`, `zhishi_student=${'a'.repeat(64)}`]) expect(await me(app, c), c).toBeNull()
  })

  it('student-sessions.json 只存 token 的 sha256；会话 30 天后到期；别的 cookie 混在一起也认得出', async () => {
    const { cookie, student } = await register(app, 'chen')
    const token = tokenOf(cookie)
    const text = fs.readFileSync(sessionsFile, 'utf8')
    expect(text).not.toContain(token)
    const s = JSON.parse(text)[sha(token)]
    expect(s).toEqual({ student: stored('chen').id, createdAt: expect.any(Number), expiresAt: s.createdAt + 30 * 24 * 3600 * 1000 })
    expect(await me(app, `a=1; zhishi_session=${'b'.repeat(64)}; ${cookie}; b=2`)).toEqual(student)
  })

  it('退出：删掉服务器上的会话，旧 cookie 不能再用；别的设备不受影响；没登录也 200', async () => {
    const { cookie, student } = await register(app, 'chu')
    const other = cookieOf(await login(app, 'chu', PASSWORD))
    expect((await call(app, 'POST', '/api/student/logout', {}, cookie)).body).toEqual({ ok: true })
    expect(await me(app, cookie)).toBeNull()
    expect(readJson(sessionsFile)[sha(tokenOf(cookie))]).toBeUndefined()
    expect(await me(app, other)).toEqual(student)
    for (const c of [undefined, cookie, 'zhishi_student=junk']) expect((await call(app, 'POST', '/api/student/logout', {}, c)).body).toEqual({ ok: true })
  })

  it('过期的会话不认；下次写会话文件时顺手删掉', async () => {
    const { cookie } = await register(app, 'wei')
    const key = sha(tokenOf(cookie))
    const all = readJson(sessionsFile)
    all[key] = { ...all[key], expiresAt: Date.now() - 1000 }
    fs.writeFileSync(sessionsFile, JSON.stringify(all))
    expect(await me(app, cookie)).toBeNull()
    await login(app, 'zhou', PASSWORD)
    expect(readJson(sessionsFile)[key]).toBeUndefined()
  })

  it('服务器重启后会话还在；students.json 被直接改了（命令行重置密码）服务器看得到：sessionsValidAfter 之前的会话、账号不在了都是 null', async () => {
    const { cookie, student } = await register(app, 'jiang')
    const restarted = await listen()
    expect(await me(restarted, cookie)).toEqual(student)
    const { cookie: keep, student: other } = await register(app, 'han')
    const data = readJson(studentsFile)
    fs.writeFileSync(studentsFile, JSON.stringify({ ...data, students: data.students.map((s: { username: string }) => (s.username === 'jiang' ? { ...s, sessionsValidAfter: Date.now() + 1000 } : s)) }))
    expect(await me(app, cookie)).toBeNull()
    expect(await me(app, keep)).toEqual(other)
    fs.writeFileSync(studentsFile, JSON.stringify({ ...data, students: data.students.filter((s: { username: string }) => s.username !== 'han') }))
    expect(await me(app, keep)).toBeNull()
    expect(await me(app, cookie)).toEqual(student)
    fs.writeFileSync(studentsFile, JSON.stringify(data))
  })

  it('lastSeenAt：/me 和登录时记，同一天只写一次文件', async () => {
    const { cookie } = await register(app, 'last.seen')
    const data = readJson(studentsFile)
    const yesterday = Date.now() - 24 * 3600 * 1000 - 1000
    fs.writeFileSync(studentsFile, JSON.stringify({ ...data, students: data.students.map((s: { username: string }) => (s.username === 'last.seen' ? { ...s, lastSeenAt: yesterday } : s)) }))
    await me(app, cookie)
    const seen = stored('last.seen').lastSeenAt
    expect(seen).toBeGreaterThan(yesterday + 1000)
    const mtime = fs.statSync(studentsFile).mtimeMs
    await new Promise((r) => setTimeout(r, 20))
    await me(app, cookie)
    await login(app, 'last.seen', PASSWORD)
    expect(fs.statSync(studentsFile).mtimeMs).toBe(mtime)
    expect(stored('last.seen').lastSeenAt).toBe(seen)
  })
})

describe('老师账号和学生账号互不相认', () => {
  it('学生 cookie 调老师接口都当没登录；老师 cookie 调学生接口也当没登录；token 换个 cookie 名也不认', async () => {
    const s = await register(app, 'cross.s')
    const t = await call(app, 'POST', '/api/auth/login', { username: 'same.name', password: TEACHER_PASSWORD })
    expect(t.status).toBe(200)
    const teacher = cookieOf(t)
    // 学生 cookie → 老师接口
    expect((await call(app, 'GET', '/api/auth/me', undefined, s.cookie)).body).toEqual({ teacher: null })
    for (const [method, url, body] of [['GET', '/api/classes'], ['POST', '/api/classes', { name: '班', roster: [{ n: 1 }], confirm: { school: true, consent: true } }], ['POST', '/api/uploads', { title: 'x', text: 'y'.repeat(300) }], ['GET', '/api/my/handouts'], ['POST', '/api/handouts/up-x/publish', { classes: [] }]] as const) {
      expect(await call(app, method, url, body, s.cookie), url).toMatchObject({ status: 401, body: { error: '请先登录' } })
    }
    // 老师 cookie → 学生接口
    expect(await me(app, teacher)).toBeNull()
    for (const [method, url, body] of [['GET', '/api/student/shelf'], ['GET', '/api/student/export'], ['GET', '/api/student/events?h=up-x'], ['GET', '/api/student/notebook'], ['PUT', '/api/student/settings', { ai: false }]] as const) {
      expect((await call(app, method, url, body, teacher)).status, url).toBe(401)
    }
    // 两个 cookie 一起带：各认各的
    expect(await me(app, `${teacher}; ${s.cookie}`)).toEqual(s.student)
    expect((await call(app, 'GET', '/api/auth/me', undefined, `${teacher}; ${s.cookie}`)).body.teacher).toMatchObject({ username: 'same.name' })
    // token 放到对方的 cookie 名下
    expect(await me(app, `zhishi_student=${tokenOf(teacher)}`)).toBeNull()
    expect((await call(app, 'GET', '/api/auth/me', undefined, `zhishi_session=${tokenOf(s.cookie)}`)).body).toEqual({ teacher: null })
  })
})

describe('设置', () => {
  it('没登录 401；ai 不是布尔 400；服务器没开放时只能关不能开（403）；开放了能开，me 和 students.json 跟着变', async () => {
    const s = await register(app, 'set.ai')
    const put = (a: App, body: unknown, cookie?: string) => call(a, 'PUT', '/api/student/settings', body, cookie)
    expect(await put(app, { ai: true })).toMatchObject({ status: 401, body: { error: '请先登录' } })
    for (const ai of [undefined, 'true', 1, null]) expect(await put(app, { ai }, s.cookie), String(ai)).toMatchObject({ status: 400, body: { error: '设置的格式不对，请刷新页面后再试' } })
    expect(await put(app, { ai: true }, s.cookie)).toMatchObject({ status: 403, body: { error: 'AI 写作检查还没开放' } })
    expect(await put(app, { ai: false }, s.cookie)).toMatchObject({ status: 200, body: { student: { ...s.student, ai: false } } })
    expect(stored('set.ai').ai).toBe(false)

    const on = await listen({ studentAi: true })
    expect(await me(on, s.cookie)).toEqual({ ...s.student, ai: false, aiAvailable: true })
    expect(await put(on, { ai: true }, s.cookie)).toEqual(expect.objectContaining({ status: 200, body: { student: { ...s.student, ai: true, aiAvailable: true } } }))
    expect(stored('set.ai').ai).toBe(true)
    expect(await me(app, s.cookie)).toEqual({ ...s.student, ai: true, aiAvailable: false }) // 账号上记着开，服务器没开放照样不发
    const form = await call(on, 'PUT', '/api/student/settings', 'ai=false', s.cookie, { 'content-type': 'application/x-www-form-urlencoded' })
    expect(form.status).toBe(415)
    expect(stored('set.ai').ai).toBe(true)
  })

  it('读取配置：默认不开放；STUDENT_AI=1 才开放', () => {
    const ENV_FILE = path.join(dataDir, 'missing.env')
    expect(loadConfig({ ENV_FILE }).studentAi).toBe(false)
    expect(loadConfig({ ENV_FILE, STUDENT_AI: '1' }).studentAi).toBe(true)
    for (const v of ['0', 'true', 'yes', '']) expect(loadConfig({ ENV_FILE, STUDENT_AI: v }).studentAi, v).toBe(false)
  })
})

describe('用找回码改密码', () => {
  const reset = (a: App, o: Record<string, unknown>) => call(a, 'POST', '/api/student/reset', o)

  it('码对了：回新的找回码；新密码能登录、旧密码不能；所有旧会话作废；旧码不能再用，新码能用；码不分大小写和「-」', async () => {
    const s = await register(app, 'reset.a')
    const other = cookieOf(await login(app, 'reset.a', PASSWORD))
    const typed = `${s.recoveryCode.slice(0, 4).toLowerCase()}-${s.recoveryCode.slice(4)}`
    const r = await reset(app, { username: ' Reset.A ', code: typed, newPassword: 'brand-new-pass-1' })
    expect(r).toMatchObject({ status: 200, body: { recoveryCode: expect.stringMatching(/^[A-HJKMNP-Z2-9]{8}$/) } })
    expect(Object.keys(r.body)).toEqual(['recoveryCode'])
    expect(r.body.recoveryCode).not.toBe(s.recoveryCode)
    expect(r.headers['set-cookie']).toBeUndefined()
    for (const c of [s.cookie, other]) expect(await me(app, c)).toBeNull()
    expect((await login(app, 'reset.a', PASSWORD)).status).toBe(401)
    expect((await login(app, 'reset.a', 'brand-new-pass-1')).status).toBe(200)
    expect((await reset(app, { username: 'reset.a', code: s.recoveryCode, newPassword: 'another-pass-2' })).status).toBe(403)
    expect((await reset(app, { username: 'reset.a', code: r.body.recoveryCode, newPassword: 'another-pass-2' })).status).toBe(200)
    expect(stored('reset.a').sid).toBe(s.student.sid)
  })

  it('码不对、用户名不存在一样 403；新密码不合格 400（不算试错）；同一用户名 15 分钟内错 5 次 429，码对了也不行；别的用户名不受影响', async () => {
    const s = await register(app, 'reset.b')
    const t = await register(app, 'reset.c')
    const WRONG = { status: 403, body: { error: '用户名或找回码不对' } }
    for (const newPassword of [undefined, 'short', 'x'.repeat(129), 'reset.b']) {
      expect(await reset(app, { username: 'reset.b', code: s.recoveryCode, newPassword }), String(newPassword)).toMatchObject({ status: 400, body: { fields: { newPassword: expect.any(String) } } })
    }
    expect(await reset(app, { username: 'nobody.here', code: s.recoveryCode, newPassword: 'new-password-1' })).toMatchObject(WRONG)
    for (let i = 0; i < 5; i++) expect(await reset(app, { username: 'reset.b', code: i === 0 ? undefined : 'AAAAAAAA', newPassword: 'new-password-1' }), String(i)).toMatchObject(WRONG)
    expect(await reset(app, { username: 'reset.b', code: s.recoveryCode, newPassword: 'new-password-1' })).toMatchObject({ status: 429, body: { error: '试错太多次了，请 15 分钟后再试' } })
    expect((await reset(app, { username: 'reset.c', code: t.recoveryCode, newPassword: 'new-password-1' })).status).toBe(200)
    expect((await login(app, 'reset.b', PASSWORD)).status).toBe(200) // 密码没变
  })

  it('登录试错锁住的账号：用找回码改完密码就能登录；日志不记用户名和码；students.json 里没有新密码和新码', async () => {
    const from = logs.length
    const s = await register(app, 'reset.d')
    for (let i = 0; i < 10; i++) await login(app, 'reset.d', 'wrong-password')
    expect((await login(app, 'reset.d', PASSWORD)).status).toBe(429)
    const r = await reset(app, { username: 'reset.d', code: s.recoveryCode, newPassword: 'fresh-pass-77' })
    expect(r.status).toBe(200)
    expect((await login(app, 'reset.d', 'fresh-pass-77')).status).toBe(200)
    const text = fs.readFileSync(studentsFile, 'utf8')
    for (const secret of ['fresh-pass-77', r.body.recoveryCode]) expect(text).not.toContain(secret)
    expect(stored('reset.d').recoveryHash).toBe(sha(r.body.recoveryCode))
    const lines = logs.slice(from).join('\n')
    for (const secret of ['reset.d', s.recoveryCode, r.body.recoveryCode, 'fresh-pass-77']) expect(lines).not.toContain(secret)
  })
})

describe('上架列表、本账号的事件、下载我的数据', () => {
  const handoutsDir = path.join(dataDir, 'handouts')
  const shelfFile = path.join(dataDir, 'shelf.json')
  const ev = (sid: string, handoutId: string, ts: number, o: Record<string, unknown> = {}) => ({ sid, handoutId, type: 'tap_word', ts, ...o })
  beforeAll(() => {
    fs.mkdirSync(handoutsDir, { recursive: true })
    for (const [id, title] of [['up-shelfa', 'Phones'], ['up-shelfb', 'Robots']]) fs.writeFileSync(path.join(handoutsDir, `${id}.meta.json`), JSON.stringify({ id, title, owner: 't-x', published: false }))
  })

  it('上架列表：要登录；按 shelf.json 的顺序列 id 和标题，讲义不在了、id 格式不对的不列；没有文件是空的', async () => {
    const s = await register(app, 'shelf.a')
    expect(await call(app, 'GET', '/api/student/shelf')).toMatchObject({ status: 401, body: { error: '请先登录' } })
    expect((await call(app, 'GET', '/api/student/shelf', undefined, s.cookie)).body).toEqual({ handouts: [] })
    fs.writeFileSync(shelfFile, JSON.stringify({ handouts: [{ id: 'up-shelfb', addedAt: '' }, { id: 'up-gone', addedAt: '' }, { id: '../secret', addedAt: '' }, { id: 'up-shelfa', addedAt: '' }] }))
    const r = await call(app, 'GET', '/api/student/shelf', undefined, s.cookie)
    expect(r.body).toEqual({ handouts: [{ id: 'up-shelfb', title: 'Robots' }, { id: 'up-shelfa', title: 'Phones' }] })
    expect(r.headers['cache-control']).toBe('no-store')
  })

  it('本账号在一篇里的事件：要登录；按时间排；别的讲义、别的账号的不在里面；讲义 id 不对 400', async () => {
    const s = await register(app, 'events.a')
    const t = await register(app, 'events.b')
    const sid = s.student.sid
    expect((await call(app, 'POST', '/api/events', [ev(sid, 'up-shelfa', 30), ev(sid, 'up-shelfa', 10, { type: 'answer_question', correct: true }), ev(sid, 'up-shelfb', 20)], s.cookie)).body).toEqual({ ok: true, accepted: 3 })
    expect((await call(app, 'POST', '/api/events', [ev(t.student.sid, 'up-shelfa', 5)], t.cookie)).body).toEqual({ ok: true, accepted: 1 })
    expect(await call(app, 'GET', '/api/student/events?h=up-shelfa')).toMatchObject({ status: 401, body: { error: '请先登录' } })
    const r = await call(app, 'GET', '/api/student/events?h=up-shelfa', undefined, s.cookie)
    expect(r.body).toEqual({ events: [ev(sid, 'up-shelfa', 10, { type: 'answer_question', correct: true }), ev(sid, 'up-shelfa', 30)] })
    expect(r.headers['cache-control']).toBe('no-store')
    expect((await call(app, 'GET', '/api/student/events?h=up-none', undefined, s.cookie)).body).toEqual({ events: [] })
    for (const h of ['', 'UP-X', '..%2Fx']) expect((await call(app, 'GET', `/api/student/events?h=${h}`, undefined, s.cookie)).status, h).toBe(400)
    expect((await call(app, 'GET', '/api/student/events', undefined, s.cookie)).status).toBe(400)
  })

  it('下载我的数据：要登录；附件；只有用户名、注册时间、设置和自己的全部原始事件，搜不到任何哈希、会话和账号 id；每小时限次', async () => {
    const s = await register(app, 'export.a')
    const t = await register(app, 'export.b')
    const sid = s.student.sid
    await call(app, 'POST', '/api/events', [ev(sid, 'up-shelfa', 1), ev(sid, 'up-shelfb', 2, { type: 'writing_submit', value: 'my sentence' })], s.cookie)
    await call(app, 'POST', '/api/events', [ev(t.student.sid, 'up-shelfa', 3)], t.cookie)
    expect(await call(app, 'GET', '/api/student/export')).toMatchObject({ status: 401, body: { error: '请先登录' } })
    const r = await call(app, 'GET', '/api/student/export', undefined, s.cookie)
    expect(r.status).toBe(200)
    expect(r.headers['content-disposition']).toBe('attachment; filename="zhishi-export.a.json"')
    expect(r.headers['content-type']).toMatch(/^application\/json/)
    expect(r.headers['cache-control']).toBe('no-store')
    const acc = stored('export.a')
    expect(r.body).toEqual({ username: 'export.a', createdAt: acc.createdAt, settings: { ai: true }, events: [ev(sid, 'up-shelfa', 1), ev(sid, 'up-shelfb', 2, { type: 'writing_submit' })] })
    for (const secret of [acc.passwordHash, acc.inviteHash, acc.recoveryHash, acc.id, tokenOf(s.cookie), sha(tokenOf(s.cookie)), t.student.sid]) expect(r.text).not.toContain(secret)
    expect(r.text).not.toMatch(/[0-9a-f]{32}|scrypt/)

    const limited = await listen({ studentExportsPerHour: 2 })
    expect((await call(limited, 'GET', '/api/student/export', undefined, t.cookie)).status).toBe(200)
    expect((await call(limited, 'GET', '/api/student/export', undefined, t.cookie)).status).toBe(200)
    expect(await call(limited, 'GET', '/api/student/export', undefined, t.cookie)).toMatchObject({ status: 429, body: { error: '下载太频繁了，请过一会儿再试' } })
    expect((await call(limited, 'GET', '/api/student/export', undefined, s.cookie)).status).toBe(200)
  })
})

describe('请求格式', () => {
  it('学生的 POST、PUT 不是 JSON 一律 415「请求格式不对」，不处理', async () => {
    const s = await register(app, 'format.s')
    const urls = ['/api/student/register', '/api/student/login', '/api/student/logout', '/api/student/reset']
    for (const url of urls) {
      for (const type of ['application/x-www-form-urlencoded', 'text/plain']) {
        const r = await call(app, 'POST', url, 'username=format.s&password=x', s.cookie, { 'content-type': type })
        expect({ status: r.status, body: r.body }, `${url} ${type}`).toEqual({ status: 415, body: { error: '请求格式不对' } })
        expect(r.headers['access-control-allow-origin']).toBeUndefined()
      }
    }
    expect(await me(app, s.cookie)).toMatchObject({ username: 'format.s' })
  })
})
