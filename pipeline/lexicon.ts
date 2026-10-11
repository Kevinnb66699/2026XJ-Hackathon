// 全文词义（handout.lexicon）：给原文里讲义词表之外的词配语境里的中文意思。学生粗读点了词表外的词，「生词」卡片和精读注释才有意思可看。
// 分两步：glossArticle 按段请模型（上传时和起草同时跑；一次最多 BATCH 个词，各批并行），模型漏掉的词再请一次；
// mergeLexicon 按规则合进讲义（词表里已有的写法跳过）。出错、漏掉的只记个数，不让上传失败
import { z } from 'zod'
import type { Handout, LexWord } from '../shared/schema'
import { hasGrammarTerm } from '../shared/terms'
import { findAll, lemmaIndex, tokenize } from '../src/lib/text'
import { chatJson, type LlmConfig } from './llm'

export const LEXICON_PROMPT_VERSION = 'lexicon-v1'
const BATCH = 40

const SYSTEM_PROMPT = `你在给中国高中生读的英文文章配词义。输入是一段原文（带句子 id）和这段里要配意思的词（原文写法，小写）。
只输出一个 JSON 对象：{"words": [每个输入的词一项: {"form": 输入里的写法（照抄）, "lemma": 原形（名词单数、动词原形、形容词和副词原级；人名、地名照原文大小写）, "pos": 词性（n. v. adj. adv. prep. conj. pron. num. art. int. 之一）, "zh": 这个词在这段里的中文意思}]}
要求：
- 每个输入的词都要给，不能漏，也不要加输入里没有的词。
- zh 是这个词在本段语境里的意思，简短（一般 2–8 个字），不解释、不举例；人名、地名、机构名写成「（人名）凯莉」这样。
- zh 只写意思，不写词性和用法说明（不要写「助动词」「冠词」这类）；the、of、it 这类小词也照样给意思，在这里没有实际意思的（如疑问句里的 do）写「（这里没有实际意思）」。
- 缩写给整个缩写的意思：don’t →「不」，it’s →「它是」，lemma 写完整形式（do not、it is）。
- zh 里不能出现 倒装、同位语、从句、主语、谓语、宾语、状语、定语、表语、语法 这些词。`

const GlossOut = z.object({ words: z.array(z.object({ form: z.string(), lemma: z.string(), pos: z.string().nullish(), zh: z.string() })) })
type GlossOut = z.infer<typeof GlossOut>

export interface LexParagraph {
  n: number
  sentences: { id: string; text: string }[]
}
export interface Gloss {
  form: string // 原文写法的小写
  lemma: string
  pos?: string
  zh: string
}
// failed：两次都没请成的批数，errors 是这几批的原因（「第 2 段：超时」，只有类别，不带原文和模型输出）；
// missingForms：最后还没配上意思的词（含词表里已有的，合进讲义时再去掉）
export interface GlossResult {
  glosses: Gloss[]
  model?: string
  failed: number
  errors: string[]
  missing: number
  missingForms: string[]
}
export type GlossFn = (p: LexParagraph, forms: string[]) => Promise<{ data: GlossOut; model: string }>

// 一批没请成的原因：只要类别，写进上传日志和补词义命令的输出
function reason(err: unknown): string {
  const e = err as { name?: string; message?: string }
  const m = String(e?.message ?? err)
  if (e?.name === 'AbortError') return '超时'
  const http = m.match(/^模型接口返回 (\d+)/)
  if (http) return `接口返回 ${http[1]}`
  if (m.startsWith('模型输出两次都不符合')) return '输出格式不对'
  if (m.startsWith('模型输出里没有 JSON') || m.startsWith('模型没有返回内容')) return '模型没给 JSON'
  if (m.startsWith('回放模式')) return '回放模式缺缓存'
  if (m.startsWith('缺少 LLM_API_KEY')) return '缺少 Key'
  if (m === 'fetch failed') return '连不上模型接口'
  return `其他错误（${(e?.name ?? 'Error').slice(0, 40)}）`
}

// 模型回的写法和问的对不上时，只差大小写和弯撇号也算对上
const norm = (t: string) => t.trim().toLowerCase().replace(/’/g, "'")

// 每段要配意思的词：原文写法的小写，去重；前面段落出现过的不再配（意思按第一次出现的语境）
export function formsByParagraph(paras: LexParagraph[]): string[][] {
  const seen = new Set<string>()
  return paras.map((p) => {
    const out: string[] = []
    for (const s of p.sentences)
      for (const t of tokenize(s.text)) {
        const f = t.text.toLowerCase()
        if (t.word && !seen.has(f)) {
          seen.add(f)
          out.push(f)
        }
      }
    return out
  })
}

// 学生看得到 zh：要有中文、不长、没有语法术语；原形不像一个词（带了别的符号、太长）就用原文写法
function clean(raw: GlossOut['words'][number], asked: Map<string, string>): Gloss | undefined {
  const form = asked.get(norm(raw.form))
  const zh = raw.zh.trim()
  if (!form || !zh || zh.length > 30 || !/[一-鿿]/.test(zh) || hasGrammarTerm(zh)) return undefined
  const lemma = raw.lemma.trim()
  const pos = raw.pos?.trim()
  return { form, lemma: /^[A-Za-z][A-Za-z'’. -]{0,39}$/.test(lemma) ? lemma : form, zh, ...(pos && pos.length <= 12 ? { pos } : {}) }
}

export async function glossArticle(cfg: LlmConfig, paras: LexParagraph[], gloss?: GlossFn): Promise<GlossResult> {
  const call: GlossFn =
    gloss ??
    ((p, forms) => chatJson(cfg, { system: SYSTEM_PROMPT, user: JSON.stringify({ sentences: p.sentences, words: forms }, null, 1), promptVersion: LEXICON_PROMPT_VERSION }, GlossOut))
  const lists = formsByParagraph(paras)
  const batches = paras.flatMap((p, i) => Array.from({ length: Math.ceil(lists[i].length / BATCH) }, (_, k) => ({ p, forms: lists[i].slice(k * BATCH, (k + 1) * BATCH) })))
  let model: string | undefined
  const results = await Promise.all(
    batches.map(async ({ p, forms }) => {
      const asked = new Map(forms.map((f) => [norm(f), f]))
      const got = new Map<string, Gloss>()
      let ok = false
      let error = ''
      // 第二次只问第一次漏掉的（第一次出错就全部再问一次）
      for (let round = 0; round < 2 && got.size < forms.length; round++) {
        try {
          const r = await call(p, forms.filter((f) => !got.has(f)))
          ok = true
          model ??= r.model
          for (const raw of r.data.words) {
            const g = clean(raw, asked)
            if (g && !got.has(g.form)) got.set(g.form, g)
          }
        } catch (err) {
          error = reason(err) // 再试一次；两次都出错算这一批失败
        }
      }
      return { glosses: [...got.values()], failed: ok ? 0 : 1, error: ok ? '' : `第 ${p.n} 段：${error}`, missingForms: forms.filter((f) => !got.has(f)) }
    }),
  )
  return {
    glosses: results.flatMap((r) => r.glosses),
    model,
    failed: results.reduce((n, r) => n + r.failed, 0),
    errors: results.flatMap((r) => (r.error ? [r.error] : [])),
    missing: results.reduce((n, r) => n + r.missingForms.length, 0),
    missingForms: results.flatMap((r) => r.missingForms),
  }
}

// 合进讲义（模型一批都没答成时不写 lexicon），返回词条数和还缺意思的词数（词表里已有的写法不算缺）。
// 词表里已有的写法（含短语的第一个词，见 lemmaIndex）跳过：粗读点它们算词表里的词。按原形分组，原形和词表里的词相同的
// （多半是词表漏了这个写法，也可能是另一个意思）按写法各算一组，不和词表里的词混在一起。一组里意思相同的写法合成一条（videos / video）；
// 原形本身那个写法（没有就是第一个）的意思用原形当词条名，别的意思（is「正在」、was「是」）用各自第一个写法另起一条，
// 这个名字已经是别的词条或词表里的词，就并进原形那一条。出现在哪几句按规则重新找
export function mergeLexicon(h: Handout, r: GlossResult): { words: number; missing: number } {
  const covered = lemmaIndex(h.words)
  const missing = r.missingForms.filter((f) => !covered.has(f)).length
  if (!r.model) return { words: 0, missing }
  const listed = new Set(h.words.map((w) => w.lemma.toLowerCase()))
  const groups = new Map<string, Gloss[]>()
  for (const g of r.glosses) {
    if (covered.has(g.form)) continue
    const key = listed.has(g.lemma.toLowerCase()) ? g.form : g.lemma.toLowerCase()
    groups.set(key, [...(groups.get(key) ?? []), g])
  }
  const names = new Set([...listed, ...groups.keys()])
  const entry = (lemma: string, gs: Gloss[]): LexWord => ({ lemma, forms: gs.map((g) => g.form), sentenceIds: [], zh: gs[0].zh, ...(gs[0].pos ? { pos: gs[0].pos } : {}) })
  const entries: LexWord[] = []
  for (const [key, gs] of groups) {
    const base = gs.find((g) => g.form === key) ?? gs[0]
    const byZh = new Map<string, Gloss[]>()
    for (const g of [base, ...gs.filter((x) => x !== base)]) byZh.set(g.zh, [...(byZh.get(g.zh) ?? []), g])
    const [main, ...others] = [...byZh.values()]
    const head = entry(listed.has(base.lemma.toLowerCase()) ? base.form : base.lemma, main)
    entries.push(head)
    for (const gs2 of others) {
      if (names.has(gs2[0].form)) head.forms.push(...gs2.map((g) => g.form))
      else {
        names.add(gs2[0].form)
        entries.push(entry(gs2[0].form, gs2))
      }
    }
  }
  const words = entries
    .map((e) => ({ ...e, sentenceIds: h.sentences.filter((s) => e.forms.some((f) => findAll(s.text, f).length > 0)).map((s) => s.id) }))
    .filter((e) => e.sentenceIds.length > 0)
  h.lexicon = { words, provenance: { by: 'llm', model: r.model, promptVersion: LEXICON_PROMPT_VERSION } }
  return { words: words.length, missing }
}

// 给一份讲义配全文词义（上传之后补的，见 scripts/lexicon.mjs）：按讲义的段落和句子请模型，合进讲义
export async function addLexicon(cfg: LlmConfig, h: Handout, gloss?: GlossFn): Promise<GlossResult & { words: number }> {
  const paras = [...new Set(h.sentences.map((s) => s.paragraph))].map((n) => ({ n, sentences: h.sentences.filter((s) => s.paragraph === n).map((s) => ({ id: s.id, text: s.text })) }))
  const r = await glossArticle(cfg, paras, gloss)
  return { ...r, ...mergeLexicon(h, r) }
}
