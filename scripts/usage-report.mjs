// 用量报表：把 DATA_DIR 下的 usage-YYYY-MM.jsonl（后端和 scripts/lexicon.mjs 追加的，见 server/index.mjs 的 appendUsage）加总，
// 只出合计数：按天（北京时间）、按类型、按模型，估计额（没拿到用量、按调用前的估计记的）单列；不列单条记录，也不列讲义 id。
// 生成讲义的一次调用有开始、结束两行，和后端启动时一样按 settleUsage 只算一行（没结束的按开始时的估计额）
// 用法（在服务器上用 ubuntu，不加 sudo；DATA_DIR 和后端一样从 .env 读）：
//   cd /srv/zhishi && npm run usage                        这个月
//   cd /srv/zhishi && npm run usage -- 2026-10 2026-11     这几个月
//   cd /srv/zhishi && npm run usage -- all                 全部
// 日志里的金额是百万分之一元的整数，这里换成元、保留 4 位小数
import fs from 'node:fs'
import path from 'node:path'
import { loadConfig, settleUsage } from '../server/index.mjs'

// 生成讲义时的几类调用：按讲义 id 加总，看每篇花了多少（和生成前的估计额对照，见 docs/上传设计.md）
const BUILD_KINDS = ['article', 'title', 'lexicon', 'repair-l1']

const cfg = loadConfig()
const args = process.argv.slice(2)
const wrong = args.filter((a) => a !== 'all' && !/^\d{4}-\d{2}$/.test(a))
if (wrong.length) {
  console.error(`不认识的参数：${wrong.join(' ')}。用法：npm run usage -- [YYYY-MM …｜all]`)
  process.exit(1)
}
if (!fs.existsSync(cfg.dataDir)) {
  console.error(`找不到数据目录 ${cfg.dataDir}`)
  process.exit(1)
}
const thisMonth = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 7)
const names = args.includes('all')
  ? fs.readdirSync(cfg.dataDir).filter((f) => /^usage-\d{4}-\d{2}\.jsonl$/.test(f)).sort()
  : [...new Set(args.length ? args : [thisMonth])].sort().map((m) => `usage-${m}.jsonl`)

const zero = () => ({ cost: 0, n: 0, estCost: 0, estN: 0 })
const total = zero()
const groups = { day: new Map(), kind: new Map(), model: new Map() }
const builds = new Map() // 讲义 id → {cost, article: 有没有起草}
const add = (g, r) => {
  if (r.estimated) {
    g.estCost += r.cost
    g.estN++
  } else {
    g.cost += r.cost
    g.n++
  }
}
let bad = 0
const missing = []
const rows = []
for (const name of names) {
  let text
  try {
    text = fs.readFileSync(path.join(cfg.dataDir, name), 'utf8')
  } catch (err) {
    if (err.code !== 'ENOENT') throw err
    missing.push(name)
    continue
  }
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    let r
    try {
      r = JSON.parse(line)
    } catch {
      r = null
    }
    if (!r || !Number.isSafeInteger(r.cost) || r.cost < 0 || !Number.isFinite(r.ts) || typeof r.kind !== 'string' || typeof r.model !== 'string') {
      bad++
      continue
    }
    rows.push(r)
  }
}
for (const r of settleUsage(rows)) {
  add(total, r)
  const keys = { day: new Date(r.ts + 8 * 3600 * 1000).toISOString().slice(0, 10), kind: r.kind, model: r.model }
  for (const [k, map] of Object.entries(groups)) {
    if (!map.has(keys[k])) map.set(keys[k], zero())
    add(map.get(keys[k]), r)
  }
  if (typeof r.handoutId === 'string' && BUILD_KINDS.includes(r.kind)) {
    const b = builds.get(r.handoutId) ?? { cost: 0, article: false }
    b.cost += r.cost
    b.article ||= r.kind === 'article'
    builds.set(r.handoutId, b)
  }
}

const yuan = (micro) => (micro / 1e6).toFixed(4)
const line = (label, g) => `  ${label}  实际 ${yuan(g.cost)} 元（${g.n} 次）  估计额 ${yuan(g.estCost)} 元（${g.estN} 次）`
console.log(`usage 日志：${names.length ? names.join('、') : '没有'}（金额单位：元）`)
if (missing.length) console.log(`没有这几个文件：${missing.join('、')}`)
console.log(`合计：${yuan(total.cost + total.estCost)} 元，其中实际 ${yuan(total.cost)} 元（${total.n} 次），估计额 ${yuan(total.estCost)} 元（${total.estN} 次）`)
for (const [title, k] of [['按天（北京时间）', 'day'], ['按类型', 'kind'], ['按模型', 'model']]) {
  console.log(title)
  for (const key of [...groups[k].keys()].sort()) console.log(line(key, groups[k].get(key)))
}
// 只算这段时间里起草过的（有 article 那一类）：只补了词义的旧讲义不算一篇
const costs = [...builds.values()].filter((b) => b.article).map((b) => b.cost)
if (costs.length) console.log(`生成讲义：${costs.length} 篇，每篇平均 ${yuan(Math.round(costs.reduce((a, b) => a + b, 0) / costs.length))} 元，最多 ${yuan(Math.max(...costs))} 元（含估计额）`)
else console.log('生成讲义：0 篇')
if (bad) console.log(`有 ${bad} 行格式不对，没算进去`)
