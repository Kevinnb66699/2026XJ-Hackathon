// 学生账号的团队命令行工具 scripts/student.mjs：invite、list、revoke、reset-password、shelf add|rm|list。照 teacher-cli.test.ts：
// 用子进程跑，DATA_DIR 指向临时目录；生成的码、上架的讲义直接用同一个数据目录上的后端验证（后端按文件 mtime 重新读，不用重启）
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { MIN_AGE, createApp } from '../server/index.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zhishi-student-cli-'))
const file = (name: string) => path.join(dataDir, name)
const readJson = (name: string) => JSON.parse(fs.readFileSync(file(name), 'utf8'))
const sha = (s: string) => createHash('sha256').update(s).digest('hex')
const PASSWORD = 'old-password-1'
const now = new Date(Date.now() + 8 * 3600 * 1000)
const BIRTH = `${now.getUTCFullYear() - MIN_AGE - 3}-01` // 满 14 周岁（GUARDIAN_AGE）：不用勾家长那一项
const YOUNG = `${now.getUTCFullYear() - MIN_AGE + 1}-01`

// ENV_FILE 指向不存在的文件：不读仓库里的 .env
function run(...args: string[]) {
  const r = spawnSync(process.execPath, ['scripts/student.mjs', ...args], { cwd: root, encoding: 'utf8', env: { ...process.env, DATA_DIR: dataDir, ENV_FILE: path.join(dataDir, 'missing.env') } })
  return { code: r.status, out: r.stdout, err: r.stderr }
}
const codesIn = (out: string) => out.match(/^[A-HJKMNP-Z2-9]{4}-[A-HJKMNP-Z2-9]{4}-[A-HJKMNP-Z2-9]{4}$/gm) ?? []

type App = { server: Server; port: number }
let app: App
function call(method: string, url: string, body?: unknown, cookie?: string) {
  return new Promise<{ status: number; body: any; cookie?: string }>((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: app.port, path: url, method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) } }, (res) => {
      let text = ''
      res.setEncoding('utf8')
      res.on('data', (c) => (text += c))
      res.on('end', () => resolve({ status: res.statusCode!, body: JSON.parse(text), cookie: res.headers['set-cookie']?.[0]?.split(';')[0] }))
    })
    req.on('error', reject)
    req.end(body === undefined ? undefined : JSON.stringify(body))
  })
}
const register = (invite: string, username: string, birth = BIRTH) => call('POST', '/api/student/register', { invite, username, password: PASSWORD, birth, agree: true })
const login = (username: string, password: string) => call('POST', '/api/student/login', { username, password })
const me = async (cookie: string) => (await call('GET', '/api/student/me', undefined, cookie)).body.student

beforeAll(async () => {
  app = await new Promise<App>((resolve) => {
    const server = createApp({ dataDir, authPerMinute: 1000, log: () => {} }).listen(0, '127.0.0.1', () => resolve({ server, port: (server.address() as AddressInfo).port }))
  })
})
afterAll(() => {
  app.server.close()
})

describe('scripts/student.mjs', () => {
  it('什么都还没有：list 说没有，退出码 0', () => {
    const r = run('list')
    expect(r.code).toBe(0)
    expect(r.out).toMatch(/还没有学生邀请码/)
    expect(r.out).toMatch(/还没有学生账号/)
  })

  let batch1: string[] = []
  let batch2: string[] = []
  let mingCode = '' // ming 注册时拿到的找回码

  it('invite：生成 N 个 12 位的码（只输出这一次），文件里只有 sha256、批次、生成时间；600；码能注册，再追加一批不影响前一批', async () => {
    const r = run('invite', '3', 'beta1')
    expect(r.code).toBe(0)
    batch1 = codesIn(r.out)
    expect(batch1).toHaveLength(3)
    expect(new Set(batch1).size).toBe(3)
    for (const c of batch1) expect(r.out.split(c)).toHaveLength(2)
    const text = fs.readFileSync(file('student-invites.json'), 'utf8')
    for (const c of batch1) {
      expect(text).not.toContain(c)
      expect(text).not.toContain(c.replace(/-/g, ''))
    }
    expect(JSON.parse(text).invites).toEqual(batch1.map((c) => ({ hash: sha(c.replace(/-/g, '')), batch: 'beta1', createdAt: expect.any(String) })))
    if (process.platform !== 'win32') expect(fs.statSync(file('student-invites.json')).mode & 0o077).toBe(0)
    batch2 = codesIn(run('invite', '2', 'beta-2').out)
    expect(batch2).toHaveLength(2)
    expect(readJson('student-invites.json').invites).toHaveLength(5)
    // 后端不用重启就认这些码；输入时不分大小写、「-」可以不打
    const ming = await register(batch1[0].toLowerCase(), 'ming')
    expect(ming.status).toBe(200)
    mingCode = ming.body.recoveryCode
    expect((await register(batch2[0].replace(/-/g, ''), 'hong')).status).toBe(200)
    expect((await register(batch1[0], 'ming2')).status).toBe(409)
    expect(fs.readdirSync(dataDir).filter((f) => f.endsWith('.tmp'))).toEqual([])
  })

  it('list：各批次的共、已用（含年龄不够作废的）、作废、可用；学生账号的用户名、注册时间、最近登录、AI；不输出哈希、sid、账号 id', async () => {
    expect((await register(batch1[1], 'tooyoung', YOUNG)).status).toBe(400) // 年龄不够：码作废，算已用
    const r = run('list')
    expect(r.code).toBe(0)
    const lines = r.out.trim().split('\n')
    expect(lines[0].split('\t')).toEqual(['批次', '生成时间（北京时间）', '共', '已用', '作废', '可用'])
    expect(lines[1].split('\t')).toEqual(['beta1', expect.stringMatching(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/), '3', '2', '0', '1'])
    expect(lines[2].split('\t')).toEqual(['beta-2', expect.any(String), '2', '1', '0', '1'])
    expect(lines[3].split('\t')).toEqual(['用户名', '注册时间（北京时间）', '最近登录（北京时间）', 'AI 写作检查'])
    const day = /^\d{4}-\d{2}-\d{2}$/
    expect(lines.slice(4, -1).map((l) => l.split('\t'))).toEqual([
      ['ming', expect.stringMatching(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/), expect.stringMatching(day), '开'], // 注册时默认开着
      ['hong', expect.any(String), expect.stringMatching(day), '开'],
    ])
    expect(lines[lines.length - 1]).toBe('共 2 个账号')
    const students = readJson('students.json').students
    for (const s of students) for (const v of [s.sid, s.id, s.inviteHash, s.passwordHash]) expect(r.out).not.toContain(v)
    expect(r.out + r.err).not.toMatch(/scrypt|[0-9a-f]{64}|u-[0-9a-f]{16}|st-[0-9a-f]{12}/)
  })

  it('revoke：只作废这一批还没用的码（后端马上不认），用过的、别的批次不动；批次不存在报错', async () => {
    const r = run('revoke', 'beta1')
    expect(r.code).toBe(0)
    expect(r.out).toMatch(/批次 beta1：作废了 1 个还没用的码/)
    const invites = readJson('student-invites.json').invites
    expect(invites.filter((x: { revokedAt?: string }) => x.revokedAt).map((x: { hash: string }) => x.hash)).toEqual([sha(batch1[2].replace(/-/g, ''))])
    expect(await register(batch1[2], 'late')).toMatchObject({ status: 403 })
    expect((await login('ming', PASSWORD)).status).toBe(200) // 已经注册的账号不受影响
    expect(run('revoke', 'beta1').out).toMatch(/作废了 0 个/)
    expect(run('list').out.split('\n')[1].split('\t').slice(2)).toEqual(['3', '2', '1', '0'])
    const missing = run('revoke', 'nope')
    expect(missing.code).not.toBe(0)
    expect(missing.err).toMatch(/没有这个批次：nope/)
    expect((await register(batch2[1], 'fang')).status).toBe(200)
  })

  it('reset-password：12 位临时密码和 8 位新找回码（只输出这一次），能登录、旧密码不能；旧找回码作废、新的能用；他所有旧会话作废，别人的不受影响；只改这个账号的密码哈希、找回码哈希和 sessionsValidAfter', async () => {
    const a = (await login('ming', PASSWORD)).cookie!
    const b = (await login('hong', PASSWORD)).cookie!
    const before = readJson('students.json')
    const sessionsBefore = fs.readFileSync(file('student-sessions.json'), 'utf8')
    const r = run('reset-password', ' MING ')
    expect(r.code).toBe(0)
    const temp = r.out.match(/临时密码（只显示这一次）：(\S+)/)![1]
    expect(temp).toMatch(/^[a-km-zA-HJ-NP-Z2-9]{12}$/)
    expect(r.out.split(temp)).toHaveLength(2)
    const code = r.out.match(/新找回码（只显示这一次，旧的已经不能用了）：(\S+)/)![1]
    expect(code).toMatch(/^[A-HJKMNP-Z2-9]{8}$/)
    expect(r.out.split(code)).toHaveLength(2)
    expect(r.out).not.toContain('找回码不变')
    const after = readJson('students.json')
    const [m0, m1] = [before, after].map((d) => d.students.find((s: { username: string }) => s.username === 'ming'))
    expect(m1).toEqual({ ...m0, passwordHash: expect.stringMatching(/^scrypt\$16384\$8\$1\$/), recoveryHash: sha(code), sessionsValidAfter: expect.any(Number) })
    expect(m1.passwordHash).not.toBe(m0.passwordHash)
    expect(m0.recoveryHash).toBe(sha(mingCode))
    expect(JSON.stringify(after)).not.toContain(code)
    expect(after.usedInvites).toEqual(before.usedInvites)
    expect(after.students.find((s: { username: string }) => s.username === 'hong')).toEqual(before.students.find((s: { username: string }) => s.username === 'hong'))
    expect(JSON.stringify(after)).not.toContain(temp)
    expect(fs.readFileSync(file('student-sessions.json'), 'utf8')).toBe(sessionsBefore)
    if (process.platform !== 'win32') expect(fs.statSync(file('students.json')).mode & 0o077).toBe(0)
    expect(await me(a)).toBeNull()
    expect(await me(b)).toMatchObject({ username: 'hong' })
    expect((await login('ming', PASSWORD)).status).toBe(401)
    expect((await login('ming', temp)).status).toBe(200)
    // 旧找回码作废；新的能改密码（后端再换一个新的给他）
    const reset = (c: string) => call('POST', '/api/student/reset', { username: 'ming', code: c, newPassword: 'ming-own-pass-1' })
    expect((await reset(mingCode)).status).toBe(403)
    const ok = await reset(code.toLowerCase())
    expect(ok.status).toBe(200)
    expect(ok.body.recoveryCode).toMatch(/^[A-HJKMNP-Z2-9]{8}$/)
    expect((await login('ming', 'ming-own-pass-1')).status).toBe(200)
  })

  it('shelf：add 上架（新的在前），讲义要在；有老师讲解的拒绝上架；rm 下架；list 列 id、标题、上架时间；后端的上架列表跟着变', async () => {
    const dir = file('handouts')
    fs.mkdirSync(dir, { recursive: true })
    const put = (id: string, title: string, sentences: unknown[]) => {
      fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify({ id, title, sentences }))
      fs.writeFileSync(path.join(dir, `${id}.meta.json`), JSON.stringify({ id, title, published: false, owner: 't-team' }))
    }
    put('up-clean1', 'Phones', [{ id: 'S01', text: 'A.' }])
    put('up-clean2', 'Robots', [{ id: 'S01', text: 'A.', teacherNote: '  ' }])
    put('up-noted', 'Notes', [{ id: 'S01', text: 'A.' }, { id: 'S02', text: 'B.', teacherNote: '先找谁做了什么。' }])
    const cookie = (await login('hong', PASSWORD)).cookie!
    const shelf = async () => (await call('GET', '/api/student/shelf', undefined, cookie)).body.handouts

    expect(run('shelf', 'list').out).toMatch(/架上还没有讲义/)
    expect(run('shelf', 'add', 'up-clean1')).toMatchObject({ code: 0, out: expect.stringMatching(/已上架 up-clean1（Phones）/) })
    expect(run('shelf', 'add', 'up-clean2').code).toBe(0)
    expect(await shelf()).toEqual([{ id: 'up-clean2', title: 'Robots' }, { id: 'up-clean1', title: 'Phones' }])
    expect(run('shelf', 'add', 'up-clean1')).toMatchObject({ code: 0, out: expect.stringMatching(/已经在架上了/) })
    expect(readJson('shelf.json').handouts).toHaveLength(2)
    if (process.platform !== 'win32') expect(fs.statSync(file('shelf.json')).mode & 0o077).toBe(0)

    const before = fs.readFileSync(file('shelf.json'), 'utf8')
    const noted = run('shelf', 'add', 'up-noted')
    expect(noted.code).not.toBe(0)
    expect(noted.err).toMatch(/up-noted 有 1 句老师讲解.*不能上架/)
    for (const [id, msg] of [['up-missing', /没有这份讲义：up-missing/], ['../secret', /讲义 id 不对/], ['mini-phones', /讲义 id 不对/]] as const) {
      const r = run('shelf', 'add', id)
      expect(r.code, id).not.toBe(0)
      expect(r.err, id).toMatch(msg)
    }
    expect(fs.readFileSync(file('shelf.json'), 'utf8')).toBe(before)

    const list = run('shelf', 'list')
    expect(list.code).toBe(0)
    expect(list.out.trim().split('\n').map((l) => l.split('\t'))).toEqual([
      ['讲义 id', '标题', '上架时间（北京时间）'],
      ['up-clean2', 'Robots', expect.stringMatching(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/)],
      ['up-clean1', 'Phones', expect.any(String)],
    ])
    expect(run('shelf', 'rm', 'up-clean2')).toMatchObject({ code: 0, out: expect.stringMatching(/已下架 up-clean2/) })
    expect(await shelf()).toEqual([{ id: 'up-clean1', title: 'Phones' }])
    const gone = run('shelf', 'rm', 'up-clean2')
    expect(gone.code).not.toBe(0)
    expect(gone.err).toMatch(/架上没有这份讲义：up-clean2/)
  })

  it('用户名不存在、参数不对：中文提示，退出码不是 0，不改任何文件', () => {
    const names = ['students.json', 'student-invites.json', 'shelf.json']
    const before = names.map((n) => fs.readFileSync(file(n), 'utf8'))
    const missing = run('reset-password', 'nobody')
    expect(missing.code).not.toBe(0)
    expect(missing.err).toMatch(/没有这个用户名：nobody/)
    expect(missing.out).toBe('')
    for (const args of [['invite', '0', 'b'], ['invite', '201', 'b'], ['invite', '1.5', 'b'], ['invite', 'x', 'b']]) {
      const r = run(...args)
      expect(r.code, args.join(' ')).not.toBe(0)
      expect(r.err, args.join(' ')).toMatch(/个数要是 1 到 200 的整数/)
    }
    for (const b of ['中文', 'a b', 'x'.repeat(33), '../x']) expect(run('invite', '1', b).err, b).toMatch(/批次名只能用/)
    for (const args of [[], ['invite', '1'], ['invite', '1', 'b', 'c'], ['list', 'x'], ['revoke'], ['reset-password'], ['reset-password', 'a', 'b'], ['shelf'], ['shelf', 'add'], ['shelf', 'list', 'x'], ['shelf', 'move', 'up-x'], ['--help']]) {
      const r = run(...args)
      expect(r.code, args.join(' ')).not.toBe(0)
      expect(r.err, args.join(' ')).toMatch(/用法/)
    }
    expect(names.map((n) => fs.readFileSync(file(n), 'utf8'))).toEqual(before)
    expect(fs.readdirSync(dataDir).filter((f) => f.endsWith('.tmp'))).toEqual([])
  })
})
