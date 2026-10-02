// 原文渲染用的切分工具。切出来的片段拼回去必须与原文逐字一致（见 tests/frontend.test.ts）。
import { hasGrammarTerm } from '../../shared/terms'

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

// 粗读：词形（小写）→ lemma。多词词形（如 toying with）一次只能点一个词，所以再把它的第一个词（toying）
// 也指到这个词条；虚词、太短的词不指，已经被别的词条占用的词也不指
const FUNCTION_WORDS = new Set(['the', 'a', 'an', 'to', 'of', 'in', 'on', 'at', 'for', 'with', 'and', 'be', 'is', 'are'])
export function lemmaIndex(words: { lemma: string; forms: string[] }[]): Map<string, string> {
  const m = new Map<string, string>()
  for (const w of words) for (const f of w.forms) m.set(f.toLowerCase(), w.lemma)
  for (const w of words)
    for (const f of w.forms) {
      const parts = f.toLowerCase().trim().split(/\s+/)
      const first = parts[0]
      if (parts.length > 1 && first.length >= 3 && !FUNCTION_WORDS.has(first) && !m.has(first)) m.set(first, w.lemma)
    }
  return m
}

// 「给你」便签引的那一句老师讲解：既点名这个词、又带「如果」，而且没有术语（hasGrammarTerm）。
// 没有这样的一句就返回 undefined，不拿讲解里别的句子凑（可能讲了词义、说出题目答案）。
// 按句号、分号切句（不用后行断言：iOS 16.3 及更早的 Safari 不认，整个页面会白屏）
export function noteQuote(note: string, forms: string[]): string | undefined {
  const parts = (note.match(/[^。；]+[。；]?/g) ?? []).map((x) => x.trim()).filter(Boolean)
  return parts.find((x) => x.includes('如果') && !hasGrammarTerm(x) && forms.some((f) => findAll(x, f).length > 0))?.replace(/[。；]$/, '')
}

// 两段英文是否一字不差：不计首尾空白、空白个数和引号写法（’ 与 '、“” 与 "）
export function sameWording(a: string, b: string): boolean {
  const norm = (x: string) => x.trim().replace(/\s+/g, ' ').replace(/[‘’]/g, "'").replace(/[“”]/g, '"')
  return norm(a) === norm(b)
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
export interface Seg {
  text: string
  mark?: Mark
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

// 梯子批注：把要讲的几块（原句原话，如「谁」「做了什么」或拆开的各块）放回原句，按位置排好，
// 没被哪块盖住的原文（连接词、标点）夹在中间，拼回去与原文逐字一致。
// 先列的块先放；一块在原句里出现多次时取不和已放好的块重叠的那一处，怎么放都重叠就跳过
export interface Chunk<P> {
  text: string
  start: number
  end: number
  part?: P
}
export function annotate<P extends { text: string }>(text: string, parts: P[]): Chunk<P>[] {
  const placed: Chunk<P>[] = []
  for (const part of parts) {
    if (!part.text) continue
    for (let i = text.indexOf(part.text); i >= 0; i = text.indexOf(part.text, i + 1)) {
      const end = i + part.text.length
      if (placed.some((x) => i < x.end && x.start < end)) continue
      placed.push({ text: part.text, start: i, end, part })
      break
    }
  }
  placed.sort((a, b) => a.start - b.start)
  const out: Chunk<P>[] = []
  let at = 0
  for (const x of placed) {
    if (x.start > at) out.push({ text: text.slice(at, x.start), start: at, end: x.start })
    out.push(x)
    at = x.end
  }
  if (at < text.length) out.push({ text: text.slice(at), start: at, end: text.length })
  return out
}

// 按所有标记的边界切段，每段带上它所属的标记；from、to 只切原文的这一段（梯子批注时一块一块地切）
export function segment(text: string, marks: Mark[], from = 0, to = text.length): Seg[] {
  const cuts = new Set([from, to])
  for (const r of marks)
    for (const p of [r.start, r.end]) if (from < p && p < to) cuts.add(p)
  const pts = [...cuts].sort((a, b) => a - b)
  const segs: Seg[] = []
  for (let i = 0; i < pts.length - 1; i++) {
    const [a, b] = [pts[i], pts[i + 1]]
    segs.push({ text: text.slice(a, b), mark: marks.find((m) => m.start <= a && b <= m.end) })
  }
  return segs
}
