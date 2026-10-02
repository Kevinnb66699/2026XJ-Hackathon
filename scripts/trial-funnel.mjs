// 试用漏斗（只读）：按设备（sid）看走到了哪一步、留下了哪些学习事件、有没有前端报错。
// 用法：npm run trial:funnel -- server/data/events-social-media.jsonl
import fs from 'node:fs'

// 与 src/lib/replay.ts 的 DIAGNOSTIC_TYPES 一致：诊断事件不算学习事件
const DIAGNOSTIC = new Set(['page_view', 'client_error'])

const file = process.argv[2]
if (!file) {
  console.error('用法：node scripts/trial-funnel.mjs <events-xxx.jsonl>')
  process.exit(1)
}

// 北京时间（UTC+8，没有夏令时）
const time = (ts) => new Date(ts + 8 * 3600 * 1000).toISOString().slice(0, 19).replace('T', ' ')

const bySid = new Map()
let bad = 0
for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
  if (!line.trim()) continue
  try {
    const e = JSON.parse(line)
    if (typeof e.sid !== 'string' || typeof e.ts !== 'number') throw new Error()
    if (!bySid.has(e.sid)) bySid.set(e.sid, [])
    bySid.get(e.sid).push(e)
  } catch {
    bad++
  }
}

const rows = [...bySid].map(([sid, events]) => {
  events.sort((a, b) => a.ts - b.ts)
  // 连续重复的步骤（刷新页面）只记一次
  const steps = events.filter((e) => e.type === 'page_view').map((e) => e.value).filter((v, i, a) => v !== a[i - 1])
  const counts = {}
  for (const e of events) if (!DIAGNOSTIC.has(e.type)) counts[e.type] = (counts[e.type] || 0) + 1
  const errors = events.filter((e) => e.type === 'client_error')
  return { sid, first: events[0].ts, last: events[events.length - 1].ts, steps, counts, errors }
})
rows.sort((a, b) => a.first - b.first)

const learning = rows.filter((r) => Object.keys(r.counts).length).length
const withErrors = rows.filter((r) => r.errors.length).length
console.log(`${file}：设备 ${rows.length} 台，有学习事件 ${learning} 台，只有诊断事件 ${rows.length - learning} 台，有报错 ${withErrors} 台${bad ? `；跳过坏行 ${bad}` : ''}`)
for (const r of rows) {
  console.log(`\n${r.sid}  ${time(r.first)} → ${time(r.last)}`)
  console.log(`  步骤：${r.steps.length ? r.steps.join(' → ') : '（无 page_view）'}`)
  const c = Object.entries(r.counts).map(([t, n]) => `${t} ${n}`)
  console.log(`  学习事件：${c.length ? c.join('，') : '无'}`)
  for (const e of r.errors) console.log(`  报错 ${time(e.ts).slice(11)}：${e.value ?? ''}`)
}
