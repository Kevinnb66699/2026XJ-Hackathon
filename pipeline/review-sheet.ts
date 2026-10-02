// 生成给队友校对的表格（CSV，Excel / Numbers / 飞书都能直接打开）：模型起草的每一条内容一行，
// 按优先级排序，并标出自动体检发现的可疑点。队友在「结论 / 改成」两列填写，交回后写进 pipeline/human-edits.json。
// 用法：npx vite-node pipeline/review-sheet.ts   → docs/校对表.csv
import { readFileSync, writeFileSync } from 'fs'
import { Handout, type Question } from '../shared/schema'

const h = Handout.parse(JSON.parse(readFileSync('data/handouts/social-media.json', 'utf8')))
const textOf = (id: string) => h.sentences.find((s) => s.id === id)?.text ?? ''

// 演示必经的句子先校对：展位评委模式（pending、S16、S04）和路演里的渐隐链（S09）
const DEMO = new Set(['S04', 'S09', 'S16', 'S17'])
const PRONOUNS = new Set(['they', 'it', 'he', 'she', 'this', 'that', 'these', 'those', 'them'])

interface Row {
  priority: string
  kind: string
  id: string
  sentence: string
  content: string
  flags: string[]
}
const rows: Row[] = []

function giveaway(q: Question): string | undefined {
  const lens = q.options.map((o) => o.length)
  const others = lens.filter((_, i) => i !== q.answer)
  return lens[q.answer] > 1.6 * Math.max(...others) ? `正确项明显比其他选项长（${lens[q.answer]} 字 vs ${Math.max(...others)} 字），可能被猜出来` : undefined
}
const showQ = (q: Question) => `${q.prompt}\n${q.options.map((o, i) => `${i === q.answer ? '✔ ' : '   '}${String.fromCharCode(65 + i)}. ${o}`).join('\n')}`
const prio = (sentenceId: string, flagged: boolean) => (DEMO.has(sentenceId) || flagged ? 'P1' : h.sentences.find((s) => s.id === sentenceId)?.checkIn ? 'P2' : 'P3')

for (const s of h.sentences) {
  if (s.ladder) {
    const { subject, predicate } = s.ladder.l1
    const flags: string[] = []
    if (PRONOUNS.has(subject.toLowerCase())) flags.push(`「谁」只写了代词 ${subject}，没说指的是什么`)
    if (predicate.split(/\s+/).length <= 1) flags.push(`「做了什么」只有一个词 ${predicate}，可能太单薄`)
    rows.push({
      priority: prio(s.id, flags.length > 0),
      kind: '梯子',
      id: s.id,
      sentence: s.text,
      content: `① 谁：${subject}\n   做了什么：${predicate}\n② 正常语序：${s.ladder.l2}\n③ 简单英文：${s.ladder.l3.plain}\n   难词：${s.ladder.l3.glosses.map((g) => `${g.term}=${g.zh}`).join('；')}`,
      flags,
    })
  }
  if (s.question) {
    const g = giveaway(s.question)
    rows.push({ priority: prio(s.id, !!g), kind: '原句题', id: s.id, sentence: s.text, content: showQ(s.question), flags: g ? [g] : [] })
  }
}
for (const p of h.paragraphs) {
  const g = giveaway(p.gist)
  rows.push({
    priority: g ? 'P1' : 'P3',
    kind: '段意题',
    id: `第 ${p.n} 段`,
    sentence: `主题句 ${p.topicSentenceId}：${textOf(p.topicSentenceId)}`,
    content: `${showQ(p.gist)}\n要点（英文）：${p.gistEn}`,
    flags: g ? [g] : [],
  })
}
for (const w of h.words) {
  const sid = w.sentenceIds[0]
  const demo = w.sentenceIds.some((id) => DEMO.has(id))
  const flags: string[] = []
  const g = w.guess && giveaway(w.guess)
  if (g) flags.push(g)
  rows.push({
    priority: demo || flags.length ? 'P1' : w.teacherCore ? 'P2' : 'P3',
    kind: w.teacherCore ? '注释词（老师核心词）' : w.familiarTrap ? '注释词（熟词僻义）' : '注释词',
    id: w.lemma,
    sentence: `${sid}：${textOf(sid)}`,
    content: `中文：${w.zh}${w.pos ? `\n词性：${w.pos}` : ''}${w.en ? `\n英文（${w.teacherCore ? '老师' : 'AI 起草，待抽查'}）：${w.en}` : ''}${w.guess ? `\n先猜后看：${showQ(w.guess)}` : ''}`,
    flags,
  })
}
for (const e of h.expressions) {
  const flags: string[] = []
  try {
    if (!new RegExp(e.pattern, 'i').test(textOf(e.sentenceId))) flags.push('写作检查认不出原句里的这个表达（变形不一样），可能需要换个写法')
  } catch {
    flags.push('匹配规则有误')
  }
  rows.push({
    priority: flags.length ? 'P2' : 'P3',
    kind: e.teacherRequired ? '表达（老师要求）' : '表达',
    id: e.id,
    sentence: `${e.sentenceId}：${textOf(e.sentenceId)}`,
    content: `${e.text} = ${e.zh}`,
    flags,
  })
}

const order = { P1: 0, P2: 1, P3: 2 } as Record<string, number>
rows.sort((a, b) => order[a.priority] - order[b.priority])

const cell = (x: string) => `"${x.replace(/"/g, '""')}"`
const header = ['序号', '优先级', '类型', '编号', '原文', '待校对的内容', '自动体检提示', '结论（对 / 改 / 删）', '改成', '备注']
const lines = [header.map(cell).join(',')]
rows.forEach((r, i) => lines.push([String(i + 1), r.priority, r.kind, r.id, r.sentence, r.content, r.flags.join('；'), '', '', ''].map(cell).join(',')))
// 带 BOM，Excel 打开中文不乱码
writeFileSync('docs/校对表.csv', '﻿' + lines.join('\r\n') + '\r\n')

const count = (p: string) => rows.filter((r) => r.priority === p).length
console.log(`docs/校对表.csv：共 ${rows.length} 条（P1 ${count('P1')}，P2 ${count('P2')}，P3 ${count('P3')}），自动体检标出 ${rows.filter((r) => r.flags.length).length} 条`)
