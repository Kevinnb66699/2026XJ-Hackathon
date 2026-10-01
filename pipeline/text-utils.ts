// 入库用的文本小工具：在原文里找词形、为表达生成「有没有用上」的正则

const escapeRe = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// 老师核心词（如 'deprive...of...'、'toy with'、'shovel'）在原文里的实际词形
export function findForms(term: string, sentences: { id: string; text: string }[]): { forms: string[]; sentenceIds: string[] } {
  const first = term.replace(/\.\.\./g, ' ').trim().split(/\s+/)[0]
  const stem = first.length > 5 ? first.slice(0, first.length - 1) : first
  const re = new RegExp(`\\b(${escapeRe(stem)}[a-z]*)\\b`, 'gi')
  const forms = new Set<string>()
  const ids: string[] = []
  for (const s of sentences) {
    const hits = [...s.text.matchAll(re)].map((m) => m[1])
    if (hits.length) {
      hits.forEach((h) => forms.add(h))
      ids.push(s.id)
    }
  }
  return { forms: [...forms], sentenceIds: ids }
}

// 由表达文本生成「有没有用上」的正则（不用模型写的正则，规则更可靠）：
// - 第一个词允许动词变形（s/es/ed/d/ing），其余词允许复数；
// - 「...」「sb」「sth」「one's」以及「do sth」里的 do 当作可跳过的 0-4 个词（如 only too ... to、deprive...of...）；
// - 第一个词和第二个词之间允许夹 0-2 个词（拆开的短语动词，如 kicking under-16s off）。
// 词与词之间：空白，或讲义写法里的省略号（如 deprive...of...）
const SEP = '[\\s.…]+'
const GAP = `(?:${SEP}\\S+){0,4}`
const PLACEHOLDER = new Set(['sb', 'sth', "one's", '…'])
export function patternFor(text: string): string {
  const tokens = text.replace(/\.\.\./g, ' … ').trim().split(/\s+/)
  let out = '\\b'
  let words = 0
  tokens.forEach((tok, i) => {
    const t = tok.toLowerCase()
    // 「do sth」「do sb」里的 do 代表任意动词，也当作可跳过
    if (PLACEHOLDER.has(t) || (t === 'do' && PLACEHOLDER.has((tokens[i + 1] ?? '').toLowerCase()))) {
      out += GAP
      return
    }
    const base = escapeRe(tok.replace(/s$/, ''))
    if (words === 0) out += `${base}(?:s|es|ed|d|ing)?`
    else out += `${words === 1 ? GAP.replace('{0,4}', '{0,2}') : ''}${SEP}${base}s?`
    words++
  })
  return out + '\\b'
}
