// 加密滚动备份：在临时目录里跑 deploy/backup.sh 和 restore-backup.sh（DATA_DIR、BACKUP_DIR、KEY_FILE 都指到临时目录，不碰服务器上的默认路径）。
// 要本机的 openssl 支持 -pbkdf2（OpenSSL 1.1.1 以上；服务器是 OpenSSL 3.0.2），不支持时整组跳过（比如 macOS 自带的 LibreSSL）
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const BACKUP = fileURLToPath(new URL('../deploy/backup.sh', import.meta.url))
const RESTORE = fileURLToPath(new URL('../deploy/restore-backup.sh', import.meta.url))
const pbkdf2 = spawnSync('openssl', ['enc', '-aes-256-cbc', '-md', 'sha256', '-pbkdf2', '-iter', '1', '-pass', 'pass:x'], { input: 'x' }).status === 0
const NAME = /^zhishi-data-\d{8}-\d{6}\.tar\.gz\.enc$/
const KEY = 'backup-key-for-tests-0123456789abcdef'
const DAY = 24 * 3600 * 1000
const MINUTE = 60 * 1000

const newDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'zhishi-backup-'))
const perm = (p: string) => fs.statSync(p).mode & 0o777
function run(script: string, args: string[], env: Record<string, string>) {
  const r = spawnSync('bash', [script, ...args], { env: { PATH: process.env.PATH ?? '', ...env }, encoding: 'utf8' })
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
  return { root, data, key, backups, env: { DATA_DIR: data, BACKUP_DIR: backups, KEY_FILE: key } }
}
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
    const r = run(RESTORE, [file, target], { KEY_FILE: s.key, DATA_DIR: s.data })
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout).toBe(`已解到 ${target}\n`)
    expect(tree(target)).toEqual(withoutTmp(tree(s.data)))
    expect(Object.keys(tree(target)).sort()).toEqual(['accounts.json', 'classes.json', 'events-up-abc.jsonl', path.join('handouts', 'up-abc.json')])

    const wrong = path.join(s.root, 'wrong.key')
    fs.writeFileSync(wrong, 'not-the-backup-key\n')
    const bad = run(RESTORE, [file, path.join(s.root, 'wrong')], { KEY_FILE: wrong, DATA_DIR: s.data })
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
    const env = { KEY_FILE: s.key, DATA_DIR: s.data }
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
