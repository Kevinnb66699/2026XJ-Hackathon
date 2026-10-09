// 老师账号：邀请码注册、用户名 + 密码登录、会话 cookie、退出、限次、只收 JSON；讲义归上传它的老师（别的老师、没登录、没有 owner 的旧讲义都不能动）
// 请求用 node:http 发（同 server-upload.test.ts）；这里不调用模型，后端不发出站请求
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createApp, hashPassword, loadConfig, verifyPassword } from '../server/index.mjs'
import type { BuildArticle, ServerConfig } from '../server/index.mjs'

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zhishi-auth-'))
const logs: string[] = []
const INVITES = Array.from({ length: 50 }, (_, i) => `invite-auth-${String(i).padStart(4, '0')}`)
let nextInvite = 0
const invite = () => INVITES[nextInvite++]
const PASSWORD = 'correct-horse-9'
const sha = (s: string) => createHash('sha256').update(s).digest('hex')
const accountsFile = path.join(dataDir, 'accounts.json')
const sessionsFile = path.join(dataDir, 'sessions.json')
const readJson = (f: string) => JSON.parse(fs.readFileSync(f, 'utf8'))

// 上传的讲义：S01 有题，两句都有讲解（AI 起草时没有要起草的句子，不会去调用模型）
const TEXT = 'Many schools are toying with the idea of banning phones in class. '.repeat(5).trim()
const build: BuildArticle = async (input, opts) => ({
  handout: {
    id: opts.id,
    title: input.title,
    sentences: [
      { id: 'S01', text: 'A.', teacherNote: '讲解一', question: { id: 'S01-q', prompt: 'Who?', options: ['a', 'b'], answer: 0 } },
      { id: 'S02', text: 'B.', teacherNote: '讲解二' },
    ],
  },
  report: { errors: 0 },
})

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

// body 是字符串就原样发（测请求格式），否则发 JSON；cookie 是上一次 Set-Cookie 里的「名=值」
function call(app: App, method: string, url: string, body?: unknown, cookie?: string, headers: Record<string, string> = {}) {
  return new Promise<Res>((resolve, reject) => {
    const h: Record<string, string> = { 'content-type': 'application/json', ...(cookie ? { cookie } : {}), ...headers }
    const req = http.request({ host: '127.0.0.1', port: app.port, path: url, method, headers: h }, (res) => {
      let text = ''
      res.setEncoding('utf8')
      res.on('data', (c) => (text += c))
      res.on('end', () => resolve({ status: res.statusCode!, body: JSON.parse(text), headers: res.headers }))
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

async function register(app: App, username: string, o: Record<string, unknown> = {}) {
  const r = await call(app, 'POST', '/api/auth/register', { invite: invite(), username, password: PASSWORD, ...o })
  expect(r.status, JSON.stringify(r.body)).toBe(201)
  return { cookie: cookieOf(r), teacher: r.body.teacher as { id: string; username: string; name: string } }
}
const login = (app: App, username: unknown, password: unknown) => call(app, 'POST', '/api/auth/login', { username, password })
const me = async (app: App, cookie?: string) => (await call(app, 'GET', '/api/auth/me', undefined, cookie)).body.teacher

let app: App
beforeAll(async () => {
  app = await listen()
})
afterAll(() => {
  for (const a of open) a.server.close()
})

describe('注册', () => {
  it('没配置邀请码：带什么码都 403，不建账号', async () => {
    const closed = await listen({ uploadInvites: [] })
    for (const code of [undefined, INVITES[49], '']) {
      expect(await call(closed, 'POST', '/api/auth/register', { invite: code, username: 'nobody', password: PASSWORD })).toMatchObject({ status: 403, body: { error: '注册目前只对受邀老师开放' } })
    }
    expect(fs.existsSync(accountsFile)).toBe(false)
  })

  it('邀请码缺失、不对、类型不对 403，而且先于字段校验（没有邀请码的人试不出用户名被占没有）', async () => {
    const code = INVITES[49]
    for (const bad of [undefined, '', 'invite-auth-002', code + '1', code.toUpperCase(), ` ${code}`, 123, [code]]) {
      for (const fields of [{ username: 'okname', password: PASSWORD }, { username: 'x', password: '1' }]) {
        const r = await call(app, 'POST', '/api/auth/register', { invite: bad, ...fields })
        expect(r, JSON.stringify(bad)).toMatchObject({ status: 403, body: { error: '邀请码不对，请向知适团队确认' } })
        expect(r.body.fields).toBeUndefined()
        expect(r.headers['set-cookie']).toBeUndefined()
      }
    }
  })

  it('成功：201，用户名去空白转小写，称呼去空白；空称呼用用户名；同时登录（Set-Cookie）', async () => {
    const r = await call(app, 'POST', '/api/auth/register', { invite: invite(), username: '  Wang.Laoshi ', password: PASSWORD, name: ' 王老师 ' })
    expect(r.status).toBe(201)
    expect(r.body).toEqual({ teacher: { id: expect.stringMatching(/^t-[0-9a-f]{12}$/), username: 'wang.laoshi', name: '王老师' } })
    expect(await me(app, cookieOf(r))).toEqual(r.body.teacher)
    for (const name of [undefined, '', '   ', null]) {
      const { teacher } = await register(app, `noname-${String(name).trim() || 'blank'}${nextInvite}`, { name })
      expect(teacher.name).toBe(teacher.username)
    }
  })

  it('字段不合格 400，按字段给提示（fields）；邀请码没被用掉', async () => {
    const code = invite()
    const send = (o: Record<string, unknown>) => call(app, 'POST', '/api/auth/register', { invite: code, username: 'li_laoshi', password: PASSWORD, ...o })
    const fields = async (o: Record<string, unknown>) => {
      const r = await send(o)
      expect(r.status, JSON.stringify(o)).toBe(400)
      expect(r.headers['set-cookie']).toBeUndefined()
      return r.body.fields
    }
    for (const username of [undefined, 'ab', ' ab ', 'x'.repeat(33)]) expect(await fields({ username }), String(username)).toEqual({ username: '用户名要 3 到 32 个字符' })
    for (const username of ['_li', '.li', '-li', 'li laoshi', '李老师', 'li@school', 'li/../x']) {
      expect(await fields({ username }), username).toEqual({ username: '用户名只能用字母、数字和 _ . -，开头要是字母或数字' })
    }
    for (const password of [undefined, 12345678, '1234567', 'x'.repeat(129)]) expect(await fields({ password }), String(password)).toEqual({ password: '密码要 8 到 128 个字符' })
    expect(await fields({ username: 'Li.Laoshi', password: 'li.LAOSHI' })).toEqual({ password: '密码不能和用户名一样' })
    expect(await fields({ name: '王'.repeat(21) })).toEqual({ name: '称呼不超过 20 个字' })
    expect(await fields({ name: '王\n老师' })).toEqual({ name: '称呼里不能有换行之类的特殊字符' })
    expect(await fields({ name: 42 })).toEqual({ name: '称呼的格式不对，请刷新页面后再试' })
    const all = await send({ username: 'a', password: 'short', name: '王'.repeat(21) })
    expect(all.body).toEqual({ error: '有 3 处要改，见标红的地方', fields: { username: '用户名要 3 到 32 个字符', password: '密码要 8 到 128 个字符', name: '称呼不超过 20 个字' } })
    // 边界：3 和 32 个字符的用户名、8 和 128 个字符的密码、20 个字的称呼都可以；这个码之前没被用掉
    expect((await send({ username: 'l.i', password: 'x'.repeat(128), name: '王'.repeat(20) })).status).toBe(201)
    expect((await call(app, 'POST', '/api/auth/register', { invite: invite(), username: 'l'.repeat(32), password: '12345678' })).status).toBe(201)
  })

  it('一个邀请码只能注册一个账号：再用就 409（先于字段校验）', async () => {
    const code = invite()
    expect((await call(app, 'POST', '/api/auth/register', { invite: code, username: 'zhao', password: PASSWORD })).status).toBe(201)
    for (const o of [{ username: 'zhao2', password: PASSWORD }, { username: 'x', password: '1' }, { username: 'zhao', password: PASSWORD }]) {
      expect(await call(app, 'POST', '/api/auth/register', { invite: code, ...o }), JSON.stringify(o)).toMatchObject({ status: 409, body: { error: '这个邀请码已经注册过账号了' } })
    }
  })

  it('用户名不分大小写，已经有人用了 409，带 fields.username；码没被用掉', async () => {
    await register(app, 'qian')
    const code = invite()
    for (const username of ['QIAN', ' Qian ']) {
      const r = await call(app, 'POST', '/api/auth/register', { invite: code, username, password: PASSWORD })
      expect(r, username).toMatchObject({ status: 409, body: { error: '这个用户名已经有人用了', fields: { username: expect.stringMatching(/已经有人用了/) } } })
    }
    expect((await call(app, 'POST', '/api/auth/register', { invite: code, username: 'qian2', password: PASSWORD })).status).toBe(201)
  })

  it('同时用同一个码注册两次、或同时注册同一个用户名：只成功一个', async () => {
    const code = invite()
    const [a, b] = await Promise.all([
      call(app, 'POST', '/api/auth/register', { invite: code, username: 'race-a', password: PASSWORD }),
      call(app, 'POST', '/api/auth/register', { invite: code, username: 'race-b', password: PASSWORD }),
    ])
    expect([a.status, b.status].sort()).toEqual([201, 409])
    const [c, d] = await Promise.all([
      call(app, 'POST', '/api/auth/register', { invite: invite(), username: 'race-same', password: PASSWORD }),
      call(app, 'POST', '/api/auth/register', { invite: invite(), username: 'Race-Same', password: PASSWORD }),
    ])
    expect([c.status, d.status].sort()).toEqual([201, 409])
    const teachers = readJson(accountsFile).teachers
    expect(teachers.filter((t: { inviteHash: string }) => t.inviteHash === sha(code))).toHaveLength(1)
    expect(teachers.filter((t: { username: string }) => t.username === 'race-same')).toHaveLength(1)
  })

  it('accounts.json 里没有明文密码和邀请码：密码是 scrypt 哈希，邀请码只留 sha256；文件只给本用户读写；日志不记用户名、密码、邀请码、token', async () => {
    const from = logs.length
    const code = invite()
    const pw = 'very-secret-pass-77'
    const r = await call(app, 'POST', '/api/auth/register', { invite: code, username: 'sun.laoshi', password: pw, name: '孙老师' })
    const token = tokenOf(cookieOf(r))
    await login(app, 'sun.laoshi', pw)
    const text = fs.readFileSync(accountsFile, 'utf8')
    for (const secret of [pw, code, token]) expect(text).not.toContain(secret)
    const t = JSON.parse(text).teachers.find((x: { username: string }) => x.username === 'sun.laoshi')
    expect(t).toEqual({ id: r.body.teacher.id, username: 'sun.laoshi', name: '孙老师', passwordHash: expect.stringMatching(/^scrypt\$16384\$8\$1\$[0-9a-f]{32}\$[0-9a-f]{128}$/), createdAt: expect.any(String), inviteHash: sha(code) })
    expect(new Date(t.createdAt).toISOString()).toBe(t.createdAt)
    expect(await verifyPassword(pw, t.passwordHash)).toBe(true)
    expect(await verifyPassword(pw + 'x', t.passwordHash)).toBe(false)
    if (process.platform !== 'win32') for (const f of [accountsFile, sessionsFile]) expect(fs.statSync(f).mode & 0o077).toBe(0)
    const lines = logs.slice(from).join('\n')
    for (const secret of [pw, code, token, 'sun.laoshi', '孙老师']) expect(lines).not.toContain(secret)
    expect(fs.readdirSync(dataDir).filter((f) => f.endsWith('.tmp'))).toEqual([])
  })
})

describe('会话 cookie', () => {
  it('属性：HttpOnly、SameSite=Lax、Path=/api、30 天、Secure；cookieSecure 关掉时没有 Secure；退出时 Max-Age=0', async () => {
    const r = await call(app, 'POST', '/api/auth/register', { invite: invite(), username: 'cookie.a', password: PASSWORD })
    const c = setCookie(r)
    expect(c).toMatch(/^zhishi_session=[0-9a-f]{64}; /)
    const attrs = c.split('; ').slice(1)
    expect(attrs.sort()).toEqual(['HttpOnly', 'Max-Age=2592000', 'Path=/api', 'SameSite=Lax', 'Secure'])
    expect(setCookie(await login(app, 'cookie.a', PASSWORD)).split('; ').slice(1).sort()).toEqual(attrs)
    const out = setCookie(await call(app, 'POST', '/api/auth/logout', {}, cookieOf(r)))
    expect(out.split('; ').sort()).toEqual(['HttpOnly', 'Max-Age=0', 'Path=/api', 'SameSite=Lax', 'Secure', 'zhishi_session='])

    const insecure = await listen({ cookieSecure: false })
    const r2 = await call(insecure, 'POST', '/api/auth/register', { invite: invite(), username: 'cookie.b', password: PASSWORD })
    expect(setCookie(r2).split('; ').slice(1).sort()).toEqual(['HttpOnly', 'Max-Age=2592000', 'Path=/api', 'SameSite=Lax'])
    expect(setCookie(await call(insecure, 'POST', '/api/auth/logout', {}, cookieOf(r2)))).not.toMatch(/Secure/)
  })

  it('读取配置：默认 Secure；COOKIE_INSECURE=1 时不加；默认登录注册每分钟 60 次', () => {
    const ENV_FILE = path.join(dataDir, 'missing.env')
    expect(loadConfig({ ENV_FILE })).toMatchObject({ cookieSecure: true, authPerMinute: 60 })
    expect(loadConfig({ ENV_FILE, COOKIE_INSECURE: '1' }).cookieSecure).toBe(false)
    expect(loadConfig({ ENV_FILE, COOKIE_INSECURE: '0' }).cookieSecure).toBe(true)
  })
})

describe('登录', () => {
  let zhou: { cookie: string; teacher: { id: string } }
  beforeAll(async () => {
    zhou = await register(app, 'zhou', { name: '周老师' })
  })

  it('成功：200 {teacher}，Set-Cookie 一个新会话；用户名不分大小写、去首尾空白', async () => {
    const r = await login(app, ' ZHOU ', PASSWORD)
    expect(r.status).toBe(200)
    expect(r.body).toEqual({ teacher: { id: zhou.teacher.id, username: 'zhou', name: '周老师' } })
    expect(cookieOf(r)).not.toBe(zhou.cookie)
    expect(await me(app, cookieOf(r))).toEqual(r.body.teacher)
    expect(await me(app, zhou.cookie)).toEqual(r.body.teacher) // 注册时的会话还在
  })

  it('密码不对、用户名不存在、类型不对：一律 401「用户名或密码不对」，不 Set-Cookie', async () => {
    const denied = { status: 401, body: { error: '用户名或密码不对' } }
    for (const [u, p] of [['zhou', PASSWORD + 'x'], ['zhou', PASSWORD.toUpperCase()], ['zhou', ''], ['nobody-here', PASSWORD], ['', ''], [42, PASSWORD], ['zhou', 42], [undefined, undefined]]) {
      const r = await login(app, u, p)
      expect({ status: r.status, body: r.body }, JSON.stringify([u, p])).toEqual(denied)
      expect(r.headers['set-cookie']).toBeUndefined()
    }
  })

  it('同一用户名失败 10 次后 429（密码对了也不行），别的用户名不受影响；成功登录清零', async () => {
    await register(app, 'wuu')
    await register(app, 'zheng')
    for (let i = 0; i < 9; i++) expect((await login(app, 'wuu', 'wrong-password')).status).toBe(401)
    expect((await login(app, 'wuu', PASSWORD)).status).toBe(200) // 第 10 次之前成功：清零
    for (let i = 0; i < 10; i++) expect((await login(app, 'WUU', 'wrong-password')).status, String(i)).toBe(401)
    for (const p of ['wrong-password', PASSWORD]) expect(await login(app, 'wuu', p)).toMatchObject({ status: 429, body: { error: '试错太多次了，请 15 分钟后再试' } })
    expect((await login(app, 'zheng', PASSWORD)).status).toBe(200)
    // 不存在的用户名也一样计数，和存在的用户名分不出来
    for (let i = 0; i < 10; i++) expect((await login(app, 'ghost', PASSWORD)).status).toBe(401)
    expect((await login(app, 'ghost', PASSWORD)).status).toBe(429)
  })

  it('同一用户名同时来一批错密码：查次数和记次数之间没有空隙，只有 10 个去验证密码（401），其余 429；之后密码对了也 429', async () => {
    await register(app, 'sun.burst')
    const all = await Promise.all(Array.from({ length: 20 }, () => login(app, 'sun.burst', 'wrong-password')))
    expect(all.map((r) => r.status).sort()).toEqual([...Array(10).fill(401), ...Array(10).fill(429)])
    expect((await login(app, 'sun.burst', PASSWORD)).status).toBe(429)
  })

  it('全站登录 + 注册每分钟限次，超了 429', async () => {
    const busy = await listen({ authPerMinute: 3 })
    expect((await login(busy, 'zhou', PASSWORD)).status).toBe(200)
    expect((await login(busy, 'nobody', PASSWORD)).status).toBe(401)
    expect((await call(busy, 'POST', '/api/auth/register', { invite: 'wrong-invite', username: 'x1y', password: PASSWORD })).status).toBe(403)
    expect(await login(busy, 'zhou', PASSWORD)).toMatchObject({ status: 429, body: { error: '现在登录的人太多了，请稍后再试' } })
    expect(await call(busy, 'POST', '/api/auth/register', { invite: invite(), username: 'x2y', password: PASSWORD })).toMatchObject({ status: 429, body: { error: '现在登录的人太多了，请稍后再试' } })
    // 已经登录的不受影响
    expect(await me(busy, zhou.cookie)).toMatchObject({ username: 'zhou' })
  })
})

describe('会话', () => {
  it('没登录、cookie 格式不对、不认识的 token：me 都是 {teacher:null}；不缓存', async () => {
    const r = await call(app, 'GET', '/api/auth/me')
    expect(r.body).toEqual({ teacher: null })
    expect(r.headers['cache-control']).toBe('no-store')
    for (const c of ['zhishi_session=', 'zhishi_session=abc', `zhishi_session=${'A'.repeat(64)}`, `zhishi_session=${'a'.repeat(64)}`, `other=${'a'.repeat(64)}`]) expect(await me(app, c), c).toBeNull()
  })

  it('cookie 请求头里有别的 cookie 也能认出会话', async () => {
    const { cookie, teacher } = await register(app, 'feng')
    expect(await me(app, `a=1; ${cookie}; b=2`)).toEqual(teacher)
  })

  it('sessions.json 只存 token 的 sha256，不存 token 本身；会话 30 天后到期', async () => {
    const { cookie, teacher } = await register(app, 'chen')
    const token = tokenOf(cookie)
    const text = fs.readFileSync(sessionsFile, 'utf8')
    expect(text).not.toContain(token)
    const s = JSON.parse(text)[sha(token)]
    expect(s).toEqual({ teacher: teacher.id, createdAt: expect.any(Number), expiresAt: s.createdAt + 30 * 24 * 3600 * 1000 })
  })

  it('退出：删掉服务器上的会话，旧 cookie 不能再用；别的设备的会话不受影响；没登录也 200', async () => {
    const { cookie, teacher } = await register(app, 'chu')
    const other = cookieOf(await login(app, 'chu', PASSWORD))
    const r = await call(app, 'POST', '/api/auth/logout', {}, cookie)
    expect(r.status).toBe(200)
    expect(r.body).toEqual({ ok: true })
    expect(await me(app, cookie)).toBeNull()
    expect(readJson(sessionsFile)[sha(tokenOf(cookie))]).toBeUndefined()
    expect(await me(app, other)).toEqual(teacher)
    // 旧 cookie 不能再上传
    expect((await call(app, 'POST', '/api/uploads', { title: 'x', text: TEXT }, cookie)).status).toBe(401)
    for (const c of [undefined, cookie, 'zhishi_session=junk']) expect((await call(app, 'POST', '/api/auth/logout', {}, c)).body).toEqual({ ok: true })
  })

  it('过期的会话不认；下次写会话文件时顺手删掉', async () => {
    const { cookie } = await register(app, 'wei')
    const key = sha(tokenOf(cookie))
    const all = readJson(sessionsFile)
    all[key] = { ...all[key], expiresAt: Date.now() - 1000 }
    fs.writeFileSync(sessionsFile, JSON.stringify(all))
    expect(await me(app, cookie)).toBeNull()
    expect(readJson(sessionsFile)[key]).toBeDefined()
    await login(app, 'zhou', PASSWORD)
    expect(readJson(sessionsFile)[key]).toBeUndefined()
  })

  it('服务器重启（新建 createApp 指向同一个数据目录）后会话还在', async () => {
    const { cookie, teacher } = await register(app, 'jiang')
    const restarted = await listen()
    expect(await me(restarted, cookie)).toEqual(teacher)
  })

  it('团队重置密码正好落在登录验证旧密码期间：这次登录换来的会话照样作废，旧密码之后也登不上', async () => {
    const { teacher } = await register(app, 'race.reset')
    const passwordHash = await hashPassword('brand-new-pass-1')
    const pending = login(app, 'race.reset', PASSWORD)
    await new Promise((ok) => setTimeout(ok, 8)) // scrypt 要十几到几十毫秒：这时登录多半已经读完旧账号、还在验证旧密码
    // 照命令行工具的写法：新哈希 + sessionsValidAfter 设成现在，写临时文件再改名（同步写完，中间插不进请求）
    const data = readJson(accountsFile)
    const tmp = `${accountsFile}.race.tmp`
    fs.writeFileSync(tmp, JSON.stringify({ ...data, teachers: data.teachers.map((t: { id: string }) => (t.id === teacher.id ? { ...t, passwordHash, sessionsValidAfter: Date.now() } : t)) }))
    fs.renameSync(tmp, accountsFile)
    const r = await pending
    if (r.status === 200) expect(await me(app, cookieOf(r))).toBeNull()
    else expect(r.status).toBe(401) // 机器慢时登录读到的已经是新账号
    expect((await login(app, 'race.reset', PASSWORD)).status).toBe(401)
    expect((await login(app, 'race.reset', 'brand-new-pass-1')).status).toBe(200)
  })

  it('accounts.json 被直接改了（团队命令行工具）：服务器看得到；老师不在了、会话早于 sessionsValidAfter 都是 null', async () => {
    const { cookie, teacher } = await register(app, 'shen')
    const { cookie: keep, teacher: other } = await register(app, 'han')
    expect(await me(app, cookie)).toEqual(teacher)
    const data = readJson(accountsFile)
    fs.writeFileSync(accountsFile, JSON.stringify({ ...data, teachers: data.teachers.map((t: { id: string }) => (t.id === teacher.id ? { ...t, sessionsValidAfter: Date.now() + 1000 } : t)) }))
    expect(await me(app, cookie)).toBeNull()
    expect(await me(app, keep)).toEqual(other)
    fs.writeFileSync(accountsFile, JSON.stringify({ ...data, teachers: data.teachers.filter((t: { id: string }) => t.id !== other.id) }))
    expect(await me(app, keep)).toBeNull()
    expect(await me(app, cookie)).toEqual(teacher) // sessionsValidAfter 也跟着改回去了
  })
})

describe('讲义归上传它的老师', () => {
  let A: { cookie: string; teacher: { id: string } }
  let B: { cookie: string; teacher: { id: string } }
  let id: string
  let cid: string // A 的班，下面「上传的老师都可以」里建，发布到这个班
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
  async function upload(who: { cookie: string }, title: string) {
    const r = await call(app, 'POST', '/api/uploads', { title, text: TEXT }, who.cookie)
    expect(r.status).toBe(202)
    expect(Object.keys(r.body)).toEqual(['jobId'])
    for (let i = 0; i < 300; i++) {
      const s = await call(app, 'GET', `/api/uploads/${r.body.jobId}`, undefined, who.cookie)
      if (s.body.status !== 'running') return { jobId: r.body.jobId as string, job: s }
      await sleep(10)
    }
    throw new Error('job did not finish')
  }
  const legacy = 'up-legacyowner'
  const legacyPublished = 'up-legacypub'

  beforeAll(async () => {
    A = await register(app, 'owner.a')
    B = await register(app, 'other.b')
    id = (await upload(A, 'A first')).jobId
    const dir = path.join(dataDir, 'handouts')
    // 账号功能之前上传的讲义：meta 里没有 owner（有的只有编辑口令）
    for (const [x, published] of [[legacy, false], [legacyPublished, true]] as const) {
      fs.writeFileSync(path.join(dir, `${x}.json`), JSON.stringify({ id: x, title: 'Old', sentences: [{ id: 'S01', text: 'A.', question: { id: 'S01-q', prompt: 'Q', options: ['a', 'b'], answer: 0 } }] }))
      fs.writeFileSync(path.join(dir, `${x}.meta.json`), JSON.stringify({ id: x, title: 'Old', createdAt: new Date().toISOString(), published, editKey: 'a'.repeat(32) }))
    }
  })

  const s01q = { sentences: { S01: { question: { prompt: 'Who else?', options: ['a', 'b'], answer: 1 } } } }
  const actions = (h: string) => [
    { name: '发布', method: 'POST', url: `/api/handouts/${h}/publish`, body: {} },
    { name: '写讲解', method: 'POST', url: `/api/handouts/${h}/notes`, body: { notes: { S01: '新讲解' } } },
    { name: '改题目和梯子', method: 'POST', url: `/api/handouts/${h}/edits`, body: s01q },
    { name: '写讲解', method: 'POST', url: `/api/handouts/${h}/notes/draft`, body: {} },
    { name: '看全班的学习记录', method: 'GET', url: `/api/events?handoutId=${h}`, body: undefined },
  ]
  const ok = (url: string) => (url.startsWith('/api/events') ? { ok: false } : {})

  it('上传要登录；meta 记 owner，不再有编辑口令；查进度只有提交的老师能查（别人、没登录都 404），任务对象里没有 owner', async () => {
    expect(await call(app, 'POST', '/api/uploads', { title: 'x', text: TEXT })).toMatchObject({ status: 401, body: { error: '请先登录' } })
    const meta = readJson(path.join(dataDir, 'handouts', `${id}.meta.json`))
    expect(meta).toEqual({ id, title: 'A first', createdAt: expect.any(String), published: false, report: { errors: 0 }, owner: A.teacher.id })
    const lost = { status: 404, body: { error: '找不到这个生成任务，请重新提交' } }
    for (const c of [undefined, B.cookie, 'zhishi_session=junk']) expect(await call(app, 'GET', `/api/uploads/${id}`, undefined, c), String(c)).toMatchObject(lost)
    const job = await call(app, 'GET', `/api/uploads/${id}`, undefined, A.cookie)
    expect(job.body).toEqual({ status: 'done', handoutId: id, title: 'A first', report: { errors: 0 } })
  })

  it('没发布的讲义：只有上传的老师能读（预览），别人、没登录都 404，请求头 X-Edit-Key 不认', async () => {
    const missing = { status: 404, body: { error: '没有这份讲义' } }
    for (const c of [undefined, B.cookie]) expect(await call(app, 'GET', `/api/handouts/${id}`, undefined, c), String(c)).toMatchObject(missing)
    expect(await call(app, 'GET', `/api/handouts/${id}`, undefined, undefined, { 'x-edit-key': 'a'.repeat(32) })).toMatchObject(missing)
    const got = await call(app, 'GET', `/api/handouts/${id}`, undefined, A.cookie)
    expect(got.status).toBe(200)
    expect(got.body.title).toBe('A first')
  })

  it('没登录 401；别的老师 403（只有上传这篇文章的老师能……）；讲义不存在 404；都不改文件', async () => {
    const file = path.join(dataDir, 'handouts', `${id}.json`)
    const before = [fs.readFileSync(file, 'utf8'), fs.readFileSync(path.join(dataDir, 'handouts', `${id}.meta.json`), 'utf8')]
    for (const a of actions(id)) {
      expect(await call(app, a.method, a.url, a.body), a.url).toMatchObject({ status: 401, body: { ...ok(a.url), error: '请先登录' } })
      expect(await call(app, a.method, a.url, a.body, 'zhishi_session=' + 'f'.repeat(64)), a.url).toMatchObject({ status: 401 })
      expect(await call(app, a.method, a.url, a.body, B.cookie), a.url).toMatchObject({ status: 403, body: { ...ok(a.url), error: `只有上传这篇文章的老师能${a.name}` } })
    }
    for (const a of actions('up-missing')) {
      expect(await call(app, a.method, a.url, a.body, A.cookie), a.url).toMatchObject({ status: 404, body: { ...ok(a.url), error: '没有这份讲义' } })
      expect((await call(app, a.method, a.url, a.body)).status, a.url).toBe(401)
    }
    expect([fs.readFileSync(file, 'utf8'), fs.readFileSync(path.join(dataDir, 'handouts', `${id}.meta.json`), 'utf8')]).toEqual(before)
  })

  it('上传的老师都可以：写讲解、改题、起草（这篇每句都有讲解：过了权限检查后 400）、发布到自己的班、按班看全班记录；发布后谁都能读', async () => {
    expect(await call(app, 'POST', `/api/handouts/${id}/notes`, { notes: { S01: '新讲解' } }, A.cookie)).toMatchObject({ status: 200, body: { ok: true, count: 2 } })
    expect((await call(app, 'POST', `/api/handouts/${id}/edits`, s01q, A.cookie)).status).toBe(200)
    expect(await call(app, 'POST', `/api/handouts/${id}/notes/draft`, {}, A.cookie)).toMatchObject({ status: 400, body: { error: '每一句都已经有讲解了' } })
    cid = (await call(app, 'POST', '/api/classes', { name: '高一 1 班', roster: [{ n: 1, name: '张三' }] }, A.cookie)).body.class.id
    expect(await call(app, 'POST', `/api/handouts/${id}/publish`, { classes: [cid] }, A.cookie)).toMatchObject({ status: 200, body: { ok: true, classes: [cid] } })
    expect(readJson(path.join(dataDir, 'handouts', `${id}.meta.json`))).toMatchObject({ published: true, owner: A.teacher.id, classes: [cid] })
    const { sid } = (await call(app, 'POST', `/api/join/${cid}`, { h: id, seat: 1 })).body
    await call(app, 'POST', '/api/events', { sid, handoutId: id, type: 'tap_word', ts: 1 })
    expect(await call(app, 'GET', `/api/events?handoutId=${id}&classId=${cid}`, undefined, A.cookie)).toMatchObject({ status: 200, body: [{ sid, handoutId: id, type: 'tap_word', ts: 1 }] })
    for (const c of [undefined, B.cookie, A.cookie]) {
      const r = await call(app, 'GET', `/api/handouts/${id}`, undefined, c)
      expect(r.status, String(c)).toBe(200)
      expect(r.body.sentences[0]).toMatchObject({ teacherNote: '新讲解', question: { prompt: 'Who else?' } })
    }
    // 发布了也只有上传的老师能改、能看全班记录
    for (const a of actions(id)) expect((await call(app, a.method, a.url, a.body, B.cookie)).status, a.url).toBe(403)
  })

  it('没有 owner 的旧讲义（包括带编辑口令的）：谁都不能改、不能发布、不能看全班记录；没发布的谁都读不到，已发布的照旧谁都能读', async () => {
    for (const who of [A, B]) {
      for (const a of actions(legacy)) expect((await call(app, a.method, a.url, a.body, who.cookie)).status, a.url).toBe(403)
      for (const a of actions(legacyPublished)) expect((await call(app, a.method, a.url, a.body, who.cookie)).status, a.url).toBe(403)
      expect((await call(app, 'GET', `/api/handouts/${legacy}`, undefined, who.cookie, { 'x-edit-key': 'a'.repeat(32) })).status).toBe(404)
      expect((await call(app, 'GET', `/api/handouts/${legacyPublished}`, undefined, who.cookie)).status).toBe(200)
    }
    expect((await call(app, 'GET', `/api/handouts/${legacyPublished}`)).status).toBe(200)
    expect(readJson(path.join(dataDir, 'handouts', `${legacy}.meta.json`)).published).toBe(false)
  })

  it('我上传过的：要登录；只列自己的，新的在前，带标题、发布状态和发布到的班', async () => {
    expect(await call(app, 'GET', '/api/my/handouts')).toMatchObject({ status: 401, body: { error: '请先登录' } })
    await sleep(5)
    const second = (await upload(A, 'A second')).jobId
    const b1 = (await upload(B, 'B only')).jobId
    const mine = await call(app, 'GET', '/api/my/handouts', undefined, A.cookie)
    expect(mine.status).toBe(200)
    expect(mine.body).toEqual({
      handouts: [
        { id: second, title: 'A second', createdAt: expect.any(String), published: false, classes: [] },
        { id, title: 'A first', createdAt: expect.any(String), published: true, classes: [cid] },
      ],
    })
    expect((await call(app, 'GET', '/api/my/handouts', undefined, B.cookie)).body.handouts.map((h: { id: string }) => h.id)).toEqual([b1])
    const fresh = await register(app, 'fresh.c')
    expect((await call(app, 'GET', '/api/my/handouts', undefined, fresh.cookie)).body).toEqual({ handouts: [] })
  })
})

describe('请求格式', () => {
  it('改东西的 POST 不是 JSON 一律 415「请求格式不对」，不处理；不加 CORS 头', async () => {
    const { cookie } = await register(app, 'format.t')
    const urls = ['/api/auth/register', '/api/auth/login', '/api/auth/logout', '/api/uploads', '/api/handouts/up-x/publish', '/api/handouts/up-x/notes', '/api/handouts/up-x/edits', '/api/handouts/up-x/notes/draft']
    for (const url of urls) {
      for (const type of ['application/x-www-form-urlencoded', 'text/plain', 'multipart/form-data; boundary=x']) {
        const r = await call(app, 'POST', url, 'username=format.t&password=x', cookie, { 'content-type': type })
        expect({ status: r.status, body: r.body }, `${url} ${type}`).toEqual({ status: 415, body: { error: '请求格式不对' } })
        expect(r.headers['access-control-allow-origin']).toBeUndefined()
      }
    }
    // 退出被拒，会话还在
    expect(await me(app, cookie)).toMatchObject({ username: 'format.t' })
    expect((await call(app, 'POST', '/api/auth/logout', '', cookie, { 'content-type': 'application/json; charset=utf-8' })).status).toBe(200)
  })
})
