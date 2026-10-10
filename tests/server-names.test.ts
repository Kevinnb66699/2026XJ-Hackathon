// 学生姓名加密存储（NAME_KEY）：classes.json 里 seats[].name 是 AES-256-GCM 密文，只在班级 owner 的接口（详情、建班、改班）里解密；
// 学生接口、事件、清理、删除照常，学生拿不到姓名和密文；密钥不对时姓名为空、班级上多一个 nameError；旧明文照常能读，启动时一次改成密文（幂等）；
// 没给 nameKey 照旧明文。请求用 node:http 发（同 server-classes.test.ts）；这里不调用模型
import { spawn } from 'node:child_process'
import { createDecipheriv, randomBytes } from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { createApp, loadConfig } from '../server/index.mjs'
import type { App as ServerApp, BuildArticle, ServerConfig } from '../server/index.mjs'

const KEY = randomBytes(32).toString('hex')
const OTHER_KEY = randomBytes(32).toString('hex')
const INVITES = Array.from({ length: 20 }, (_, i) => `invite-names-${String(i).padStart(4, '0')}`)
let nextInvite = 0
const logs: string[] = []
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const TEXT = 'Many schools are toying with the idea of banning phones in class. '.repeat(5).trim()
const build: BuildArticle = async (input, opts) => ({ handout: { id: opts.id, title: input.title }, report: { errors: 0 } })
const CONFIRM = { school: true, consent: true }
const NAMES = ['张三', '李四', '王小五']
const ROSTER = [{ n: 1, name: NAMES[0] }, { n: 2, name: NAMES[1] }, { n: 3, name: NAMES[2] }, { n: 4 }]
// 'enc:v1:' + base64url(12 字节 IV) + ':' + base64url(16 字节 tag) + ':' + base64url(密文)
const SEALED = /^enc:v1:[A-Za-z0-9_-]{16}:[A-Za-z0-9_-]{22}:[A-Za-z0-9_-]+$/

const newDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'zhishi-names-'))
const classesFile = (dir: string) => path.join(dir, 'classes.json')
const raw = (dir: string) => fs.readFileSync(classesFile(dir), 'utf8')
const storedSeats = (dir: string, id: string) => JSON.parse(raw(dir)).classes.find((c: { id: string }) => c.id === id).seats as { n: number; name: string; noAi?: boolean }[]
// 别的程序改了 classes.json（先写临时文件再改名，inode 变了，服务器会重新读）
function rewrite(dir: string, fn: (data: any) => any) {
  const tmp = `${classesFile(dir)}.test.tmp`
  fs.writeFileSync(tmp, JSON.stringify(fn(JSON.parse(raw(dir)))), { mode: 0o600 })
  fs.renameSync(tmp, classesFile(dir))
}
// 用测试自己的 node:crypto 按存储格式解开，确认算法和格式
function open(value: string, key = KEY) {
  const [iv, tag, data] = value.slice('enc:v1:'.length).split(':').map((s) => Buffer.from(s, 'base64url'))
  const d = createDecipheriv('aes-256-gcm', Buffer.from(key, 'hex'), iv)
  d.setAuthTag(tag)
  return Buffer.concat([d.update(data), d.final()]).toString('utf8')
}
async function until(ok: () => boolean) {
  for (let i = 0; i < 200 && !ok(); i++) await sleep(5)
  expect(ok()).toBe(true)
}

type App = { server: Server; port: number; app: ServerApp; logs: string[] }
type Res = { status: number; body: any; headers: http.IncomingHttpHeaders }
const opened: App[] = []
function listen(dataDir: string, config: Partial<ServerConfig> = {}) {
  const own: string[] = []
  const app = createApp({ dataDir, apiKey: 'sk-test-not-a-real-key', uploadInvites: INVITES, authPerMinute: 1000, uploadsPerTeacherPerHour: 1000, uploadsPerDay: 1000, buildArticle: build, log: (l: string) => (logs.push(l), own.push(l)), ...config })
  return new Promise<App>((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const a = { server, port: (server.address() as AddressInfo).port, app, logs: own }
      opened.push(a)
      resolve(a)
    })
  })
}
afterAll(() => {
  for (const a of opened) a.server.close()
})

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
    req.end(body === undefined ? undefined : JSON.stringify(body))
  })
}
async function register(a: App, username: string) {
  const r = await call(a, 'POST', '/api/auth/register', { invite: INVITES[nextInvite++], username, password: 'password-for-tests' })
  expect(r.status, JSON.stringify(r.body)).toBe(201)
  return String(r.headers['set-cookie']?.[0]).split(';')[0]
}
const newClass = async (a: App, cookie: string, roster: unknown = ROSTER) => {
  const r = await call(a, 'POST', '/api/classes', { name: '高一 3 班', roster, confirm: CONFIRM }, cookie)
  expect(r.status, JSON.stringify(r.body)).toBe(201)
  return r.body.class
}
const detail = (a: App, id: string, cookie: string) => call(a, 'GET', `/api/classes/${id}`, undefined, cookie)
async function upload(a: App, cookie: string) {
  const r = await call(a, 'POST', '/api/uploads', { title: 'Phones', text: TEXT }, cookie)
  expect(r.status).toBe(202)
  for (let i = 0; i < 300; i++) {
    if ((await call(a, 'GET', `/api/uploads/${r.body.jobId}`, undefined, cookie)).body.status === 'done') return r.body.jobId as string
    await sleep(5)
  }
  throw new Error('job did not finish')
}
// 名单里有姓名的座号（4 号没填）
const named = (seats: { n: number; name: string }[]) => seats.filter((s) => s.n !== 4)
const noSecretsIn = (text: string) => {
  for (const name of [...NAMES, '张三丰', '赵六']) expect(text).not.toContain(name)
  expect(text).not.toContain('enc:v1:')
}

describe('姓名加密存储', () => {
  it('有 nameKey：建班、换名单写进 classes.json 的姓名是 enc:v1: 密文（每个随机 IV，看不到明文），空姓名存空字符串；建班、详情、改班的响应里是明文', async () => {
    const dir = newDir()
    const a = await listen(dir, { nameKey: KEY })
    const cookie = await register(a, 'names.a')
    const twins = [{ n: 1, name: '张三' }, { n: 2, name: '张三' }, { n: 3 }]
    const cls = await newClass(a, cookie, twins)
    expect(cls.seats.map((s: { name: string }) => s.name)).toEqual(['张三', '张三', ''])
    expect(cls).not.toHaveProperty('nameError')
    let seats = storedSeats(dir, cls.id)
    expect(seats[0].name).toMatch(SEALED)
    expect(seats[1].name).toMatch(SEALED)
    expect(seats[0].name).not.toBe(seats[1].name) // 同一个姓名两次加密结果不一样
    expect(seats[2].name).toBe('')
    expect(open(seats[0].name)).toBe('张三')
    expect(open(seats[1].name)).toBe('张三')
    expect(raw(dir)).not.toContain('张三')
    expect((await detail(a, cls.id, cookie)).body.class.seats.map((s: { name: string }) => s.name)).toEqual(['张三', '张三', ''])

    // 换名单：留下的座号改名、新座号，响应是明文，存的是新的密文
    const r = await call(a, 'POST', `/api/classes/${cls.id}`, { roster: [{ n: 1, name: '张三丰' }, { n: 5, name: '赵六' }], confirm: CONFIRM }, cookie)
    expect(r.status).toBe(200)
    expect(r.body.class.seats.map((s: { n: number; name: string }) => [s.n, s.name])).toEqual([[1, '张三丰'], [5, '赵六']])
    expect(r.body.class).not.toHaveProperty('nameError')
    seats = storedSeats(dir, cls.id)
    expect(seats.map((s) => open(s.name))).toEqual(['张三丰', '赵六'])
    noSecretsIn(raw(dir).replace(/enc:v1:/g, ''))

    // 关 AI、只改班名：姓名的密文原样不动
    const before = storedSeats(dir, cls.id).map((s) => s.name)
    expect((await call(a, 'POST', `/api/classes/${cls.id}/seats/1/ai`, { enabled: false }, cookie)).status).toBe(200)
    const renamed = await call(a, 'POST', `/api/classes/${cls.id}`, { name: '高一 4 班' }, cookie)
    expect(renamed.body.class.seats.map((s: { name: string; ai: boolean }) => [s.name, s.ai])).toEqual([['张三丰', false], ['赵六', true]])
    expect(storedSeats(dir, cls.id).map((s) => s.name)).toEqual(before)
    expect(storedSeats(dir, cls.id)[0].noAi).toBe(true)
    // 班级列表只有人数；日志里没有姓名和密文
    noSecretsIn(JSON.stringify((await call(a, 'GET', '/api/classes', undefined, cookie)).body))
    noSecretsIn(a.logs.join('\n'))
  })

  it('有 nameKey 时学生接口和事件流程照常：进班、找回、发事件、拿回作答、老师看记录、清空座号、到期清理、删除班级；学生拿到的响应里没有姓名和密文', async () => {
    const dir = newDir()
    const a = await listen(dir, { nameKey: KEY })
    const cookie = await register(a, 'names.b')
    const c = (await newClass(a, cookie)).id
    const h = await upload(a, cookie)
    expect((await call(a, 'POST', `/api/handouts/${h}/publish`, { classes: [c] }, cookie)).status).toBe(200)
    const student: Res[] = []
    const seen = async (p: Promise<Res>) => {
      const r = await p
      student.push(r)
      return r
    }

    const grid = await seen(call(a, 'GET', `/api/join/${c}?h=${h}`))
    expect(grid.body).toEqual({ className: '高一 3 班', seats: [1, 2, 3, 4].map((n) => ({ n, taken: false })) })
    const joined = await seen(call(a, 'POST', `/api/join/${c}`, { h, seat: 1, confirm: true }))
    expect(joined.status).toBe(201)
    const { sid, token, recoveryCode } = joined.body
    const ev = await seen(call(a, 'POST', '/api/events', [{ sid, handoutId: h, type: 'tap_word', ts: Date.now(), lemma: 'toy' }, { sid: 's-nobody', handoutId: h, type: 'tap_word', ts: Date.now() }]))
    expect(ev.body).toEqual({ ok: true, accepted: 1 })
    const mine = await seen(call(a, 'GET', `/api/my-progress?h=${h}&c=${c}`, undefined, undefined, { 'x-student-token': token }))
    expect(mine.status).toBe(200)
    expect(mine.body.events).toHaveLength(1)
    const back = await seen(call(a, 'POST', `/api/join/${c}/recover`, { h, seat: 1, code: recoveryCode }))
    expect(back.body).toMatchObject({ seat: 1, sid })
    for (const r of student) noSecretsIn(JSON.stringify(r.body))

    // 老师端照常：按班看记录、详情里座号对上 sid、姓名是明文
    const events = await call(a, 'GET', `/api/events?handoutId=${h}&classId=${c}`, undefined, cookie)
    expect(events.body.map((e: { sid: string }) => e.sid)).toEqual([sid])
    expect((await detail(a, c, cookie)).body.class.seats[0]).toMatchObject({ n: 1, name: '张三', joined: true, sid })
    // 清空座号删掉这个 sid 的记录；到期清理、删除班级不出错
    expect((await call(a, 'POST', `/api/classes/${c}/seats/1/clear`, {}, cookie)).body).toEqual({ ok: true, deletedEvents: 1 })
    expect(await a.app.cleanup()).toEqual({ files: 0, events: 0, cacheFiles: 0 })
    expect(a.logs).toContain('cleanup 0 files 0 events 0 cache files')
    expect((await call(a, 'POST', `/api/classes/${c}/delete`, {}, cookie)).body).toEqual({ ok: true, deletedEvents: 0 })
    expect(JSON.parse(raw(dir)).classes).toEqual([])
    expect(a.logs.filter((l) => /decrypt|names/.test(l))).toEqual([])
    noSecretsIn(a.logs.join('\n'))
  })

  it('解不开（密钥不对、没有密钥、密文坏了）：这个座号 name 为空字符串，班级上多一个 nameError: true，照常 200；日志一行错误类型，不带姓名和密文', async () => {
    const dir = newDir()
    const a = await listen(dir, { nameKey: KEY })
    const cookie = await register(a, 'names.c') // sessions.json 在同一个目录：下面几个服务都认这个登录
    const cls = await newClass(a, cookie)
    const sealed = storedSeats(dir, cls.id).map((s) => s.name)
    const empty = { ...cls, seats: cls.seats.map((s: object) => ({ ...s, name: '' })), nameError: true }

    for (const [config, code] of [[{ nameKey: OTHER_KEY }, 'NAME_AUTH_FAILED'], [{}, 'NAME_NO_KEY']] as const) {
      const b = await listen(dir, config)
      const r = await detail(b, cls.id, cookie)
      expect(r.status).toBe(200)
      expect(r.body.class).toEqual({ ...empty, name: expect.any(String) }) // 第二轮时班名已经改过
      expect(b.logs).toEqual([`name decrypt failed ${code}`, expect.stringMatching(/^#\d+ GET \/api\/classes\/c-[0-9a-f]{12} 200 \d+ms$/)])
      // 改班名照常，响应里同样标出来；存的密文不动
      const renamed = await call(b, 'POST', `/api/classes/${cls.id}`, { name: '改过的班名' }, cookie)
      expect(renamed.status).toBe(200)
      expect(renamed.body.class).toMatchObject({ name: '改过的班名', nameError: true })
      expect(storedSeats(dir, cls.id).map((s) => s.name)).toEqual(sealed)
    }

    // 密文坏了：改掉 2 号的一个字符、3 号少一段；1 号照常解开
    rewrite(dir, (data) => {
      const seats = data.classes[0].seats
      seats[1].name = seats[1].name.slice(0, -2) + (seats[1].name.endsWith('AA') ? 'BB' : 'AA')
      seats[2].name = seats[2].name.split(':').slice(0, 3).join(':')
      return data
    })
    const n0 = a.logs.length
    const r = await detail(a, cls.id, cookie)
    expect(r.status).toBe(200)
    expect(r.body.class.seats.map((s: { name: string }) => s.name)).toEqual(['张三', '', '', ''])
    expect(r.body.class.nameError).toBe(true)
    expect(a.logs.slice(n0).filter((l) => l.startsWith('name decrypt failed'))).toEqual(['name decrypt failed NAME_AUTH_FAILED'])
    noSecretsIn(logs.join('\n'))
  })

  it('旧明文：没 nameKey 时照旧存明文；有 nameKey 时启动后一次改成密文（日志只记个数），再启动不再改；之后读到的明文照常返回', async () => {
    const dir = newDir()
    const plainApp = await listen(dir)
    const cookie = await register(plainApp, 'names.d')
    const cls = await newClass(plainApp, cookie)
    expect(storedSeats(dir, cls.id).map((s) => s.name)).toEqual([...NAMES, ''])
    expect((await detail(plainApp, cls.id, cookie)).body.class).toEqual(cls)

    // 有 nameKey 启动：明文姓名一次改成密文，空姓名不动；详情照旧是明文
    const a = await listen(dir, { nameKey: KEY })
    await until(() => named(storedSeats(dir, cls.id)).every((s) => SEALED.test(s.name)))
    expect(storedSeats(dir, cls.id).map((s) => (s.name ? open(s.name) : s.name))).toEqual([...NAMES, ''])
    await until(() => a.logs.includes('names encrypted 3'))
    expect(raw(dir)).not.toContain('张三')
    expect((await detail(a, cls.id, cookie)).body.class).toEqual(cls)
    expect(fs.statSync(classesFile(dir)).mode & 0o777).toBe(0o600)
    expect(fs.readdirSync(dir).filter((f) => f.endsWith('.tmp'))).toEqual([])

    // 再启动一次：都加密过了，文件不改。迁移排在写队列里，后面这个不写盘的改动（座号不存在）回来时迁移一定跑完了
    const text = raw(dir)
    const again = await listen(dir, { nameKey: KEY })
    expect((await call(again, 'POST', `/api/classes/${cls.id}/seats/99/ai`, { enabled: false }, cookie)).status).toBe(400)
    expect(raw(dir)).toBe(text)
    expect(again.logs.filter((l) => l.startsWith('names'))).toEqual([])

    // 别的程序写进来的明文（没有 enc:v1: 前缀）照常返回，不报 nameError
    rewrite(dir, (data) => {
      data.classes[0].seats[0].name = '老名字'
      return data
    })
    const r = (await detail(again, cls.id, cookie)).body.class
    expect(r.seats.map((s: { name: string }) => s.name)).toEqual(['老名字', NAMES[1], NAMES[2], ''])
    expect(r).not.toHaveProperty('nameError')
  })

  it('配置：NAME_KEY 是 64 位十六进制才用（去首尾空白，大小写都行），别的忽略、日志一行不带值；createApp 给了不合格的 nameKey 直接报错', () => {
    const dir = newDir()
    const ENV_FILE = path.join(dir, 'missing.env')
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {})
    try {
      expect(loadConfig({ ENV_FILE }).nameKey).toBe('')
      expect(loadConfig({ ENV_FILE, NAME_KEY: ` ${KEY} ` }).nameKey).toBe(KEY)
      expect(loadConfig({ ENV_FILE, NAME_KEY: KEY.toUpperCase() }).nameKey).toBe(KEY.toUpperCase())
      const fromFile = path.join(dir, 'names.env')
      fs.writeFileSync(fromFile, `NAME_KEY="${KEY}"\n`)
      expect(loadConfig({ ENV_FILE: fromFile }).nameKey).toBe(KEY)
      expect(spy).not.toHaveBeenCalled()
      const bad = ['', 'abc', KEY.slice(1), `${KEY}0`, 'g'.repeat(64), `${KEY.slice(0, 32)} ${KEY.slice(32, 63)}`, randomBytes(32).toString('base64')]
      for (const v of bad) expect(loadConfig({ ENV_FILE, NAME_KEY: v }).nameKey, v).toBe('')
      expect(spy.mock.calls.map((c) => c[0])).toEqual(bad.map(() => 'NAME_KEY 不是 64 位十六进制，已忽略，姓名不加密'))
    } finally {
      spy.mockRestore()
    }
    expect(() => createApp({ dataDir: dir, nameKey: 'abc', log: () => {} })).toThrow('nameKey 要是 64 位十六进制')
  })

  it('直接运行（node server/index.mjs）：启动日志一行「姓名加密 on / off」，不出现密钥', async () => {
    const dir = newDir()
    const ENV_FILE = path.join(dir, 'test.env')
    fs.writeFileSync(ENV_FILE, `NAME_KEY=${KEY}\n`)
    const script = fileURLToPath(new URL('../server/index.mjs', import.meta.url))
    const startup = (env: Record<string, string>) =>
      new Promise<string>((resolve, reject) => {
        const child = spawn(process.execPath, [script], { cwd: dir, env: { PATH: process.env.PATH ?? '', PORT: '0', DATA_DIR: path.join(dir, 'data'), ...env }, stdio: ['ignore', 'pipe', 'pipe'] })
        let out = ''
        const timer = setTimeout(() => child.kill(), 5000)
        child.stdout.on('data', (b) => {
          out += b
          if (out.includes('姓名加密')) child.kill()
        })
        child.on('error', reject)
        child.on('exit', () => {
          clearTimeout(timer)
          resolve(out)
        })
      })
    const on = await startup({ ENV_FILE })
    expect(on.split('\n')).toContain('姓名加密 on')
    expect(on).not.toContain(KEY)
    const off = await startup({ ENV_FILE: path.join(dir, 'missing.env') })
    expect(off.split('\n')).toContain('姓名加密 off')
  })
})
