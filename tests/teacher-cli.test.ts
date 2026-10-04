// 团队命令行工具 scripts/teacher.mjs：list、reset-password。用子进程跑（和服务器上一样），DATA_DIR 指向临时目录；
// 账号由同一个数据目录上的后端注册，重置密码后直接用后端验证（后端按文件 mtime 重新读 accounts.json，不用重启）
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createApp } from '../server/index.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zhishi-cli-'))
const accountsFile = path.join(dataDir, 'accounts.json')
const sessionsFile = path.join(dataDir, 'sessions.json')
const PASSWORD = 'old-password-1'

// ENV_FILE 指向不存在的文件：不读仓库里的 .env
function run(...args: string[]) {
  const r = spawnSync(process.execPath, ['scripts/teacher.mjs', ...args], { cwd: root, encoding: 'utf8', env: { ...process.env, DATA_DIR: dataDir, ENV_FILE: path.join(dataDir, 'missing.env') } })
  return { code: r.status, out: r.stdout, err: r.stderr }
}

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
const login = (username: string, password: string) => call('POST', '/api/auth/login', { username, password })
const me = async (cookie: string) => (await call('GET', '/api/auth/me', undefined, cookie)).body.teacher

beforeAll(async () => {
  app = await new Promise<App>((resolve) => {
    const server = createApp({ dataDir, uploadInvites: ['invite-cli-0001', 'invite-cli-0002'], log: () => {} }).listen(0, '127.0.0.1', () => resolve({ server, port: (server.address() as AddressInfo).port }))
  })
})
afterAll(() => {
  app.server.close()
})

describe('scripts/teacher.mjs', () => {
  it('还没有账号：list 说没有，退出码 0', () => {
    const r = run('list')
    expect(r.code).toBe(0)
    expect(r.out).toMatch(/还没有老师账号/)
  })

  let wang: { id: string; cookie: string }
  let li: { id: string; cookie: string }

  it('list：用户名、称呼、注册时间（北京时间）、讲义数（数 meta 里 owner 是这位老师的），不输出哈希和邀请码', async () => {
    const reg = async (invite: string, username: string, name: string) => {
      const r = await call('POST', '/api/auth/register', { invite, username, password: PASSWORD, name })
      expect(r.status).toBe(201)
      return { id: r.body.teacher.id as string, cookie: r.cookie! }
    }
    wang = await reg('invite-cli-0001', 'wang', '王老师')
    li = await reg('invite-cli-0002', 'li.laoshi', '李老师')
    const dir = path.join(dataDir, 'handouts')
    fs.mkdirSync(dir, { recursive: true })
    const meta = (id: string, o: Record<string, unknown>) => fs.writeFileSync(path.join(dir, `${id}.meta.json`), JSON.stringify({ id, ...o }))
    meta('up-a1', { owner: wang.id })
    meta('up-a2', { owner: wang.id, published: true })
    meta('up-old', { editKey: 'a'.repeat(32) }) // 没有 owner 的旧讲义不算谁的
    fs.writeFileSync(path.join(dir, 'up-a1.json'), '{}') // 讲义本身不算
    fs.writeFileSync(path.join(dir, 'up-bad.meta.json'), '{not json')

    const r = run('list')
    expect(r.code).toBe(0)
    const lines = r.out.trim().split('\n')
    expect(lines[0].split('\t')).toEqual(['用户名', '称呼', '注册时间（北京时间）', '讲义数'])
    const rows = lines.slice(1, -1).map((l) => l.split('\t'))
    expect(rows).toEqual([
      ['wang', '王老师', expect.stringMatching(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/), '2'],
      ['li.laoshi', '李老师', expect.stringMatching(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/), '0'],
    ])
    const created = readAccounts().find((t: { id: string }) => t.id === wang.id).createdAt
    expect(rows[0][2]).toBe(new Date(Date.parse(created) + 8 * 3600 * 1000).toISOString().slice(0, 16).replace('T', ' '))
    expect(lines[lines.length - 1]).toBe('共 2 个账号')
    expect(r.out + r.err).not.toMatch(/scrypt|invite|[0-9a-f]{64}|t-[0-9a-f]{12}/)
  })

  it('reset-password：生成 12 位临时密码（只输出这一次），能登录；旧密码不能；他所有旧会话作废，别人的不受影响；只写 accounts.json', async () => {
    const other = (await login('wang', PASSWORD)).cookie! // 另一台设备
    expect(await me(wang.cookie)).toMatchObject({ username: 'wang' })
    const sessionsBefore = fs.readFileSync(sessionsFile, 'utf8')
    const before = readAccounts()

    const r = run('reset-password', ' WANG ')
    expect(r.code).toBe(0)
    const m = r.out.match(/临时密码（只显示这一次）：(\S+)/)
    expect(m).not.toBeNull()
    const temp = m![1]
    expect(temp).toMatch(/^[a-km-zA-HJ-NP-Z2-9]{12}$/)
    expect(r.out.split(temp)).toHaveLength(2) // 只出现一次
    expect(r.out).toMatch(/wang（王老师）/)

    expect(fs.readFileSync(sessionsFile, 'utf8')).toBe(sessionsBefore)
    const after = readAccounts()
    const [w0, w1] = [before, after].map((list) => list.find((t: { id: string }) => t.id === wang.id))
    expect(w1).toEqual({ ...w0, passwordHash: expect.stringMatching(/^scrypt\$16384\$8\$1\$/), sessionsValidAfter: expect.any(Number) })
    expect(w1.passwordHash).not.toBe(w0.passwordHash)
    expect(JSON.stringify(after)).not.toContain(temp)
    expect(after.find((t: { id: string }) => t.id === li.id)).toEqual(before.find((t: { id: string }) => t.id === li.id))
    if (process.platform !== 'win32') expect(fs.statSync(accountsFile).mode & 0o077).toBe(0)
    expect(fs.readdirSync(dataDir).filter((f) => f.endsWith('.tmp'))).toEqual([])

    // 服务器不用重启就看到新密码
    for (const c of [wang.cookie, other]) expect(await me(c)).toBeNull()
    expect(await me(li.cookie)).toMatchObject({ username: 'li.laoshi' })
    expect((await login('wang', PASSWORD)).status).toBe(401)
    const fresh = await login('wang', temp)
    expect(fresh.status).toBe(200)
    expect(await me(fresh.cookie!)).toEqual({ id: wang.id, username: 'wang', name: '王老师' })
  })

  it('用户名不存在、参数不对：中文提示，退出码不是 0，不改 accounts.json', () => {
    const before = fs.readFileSync(accountsFile, 'utf8')
    const missing = run('reset-password', 'nobody')
    expect(missing.code).not.toBe(0)
    expect(missing.err).toMatch(/没有这个用户名：nobody/)
    expect(missing.out).toBe('')
    for (const args of [[], ['reset-password'], ['reset-password', 'wang', 'extra'], ['list', 'x'], ['delete', 'wang'], ['--help']]) {
      const r = run(...args)
      expect(r.code, args.join(' ')).not.toBe(0)
      expect(r.err, args.join(' ')).toMatch(/用法/)
    }
    expect(fs.readFileSync(accountsFile, 'utf8')).toBe(before)
  })
})

function readAccounts() {
  return JSON.parse(fs.readFileSync(accountsFile, 'utf8')).teachers
}
