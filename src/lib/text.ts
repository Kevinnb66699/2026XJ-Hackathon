// 原文渲染用的切分工具。切出来的片段拼回去必须与原文逐字一致（见 tests/frontend.test.ts）。
const escapeRe = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// 粗读：把原文切成「英文单词」和「其他字符」，每个单词都能点
export interface Token {
  text: string
  word: boolean
}

export function tokenize(text: string): Token[] {
  return text
    .split(/([A-Za-z]+(?:['’][A-Za-z]+)*)/)
    .filter(Boolean)
    .map((t) => ({ text: t, word: /^[A-Za-z]/.test(t) }))
}

// 词形在原文里的所有位置（整词、不区分大小写）；不用后行断言，兼容旧版 Safari
export function findAll(text: string, form: string): [number, number][] {
  if (!form) return []
  const out: [number, number][] = []
  const re = new RegExp(`(^|[^A-Za-z])(${escapeRe(form)})(?![A-Za-z])`, 'gi')
  let m: RegExpExecArray | null
  while ((m = re.exec(text))) {
    const start = m.index + m[1].length
    out.push([start, start + m[2].length])
  }
  return out
}

export type MarkKind = 'gloss' | 'skip' | 'bold'
export interface Mark {
  start: number
  end: number
  kind: MarkKind
  lemma: string
}
export interface Highlight {
  start: number
  end: number
  kind: 'who' | 'what'
}
export interface Seg {
  text: string
  mark?: Mark
  hl?: Highlight['kind']
}

// 按词形给原文加标记；和已有标记重叠的跳过（先加的优先）
export function markWords(text: string, words: { lemma: string; forms: string[] }[], kind: MarkKind, into: Mark[] = []): Mark[] {
  for (const w of words)
    for (const f of w.forms)
      for (const [start, end] of findAll(text, f)) {
        if (!into.some((m) => start < m.end && m.start < end)) into.push({ start, end, kind, lemma: w.lemma })
      }
  return into
}

// 梯子第 1 步：在原句里找「谁」「做了什么」两段子串
export function ladderHighlights(text: string, who: string, what: string): Highlight[] {
  const out: Highlight[] = []
  const a = who ? text.indexOf(who) : -1
  if (a >= 0) out.push({ start: a, end: a + who.length, kind: 'who' })
  let b = what ? text.indexOf(what) : -1
  if (b >= 0 && a >= 0 && b < a + who.length && a < b + what.length) b = text.indexOf(what, a + who.length)
  if (b >= 0) out.push({ start: b, end: b + what.length, kind: 'what' })
  return out
}

// 按所有标记和高亮的边界切段，每段带上它所属的标记和高亮
export function segment(text: string, marks: Mark[], hls: Highlight[] = []): Seg[] {
  const cuts = new Set([0, text.length])
  for (const r of [...marks, ...hls]) {
    cuts.add(r.start)
    cuts.add(r.end)
  }
  const pts = [...cuts].sort((a, b) => a - b)
  const segs: Seg[] = []
  for (let i = 0; i < pts.length - 1; i++) {
    const [a, b] = [pts[i], pts[i + 1]]
    segs.push({
      text: text.slice(a, b),
      mark: marks.find((m) => m.start <= a && b <= m.end),
      hl: hls.find((x) => x.start <= a && b <= x.end)?.kind,
    })
  }
  return segs
}
