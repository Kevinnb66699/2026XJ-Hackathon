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
// - 第一个词允许动词变形（s/es/ed/d/ing；以 e 结尾的去 e 再变，如 taking、deprived；be 认 is/are/was/being 等），
//   其余词允许复数（f/fe 结尾的认 ves，如 lives）；
// - 「...」「sb」「sth」「someone」「something」「one's」「doing」以及「do sth」里的 do 当作可跳过的 0-4 个词
//   （如 only too ... to、deprive...of...、be tricked into doing）；
// - 第一个词和第二个词之间允许夹 0-2 个词（拆开的短语动词，如 kicking under-16s off）。
// 词与词之间：空白，或讲义写法里的省略号（如 deprive...of...）
const SEP = '[\\s.…]+'
// 跳过的词本身不能含空白、句点或省略号：否则一长串「……」可以被拆成无数种组合，正则回溯会卡死
const GAP = `(?:${SEP}[^\\s.…]+){0,4}`
const PLACEHOLDER = new Set(['sb', 'sth', 'someone', 'somebody', 'something', "one's", 'doing', '…'])
const verbForms = (w: string) => {
  if (w.toLowerCase() === 'be') return '(?:be|being|been|am|is|are|was|were)'
  const b = w.replace(/s$/, '')
  return /[^e]e$/i.test(b) ? `${escapeRe(b.slice(0, -1))}(?:e|es|ed|ing|en)` : `${escapeRe(b)}(?:s|es|ed|d|ing)?`
}
const nounForms = (w: string) => {
  const b = w.replace(/s$/, '')
  if (b.length >= 4 && /fe$/i.test(b)) return `${escapeRe(b.slice(0, -2))}(?:fe|ves)`
  if (b.length >= 4 && /f$/i.test(b)) return `${escapeRe(b.slice(0, -1))}(?:f|ves)`
  return `${escapeRe(b)}s?`
}
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
    if (words === 0) out += verbForms(tok)
    else out += `${words === 1 ? GAP.replace('{0,4}', '{0,2}') : ''}${SEP}${nounForms(tok)}`
    words++
  })
  return out + '\\b'
}

// 选项洗牌：模型总把正确答案放在固定位置（常在第 2 个，先猜后看总在第 1 个），学生会按位置猜。
// 按题目 id 的哈希确定性洗牌，回放时结果不变。
export function shuffleChoice<T extends { id: string; options: string[]; answer: number }>(q: T): T {
  let h = 2166136261
  for (const c of q.id) h = Math.imul(h ^ c.charCodeAt(0), 16777619)
  const order = q.options.map((_, i) => i)
  for (let i = order.length - 1; i > 0; i--) {
    h = Math.imul(h ^ (h >>> 13), 0x5bd1e995) >>> 0
    const j = h % (i + 1)
    ;[order[i], order[j]] = [order[j], order[i]]
  }
  return { ...q, options: order.map((i) => q.options[i]), answer: order.indexOf(q.answer) }
}
