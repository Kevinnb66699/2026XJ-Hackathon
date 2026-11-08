// 加密滚动备份：在临时目录里跑 deploy/backup.sh 和 restore-backup.sh（DATA_DIR、BACKUP_DIR、KEY_FILE、DELETIONS_DIR 都指到临时目录，不碰服务器上的默认路径）。
// 要本机的 openssl 支持 -pbkdf2（OpenSSL 1.1.1 以上；服务器是 OpenSSL 3.0.2），不支持时整组跳过（比如 macOS 自带的 LibreSSL）。
// 恢复时按删除台账再删一遍（scripts/student.mjs apply-deletions）不用 openssl，单独一组：台账由真的后端注销账号时写
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import { DELETIONS_FILE, MIN_AGE, createApp } from '../server/index.mjs'

const BACKUP = fileURLToPath(new URL('../deploy/backup.sh', import.meta.url))
const RESTORE = fileURLToPath(new URL('../deploy/restore-backup.sh', import.meta.url))
const ROOT = fileURLToPath(new URL('..', import.meta.url))
const pbkdf2 = spawnSync('openssl', ['enc', '-aes-256-cbc', '-md', 'sha256', '-pbkdf2', '-iter', '1', '-pass', 'pass:x'], { input: 'x' }).status === 0
const NAME = /^zhishi-data-\d{8}-\d{6}\.tar\.gz\.enc$/
const KEY = 'backup-key-for-tests-0123456789abcdef'
const DAY = 24 * 3600 * 1000
const MINUTE = 60 * 1000

const newDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'zhishi-backup-'))
const perm = (p: string) => fs.statSync(p).mode & 0o777
function run(script: string, args: string[], env: Record<string, string>, cwd?: string) {
  const r = spawnSync('bash', [script, ...args], { cwd, env: { PATH: process.env.PATH ?? '', ...env }, encoding: 'utf8' })
  return { status: r.status, stdout: r.stdout, stderr: r.stderr }
}
// 一份假的数据目录：账号、班级、事件、讲义，外加一个写到一半的临时文件（不进备份）
function setup() {
  const root = newDir()
  const data = path.join(root, 'data')
  fs.mkdirSync(path.join(data, 'handouts'), { recursive: true })
  fs.writeFileSync(path.join(data, 'accounts.json'), JSON.stringify({ teachers: [{ id: 't-1', username: 'wang' }] }))
  fs.writeFileSync(path.join(data, 'classes.json'), JSON.stringify({ classes: [{ id: 'c-1', seats: [{ n: 1, name: '张三' }] }] }))
  fs.writeFileSync(path.join(data, 'events-up-abc.jsonl'), '{"sid":"s-1","type":"tap_word"}\n'.repeat(50))
  fs.writeFileSync(path.join(data, 'handouts', 'up-abc.json'), JSON.stringify({ id: 'up-abc', title: 'Phones' }))
  fs.writeFileSync(path.join(data, 'classes.json.0a1b2c.tmp'), '{"half')
  const key = path.join(root, 'backup.key')
  fs.writeFileSync(key, `${KEY}\n`, { mode: 0o600 })
  const backups = path.join(root, 'var', 'backups', 'zhishi') // 还不存在：backup.sh 建
  // 恢复时用的：删除台账在数据目录外面（目录后端启动时就建好）；ENV_FILE 指向不存在的文件，不读仓库里的 .env
  const deletions = path.join(root, 'deletions')
  fs.mkdirSync(deletions, { mode: 0o700 })
  const restoreEnv = { KEY_FILE: key, DATA_DIR: data, DELETIONS_DIR: deletions, ENV_FILE: path.join(root, 'missing.env') }
  return { root, data, key, backups, deletions, restoreEnv, env: { DATA_DIR: data, BACKUP_DIR: backups, KEY_FILE: key } }
}
const noLedger = (deletions: string) => `删除台账里还没有记录（${path.join(deletions, DELETIONS_FILE)}），不用删。\n`
// 目录里的全部文件：相对路径 → 内容
function tree(dir: string, base = dir): Record<string, string> {
  const out: Record<string, string> = {}
  for (const f of fs.readdirSync(dir)) {
    const p = path.join(dir, f)
    if (fs.statSync(p).isDirectory()) Object.assign(out, tree(p, base))
    else out[path.relative(base, p)] = fs.readFileSync(p, 'utf8')
  }
  return out
}
const withoutTmp = (t: Record<string, string>) => Object.fromEntries(Object.entries(t).filter(([k]) => !k.endsWith('.tmp')))
const backupsIn = (dir: string) => fs.readdirSync(dir).filter((f) => NAME.test(f))
const age = (file: string, ms: number) => {
  fs.writeFileSync(file, 'old')
  const t = new Date(Date.now() - ms)
  fs.utimesSync(file, t, t)
}

describe.skipIf(!pbkdf2)('加密滚动备份 deploy/backup.sh、restore-backup.sh（本机 openssl 不支持 -pbkdf2 时整组跳过）', () => {
  it('打包加密到 BACKUP_DIR（不存在就建，700）：文件名 zhishi-data-YYYYMMDD-HHMMSS.tar.gz.enc、600、是 openssl 加密格式、看不到明文；只输出一行文件名和大小，不输出密钥，不留 .tmp', () => {
    const s = setup()
    const r = run(BACKUP, [], s.env)
    expect(r.status, r.stderr).toBe(0)
    const files = fs.readdirSync(s.backups)
    expect(files).toHaveLength(1)
    expect(files[0]).toMatch(NAME)
    const file = path.join(s.backups, files[0])
    expect(r.stdout).toBe(`${files[0]} ${fs.statSync(file).size} 字节\n`)
    expect(r.stdout + r.stderr).not.toContain(KEY)
    expect(perm(file)).toBe(0o600)
    expect(perm(s.backups)).toBe(0o700)
    const bytes = fs.readFileSync(file)
    expect(bytes.subarray(0, 8).toString('latin1')).toBe('Salted__')
    for (const plain of ['张三', 'tap_word', 'accounts.json']) expect(bytes.includes(Buffer.from(plain))).toBe(false)
  })

  it('restore-backup.sh 用同一个密钥解到新目录（不存在就建），和原数据一样（写到一半的 .tmp 不在里面）；密钥不对失败', () => {
    const s = setup()
    expect(run(BACKUP, [], s.env).status).toBe(0)
    const file = path.join(s.backups, backupsIn(s.backups)[0])
    const target = path.join(s.root, 'drill', 'data')
    const r = run(RESTORE, [file, target], s.restoreEnv)
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout).toBe(`已解到 ${target}\n${noLedger(s.deletions)}`)
    expect(tree(target)).toEqual(withoutTmp(tree(s.data)))
    expect(Object.keys(tree(target)).sort()).toEqual(['accounts.json', 'classes.json', 'events-up-abc.jsonl', path.join('handouts', 'up-abc.json')])

    const wrong = path.join(s.root, 'wrong.key')
    fs.writeFileSync(wrong, 'not-the-backup-key\n')
    const bad = run(RESTORE, [file, path.join(s.root, 'wrong')], { ...s.restoreEnv, KEY_FILE: wrong })
    expect(bad.status).not.toBe(0)
    expect(tree(path.join(s.root, 'wrong'))).toEqual({})
  })

  it('restore-backup.sh 拒绝已存在且非空的目标目录（目录里的东西不动），带 --force 才解；目标是线上数据目录（DATA_DIR）时带 --force 也拒绝；参数不对给用法', () => {
    const s = setup()
    expect(run(BACKUP, [], s.env).status).toBe(0)
    const file = path.join(s.backups, backupsIn(s.backups)[0])
    const target = path.join(s.root, 'busy')
    fs.mkdirSync(target)
    fs.writeFileSync(path.join(target, 'keep.txt'), 'mine')
    const env = s.restoreEnv
    const r = run(RESTORE, [file, target], env)
    expect(r.status).not.toBe(0)
    expect(r.stderr).toContain('不是空的')
    expect(tree(target)).toEqual({ 'keep.txt': 'mine' })

    expect(run(RESTORE, ['--force', file, target], env).status).toBe(0)
    expect(tree(target)).toEqual({ ...withoutTmp(tree(s.data)), 'keep.txt': 'mine' })

    // 线上数据目录：换个写法（带 .. 的路径）也认得出来，文件不动
    fs.writeFileSync(path.join(s.data, 'classes.json'), 'live')
    const live = run(RESTORE, ['--force', file, path.join(s.data, 'handouts', '..')], env)
    expect(live.status).not.toBe(0)
    expect(live.stderr).toContain('线上数据目录')
    expect(fs.readFileSync(path.join(s.data, 'classes.json'), 'utf8')).toBe('live')

    for (const args of [[], [file], [file, target, 'extra'], ['--what', file, target]]) {
      const u = run(RESTORE, args, env)
      expect(u.status, args.join(' ')).not.toBe(0)
      expect(u.stderr).toContain('用法')
    }
    expect(run(RESTORE, [path.join(s.root, 'missing.enc'), path.join(s.root, 'x')], env).status).not.toBe(0)
  })

  it('备份成功后删掉早于 BACKUP_DAYS 天（默认 30）的旧备份和超过 1 小时的残留 .tmp；新的、别的文件不动；BACKUP_DAYS 可以覆盖', async () => {
    const s = setup()
    fs.mkdirSync(s.backups, { recursive: true })
    const at = (f: string) => path.join(s.backups, f)
    age(at('zhishi-data-20260901-033000.tar.gz.enc'), 31 * DAY) // 删
    age(at('zhishi-data-20260910-033000.tar.gz.enc'), 29 * DAY) // 留
    age(at('zhishi-data-20261008-033000.tar.gz.enc'), 1 * DAY) // 留
    age(at('zhishi-data-20261009-010000.tar.gz.enc.tmp'), 2 * 60 * MINUTE) // 中途被杀掉留下的：删
    age(at('zhishi-data-20261009-033000.tar.gz.enc.tmp'), 10 * MINUTE) // 可能另一次正在写：留
    age(at('notes.txt'), 60 * DAY) // 不是备份：留
    const r = run(BACKUP, [], s.env)
    expect(r.status, r.stderr).toBe(0)
    const left = fs.readdirSync(s.backups).sort()
    const fresh = r.stdout.split(' ')[0]
    expect(left).toEqual(['notes.txt', 'zhishi-data-20260910-033000.tar.gz.enc', 'zhishi-data-20261008-033000.tar.gz.enc', 'zhishi-data-20261009-033000.tar.gz.enc.tmp', fresh].sort())

    await new Promise((ok) => setTimeout(ok, 1010 - (Date.now() % 1000))) // 文件名精确到秒：等到下一秒，免得和上一份同名
    const r7 = run(BACKUP, [], { ...s.env, BACKUP_DAYS: '7' })
    expect(r7.status, r7.stderr).toBe(0)
    expect(backupsIn(s.backups).sort()).toEqual(['zhishi-data-20261008-033000.tar.gz.enc', fresh, r7.stdout.split(' ')[0]].sort())
  })

  it('没有密钥文件、密钥文件是空的或第一行是空的、数据目录不在、BACKUP_DAYS 不是正整数：退出码不是 0，不生成备份', () => {
    const s = setup()
    const empty = path.join(s.root, 'empty.key')
    fs.writeFileSync(empty, '')
    const blank = path.join(s.root, 'blank.key')
    fs.writeFileSync(blank, `\n${KEY}\n`)
    const cases: [Record<string, string>, string][] = [
      [{ KEY_FILE: path.join(s.root, 'missing.key') }, '找不到备份密钥'],
      [{ KEY_FILE: empty }, '找不到备份密钥'],
      [{ KEY_FILE: blank }, '第一行是空的'],
      [{ DATA_DIR: path.join(s.root, 'nodata') }, '找不到数据目录'],
      [{ BACKUP_DAYS: '0' }, 'BACKUP_DAYS'],
      [{ BACKUP_DAYS: '030' }, 'BACKUP_DAYS'],
      [{ BACKUP_DAYS: '7d' }, 'BACKUP_DAYS'],
    ]
    for (const [env, msg] of cases) {
      const r = run(BACKUP, [], { ...s.env, ...env })
      expect(r.status, JSON.stringify(env)).not.toBe(0)
      expect(r.stderr).toContain(msg)
      expect(r.stdout).toBe('')
    }
    expect(fs.existsSync(s.backups)).toBe(false)
  })
})

// ---- 恢复时按删除台账再删一遍 ----
// 一份线上数据目录和它的删除台账（在数据目录外面），用真的后端注册、写事件、注销
const PASSWORD = 'restore-pass-1'
const BIRTH = `${new Date().getUTCFullYear() - MIN_AGE - 3}-01`
const CODES = ['TESTRESTORE01', 'TESTRESTORE02', 'TESTRESTORE03']
const sha = (s: string) => createHash('sha256').update(s).digest('hex')
const servers: Server[] = []
afterAll(() => servers.forEach((x) => x.close()))
type Res = { status: number; body: any; cookie: string }
async function liveApp(data: string, deletions: string) {
  fs.mkdirSync(data, { recursive: true })
  if (!fs.existsSync(path.join(data, 'student-invites.json'))) fs.writeFileSync(path.join(data, 'student-invites.json'), JSON.stringify({ invites: CODES.map((c) => ({ hash: sha(c), batch: 't', createdAt: '' })) }))
  const server = await new Promise<Server>((ok) => {
    const x = createApp({ dataDir: data, deletionsDir: deletions, authPerMinute: 1000, log: () => {} }).listen(0, '127.0.0.1', () => ok(x))
  })
  servers.push(server)
  const port = (server.address() as AddressInfo).port
  return (method: string, url: string, body?: unknown, cookie?: string) =>
    new Promise<Res>((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, path: url, method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) } }, (res) => {
        let text = ''
        res.setEncoding('utf8')
        res.on('data', (c) => (text += c))
        res.on('end', () => resolve({ status: res.statusCode!, body: JSON.parse(text), cookie: res.headers['set-cookie']?.[0]?.split(';')[0] ?? '' }))
      })
      req.on('error', reject)
      req.end(body === undefined ? undefined : JSON.stringify(body))
    })
}
type Call = Awaited<ReturnType<typeof liveApp>>
// 两个账号 gone（要注销的）和 kept，各写了学习事件和一条页面报错
async function twoAccounts(call: Call) {
  const out = []
  for (const [i, username] of ['gone.one', 'kept.one'].entries()) {
    const r = await call('POST', '/api/student/register', { invite: CODES[i], username, password: PASSWORD, birth: BIRTH, agree: true })
    expect(r.status, JSON.stringify(r.body)).toBe(200)
    const sid = r.body.student.sid as string
    const ev = (ts: number, type = 'tap_word') => ({ sid, handoutId: 'up-abc', type, ts })
    expect((await call('POST', '/api/events', [ev(1), ev(2), ev(3, 'client_error')], r.cookie)).body).toEqual({ ok: true, accepted: 3 })
    out.push({ username, sid, cookie: r.cookie, code: CODES[i] })
  }
  return out
}
const cli = (args: string[], env: Record<string, string>) => {
  const r = spawnSync(process.execPath, ['scripts/student.mjs', ...args], { cwd: ROOT, encoding: 'utf8', env: { ...process.env, ...env } })
  return { status: r.status, stdout: r.stdout, stderr: r.stderr }
}
const everything = (dir: string) => Object.values(tree(dir)).join('\n')

describe('scripts/student.mjs apply-deletions：按删除台账把恢复出来的目录里已经删掉的账号再删一遍', () => {
  it('注销前的一份数据（模拟从备份解出来的）：已注销的账号、会话、学习记录文件、事件里的 sid 都删掉，别的账号和解析不了的行不动；码照样不能再用；用这份数据起后端，账号没有复活', async () => {
    const root = newDir()
    const live = path.join(root, 'live')
    const deletions = path.join(root, 'deletions')
    const call = await liveApp(live, deletions)
    const [gone, kept] = await twoAccounts(call)
    fs.appendFileSync(path.join(live, 'events-up-abc.jsonl'), '{broken\n')
    const restored = path.join(root, 'restored')
    fs.cpSync(live, restored, { recursive: true }) // 注销之前的备份
    expect((await call('POST', '/api/student/delete', { password: PASSWORD }, gone.cookie)).body).toEqual({ ok: true })
    expect(everything(restored)).toContain(gone.sid)

    const env = { DATA_DIR: live, DELETIONS_DIR: deletions, ENV_FILE: path.join(root, 'missing.env') }
    const r = cli(['apply-deletions', restored], env)
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout).toBe(`按删除台账（1 条）在 ${restored} 里删掉了 1 个账号、1 个账号的学习记录文件、1 行事件。\n`)
    expect(everything(restored)).not.toContain(gone.sid)
    const data = JSON.parse(fs.readFileSync(path.join(restored, 'students.json'), 'utf8'))
    expect(data.students.map((x: { username: string }) => x.username)).toEqual(['kept.one'])
    expect(data.usedInvites).toEqual(expect.arrayContaining([sha(gone.code), sha(kept.code)]))
    expect(fs.readdirSync(path.join(restored, 'students'))).toEqual([`${kept.sid}.jsonl`])
    expect(fs.readFileSync(path.join(restored, 'events-up-abc.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => (l.startsWith('{"') ? JSON.parse(l).sid : l))).toEqual([kept.sid, '{broken'])
    expect(fs.readdirSync(restored).filter((f) => f.endsWith('.tmp'))).toEqual([])
    expect((fs.statSync(path.join(restored, 'students.json')).mode & 0o777)).toBe(0o600)
    // 再跑一遍：没有要删的
    expect(cli(['apply-deletions', restored], env).stdout).toContain('删掉了 0 个账号、0 个账号的学习记录文件、0 行事件')

    // 用这份数据起后端：旧 cookie、密码都进不去，码不能再注册；没注销的照常
    const back = await liveApp(restored, deletions)
    expect((await back('GET', '/api/student/me', undefined, gone.cookie)).body).toEqual({ student: null })
    expect((await back('POST', '/api/student/login', { username: 'gone.one', password: PASSWORD })).status).toBe(401)
    expect((await back('POST', '/api/student/register', { invite: gone.code, username: 'gone.two', password: PASSWORD, birth: BIRTH, agree: true })).status).toBe(409)
    expect((await back('GET', '/api/student/me', undefined, kept.cookie)).body.student).toMatchObject({ username: 'kept.one' })
  })

  it('待删列表（purge）里在台账上的 sid 也去掉；台账还没有记录时说一句、什么都不改；目标是线上数据目录、目录不在时拒绝', async () => {
    const root = newDir()
    const live = path.join(root, 'live')
    const deletions = path.join(root, 'deletions')
    const env = { DATA_DIR: live, DELETIONS_DIR: deletions, ENV_FILE: path.join(root, 'missing.env') }
    const call = await liveApp(live, deletions)
    const [gone] = await twoAccounts(call)
    const restored = path.join(root, 'restored')
    fs.cpSync(live, restored, { recursive: true })
    const before = tree(restored)
    expect(cli(['apply-deletions', restored], env)).toMatchObject({ status: 0, stdout: noLedger(deletions) })
    expect(tree(restored)).toEqual(before)

    expect((await call('POST', '/api/student/delete', { password: PASSWORD }, gone.cookie)).status).toBe(200)
    // 恢复出来的 students.json 里，这个 sid 已经在待删列表里了（注销到一半时的备份）
    const file = path.join(restored, 'students.json')
    const data = JSON.parse(fs.readFileSync(file, 'utf8'))
    fs.writeFileSync(file, JSON.stringify({ ...data, students: data.students.filter((x: { sid: string }) => x.sid !== gone.sid), purge: [gone.sid, 'u-0000000000000000'] }))
    expect(cli(['apply-deletions', restored], env).status).toBe(0)
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).purge).toEqual(['u-0000000000000000'])
    expect(everything(restored)).not.toContain(gone.sid)

    const self = cli(['apply-deletions', path.join(live, 'students', '..')], env)
    expect(self.status).toBe(1)
    expect(self.stderr).toContain('是线上数据目录')
    expect(cli(['apply-deletions', path.join(root, 'nowhere')], env)).toMatchObject({ status: 1, stderr: expect.stringContaining('找不到目录') })
    expect(cli(['apply-deletions'], env)).toMatchObject({ status: 1, stderr: expect.stringContaining('apply-deletions <目录>') })
  })

  it('台账目录不在（路径解析错了、换了机器没搬过来）：报错退出，不当作「没有记录」，什么都不改', async () => {
    const root = newDir()
    const live = path.join(root, 'live')
    const call = await liveApp(live, path.join(root, 'deletions'))
    await twoAccounts(call)
    const restored = path.join(root, 'restored')
    fs.cpSync(live, restored, { recursive: true })
    const before = tree(restored)
    const nowhere = path.join(root, 'nowhere')
    const r = cli(['apply-deletions', restored], { DATA_DIR: live, DELETIONS_DIR: nowhere, ENV_FILE: path.join(root, 'missing.env') })
    expect(r).toMatchObject({ status: 1, stdout: '' })
    expect(r.stderr).toContain(`找不到删除台账的目录 ${nowhere}`)
    expect(tree(restored)).toEqual(before)
  })
})

describe.skipIf(!pbkdf2)('从备份恢复：restore-backup.sh 解完自动按删除台账删（本机 openssl 不支持 -pbkdf2 时跳过）', () => {
  it('备份 → 注销一个账号 → 恢复到别的目录：已注销的 sid 不回来，没注销的在；台账不在备份里；台账读不了时恢复失败', async () => {
    const s = setup()
    const call = await liveApp(s.data, s.deletions)
    const [gone, kept] = await twoAccounts(call)
    expect(run(BACKUP, [], s.env).status).toBe(0)
    const file = path.join(s.backups, backupsIn(s.backups)[0])
    expect((await call('POST', '/api/student/delete', { password: PASSWORD }, gone.cookie)).body).toEqual({ ok: true })
    expect(fs.existsSync(path.join(s.deletions, DELETIONS_FILE))).toBe(true)

    const target = path.join(s.root, 'restore', 'data')
    const r = run(RESTORE, [file, target], s.restoreEnv)
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout).toBe(`已解到 ${target}\n按删除台账（1 条）在 ${target} 里删掉了 1 个账号、1 个账号的学习记录文件、1 行事件。\n`)
    expect(everything(target)).not.toContain(gone.sid)
    expect(everything(target)).toContain(kept.sid)
    expect(Object.keys(tree(target)).some((f) => f.includes(DELETIONS_FILE))).toBe(false)

    // 台账的位置是个目录（读不了）：解是解了，但退出码不是 0，提示不要换到线上
    const blocked = { ...s.restoreEnv, DELETIONS_DIR: path.join(s.root, 'blocked') }
    fs.mkdirSync(path.join(blocked.DELETIONS_DIR, DELETIONS_FILE), { recursive: true })
    const bad = run(RESTORE, [file, path.join(s.root, 'restore2')], blocked)
    expect(bad.status).not.toBe(0)
    expect(bad.stderr).toContain('不要换到线上')
  })

  it('台账目录不在时恢复失败；DELETIONS_DIR 是相对路径时按仓库根目录算（和后端一样），目标目录按跑脚本时的当前目录算，在别的目录下跑也对', () => {
    const s = setup()
    expect(run(BACKUP, [], s.env).status).toBe(0)
    const file = path.join(s.backups, backupsIn(s.backups)[0])
    const missing = run(RESTORE, [file, path.join(s.root, 'r1')], { ...s.restoreEnv, DELETIONS_DIR: path.join(s.root, 'nowhere') })
    expect(missing.status).not.toBe(0)
    expect(missing.stderr).toContain('找不到删除台账的目录')
    expect(missing.stderr).toContain('不要换到线上')

    const rel = run(RESTORE, [file, 'r2'], { ...s.restoreEnv, DELETIONS_DIR: path.relative(ROOT, s.deletions) }, s.root)
    expect(rel.status, rel.stderr).toBe(0)
    expect(rel.stdout).toBe(`已解到 r2\n${noLedger(s.deletions)}`)
    expect(tree(path.join(s.root, 'r2'))).toEqual(withoutTmp(tree(s.data)))
  })
})
