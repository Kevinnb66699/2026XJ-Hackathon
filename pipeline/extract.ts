// 讲义规则抽取：data/raw/day1~5.txt（老师讲义经 pdftotext -layout）→ data/extract/social-media.extract.json
// 运行：npx vite-node pipeline/extract.ts
// 只抽讲义里明写的内容，每条带出处 source；梯子、意思题等由后续大模型步骤起草。
import { mkdirSync, readFileSync, writeFileSync } from 'fs'
import type { Source } from '../shared/schema'
import { Extract } from './extract-schema'
import { HAS_CJK, joinLines, normalizeSpace, normalizeText, stripFooters } from './normalize'
import { summaryClozeForms } from './overrides'

type Lines = string[]
type Sentence = Extract['article']['sentences'][number]
interface Article {
  paragraphs: Extract['article']['paragraphs']
  sentences: Sentence[]
  full: string // 全文：所有句子用空格相连
  spans: { id: string; start: number; end: number }[] // 每句在 full 里的位置
  tokens: { w: string; id: string }[] // 按空格切的词，带所在句子 id
}

const src = (day: number, section: string, quote: string): Source => ({ day, section, quote: normalizeSpace(quote) })
const indented = (l: string) => /^\s/.test(l)
const noCJK = (l: string) => !HAS_CJK.test(l)
// 粗略判断是不是同一个词的变形：去掉词尾 e 后开头相同，后缀不超过 3 个字母（toying、shovelled、arise）
const sameWord = (tok: string, w: string) => {
  const s = w.replace(/e$/, '')
  return tok.startsWith(s) && tok.length - s.length <= 3
}
// 小写并去掉词两端的标点
const bare = (w: string) => w.toLowerCase().replace(/^[^a-z]+|[^a-z]+$/g, '')

// 切节：「二、细节理解」这样的标题行把一天分成几节。返回去掉页脚的原始行（保留缩进）
const HEADER = /^\s*[一二三四五六七八九十]+、(.+?)\s*$/
function section(raw: string, title: string): Lines {
  const lines = stripFooters(raw)
  const start = lines.findIndex((l) => HEADER.exec(l)?.[1].startsWith(title))
  if (start < 0) throw new Error(`找不到小节：${title}`)
  const end = lines.findIndex((l, i) => i > start && HEADER.test(l))
  return lines.slice(start + 1, end < 0 ? lines.length : end)
}

// 按缩进分段：缩进的行开始新段，顶格的行接在上一段后面（跨页、折行）
function paragraphsByIndent(lines: Lines): Lines[] {
  const out: Lines[] = []
  for (const l of lines) {
    if (!l.trim()) continue
    if (indented(l) || !out.length) out.push([l])
    else out[out.length - 1].push(l)
  }
  return out
}

// 按题号分块：「12. xxx」开始新块，后面的非空行都归它
function numberedBlocks(lines: Lines): Lines[] {
  const out: Lines[] = []
  for (const l of lines) {
    if (/^\s*\d+\.\s/.test(l)) out.push([l])
    else if (out.length && l.trim()) out[out.length - 1].push(l)
  }
  return out
}

// 句子 id：引文在原文里覆盖到的所有句子
function locate(art: Article, quote: string): string[] {
  const q = normalizeSpace(quote)
  const pos = art.full.indexOf(q)
  if (pos < 0) throw new Error(`原文里找不到：${q.slice(0, 80)}`)
  return art.spans.filter((s) => s.start < pos + q.length && s.end > pos).map((s) => s.id)
}

// 1. 原文：Day 1「二、原文泛读」。段首缩进，跨页的续行顶格；按句末标点 + 大写开头切句
function parseArticle(day1: string): Article {
  const sentences: Sentence[] = []
  const paragraphs = paragraphsByIndent(section(day1, '原文泛读').filter(noCJK)).map((ls, i) => {
    const text = joinLines(ls)
    const sentenceIds = text.split(/(?<=[.!?])\s+(?=[A-Z“"])/).map((t) => {
      const id = `S${String(sentences.length + 1).padStart(2, '0')}`
      sentences.push({ id, paragraph: i + 1, text: t, source: src(1, '原文泛读', t) })
      return id
    })
    return { n: i + 1, text, sentenceIds }
  })
  const spans: Article['spans'] = []
  const tokens: Article['tokens'] = []
  let at = 0
  for (const s of sentences) {
    spans.push({ id: s.id, start: at, end: at + s.text.length })
    at += s.text.length + 1
    for (const w of s.text.split(' ')) tokens.push({ w, id: s.id })
  }
  return { paragraphs, sentences, full: sentences.map((s) => s.text).join(' '), spans, tokens }
}

// 2. 精读覆盖：Day 2/3「一、今日学习范围」的段落和原文段落逐段比对
function parseCoverage(art: Article, day: number, raw: string): Extract['dayCoverage'][number] {
  const paragraphs = paragraphsByIndent(section(raw, '今日学习范围').filter(noCJK)).map((ls) => {
    const text = joinLines(ls)
    const p = art.paragraphs.find((p) => p.text === text)
    if (!p) throw new Error(`Day ${day} 学习范围里的段落和原文不一致：${text.slice(0, 60)}`)
    return p.n
  })
  const sentenceIds = paragraphs.flatMap((n) => art.paragraphs[n - 1].sentenceIds)
  return { day, paragraphs, sentenceIds, source: src(day, '今日学习范围', art.sentences.find((s) => s.id === sentenceIds[0])!.text) }
}

// 3. 核心词汇表：顶格行开始一条，缩进行是续行。中文释义和英文提示两列会交错，
// 按文字区分：含中文的词块归中文释义，其余归英文提示（各自保持行序）
function parseCoreVocab(day1: string): Extract['coreVocab'] {
  const rows: Lines[] = []
  for (const l of section(day1, '核心词汇表')) {
    if (!l.trim() || l.includes('单词/短语')) continue // 空行、表头
    if (!indented(l)) rows.push([l])
    else rows[rows.length - 1].push(l)
  }
  return rows.map((row) => {
    const tokens = row.join(' ').trim().split(/\s+/) // 用原始空白切词块，归一化会把「；」和后面的英文粘在一起
    const p = tokens.findIndex((t) => t === '-' || /^\/.+\/$/.test(t)) // 音标列
    if (p < 1) throw new Error(`词汇表行解析失败：${row[0]}`)
    const rest = tokens.slice(p + 2)
    return {
      term: tokens.slice(0, p).join(' '),
      phonetic: tokens[p] === '-' ? null : tokens[p],
      pos: tokens[p + 1],
      zh: rest.filter((t) => HAS_CJK.test(t)).join(''),
      enHint: rest.filter(noCJK).join(' '),
      source: src(1, '核心词汇表', row[0]),
    }
  })
}

// 单选题（Day 1 词汇检测、Day 2/3 细节理解）：一题合成一行，再按「 A. 」「 B. 」…切选项
function parseChoices(day: number, section: string, lines: Lines) {
  return numberedBlocks(lines).map((b) => {
    const [head, ...opts] = joinLines(b).split(/ (?=[A-D]\. )/)
    const m = /^(\d+)\. (.+)$/.exec(head)
    if (!m || opts.length !== 4 || opts.some((o, i) => !o.startsWith(`${'ABCD'[i]}. `)))
      throw new Error(`选择题解析失败：${head}`)
    return { n: Number(m[1]), stem: m[2], options: opts.map((o) => o.slice(3)), answer: null, source: src(day, `${section}#${m[1]}`, head) }
  })
}

// 引文上下文：start..end 前后各取 n 个词，仍是原文的连续片段
function around(text: string, start: number, end: number, n = 3): string {
  const before = text.slice(0, start).split(' ').slice(-n - 1).join(' ')
  const after = text.slice(end).split(' ').slice(0, n + 1).join(' ')
  return before + text.slice(start, end) + after
}

// 5. 文章总结填空：只填能唯一推断的空。两条证据：
// A 生词池：Day 1 核心词 + 词汇检测的单词，首字母相同；短语（toy with、deprive...of...）要求后面几个词里有它的后半截
// B 原文对齐：Day 1 原文里首字母相同、且左邻或右邻词和空格两侧相同的词（直接给出原文词形）
// A、B 交集唯一 → 取它；否则 A 唯一 → 取原文词形；A 为空时 B 左右都对上且唯一 → 取它；其余为 null
function parseSummaryCloze(art: Article, day1: string, coreVocab: Extract['coreVocab'], quiz: { stem: string }[]): Extract['summaryCloze'] {
  const text = joinLines(section(day1, '文章总结填空').filter(noCJK))
  const pool = [...coreVocab.map((v) => v.term), ...quiz.map((q) => q.stem.replace(/\s*\(.+\)$/, '')).filter((s) => /^[a-z-]+$/i.test(s))]
    .map((t) => t.toLowerCase().split(/[\s.]+/).filter(Boolean))
  const artWords = art.tokens.map((t) => bare(t.w))
  const uniq = (xs: string[]) => [...new Set(xs)]

  const blanks = [...text.matchAll(/\((\d+)\) ([a-z])_+/g)].map((m) => {
    const n = Number(m[1])
    const initial = m[2]
    const start = m.index!
    const end = start + m[0].length
    const prev = bare(text.slice(0, start).trim().split(' ').pop() ?? '')
    const next = text.slice(end).split(' ').map(bare).filter(Boolean).slice(0, 3)

    const cands = pool.filter((w) => w[0].startsWith(initial))
    const phrases = cands.filter((w) => w.length > 1 && w.slice(1).every((t) => next.some((x) => sameWord(x, t))))
    const A = phrases.length ? phrases : cands.filter((w) => w.length === 1)
    const B = artWords
      .map((w, i) => ({ w, score: Number(artWords[i - 1] === prev) + Number(artWords[i + 1] === next[0]) }))
      .filter((x) => x.score > 0 && x.w.length > 3 && x.w.startsWith(initial))

    let answer: string | null = null
    const both = uniq(B.filter((x) => A.some((a) => sameWord(x.w, a[0]))).map((x) => x.w))
    if (both.length === 1) answer = both[0]
    else if (A.length === 1) answer = artWords.find((w) => sameWord(w, A[0][0])) ?? A[0][0]
    else if (!A.length) {
      const best = uniq(B.filter((x) => x.score === 2).map((x) => x.w))
      if (best.length === 1) answer = best[0]
    }
    if (answer !== null && summaryClozeForms[n]) answer = summaryClozeForms[n]
    return { n, initial, answer, inferred: answer !== null, source: src(1, `文章总结填空#${n}`, around(text, start, end)) }
  })
  return { text, blanks }
}

// 7. 功能词填空：填空段落和原文逐词对齐，空格位置上的原文词就是答案
function parseFunctionCloze(art: Article, day: number, raw: string): Extract['functionCloze'] {
  const cloze = joinLines(section(raw, '功能词填空').filter(noCJK)).split(' ')
  const BLANK = /^\((\d+)\)_+(.*)$/
  const k = cloze.findIndex((c) => BLANK.test(c))
  const start = art.tokens.findIndex((_, i) => cloze.slice(0, k).every((c, j) => art.tokens[i + j]?.w === c))
  if (k < 1 || start < 0) throw new Error(`Day ${day} 功能词填空找不到对应原文`)
  return cloze.flatMap((c, j) => {
    const t = art.tokens[start + j]
    const m = BLANK.exec(c)
    if (!m) {
      if (t?.w !== c) throw new Error(`Day ${day} 功能词填空对不齐：「${c}」≠「${t?.w}」`)
      return []
    }
    if (!t || !t.w.endsWith(m[2])) throw new Error(`Day ${day} 功能词填空第 ${m[1]} 空对不齐`)
    const quote = cloze.slice(Math.max(0, j - 3), j + 4).join(' ')
    return [{ day, n: Number(m[1]), sentenceId: t.id, answer: t.w.slice(0, t.w.length - m[2].length), source: src(day, `功能词填空#${m[1]}`, quote) }]
  })
}

// 8. 句子翻译（打卡句）：「Sentence n:」到「你的译文：」之间的英文
function parseCheckIn(art: Article, day: number, raw: string): Extract['checkIn'] {
  const items: { n: number; lines: Lines }[] = []
  let cur: Lines | null = null
  for (const l of section(raw, '句子翻译')) {
    const m = /^\s*Sentence (\d+):/.exec(l)
    if (m) items.push({ n: Number(m[1]), lines: (cur = []) })
    else if (l.includes('你的译文')) cur = null
    else if (cur && l.trim()) cur.push(l)
  }
  return items.map(({ n, lines }) => {
    const text = joinLines(lines)
    const ids = locate(art, text)
    if (ids.length !== 1) throw new Error(`Day ${day} 打卡句 ${n} 不是一整句：${ids}`)
    return { day, n, sentenceId: ids[0], source: src(day, `句子翻译#${n}`, text) }
  })
}

// pdftotext 偶尔把一行的后半截排到了上一行（Day 2 讲 fret 那段、Day 3 最后一段）。
// 特征：上一行没在句号处结束，本行缩进且以 “ 开头，下一行顶格 → 两行对调。
// 对调后，前一行以句号结束，说明本行是新段段首（Day 3），保留缩进；否则本行是句中续行（fret），去掉缩进
function fixLineOrder(lines: Lines): Lines {
  const out = [...lines]
  for (let i = 1; i + 1 < out.length; i++) {
    if (/^\s+“/.test(out[i]) && !indented(out[i + 1]) && !/[。！？]$/.test(out[i - 1].trim())) {
      const newParagraph = /[。！？]$/.test(out[i + 1].trim())
      ;[out[i], out[i + 1]] = [out[i + 1], newParagraph ? out[i] : out[i].trim()]
      i++
    }
  }
  return out
}

// 词汇精讲词条落到哪句：词条里的词（去掉 sb/sth 等占位）在句中找到得最多的那几句；一个都找不到就算整块
// （不规则变形如 life→lives、sit→sat 找不到，靠「最多」兜住）
function termSentences(term: string, sents: Sentence[]): string[] {
  const words = term.toLowerCase().split(/\s+/).filter((w) => /^[a-z’'-]+$/.test(w) && !/^(sb|sth|one[’']s|doing)$/.test(w))
  const score = sents.map((s) => {
    const toks = s.text.split(' ').map(bare)
    return words.filter((w) => toks.some((t) => sameWord(t, w))).length
  })
  const best = Math.max(...score)
  return sents.filter((_, i) => best === 0 || score[i] === best).map((s) => s.id)
}

// 句子分析落到哪句：「第二句话」按块内序号；引用的英文片段（≥3 词）按出现在哪句；都没有就算整块
function noteSentences(text: string, sents: Sentence[]): string[] {
  const hit = new Set<string>()
  for (const m of text.matchAll(/第([一二三四五六七八九])句/g)) {
    const s = sents['一二三四五六七八九'.indexOf(m[1])]
    if (s) hit.add(s.id)
  }
  for (const run of text.split(/[^A-Za-z0-9’'\-, ]+/)) {
    const r = run.replace(/^[\s,]+|[\s,]+$/g, '').toLowerCase()
    if (r.split(' ').length < 3) continue
    for (const s of sents) if (s.text.toLowerCase().includes(r)) hit.add(s.id)
  }
  const ids = sents.map((s) => s.id).filter((id) => hit.has(id))
  return ids.length ? ids : sents.map((s) => s.id)
}

// 9. 原文精读学习：每块 = 原文引文 → 词汇精讲 → 句子分析。引文行没有中文且从某句句首开始
function parseAnalyses(art: Article, day: number, raw: string): Extract['analyses']['blocks'] {
  const dayText = normalizeText(raw)
  const starts = new Set(art.spans.map((s) => s.start))
  const isQuoteStart = (l: string) => noCJK(l) && starts.has(art.full.indexOf(normalizeSpace(l)))
  const blocks: { quote: Lines; vocab: Lines; note: Lines }[] = []
  let mode: 'quote' | 'vocab' | 'note' = 'quote'
  for (const l of section(raw, '原文精读学习').filter((l) => l.trim())) {
    const t = l.trim()
    if (t === '词汇精讲') mode = 'vocab'
    else if (t === '句子分析') mode = 'note'
    else if ((mode === 'note' || !blocks.length) && isQuoteStart(l)) {
      blocks.push({ quote: [l], vocab: [], note: [] })
      mode = 'quote'
    } else if (blocks.length) blocks[blocks.length - 1][mode].push(l)
    else throw new Error(`Day ${day} 精读学习开头不是原文引文：${t}`)
  }
  return blocks.map((b, i) => {
    const quote = joinLines(b.quote)
    const sentenceIds = locate(art, quote)
    const sents = art.sentences.filter((s) => sentenceIds.includes(s.id))
    const vocab = paragraphsByIndent(b.vocab).map((ls) => {
      const e = joinLines(ls)
      const k = e.indexOf('：')
      if (k < 0) throw new Error(`Day ${day} 词汇精讲缺少冒号：${e}`)
      const head = e.slice(0, k).trim()
      const pm = /^(.*?)\s*[([]([a-z]+\.?)[)\]]$/.exec(head) // 末尾的词性 (phr.)、[plural]
      const term = pm ? pm[1] : head
      return { term, ...(pm ? { pos: pm[2] } : {}), note: e.slice(k + 1), sentenceIds: termSentences(term, sents), source: src(day, '原文精读学习', e) }
    })
    const notes = paragraphsByIndent(fixLineOrder(b.note)).map((ls) => {
      const text = joinLines(ls)
      // 调过行序的段落不再是原文子串，出处退回到它的第一行
      const quote = dayText.includes(text) ? text : normalizeSpace(ls[0])
      return { text, sentenceIds: noteSentences(text, sents), source: src(day, '原文精读学习', quote) }
    })
    return { day, n: i + 1, sentenceIds, source: src(day, '原文精读学习', quote), vocab, notes }
  })
}

// 10. Day 4：视译两段 → 句子 id；关键词复述 4 部分
function parseSight(art: Article, day4: string): Extract['sightTranslation'] {
  return numberedBlocks(section(day4, '视译训练')).map((b) => {
    const m = /^(\d+)\. (.+)$/.exec(joinLines(b))!
    return { n: Number(m[1]), sentenceIds: locate(art, m[2]), source: src(4, `视译训练#${m[1]}`, m[2]) }
  })
}

function parseRetell(day4: string): Extract['retellKeywords'] {
  const parts: Lines[] = []
  for (const l of section(day4, '关键词复述')) {
    if (/^\s*Part \d+:/.test(l)) parts.push([l])
    else if (parts.length && l.trim()) parts[parts.length - 1].push(l)
  }
  return parts.map((p) => {
    const h = /^Part (\d+):\s*(.+)$/.exec(p[0].trim())
    const m = /^Keywords:\s*(.+?)\s*\(Tip:\s*(.+)\)$/.exec(joinLines(p.slice(1)))
    if (!h || !m) throw new Error(`关键词复述解析失败：${p[0]}`)
    return { part: Number(h[1]), title: h[2], keywords: m[1].split(/,\s*/), tip: m[2], source: src(4, `关键词复述#${h[1]}`, joinLines(p)) }
  })
}

// 11. Day 5：拓展问答 3 题；写作题目、要求和必须用上的表达
function parseDay5(day5: string): Extract['day5'] {
  const questions = numberedBlocks(section(day5, '拓展问答')).map((b) => {
    const text = joinLines(b)
    const m = /^(\d+)\. (.+?) \(Hint: (.+)\)$/.exec(text)
    if (!m) throw new Error(`拓展问答解析失败：${text}`)
    return { n: Number(m[1]), question: m[2], hint: m[3], source: src(5, `拓展问答#${m[1]}`, text) }
  })
  const lines = section(day5, '写作').filter((l) => l.trim())
  const topicLine = lines.find((l) => /Topic[：:]/.test(l))
  const zh = lines.map((l) => /^（(.+)）$/.exec(l.trim())).find(Boolean)
  const reqStart = lines.findIndex((l) => l.trim() === '要求：')
  if (!topicLine || !zh || reqStart < 0) throw new Error('写作题目解析失败')
  const requirements: string[] = []
  const structure: string[] = []
  for (const l of lines.slice(reqStart + 1)) {
    const m = /^\s*\d+\.\s*(.+)$/.exec(l)
    if (m) requirements.push(normalizeSpace(m[1]))
    else structure.push(normalizeSpace(l)) // 「结构建议：」下面的三行
  }
  const req = requirements.find((r) => /如\s*.+?\s*等/.test(r))
  if (!req) throw new Error('写作要求里找不到「如……等」')
  const requiredExpressions = /如\s*(.+?)\s*等/.exec(req)![1].split(/[，,]\s*/).map((text) => ({ text, source: src(5, '写作', req) }))
  return {
    questions,
    writing: { topic: topicLine.replace(/^.*Topic[：:]\s*/, '').trim(), topicZh: zh[1], requirements, structure, requiredExpressions, source: src(5, '写作', topicLine) },
  }
}

// 入口：raw[0..4] = Day 1..5 的讲义文本
export function extractHandout(raw: string[]): Extract {
  const [day1, day2, day3, day4, day5] = raw
  const art = parseArticle(day1)
  const coreVocab = parseCoreVocab(day1)
  const vocabQuiz = parseChoices(1, '词汇通关检测', section(day1, '词汇通关检测'))
  const blocks = [2, 3].flatMap((d) => parseAnalyses(art, d, raw[d - 1]))
  const grouped: Extract['analyses']['bySentence'] = {}
  const put = (id: string, k: 'vocab' | 'notes', v: string) => ((grouped[id] ??= { vocab: [], notes: [] })[k].push(v))
  for (const b of blocks) {
    for (const v of b.vocab) v.sentenceIds.forEach((id) => put(id, 'vocab', v.term))
    for (const n of b.notes) n.sentenceIds.forEach((id) => put(id, 'notes', n.text))
  }
  const bySentence = Object.fromEntries(art.sentences.filter((s) => grouped[s.id]).map((s) => [s.id, grouped[s.id]]))
  return Extract.parse({
    handoutId: 'social-media',
    article: { paragraphs: art.paragraphs, sentences: art.sentences },
    dayCoverage: [parseCoverage(art, 2, day2), parseCoverage(art, 3, day3)],
    coreVocab,
    vocabQuiz,
    summaryCloze: parseSummaryCloze(art, day1, coreVocab, vocabQuiz),
    detailQuestions: [2, 3].flatMap((d) => parseChoices(d, '细节理解', section(raw[d - 1], '细节理解')).map((q) => ({ day: d, ...q }))),
    functionCloze: [2, 3].flatMap((d) => parseFunctionCloze(art, d, raw[d - 1])),
    checkIn: [2, 3].flatMap((d) => parseCheckIn(art, d, raw[d - 1])),
    analyses: { blocks, bySentence },
    sightTranslation: parseSight(art, day4),
    retellKeywords: parseRetell(day4),
    day5: parseDay5(day5),
  })
}

export function readRawDays(): string[] {
  return [1, 2, 3, 4, 5].map((d) => readFileSync(new URL(`../data/raw/day${d}.txt`, import.meta.url), 'utf8'))
}

export const OUT_PATH = new URL('../data/extract/social-media.extract.json', import.meta.url)

function main() {
  const out = extractHandout(readRawDays())
  mkdirSync(new URL('.', OUT_PATH), { recursive: true })
  writeFileSync(OUT_PATH, JSON.stringify(out, null, 2) + '\n')
  // 教师端信息（学生端不出现这些术语）：老师句子分析里点名的结构
  const tagged = (kw: string) => [...new Set(out.analyses.blocks.flatMap((b) => b.notes.filter((n) => n.text.includes(kw)).flatMap((n) => n.sentenceIds)))]
  console.log(`句子 ${out.article.sentences.length}，段落 ${out.article.paragraphs.length}，核心词 ${out.coreVocab.length}，词汇题 ${out.vocabQuiz.length}`)
  console.log(`总结填空推断：${out.summaryCloze.blanks.map((b) => `(${b.n})${b.answer ?? '—'}`).join(' ')}`)
  console.log(`打卡句：${out.checkIn.map((c) => c.sentenceId).join(' ')}`)
  console.log(`老师点名「同位语从句」：${tagged('同位语从句').join(' ')}；「倒装」：${tagged('倒装').join(' ')}`)
  console.log(`已写入 ${OUT_PATH.pathname}`)
}

// vitest 导入时不写文件
if (!process.env.VITEST) main()
