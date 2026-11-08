// 跨篇的单词本和表达本（阶段 4）：从一个学生账号的全部学习事件推算，不另存一份（几台设备不会互相覆盖）。
// 纯函数，不碰 DOM、不 import React：服务器用 npm run build 打出来的 dist-server/notebook.mjs（见 vite.server.config.ts），测试直接用这份。
// 每一篇先 replay 出这一篇的状态，生词用小结的 handoutReport 原样算，按原形合并成单词本（几处出处）；各篇收的表达合并成表达本。
// 只记发生了什么：不产生「已掌握」之类的字段，也不算跨篇的合计数。
// 跨篇的学习记录（阶段 5，buildRecords）也在这里，和单词本用同一份讲义、同一批事件
import { Handout, NOTEBOOK_ID, type LearningEvent, type Provenance } from '../../shared/schema'
import { lookupWord } from '../engine'
import { handoutReport } from './report'
import { learningEvents, replay } from './replay'

export interface NotebookSource {
  handoutId: string
  title: string
}

export interface NotebookWord {
  lemma: string
  pos?: string
  zh: string
  ai: boolean // 这条中文是 AI 生成的
  sources: NotebookSource[] // 出自哪几篇，先遇到的在前
  example?: { handoutId: string; sentenceId: string; text: string } // 原文例句，和 zh 出自同一篇
  addedTs: number // 进单词本的时间；移出以后又回来的，算回来的时间
  lastReview?: { ts: number; correct: boolean } // 最近一次复习（这一次进单词本之前的不算）
}

export interface NotebookExpression {
  id: string
  handoutId: string
  title: string
  text: string
  zh: string
  ai: boolean // 这条中文是 AI 生成的
  example?: string // 原文例句
  pattern?: string // 原文例句里找这个表达的规则（同写作页）
  ts: number // 收进来的时间
}

export interface Notebook {
  words: NotebookWord[] // 最近进来的在前
  expressions: NotebookExpression[] // 最近收的在前
}

// 「AI 生成」标签的规则，和 components/ui.tsx 的 byAi、aiDrafted、meaningByAi 一样（那边是 React 文件，服务器不能引）。
// tests/notebook.test.ts 比对两边的结果
const byAi = (p?: Provenance) => p?.by === 'llm'
const aiDrafted = (h: Handout) =>
  h.paragraphs.some((p) => byAi(p.provenance) || byAi(p.gist.provenance)) ||
  h.sentences.some((x) => byAi(x.question?.provenance) || byAi(x.ladder?.provenance) || byAi(x.breakdown?.provenance)) ||
  h.words.some((w) => byAi(w.guess?.provenance)) ||
  byAi(h.structure?.provenance)
const meaningByAi = (h: Handout, lemma: string) => (h.words.some((w) => w.lemma === lemma) ? aiDrafted(h) : byAi(h.lexicon?.provenance))

// 讲义文件解析不过（不是讲义的格式）返回 null，调用的地方跳过这一篇
export function parseHandout(raw: unknown): Handout | null {
  const r = Handout.safeParse(raw)
  return r.success ? r.data : null
}

// 这条事件让哪个词进了这一篇的生词：粗读点了、标了不认识、先猜后看猜错了。返回词条的原形（以前词表外的词记的是小写原词，如 phones）
function addedLemma(h: Handout, e: LearningEvent): string | undefined {
  if (!e.lemma) return undefined
  const added =
    (e.type === 'tap_word' && e.value !== 'off') || (e.type === 'word_card' && e.value === 'unknown') || (e.type === 'answer_question' && !e.sentenceId && e.correct === false)
  return added ? (lookupWord(h, e.lemma)?.lemma ?? e.lemma) : undefined
}

// 几篇里的同一个词按原形合并，不分大小写
const wordKey = (lemma: string) => lemma.toLowerCase()

function push<K, V>(m: Map<K, V[]>, k: K, v: V) {
  const list = m.get(k)
  if (list) list.push(v)
  else m.set(k, [v])
}

// events 是一个账号的事件（都是同一个 sid），handouts 是要算的讲义；别的讲义的事件不看。
// 单词本：各篇小结里的生词，减去移出单词本（drop_word）之后在那一篇里没再点过、标不认识、猜错过的。
// 意思、词性、例句取最近一次进来的那一篇（同一个词在不同文章里意思可能不一样，和例句对得上）
export function buildNotebook(handouts: Handout[], events: LearningEvent[]): Notebook {
  const byHandout = new Map<string, LearningEvent[]>() // 讲义 id → 这一篇的事件，按时间先后
  for (const e of [...events].sort((a, b) => a.ts - b.ts)) push(byHandout, e.handoutId, e)
  const droppedAt = new Map<string, number>() // 原形 → 最近一次移出单词本的时间
  const reviewed = new Map<string, LearningEvent>() // 原形 → 最近一次复习
  for (const e of byHandout.get(NOTEBOOK_ID) ?? []) {
    if (!e.lemma) continue
    if (e.type === 'drop_word') droppedAt.set(wordKey(e.lemma), e.ts)
    if (e.type === 'review_word' && typeof e.correct === 'boolean') reviewed.set(wordKey(e.lemma), e)
  }

  type Entry = { h: Handout; lemma: string; pos?: string; zh: string; sentenceId: string; first: number; last: number }
  const entries = new Map<string, Entry[]>()
  const expressions: NotebookExpression[] = []
  for (const h of handouts) {
    const list = byHandout.get(h.id) ?? []
    const [s] = replay(h, list)
    if (!s) continue // 这一篇没有事件，或者只有页面诊断
    const addedAt = new Map<string, number[]>() // 原形 → 这一篇里每次进生词的时间（先后排好）
    for (const e of list) {
      const l = addedLemma(h, e)
      if (l) push(addedAt, l, e.ts)
    }
    for (const w of handoutReport(h, s).words) {
      const k = wordKey(w.lemma)
      const since = droppedAt.get(k) ?? -Infinity
      const ts = (addedAt.get(w.lemma) ?? []).filter((t) => t > since)
      if (ts.length) push(entries, k, { h, lemma: w.lemma, pos: w.pos, zh: w.zh, sentenceId: w.sentenceIds[0], first: ts[0], last: ts[ts.length - 1] })
    }
    const collectedAt = new Map<string, number>() // 表达 id → 最近一次收进来的时间
    for (const e of list) if (e.type === 'collect_expression' && e.value) collectedAt.set(e.value, e.ts)
    for (const id of s.collectedExpressions) {
      const x = h.expressions.find((y) => y.id === id)
      if (!x) continue // 讲义改过，没有这个表达了
      const example = h.sentences.find((y) => y.id === x.sentenceId)?.text
      expressions.push({
        id: x.id,
        handoutId: h.id,
        title: h.title,
        text: x.text,
        zh: x.zh,
        ai: aiDrafted(h),
        ...(example ? { example } : {}),
        pattern: x.pattern,
        ts: collectedAt.get(id) ?? 0,
      })
    }
  }

  const words = [...entries].map(([k, list]): NotebookWord => {
    const byFirst = [...list].sort((a, b) => a.first - b.first)
    const main = list.reduce((a, b) => (b.last > a.last ? b : a))
    const text = main.h.sentences.find((y) => y.id === main.sentenceId)?.text
    const r = reviewed.get(k)
    // 和这一次进单词本的时间比（一定晚于移出的时间）：移出以后、回来之前的复习（比如另一台设备上还开着旧列表）也不算
    const review = r && r.ts > byFirst[0].first ? r : undefined
    return {
      lemma: main.lemma,
      ...(main.pos ? { pos: main.pos } : {}),
      zh: main.zh,
      ai: meaningByAi(main.h, main.lemma),
      sources: byFirst.map((x) => ({ handoutId: x.h.id, title: x.h.title })),
      ...(text ? { example: { handoutId: main.h.id, sentenceId: main.sentenceId, text } } : {}),
      addedTs: byFirst[0].first,
      ...(review ? { lastReview: { ts: review.ts, correct: review.correct! } } : {}),
    }
  })
  return { words: words.sort((a, b) => b.addedTs - a.addedTs), expressions: expressions.sort((a, b) => b.ts - a.ts) }
}

// 复习一次几张
export const REVIEW_SIZE = 10

// 复习的顺序：最近一次点了「还不认识」的在前，然后是还没复习过的（进来早的先出），最后是点过「认识」的（隔得最久的先出）。
// 「还不认识」的也是隔得久的先出：刚点过的不会马上又排到第一张
export function reviewOrder(words: NotebookWord[]): NotebookWord[] {
  const group = (w: NotebookWord) => (!w.lastReview ? 1 : w.lastReview.correct ? 2 : 0)
  const time = (w: NotebookWord) => w.lastReview?.ts ?? w.addedTs
  return [...words].sort((a, b) => group(a) - group(b) || time(a) - time(b))
}

// 学习记录（#/records）的一行：一篇只有标题、最近一次读的时间、自己选的难度（选过才有）和一个不带数字的状态。
// 不放答对几句、生词几个这类数字：几行连着看，数字就会被读成「这篇比上篇好」；数字只在点进去的那篇小结里有
export interface StudyRecord {
  handoutId: string
  title: string
  lastTs: number // 最近一次在这一篇里动手的时间（打开、看小结不算）
  rating?: string // 小结页上最近一次选的难度
  status: 'todo' | 'done' // 还有没答的句子 / 都答过了
  firstPending?: string // 还有没答的句子时，第一句没答的句子 id（「接着读」跳到这一句）
}

// 小结页的难度选项，和 pages/student/Summary.tsx 的 RATINGS 一样（那边是 React 文件，服务器不能引）。tests/notebook.test.ts 比对两边
export const RATINGS = ['太简单', '刚好', '太难']

// events、handouts 同 buildNotebook。只列动过手的篇（handoutReport 的 started，同小结页「这一篇你还没开始读」）：只打开、只看过的不列。
// 最近一次读的时间只看学习事件（page_view 这类诊断不算）：看一眼小结不会把这一篇排到最前面。移出表达（drop_expression）也不算：
// 表达本页（#/expressions）上移出带的是那一篇的 handoutId，不读文章也会发。最近读的在前
export function buildRecords(handouts: Handout[], events: LearningEvent[]): StudyRecord[] {
  const learned = learningEvents(events)
  const out: StudyRecord[] = []
  for (const h of handouts) {
    const list = learned.filter((e) => e.handoutId === h.id).sort((a, b) => a.ts - b.ts)
    const [s] = replay(h, list)
    if (!s) continue
    const r = handoutReport(h, s)
    if (!r.started) continue
    const rating = list.filter((e) => e.type === 'feedback' && RATINGS.includes(e.value ?? '')).pop()?.value
    const todo = r.pending.find((p) => p.status === 'todo')
    const last = list.filter((e) => e.type !== 'drop_expression').pop() ?? list[list.length - 1]
    out.push({
      handoutId: h.id,
      title: h.title,
      lastTs: last.ts,
      ...(rating ? { rating } : {}),
      status: todo ? 'todo' : 'done',
      ...(todo ? { firstPending: todo.id } : {}),
    })
  }
  return out.sort((a, b) => b.lastTs - a.lastTs)
}
