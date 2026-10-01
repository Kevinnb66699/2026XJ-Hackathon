// 适配引擎：纯函数。输入讲义 + 学生状态，输出「你的这一份」。
// 原文一字不改，只适配支架；学生端文案不出现语法术语；不存「已掌握」字段。
import type { Handout, Sentence, Word } from '../../shared/schema'
import type {
  AnswerRecord,
  DeckCard,
  Engine,
  GlossView,
  LadderMode,
  PersonalView,
  ReviewPick,
  SentenceStuck,
  SentenceView,
  StudentState,
  StuckCause,
  StuckLevel,
} from './types'
import { hashString, mulberry32 } from './prng'

const GLOSS_BUDGET = 5 // 每段最多注释 5 个非必练词（必练词另算）
const FAKE_WORDS = ['brondle', 'sapture', 'flimber', 'trosk', 'glendary']
const COLLAPSE_REASON = '你第一次就读懂了这句'
const TIER_RANK = { must: 0, focus: 1, other: 2 } as const

export function emptyState(sid: string): StudentState {
  return { sid, tappedWords: [], wordMarks: {}, fakeWordClaimedKnown: false, answers: {}, ladder: {}, checkInDrafted: {}, collectedExpressions: [] }
}

// K：认识的词。把假词点成「认识」后，所有「认识」都不可信，K 为空
function knownSet(s: StudentState): Set<string> {
  if (s.fakeWordClaimedKnown) return new Set()
  return new Set(Object.keys(s.wordMarks).filter((l) => s.wordMarks[l] === 'known'))
}

// U：不认识的词 = 粗读点过的 ∪ 卡片标「不认识」的，再减去 K（卡片标记优先于点击）
function unknownSet(s: StudentState): Set<string> {
  const U = new Set([...s.tappedWords, ...Object.keys(s.wordMarks).filter((l) => s.wordMarks[l] === 'unknown')])
  for (const l of knownSet(s)) U.delete(l)
  return U
}

const escapeRe = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// 词是否出现在句中：按 forms 不区分大小写整词匹配（不用后行断言，兼容旧版 Safari）
function occursIn(word: Word, text: string): boolean {
  return word.forms.some((f) => new RegExp(`(^|[^A-Za-z])${escapeRe(f)}([^A-Za-z]|$)`, 'i').test(text))
}

export function ladderMode(h: Handout, s: StudentState, sentence: Sentence): LadderMode {
  const { tag, question } = sentence
  if (!tag || !question) return 'available'
  const own = s.answers[question.id]
  if (own && !own.firstTryCorrect) return 'available' // 本句首答错误，立刻给梯子
  for (const e of h.sentences) {
    if (e.id === sentence.id) break // 只看更早的句子
    // 「自己读懂过」= 那一句首答就对，而且没开梯子（开过梯子再答对不算）
    if (e.tag === tag && e.question && s.answers[e.question.id]?.firstTryCorrect === true && (s.ladder[e.id] ?? 0) === 0) return 'tryFirst'
  }
  return 'available'
}

export function personalize(h: Handout, s: StudentState): PersonalView {
  const K = knownSet(s)
  const U = unknownSet(s)

  // 注释按段落计算：候选词排序后，前 5 个加注，其余属于 U 的放进 skippableWords
  const glosses = new Map<string, GlossView[]>()
  const skippable = new Map<string, string[]>()
  for (const p of new Set(h.sentences.map((x) => x.paragraph))) {
    const inPara = h.sentences.filter((x) => x.paragraph === p)
    const cands: { w: Word; first: Sentence }[] = []
    for (const w of h.words) {
      if (!(U.has(w.lemma) || ((w.teacherCore || w.familiarTrap) && !K.has(w.lemma)))) continue
      const first = inPara.find((x) => occursIn(w, x.text))
      if (first) cands.push({ w, first })
    }
    const key = (c: (typeof cands)[number]) => [c.w.teacherCore ? 0 : 1, c.w.familiarTrap ? 0 : 1, c.first.question ? 0 : 1, TIER_RANK[c.w.tier]]
    cands.sort((a, b) => {
      const ka = key(a)
      const kb = key(b)
      for (let i = 0; i < ka.length; i++) if (ka[i] !== kb[i]) return ka[i] - kb[i]
      return a.w.lemma < b.w.lemma ? -1 : a.w.lemma > b.w.lemma ? 1 : 0
    })
    // 老师必练词（tier=must）永远加注、不占预算、永不「可跳过」；其余词按顺序占用每段 5 个名额
    let budget = GLOSS_BUDGET
    for (const { w, first } of cands) {
      const must = w.tier === 'must'
      if (must || budget > 0) {
        glosses.set(first.id, [...(glosses.get(first.id) ?? []), { lemma: w.lemma, forms: w.forms, zh: w.zh, guess: w.guess }])
        if (!must) budget--
      } else if (U.has(w.lemma)) {
        skippable.set(first.id, [...(skippable.get(first.id) ?? []), w.lemma])
      }
    }
  }

  const sentences = h.sentences.map((x): SentenceView => {
    const q = x.question
    // 收起只看直接证据（首答对、没开梯子），不读结构标签；必练句永不收起
    const collapsed = x.tier !== 'must' && !!q && s.answers[q.id]?.firstTryCorrect === true && (s.ladder[x.id] ?? 0) === 0
    return {
      id: x.id,
      paragraph: x.paragraph,
      text: x.text,
      tier: x.tier,
      checkIn: x.checkIn,
      hasLadder: !!x.ladder,
      ladderMode: ladderMode(h, s, x),
      maxLadderLevel: x.checkIn && !s.checkInDrafted[x.id] ? 1 : 3,
      question: q,
      teacherNote: x.teacherNote,
      teacherNoteCollapsed: collapsed,
      collapseReason: collapsed ? COLLAPSE_REASON : undefined,
      glosses: glosses.get(x.id) ?? [],
      skippableWords: skippable.get(x.id) ?? [],
    }
  })

  // 学生词卡片：点过的词 → 老师必练词 → 熟词僻义，再混入 1 个假词
  const byLemma = new Map(h.words.map((w) => [w.lemma, w]))
  const tapped = [...new Set(s.tappedWords)].filter((l) => byLemma.has(l))
  const tappedSet = new Set(tapped)
  const isCore = (w: Word) => w.teacherCore || w.tier === 'must'
  const rest = h.words.filter((w) => !tappedSet.has(w.lemma))
  const deck: DeckCard[] = [
    ...tapped.map((l): DeckCard => ({ lemma: l, kind: 'tapped', word: byLemma.get(l) })),
    ...rest.filter(isCore).map((w): DeckCard => ({ lemma: w.lemma, kind: 'teacher_core', word: w })),
    ...rest.filter((w) => !isCore(w) && w.familiarTrap).map((w): DeckCard => ({ lemma: w.lemma, kind: 'familiar_trap', word: w })),
  ]
  deck.splice(Math.min(2, deck.length), 0, { lemma: FAKE_WORDS[hashString(s.sid) % FAKE_WORDS.length], kind: 'fake' })

  const writingExpressionIds = [...new Set([...s.collectedExpressions, ...h.writing.requiredExpressionIds])]
  return { sentences, deck, writingExpressionIds }
}

// 一句的卡点信号：w = 本句里不认识的词数，q = 原句题作答，L = 梯子开到第几级
interface Signals {
  w: number
  q?: AnswerRecord
  L: number
}

function signals(h: Handout, s: StudentState, U: Set<string>, x: Sentence): Signals {
  return {
    w: h.words.filter((wd) => U.has(wd.lemma) && occursIn(wd, x.text)).length,
    q: x.question && s.answers[x.question.id],
    L: s.ladder[x.id] ?? 0,
  }
}

function levelOf({ w, q, L }: Signals): StuckLevel | null {
  if (!q && L === 0 && w === 0) return null
  if (L === 3 || (q && !q.correct && q.attempts >= 2)) return 3
  if (L === 2 || (q && !q.firstTryCorrect)) return 2
  if (L === 1 || w >= 2) return 1
  return 0
}

export function stuck(h: Handout, s: StudentState, sentenceId: string): SentenceStuck {
  const x = h.sentences.find((y) => y.id === sentenceId)
  if (!x) throw new Error(`讲义里没有句子 ${sentenceId}`)
  const sig = signals(h, s, unknownSet(s), x)
  const level = levelOf(sig)
  let cause: StuckCause | undefined
  if (level) cause = sig.w === 0 ? 'structure' : level <= 1 ? 'word' : 'mixed'
  return { sentenceId, level, cause }
}

export function expressionUsed(text: string, pattern: string): boolean {
  try {
    return new RegExp(pattern, 'i').test(text)
  } catch {
    return false
  }
}

const bySid = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)
const heavy = (x: Sentence) => x.tier === 'must' || x.checkIn // 必练句、打卡句分数 ×2

// 一句的原因短语，如「开到第 3 级，原句题第 2 次才答对」（教师端）
function phrases({ w, q, L }: Signals): string {
  const out: string[] = []
  if (L > 0) out.push(`开到第 ${L} 级`)
  if (q && q.correct && !q.firstTryCorrect) out.push(`原句题第 ${q.attempts} 次才答对`)
  if (q && !q.correct) out.push('原句题还没答对')
  if (w >= 2) out.push(`有 ${w} 个生词`)
  return out.join('，')
}

export function reviewPicks(h: Handout, students: StudentState[], opts: { targeted: number; random: number; seed: number }): ReviewPick[] {
  const rows = students.map((st) => {
    const U = unknownSet(st)
    const items = h.sentences.map((x) => {
      const sig = signals(h, st, U, x)
      return { x, sig, level: levelOf(sig) ?? 0 }
    })
    const score = items.reduce((sum, it) => sum + it.level * (heavy(it.x) ? 2 : 1), 0)
    return { sid: st.sid, items, score }
  })

  // 定向：只从有卡点（分数 > 0）的学生里按分数取，同分按 sid；原因取最严重的 1-2 句
  const picks: ReviewPick[] = rows
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score || bySid(a.sid, b.sid))
    .slice(0, opts.targeted)
    .map((r): ReviewPick => {
      const worst = r.items
        .filter((it) => it.level > 0)
        .sort((a, b) => b.level - a.level || Number(heavy(b.x)) - Number(heavy(a.x)))
        .slice(0, 2)
      return { sid: r.sid, kind: 'targeted', reason: worst.map((it) => `${it.x.id} ${phrases(it.sig)}`).join('；') }
    })

  // 随机：剩下的人先按 sid 排好，再用种子洗牌取前 random 个，结果只取决于种子
  const picked = new Set(picks.map((p) => p.sid))
  const pool = rows.map((r) => r.sid).filter((sid) => !picked.has(sid)).sort(bySid)
  const rand = mulberry32(opts.seed)
  for (let i = 0; i < Math.min(opts.random, pool.length); i++) {
    const j = i + Math.floor(rand() * (pool.length - i))
    ;[pool[i], pool[j]] = [pool[j], pool[i]]
    picks.push({ sid: pool[i], kind: 'random', reason: '随机抽查' })
  }
  return picks
}

export const engine: Engine = { emptyState, personalize, ladderMode, stuck, expressionUsed, reviewPicks }
