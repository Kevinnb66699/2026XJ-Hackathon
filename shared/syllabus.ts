// 课标词表档位：0 义务教育阶段、1 必修、2 选择性必修（数据和来源见 shared/syllabus-words.ts）。前端、管线、后端共用。
// 档位只在引擎里用，界面上不出现档位名、词汇量这些（只给词贴「高中新词」标签）。
import { SYLLABUS_PHRASES, SYLLABUS_WORDS } from './syllabus-words'

export type SyllabusBand = 0 | 1 | 2

// café 和 cafe、o’clock 和 o'clock 算同一个写法
const fold = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/’/g, "'")

// exact 区分大小写（China 是 0、china 是 1）；lower 给大小写对不上的查，同一个小写写法原表小写的那条优先
const exact = new Map<string, SyllabusBand>()
const lower = new Map<string, SyllabusBand>()
for (const entry of [...SYLLABUS_WORDS, ...SYLLABUS_PHRASES]) {
  const band = (entry.match(/\*+$/)?.[0].length ?? 0) as SyllabusBand
  for (const form of entry.replace(/\*+$/, '').split('/')) {
    if (form.includes(' ')) continue // 多词写法不当单词查
    const f = fold(form)
    exact.set(f, band)
    if (f === f.toLowerCase() || !lower.has(f.toLowerCase())) lower.set(f.toLowerCase(), band)
  }
}

// 按规则还原 -s、-es、-ies、-ed、-ied、-ing（含双写辅音）；不还原派生词（课标不列能推导出的派生词）。
// 先试的先算：-ies 先于 -s、-es（skies 是 sky 不是 ski）；-ing 先补 e、再去掉、最后去双写
// （staring 是 stare、starring 是 star，biting / sitting / wining / winning 同理，课标里成对的词都这样核对过）
const undouble = (s: string) => (/([b-df-hj-np-tv-z])\1$/.test(s) ? s.slice(0, -1) : '')
function stems(w: string): string[] {
  const out: string[] = []
  if (w.endsWith('ies')) out.push(w.slice(0, -3) + 'y')
  if (w.endsWith('s')) out.push(w.slice(0, -1))
  if (w.endsWith('es')) out.push(w.slice(0, -2))
  if (w.endsWith('ed')) {
    const s = w.slice(0, -2)
    out.push(w.slice(0, -1), s, undouble(s))
  }
  if (w.endsWith('ied')) out.push(w.slice(0, -3) + 'y')
  if (w.endsWith('ing')) {
    const s = w.slice(0, -3)
    out.push(s + 'e', s, undouble(s))
  }
  return out.filter((s) => s.length >= 2)
}

// 写法 form 能不能按上面的规则还原成原形 lemma（不分大小写）：引擎跨篇认单词本里的词时用，found 还原不成 find
export const inflectsTo = (form: string, lemma: string): boolean => stems(form.toLowerCase()).includes(lemma.toLowerCase())

// 看着像变形、其实本身就是原形的词，不还原（incoming 是「新来的」，不是 income）
const NOT_INFLECTED = new Set(['incoming'])

// 全文词义里专有名词的中文写成「（人名）凯莉」（pipeline/lexicon.ts 的提示词：人名、地名、机构名），这类不分档。
// 机构名里的单个词（United Nations 的 Nations）也挡住；提示词只举了「（人名）」的例子，模型也可能写「（机构）」
export const PROPER_NAME_TAGS = ['人名', '地名', '机构名', '机构'] as const
const PROPER_NAME = new RegExp(`^（(${PROPER_NAME_TAGS.join('|')})）`)

// zh 是全文词义里的中文（见上）。短语不分档；全大写的缩写（AIDS）只按原样查，不还原
export const syllabusBand = (lemma: string, zh?: string): SyllabusBand | undefined => {
  if (zh && PROPER_NAME.test(zh)) return undefined
  const w = fold(lemma.trim())
  if (!w || /\s/.test(w)) return undefined
  const hit = exact.get(w) ?? lower.get(w.toLowerCase())
  if (hit !== undefined) return hit
  if ((w.length > 1 && w === w.toUpperCase()) || NOT_INFLECTED.has(w.toLowerCase())) return undefined
  for (const s of stems(w.toLowerCase())) {
    const b = lower.get(s)
    if (b !== undefined) return b
  }
  return undefined
}
