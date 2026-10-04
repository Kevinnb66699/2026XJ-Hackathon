// 老师账号的团队命令行工具：在服务器上用，cd /srv/zhishi && node scripts/teacher.mjs <命令>（或 npm run teacher -- <命令>）。
// 数据目录和后端一致：DATA_DIR（环境变量或 .env）优先，否则 server/data。只写 accounts.json（临时文件 + 改名），不碰 sessions.json：
// 重置密码时把这位老师的 sessionsValidAfter 设成现在，后端按它让旧会话作废。后端按文件的 mtime 重新读，不用重启
import { randomInt } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { hashPassword, loadConfig } from '../server/index.mjs'

const USAGE = `用法：
  node scripts/teacher.mjs list                      列出所有老师账号
  node scripts/teacher.mjs reset-password <用户名>   重置密码：生成一个临时密码（只显示这一次），这位老师所有已登录的设备都要重新登录`

// 出错：中文提示、退出码 1（不直接 process.exit，免得输出还没写完）
const fail = (msg) => {
  console.error(msg)
  process.exitCode = 1
}

const dataDir = loadConfig().dataDir
const accountsFile = path.join(dataDir, 'accounts.json')

function readAccounts() {
  let text
  try {
    text = fs.readFileSync(accountsFile, 'utf8')
  } catch (err) {
    if (err.code === 'ENOENT') return { teachers: [] }
    throw err
  }
  const data = JSON.parse(text)
  return { ...data, teachers: Array.isArray(data.teachers) ? data.teachers : [] }
}

// 北京时间（UTC+8，没有夏令时）
const time = (iso) => (iso ? new Date(Date.parse(iso) + 8 * 3600 * 1000).toISOString().slice(0, 16).replace('T', ' ') : '-')

function list() {
  const { teachers } = readAccounts()
  if (!teachers.length) return console.log(`还没有老师账号（${accountsFile}）`)
  // 讲义数：数 handouts/*.meta.json 里 owner 是这位老师的
  const owned = new Map()
  const dir = path.join(dataDir, 'handouts')
  for (const f of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
    if (!f.endsWith('.meta.json')) continue
    try {
      const { owner } = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'))
      if (typeof owner === 'string') owned.set(owner, (owned.get(owner) ?? 0) + 1)
    } catch {
      // 跳过读不了的
    }
  }
  console.log(['用户名', '称呼', '注册时间（北京时间）', '讲义数'].join('\t'))
  for (const t of teachers) console.log([t.username, t.name, time(t.createdAt), owned.get(t.id) ?? 0].join('\t'))
  console.log(`共 ${teachers.length} 个账号`)
}

// 临时密码：12 位，去掉容易看错的 0 O 1 l I
const ALPHABET = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789'
const tempPassword = () => Array.from({ length: 12 }, () => ALPHABET[randomInt(ALPHABET.length)]).join('')

async function resetPassword(name) {
  const username = name.trim().toLowerCase()
  const missing = () => fail(`没有这个用户名：${username}（可以先用 list 看看有哪些账号）`)
  if (!readAccounts().teachers.some((x) => x.username === username)) return missing()
  const password = tempPassword()
  const passwordHash = await hashPassword(password)
  // 算完哈希再读一遍最新的文件马上写回，和后端注册写同一个文件的空隙尽量短
  const data = readAccounts()
  const t = data.teachers.find((x) => x.username === username)
  if (!t) return missing()
  const teachers = data.teachers.map((x) => (x === t ? { ...x, passwordHash, sessionsValidAfter: Date.now() } : x))
  const tmp = `${accountsFile}.${process.pid}-${Date.now()}.tmp`
  try {
    fs.writeFileSync(tmp, JSON.stringify({ ...data, teachers }), { mode: 0o600 })
    fs.renameSync(tmp, accountsFile)
  } catch (err) {
    fs.rmSync(tmp, { force: true })
    throw err
  }
  console.log(`已重置 ${t.username}（${t.name}）的密码，这位老师所有已登录的设备都要重新登录。`)
  console.log(`临时密码（只显示这一次）：${password}`)
  console.log('请私下告诉这位老师，不要发到群里。')
}

const [cmd, arg, ...rest] = process.argv.slice(2)
if (cmd === 'list' && arg === undefined) list()
else if (cmd === 'reset-password' && arg && !rest.length) await resetPassword(arg)
else fail(USAGE)
