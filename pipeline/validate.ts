// 校验器：任何进入 data/handouts/ 的讲义（不管是模型起草还是人工编写）都必须通过。
// 用法：npm run validate                 校验 data/handouts/*.json 和测试样例
//       npm run validate -- <file.json>   校验指定文件（命令行入口见 validate-cli.ts）
import { existsSync, readdirSync, readFileSync } from 'fs'
import { join } from 'path'
import { BREAKDOWN_LABELS, Handout } from '../shared/schema'
import { normalizeSpace, normalizeText } from './normalize'

import { GRAMMAR_TERMS, hasGrammarTerm } from '../shared/terms'

export { GRAMMAR_TERMS }

export interface Issue {
  level: 'error' | 'warn'
  where: string
  message: string
}

function wordIn(text: string, form: string): boolean {
  const escaped = form.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(^|[^A-Za-z])${escaped}([^A-Za-z]|$)`, 'i').test(text)
}

// rawByDay：老师讲义每天的原文（data/raw/dayN.txt）。没有时，出处只能对照讲义自身的文本。
export function validateHandout(input: unknown, rawByDay?: Record<number, string>): Issue[] {
  const issues: Issue[] = []
  const err = (where: string, message: string) => issues.push({ level: 'error', where, message })
  const warn = (where: string, message: string) => issues.push({ level: 'warn', where, message })

  const parsed = Handout.safeParse(input)
  if (!parsed.success) {
    for (const i of parsed.error.issues.slice(0, 20)) err(i.path.join('.') || '(root)', i.message)
    return issues
  }
  const h = parsed.data
  const sentenceById = new Map(h.sentences.map((s) => [s.id, s]))
  if (sentenceById.size !== h.sentences.length) err('sentences', '句子 id 重复')

  const selfText = normalizeSpace(
    [...h.sentences.map((s) => `${s.text} ${s.teacherNote ?? ''}`), h.writing.prompt, ...h.expressions.map((e) => e.text)].join(' '),
  )
  // 与抽取器同一套归一化（去页脚、合并断行、中文空格），保证两边对「原文」的理解一致
  const rawNorm = rawByDay ? Object.fromEntries(Object.entries(rawByDay).map(([d, t]) => [d, normalizeText(t)])) : undefined
  const checkSources = (where: string, sources: { day: number; quote: string }[]) => {
    for (const src of sources) {
      const q = normalizeSpace(src.quote)
      if (!q) err(where, '出处 quote 为空')
      else if (rawNorm) {
        if (!rawNorm[src.day]?.includes(q)) err(where, `出处不在 Day ${src.day} 原文里：「${q.slice(0, 40)}」`)
      } else if (!selfText.includes(q)) err(where, `出处不在讲义文本里：「${q.slice(0, 40)}」`)
    }
  }
  const checkQuestion = (where: string, q: { prompt: string; options: string[]; answer: number }) => {
    if (q.answer >= q.options.length) err(where, '答案序号超出选项范围')
    if (new Set(q.options.map((o) => o.trim())).size !== q.options.length) err(where, '选项重复')
    const term = hasGrammarTerm(`${q.prompt} ${q.options.join(' ')}`)
    if (term) err(where, `学生端题目出现语法术语「${term}」`)
  }

  for (const s of h.sentences) {
    const where = `sentence ${s.id}`
    if (!s.text.trim()) err(where, '原文为空')
    if (s.checkIn && s.tier !== 'must') err(where, '打卡句必须是 must')
    if (s.ladder) {
      if (!s.text.includes(s.ladder.l1.subject)) err(where, `梯子 L1「谁」不是原句子串：${s.ladder.l1.subject}`)
      if (!s.text.includes(s.ladder.l1.predicate)) err(where, `梯子 L1「做了什么」不是原句子串：${s.ladder.l1.predicate}`)
      if (!s.ladder.l2.trim()) err(where, '梯子 L2 为空')
      const term = hasGrammarTerm(`${s.ladder.l2} ${s.ladder.l3.plain} ${s.ladder.l3.glosses.map((g) => g.zh).join(' ')}`)
      if (term) err(where, `梯子里出现语法术语「${term}」`)
    }
    if (s.breakdown) {
      // 拆开的每一块必须是原句原话，标签只用大白话那几个，提示和整句中文不出现语法术语
      const bw = `${where} breakdown`
      for (const p of s.breakdown.parts) {
        if (!s.text.includes(p.text)) err(bw, `拆开的一块不是原句子串：${p.text}`)
        if (!(BREAKDOWN_LABELS as readonly string[]).includes(p.label)) err(bw, `拆开的标签不在允许的范围里：${p.label}`)
      }
      const term = hasGrammarTerm(`${s.breakdown.parts.map((p) => p.hint ?? '').join(' ')} ${s.breakdown.zh}`)
      if (term) err(bw, `拆开或整句中文里出现语法术语「${term}」`)
    }
    if (s.question) checkQuestion(`${where} question`, s.question)
    if (s.tag && !s.question) warn(where, '有结构标签但没有原句题，渐隐无法触发')
    checkSources(where, s.sources)
  }

  for (const p of h.paragraphs) {
    const where = `paragraph ${p.n}`
    const topic = sentenceById.get(p.topicSentenceId)
    if (!topic) err(where, `主题句 ${p.topicSentenceId} 不存在`)
    else if (topic.paragraph !== p.n) err(where, `主题句 ${p.topicSentenceId} 不在第 ${p.n} 段`)
    checkQuestion(`${where} gist`, p.gist)
  }

  for (const w of h.words) {
    const where = `word ${w.lemma}`
    for (const id of w.sentenceIds) {
      const s = sentenceById.get(id)
      if (!s) err(where, `句子 ${id} 不存在`)
      else if (!w.forms.some((f) => wordIn(s.text, f))) err(where, `词形 ${w.forms.join('/')} 不在句子 ${id} 里`)
    }
    if (w.guess) checkQuestion(`${where} guess`, w.guess)
    if (w.teacherCore && w.tier !== 'must') err(where, '老师核心词必须是 must')
    checkSources(where, w.sources)
  }

  const exprIds = new Set(h.expressions.map((e) => e.id))
  for (const e of h.expressions) {
    const where = `expression ${e.id}`
    const s = sentenceById.get(e.sentenceId)
    if (!s) err(where, `句子 ${e.sentenceId} 不存在`)
    let re: RegExp | undefined
    try {
      re = new RegExp(e.pattern, 'i')
    } catch {
      err(where, `正则非法：${e.pattern}`)
    }
    if (re && !re.test(e.text)) err(where, `正则匹配不到表达本身：${e.text}`)
    if (re && s && !re.test(s.text)) warn(where, `正则匹配不到出处句 ${s.id}`)
    if (e.teacherRequired && !h.writing.requiredExpressionIds.includes(e.id)) err(where, '老师要求的表达没放进写作要求')
    checkSources(where, e.sources)
  }
  for (const id of h.writing.requiredExpressionIds) if (!exprIds.has(id)) err('writing', `写作要求的表达 ${id} 不存在`)

  return issues
}

function loadRaw(): Record<number, string> | undefined {
  const dir = 'data/raw'
  if (!existsSync(dir)) return undefined
  const out: Record<number, string> = {}
  for (let d = 1; d <= 5; d++) {
    const f = join(dir, `day${d}.txt`)
    if (existsSync(f)) out[d] = readFileSync(f, 'utf8')
  }
  return out
}

export async function main(args: string[]) {
  const targets: { name: string; data: unknown; raw?: Record<number, string> }[] = []
  const raw = loadRaw()
  const files = args.length ? args : existsSync('data/handouts') ? readdirSync('data/handouts').filter((f) => f.endsWith('.json') && !f.endsWith('.report.json')).map((f) => join('data/handouts', f)) : []
  for (const f of files) targets.push({ name: f, data: JSON.parse(readFileSync(f, 'utf8')), raw })
  if (!args.length) {
    const { miniHandout } = await import('../tests/fixtures/mini-handout')
    targets.push({ name: 'tests/fixtures/mini-handout.ts', data: miniHandout })
  }
  let errors = 0
  for (const t of targets) {
    const issues = validateHandout(t.data, t.raw)
    const e = issues.filter((i) => i.level === 'error').length
    errors += e
    console.log(`${e ? '✗' : '✓'} ${t.name}：${e} 个错误，${issues.length - e} 个提醒`)
    for (const i of issues) console.log(`  ${i.level === 'error' ? '错误' : '提醒'} [${i.where}] ${i.message}`)
  }
  if (errors) process.exit(1)
}
