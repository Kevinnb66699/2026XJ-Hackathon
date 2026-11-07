// 学生账号（内测）的团队命令行工具：在服务器上用，cd /srv/zhishi && node scripts/student.mjs <命令>（或 npm run student -- <命令>）。
// 数据目录和后端一致：DATA_DIR（环境变量或 .env）优先，否则 server/data。都是写临时文件再改名（只给本用户读写），后端按文件的 mtime 重新读，不用重启。
// 只由这里写：student-invites.json（邀请码只存 sha256）、shelf.json（团队上架的讲义）。reset-password 要改后端也在写的 students.json：
// 后端的写队列管不到这里，同时写会丢更新，所以趁没人用的时候跑，或者先停服务（见 deploy/README.md）
import { randomInt } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { hashPassword, loadConfig, studentInviteHash } from '../server/index.mjs'

const USAGE = `用法：
  node scripts/student.mjs invite <个数> <批次>        生成邀请码（只显示这一次），批次名用字母、数字、_ -
  node scripts/student.mjs list                        列出各批邀请码的使用情况和学生账号
  node scripts/student.mjs revoke <批次>               作废这一批还没用的码（已经注册的账号不受影响）
  node scripts/student.mjs reset-password <用户名>     重置密码：生成一个临时密码和新找回码（只显示这一次，旧找回码作废），这个账号所有已登录的设备都要重新登录
  node scripts/student.mjs shelf add <讲义 id>         上架一份讲义（有老师讲解的不能上架）
  node scripts/student.mjs shelf rm <讲义 id>          下架
  node scripts/student.mjs shelf list                  列出上架的讲义`

// 出错：中文提示、退出码 1（不直接 process.exit，免得输出还没写完）
const fail = (msg) => {
  console.error(msg)
  process.exitCode = 1
}

const dataDir = loadConfig().dataDir
const file = (name) => path.join(dataDir, name)
const UPLOAD_ID = /^up-[a-z0-9]{1,40}$/ // 同 server/index.mjs
const BATCH = /^[A-Za-z0-9_-]{1,32}$/
const MAX_INVITES = 200

function readJson(name, empty) {
  let text
  try {
    text = fs.readFileSync(file(name), 'utf8')
  } catch (err) {
    if (err.code === 'ENOENT') return empty()
    throw err
  }
  return JSON.parse(text)
}
const list = (v) => (Array.isArray(v) ? v : [])
const readInvites = () => list(readJson('student-invites.json', () => ({})).invites)
const readStudents = () => {
  const data = readJson('students.json', () => ({}))
  return { ...data, students: list(data.students), usedInvites: list(data.usedInvites) }
}
const readShelf = () => list(readJson('shelf.json', () => ({})).handouts)

function writeJson(name, data) {
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 })
  const tmp = `${file(name)}.${process.pid}-${Date.now()}.tmp`
  try {
    fs.writeFileSync(tmp, JSON.stringify(data), { mode: 0o600 })
    fs.renameSync(tmp, file(name))
  } catch (err) {
    fs.rmSync(tmp, { force: true })
    throw err
  }
}

// 北京时间（UTC+8，没有夏令时）
const time = (t) => (t ? new Date((typeof t === 'number' ? t : Date.parse(t)) + 8 * 3600 * 1000).toISOString().slice(0, 16).replace('T', ' ') : '-')

// 邀请码：12 位，去掉容易看错的 I L O 0 1，显示成 XXXX-XXXX-XXXX。学生输入时空格、「-」、大小写都不要紧（studentInviteHash 先去掉、转大写）
const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'
const newCode = () => Array.from({ length: 12 }, () => CODE_CHARS[randomInt(CODE_CHARS.length)]).join('').replace(/(.{4})(?=.)/g, '$1-')

function invite(count, batch) {
  const n = /^\d+$/.test(count) ? Number(count) : 0
  if (n < 1 || n > MAX_INVITES) return fail(`个数要是 1 到 ${MAX_INVITES} 的整数`)
  if (!BATCH.test(batch)) return fail('批次名只能用字母、数字和 _ -，最多 32 个字符')
  const invites = readInvites()
  const seen = new Set(invites.map((x) => x.hash))
  const codes = []
  const now = new Date().toISOString()
  while (codes.length < n) {
    const code = newCode()
    const hash = studentInviteHash(code)
    if (seen.has(hash)) continue
    seen.add(hash)
    codes.push(code)
    invites.push({ hash, batch, createdAt: now })
  }
  writeJson('student-invites.json', { invites })
  console.log(`批次 ${batch} 新生成 ${n} 个邀请码（只显示这一次，服务器只存哈希）：`)
  for (const c of codes) console.log(c)
  console.log('请一个一个私下发给同学，不要发到群里。')
}

function show() {
  const invites = readInvites()
  const { students, usedInvites } = readStudents()
  const used = new Set([...usedInvites, ...students.map((s) => s.inviteHash)])
  if (!invites.length) console.log(`还没有学生邀请码（${file('student-invites.json')}）`)
  else {
    // 已用：注册用掉的，和年龄不够作废的；作废：命令行 revoke 的、还没用过的
    const batches = new Map()
    for (const x of invites) {
      const b = batches.get(x.batch) ?? { createdAt: x.createdAt, total: 0, used: 0, revoked: 0 }
      b.total++
      if (used.has(x.hash)) b.used++
      else if (x.revokedAt) b.revoked++
      batches.set(x.batch, b)
    }
    console.log(['批次', '生成时间（北京时间）', '共', '已用', '作废', '可用'].join('\t'))
    for (const [name, b] of batches) console.log([name, time(b.createdAt), b.total, b.used, b.revoked, b.total - b.used - b.revoked].join('\t'))
  }
  if (!students.length) return console.log(`还没有学生账号（${file('students.json')}）`)
  console.log(['用户名', '注册时间（北京时间）', '最近登录（北京时间）', 'AI 写作检查'].join('\t'))
  for (const s of students) console.log([s.username, time(s.createdAt), time(s.lastSeenAt).slice(0, 10), s.ai === true ? '开' : '关'].join('\t'))
  console.log(`共 ${students.length} 个账号`)
}

function revoke(batch) {
  const invites = readInvites()
  if (!invites.some((x) => x.batch === batch)) return fail(`没有这个批次：${batch}（可以先用 list 看看有哪些批次）`)
  const { students, usedInvites } = readStudents()
  const used = new Set([...usedInvites, ...students.map((s) => s.inviteHash)])
  const now = new Date().toISOString()
  let n = 0
  const next = invites.map((x) => {
    if (x.batch !== batch || x.revokedAt || used.has(x.hash)) return x
    n++
    return { ...x, revokedAt: now }
  })
  if (n) writeJson('student-invites.json', { invites: next })
  console.log(`批次 ${batch}：作废了 ${n} 个还没用的码。已经注册的账号不受影响。`)
}

// 临时密码：12 位，去掉容易看错的 0 O 1 l I（同 scripts/teacher.mjs）
const ALPHABET = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789'
const tempPassword = () => Array.from({ length: 12 }, () => ALPHABET[randomInt(ALPHABET.length)]).join('')
// 新找回码：同后端注册时发的（8 位，字母表同邀请码）。存的哈希也和邀请码同一种（studentInviteHash：去掉「-」、转大写后的 sha256），后端改密码时比得上
const newRecoveryCode = () => Array.from({ length: 8 }, () => CODE_CHARS[randomInt(CODE_CHARS.length)]).join('')

// 重置密码时连找回码一起换：来找团队的多半是找回码丢了或被人拿去改了密码，旧码留着的话，拿到它的人还能再改一次
async function resetPassword(name) {
  const username = name.trim().toLowerCase()
  const missing = () => fail(`没有这个用户名：${username}（可以先用 list 看看有哪些账号）`)
  if (!readStudents().students.some((x) => x.username === username)) return missing()
  const password = tempPassword()
  const passwordHash = await hashPassword(password)
  // 算完哈希再读一遍最新的文件马上写回，和后端写同一个文件的空隙尽量短
  const data = readStudents()
  const s = data.students.find((x) => x.username === username)
  if (!s) return missing()
  const code = newRecoveryCode()
  writeJson('students.json', { ...data, students: data.students.map((x) => (x === s ? { ...x, passwordHash, recoveryHash: studentInviteHash(code), sessionsValidAfter: Date.now() } : x)) })
  console.log(`已重置 ${s.username} 的密码，这个账号所有已登录的设备都要重新登录。`)
  console.log(`临时密码（只显示这一次）：${password}`)
  console.log(`新找回码（只显示这一次，旧的已经不能用了）：${code}`)
  console.log('请私下告诉这位同学，不要发到群里。同学可以用新找回码再改一个自己的密码。')
}

// 上架：讲义和 meta 都要在。老师讲解（teacherNote）只是一个字符串、没有来源标记，学生端分不出是不是 AI 写的，所以有讲解的不上架
function shelfAdd(id) {
  if (!UPLOAD_ID.test(id)) return fail(`讲义 id 不对：${id}（是 up- 开头的那一串）`)
  let handout
  let meta
  try {
    handout = JSON.parse(fs.readFileSync(file(`handouts/${id}.json`), 'utf8'))
    meta = JSON.parse(fs.readFileSync(file(`handouts/${id}.meta.json`), 'utf8'))
  } catch {
    return fail(`没有这份讲义：${id}`)
  }
  const noted = list(handout.sentences).filter((x) => typeof x?.teacherNote === 'string' && x.teacherNote.trim()).length
  if (noted) return fail(`${id} 有 ${noted} 句老师讲解，讲解没有来源标记，不能上架。先在上传页把讲解都清空、保存，再上架。`)
  const items = readShelf()
  if (items.some((x) => x.id === id)) return console.log(`${id}（${meta.title ?? ''}）已经在架上了`)
  writeJson('shelf.json', { handouts: [{ id, addedAt: new Date().toISOString() }, ...items] })
  console.log(`已上架 ${id}（${meta.title ?? ''}），登录的学生在首页就能看到。`)
}

function shelfRm(id) {
  const items = readShelf()
  if (!items.some((x) => x.id === id)) return fail(`架上没有这份讲义：${id}`)
  writeJson('shelf.json', { handouts: items.filter((x) => x.id !== id) })
  console.log(`已下架 ${id}。学生已经记下的作答不删。`)
}

function shelfList() {
  const items = readShelf()
  if (!items.length) return console.log('架上还没有讲义')
  console.log(['讲义 id', '标题', '上架时间（北京时间）'].join('\t'))
  for (const x of items) {
    let title = '（讲义不在了）'
    try {
      title = JSON.parse(fs.readFileSync(file(`handouts/${x.id}.meta.json`), 'utf8')).title ?? ''
    } catch {
      // 讲义不在了：后端也不会列出来
    }
    console.log([x.id, title, time(x.addedAt)].join('\t'))
  }
}

const [cmd, ...args] = process.argv.slice(2)
if (cmd === 'invite' && args.length === 2) invite(args[0], args[1])
else if (cmd === 'list' && !args.length) show()
else if (cmd === 'revoke' && args.length === 1) revoke(args[0])
else if (cmd === 'reset-password' && args.length === 1 && args[0].trim()) await resetPassword(args[0])
else if (cmd === 'shelf' && args[0] === 'add' && args.length === 2) shelfAdd(args[1])
else if (cmd === 'shelf' && args[0] === 'rm' && args.length === 2) shelfRm(args[1])
else if (cmd === 'shelf' && args[0] === 'list' && args.length === 1) shelfList()
else fail(USAGE)
