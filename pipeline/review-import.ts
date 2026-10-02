// 校对表 → 人工修订：把队友在 docs/校对表.csv 里填好「结论 / 改成」的行，转成 pipeline/human-edits.json。
// 「改成」沿用校对表「待校对的内容」的写法（① 谁：… / 选项前打 ✔ / 中文：… / 表达 = 中文），这里按同样格式解析。
// 用法：npm run review:import -- [docs/校对表.csv] [--by=队友2] [--dry]
//   --dry：只把修改套到当前讲义上跑校验，不写文件
import { existsSync, readFileSync, writeFileSync } from 'fs'
import type { Handout } from '../shared/schema'
import { applyHumanEdits, type HumanEdit } from './human-edits'
import { validateHandout } from './validate'

// CSV 解析（支持引号内换行和 ""）
export function parseCsv(src: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let cell = ''
  let quoted = false
  for (let i = 0; i < src.length; i++) {
    const c = src[i]
    if (quoted) {
      if (c === '"' && src[i + 1] === '"') {
        cell += '"'
        i++
      } else if (c === '"') quoted = false
      else cell += c
    } else if (c === '"') quoted = true
    else if (c === ',') {
      row.push(cell)
      cell = ''
    } else if (c === '\n') {
      row.push(cell.replace(/\r$/, ''))
      rows.push(row)
      row = []
      cell = ''
    } else cell += c
  }
  if (cell || row.length) rows.push([...row, cell])
  return rows
}

const lines = (text: string) => text.split('\n').map((l) => l.replace(/\r$/, ''))
const after = (ls: string[], label: string) => {
  const l = ls.find((x) => x.includes(`${label}：`))
  return l === undefined ? undefined : l.slice(l.indexOf(`${label}：`) + label.length + 1).trim()
}

// 难词：「a=b；c=d」。中文释义里本身也可能有「；」（如 claim=说法；主张），没有「=」的片段并回前一条
export function parseGlosses(text: string): { term: string; zh: string }[] {
  const out: { term: string; zh: string }[] = []
  for (const piece of text.split('；')) {
    const i = piece.indexOf('=')
    if (i > 0) out.push({ term: piece.slice(0, i).trim(), zh: piece.slice(i + 1).trim() })
    else if (out.length && piece.trim()) out[out.length - 1].zh += `；${piece.trim()}`
    else if (piece.trim()) throw new Error(`难词格式不对：${piece}`)
  }
  return out
}

export function parseLadder(text: string) {
  const ls = lines(text)
  if (ls.filter((l) => /谁：/.test(l)).length !== 1 || ls.filter((l) => /做了什么：/.test(l)).length !== 1) throw new Error('梯子要正好一个「谁」和一个「做了什么」')
  const subject = after(ls, '谁')
  const predicate = after(ls, '做了什么')
  const l2 = after(ls, '正常语序')
  const plain = after(ls, '简单英文')
  if (!subject || !predicate || !l2 || !plain) throw new Error('梯子缺少「谁 / 做了什么 / 正常语序 / 简单英文」中的某一项')
  return { l1: { subject, predicate }, l2, l3: { plain, glosses: parseGlosses(after(ls, '难词') ?? '') } }
}

// 题目：第一行题干，之后每行一个选项「A. …」，正确项前打 ✔
export function parseQuestion(ls: string[]) {
  const options: string[] = []
  let answer = -1
  const rest: string[] = []
  for (const l of ls) {
    const m = l.match(/^\s*(✔)?\s*[A-D]\.\s*(.*)$/)
    if (m) {
      if (m[1]) answer = options.length
      options.push(m[2].trim())
    } else if (l.trim()) rest.push(l.trim())
  }
  if (rest.length !== 1) throw new Error(`题干应为一行，现在是：${rest.join(' | ')}`)
  if (options.length < 2 || answer < 0 || ls.filter((l) => l.includes('✔')).length !== 1) throw new Error('选项至少 2 个，且正好一个 ✔')
  return { prompt: rest[0], options, answer }
}

export function parseWord(text: string) {
  const ls = lines(text)
  const gi = ls.findIndex((l) => l.startsWith('先猜后看：'))
  const head = gi >= 0 ? ls.slice(0, gi) : ls
  for (const l of head) if (l.trim() && !/^(中文|英文（老师）)：/.test(l)) throw new Error(`单词卡没有这一栏：${l}`)
  return {
    zh: after(head, '中文'),
    en: after(head, '英文（老师）'),
    guess: gi >= 0 ? parseQuestion([ls[gi].slice('先猜后看：'.length), ...ls.slice(gi + 1)]) : undefined,
  }
}

export function parseExpression(text: string) {
  const i = text.indexOf(' = ')
  if (i < 0) throw new Error('表达格式应为「表达 = 中文」')
  return { text: text.slice(0, i).trim(), zh: text.slice(i + 3).trim() }
}

// 一行校对结果 → 若干条人工修订
export function rowToEdits(row: Record<string, string>, by: string): HumanEdit[] {
  const verdict = (row['结论（对 / 改 / 删）'] ?? '').trim()
  const kind = row['类型'] ?? ''
  const id = (row['编号'] ?? '').trim()
  const note = `校对表 #${row['序号']}`
  const e = (target: HumanEdit['target'], field: string, value: unknown, targetId = id): HumanEdit => ({ target, id: targetId, field, value, by, note })
  if (verdict === '对' || verdict === '') return []
  if (verdict === '删') {
    if (kind.startsWith('注释词')) return [e('word', 'remove', true)]
    if (kind.startsWith('表达')) return [e('expression', 'remove', true)]
    throw new Error(`#${row['序号']}：${kind}暂不支持「删」，请改成「改」或保留`)
  }
  if (verdict !== '改') throw new Error(`#${row['序号']}：结论应为 对 / 改 / 删，现在是「${verdict}」`)
  const to = (row['改成'] ?? '').trim()
  if (!to) throw new Error(`#${row['序号']}：结论是「改」但「改成」是空的`)
  try {
    if (kind === '梯子') {
      const l = parseLadder(to)
      return [e('sentence', 'ladder.l1', l.l1), e('sentence', 'ladder.l2', l.l2), e('sentence', 'ladder.l3', l.l3)]
    }
    if (kind === '原句题') {
      const q = parseQuestion(lines(to))
      return [e('sentence', 'question.prompt', q.prompt), e('sentence', 'question.options', q.options), e('sentence', 'question.answer', q.answer)]
    }
    if (kind === '段意题') {
      const n = id.match(/\d+/)?.[0] ?? id
      const ls = lines(to)
      const gistEn = after(ls, '要点（英文）')
      const q = parseQuestion(ls.filter((l) => !l.startsWith('要点（英文）：')))
      const out = [e('paragraph', 'gist.prompt', q.prompt, n), e('paragraph', 'gist.options', q.options, n), e('paragraph', 'gist.answer', q.answer, n)]
      return gistEn ? [...out, e('paragraph', 'gistEn', gistEn, n)] : out
    }
    if (kind.startsWith('注释词')) {
      const w = parseWord(to)
      const out: HumanEdit[] = []
      if (w.zh) out.push(e('word', 'zh', w.zh))
      if (w.en) out.push(e('word', 'en', w.en))
      if (w.guess) out.push(e('word', 'guess.prompt', w.guess.prompt), e('word', 'guess.options', w.guess.options), e('word', 'guess.answer', w.guess.answer))
      return out
    }
    if (kind.startsWith('表达')) {
      const x = parseExpression(to)
      return [e('expression', 'text', x.text), e('expression', 'zh', x.zh)]
    }
  } catch (err) {
    throw new Error(`#${row['序号']}（${kind} ${id}）：${(err as Error).message}`)
  }
  throw new Error(`#${row['序号']}：不认识的类型「${kind}」`)
}

export function sheetToEdits(csv: string, by: string): HumanEdit[] {
  const rows = parseCsv(csv.replace(/^﻿/, ''))
  const hi = rows.findIndex((r) => r[0] === '序号') // Numbers 导出时第一行可能是表名
  if (hi < 0) throw new Error('找不到表头（第一列应为「序号」）')
  const head = rows[hi]
  return rows
    .slice(hi + 1)
    .filter((r) => r[0]?.trim())
    .flatMap((r) => rowToEdits(Object.fromEntries(head.map((k, i) => [k, r[i] ?? ''])), by))
}

export async function main(args: string[]) {
  const sheet = args.find((a) => !a.startsWith('--')) ?? 'docs/校对表.csv'
  const by = args.find((a) => a.startsWith('--by='))?.slice(5) ?? '队友2'
  const dry = args.includes('--dry')
  const edits = sheetToEdits(readFileSync(sheet, 'utf8'), by)
  console.log(`${sheet}：${edits.length} 条人工修订`)

  // 套到当前讲义上跑一遍校验（重新入库时也是同样的顺序：模型起草 → 人工修订 → 校验）
  const h = JSON.parse(readFileSync('data/handouts/social-media.json', 'utf8')) as Handout
  const log = applyHumanEdits(h, edits)
  const bad = log.filter((l) => !l.startsWith('已'))
  for (const l of bad) console.log(`  ${l}`)
  const raw: Record<number, string> = {}
  for (let d = 1; d <= 5; d++) if (existsSync(`data/raw/day${d}.txt`)) raw[d] = readFileSync(`data/raw/day${d}.txt`, 'utf8')
  const issues = validateHandout(h, raw)
  const errors = issues.filter((i) => i.level === 'error')
  for (const i of issues) console.log(`  ${i.level === 'error' ? '错误' : '提醒'} [${i.where}] ${i.message}`)
  if (errors.length || bad.length) {
    console.log(`校验没通过：${errors.length} 个错误，${bad.length} 条修订没套上。没有写文件。`)
    process.exit(1)
  }
  if (dry) {
    console.log('试运行通过，没有写文件。')
    return
  }
  writeFileSync('pipeline/human-edits.json', JSON.stringify({ edits }, null, 2) + '\n')
  console.log('已写入 pipeline/human-edits.json。接着运行 npm run ingest -- --replay 重新入库。')
}
