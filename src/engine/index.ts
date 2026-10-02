// 适配引擎：纯函数。输入讲义 + 学生状态，输出「你的这一份」。
// 原文一字不改，只适配支架；学生端文案不出现语法术语；不存「已掌握」字段。
import type { Handout, Sentence, StructureTag, Word } from '../../shared/schema'
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
  Trail,
  TrailOutcome,
  TrailStep,
} from './types'
import { hashString, mulberry32 } from './prng'

const GLOSS_BUDGET = 5 // 每段最多注释 5 个非必练词（必练词另算）
// 假词卡和真词卡长得一样：配词性、一句例句（我们编的，不在原文里）、先猜一猜的两个中文选项（没有对错，选了不记录）
export const FAKE_CARDS: Record<string, { pos: string; sentence: string; options: [string, string] }> = {
  brondle: { pos: 'n.', sentence: 'Several schools now ask pupils to leave their phones in a brondle by the classroom door before lessons begin.', options: ['收纳柜', '登记处'] },
  sapture: { pos: 'n.', sentence: 'The sudden sapture for short dance videos has left many parents wondering what their children are watching.', options: ['热潮', '反感'] },
  flimber: { pos: 'adj.', sentence: 'Teenagers who scroll late into the night often feel flimber and distracted in class the next morning.', options: ['疲惫的', '烦躁的'] },
  trosk: { pos: 'n.', sentence: 'Under the new rules, every app would need a trosk to check that its users are over 16.', options: ['核查工具', '监管人员'] },
  glendary: { pos: 'adj.', sentence: 'Supporters of the ban call it a glendary step, but many teachers doubt it will change much.', options: ['意义重大的', '草率的'] },
}
const FAKE_WORDS = Object.keys(FAKE_CARDS)
const COLLAPSE_REASON = '你第一次就读懂了这句'
const TIER_RANK = { must: 0, focus: 1, other: 2 } as const

export function emptyState(sid: string): StudentState {
  return { sid, tappedWords: [], wordMarks: {}, fakeWordClaimedKnown: false, answers: {}, ladder: {}, collectedExpressions: [] }
}

// 先猜后看第一次就猜错的词。证据优先于自评：猜错后再点「认识」不算（看过答案再点，多半是「现在认识了」）
function guessedWrong(h: Handout, s: StudentState): Set<string> {
  return new Set(h.words.filter((w) => w.guess && s.answers[w.guess.id]?.firstTryCorrect === false).map((w) => w.lemma))
}

// K：认识的词 = 卡片标「认识」的，减去猜错的。把假词点成「认识」后，所有「认识」都不可信，K 为空
function knownSet(h: Handout, s: StudentState): Set<string> {
  if (s.fakeWordClaimedKnown) return new Set()
  const wrong = guessedWrong(h, s)
  return new Set(Object.keys(s.wordMarks).filter((l) => s.wordMarks[l] === 'known' && !wrong.has(l)))
}

// U：不认识的词 = 粗读点过的 ∪ 卡片标「不认识」的 ∪ 猜错的，再减去 K（卡片标记优先于点击）
export function unknownWords(h: Handout, s: StudentState): Set<string> {
  const U = new Set([...s.tappedWords, ...Object.keys(s.wordMarks).filter((l) => s.wordMarks[l] === 'unknown'), ...guessedWrong(h, s)])
  for (const l of knownSet(h, s)) U.delete(l)
  return U
}

// 练完一轮的总结：这副卡里精读会加注释的词有几个，其中几个是第一次猜错的（猜错后点了「认识」也照样加注释，要说清原因）。
// bluff：把假词点成了「认识」，这次的「认识」都不算
export function deckSummary(h: Handout, deck: DeckCard[], s: StudentState): { total: number; wrong: number; bluff: boolean } {
  const U = unknownWords(h, s)
  const wrong = guessedWrong(h, s)
  const marked = deck.filter((d) => d.word && U.has(d.lemma))
  return { total: marked.length, wrong: marked.filter((d) => wrong.has(d.lemma)).length, bluff: s.fakeWordClaimedKnown }
}

// 再练一遍：这一轮标了「不认识」的真词；第一轮还算上第一次就猜错的（之后几轮题已经答过，只看这一轮的标记，全标「认识」就练完了）。假词不再出现
export function retryDeck(h: Handout, deck: DeckCard[], s: StudentState, firstRound: boolean): DeckCard[] {
  const wrong = firstRound ? guessedWrong(h, s) : new Set<string>()
  return deck.filter((d) => d.word && (s.wordMarks[d.lemma] !== 'known' || wrong.has(d.lemma)))
}

// 假词卡照着哪张真词卡长（标签、要不要先猜）：先看后一张、前一张，再从头找，不挑「点过」的卡——假词学生没点过，
// 标「你在粗读时点过」一眼就露馅。整副都是点过的卡时才退回最近那张（标签另外处理）
export function fakeTwin(deck: DeckCard[], i: number): DeckCard | undefined {
  const real = [deck[i + 1], deck[i - 1], ...deck].filter((d): d is DeckCard => !!d?.word)
  return real.find((d) => d.kind !== 'tapped') ?? real[0]
}

// 词卡上要不要先猜：有二选一，而且这张卡出现时（seen）还没猜过。之前猜过的（再练一遍、别处猜过）不再猜，意思先盖住，点「看意思」再看
export const guessFirst = (w: Word | undefined, seen: StudentState['answers']) => !!w?.guess && !seen[w.guess.id]

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
  const K = knownSet(h, s)
  const U = unknownWords(h, s)

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
      maxLadderLevel: 3,
      breakdown: x.breakdown,
      question: q,
      teacherNote: x.teacherNote,
      teacherNoteCollapsed: collapsed,
      collapseReason: collapsed ? COLLAPSE_REASON : undefined,
      glosses: glosses.get(x.id) ?? [],
      skippableWords: skippable.get(x.id) ?? [],
    }
  })

  // 学生词卡片：点过的词 → 老师必练词 → 熟词僻义，再混入 1 个假词。上传的文章（id 以 up- 开头）不放假词：
  // 假词的例句都是社交媒体话题，换一篇文章就对不上，一眼能看出来
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
  if (!h.id.startsWith('up-')) deck.splice(Math.min(2, deck.length), 0, { lemma: FAKE_WORDS[hashString(s.sid) % FAKE_WORDS.length], kind: 'fake' })

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
  const sig = signals(h, s, unknownWords(h, s), x)
  const level = levelOf(sig)
  let cause: StuckCause | undefined
  if (level) cause = sig.w === 0 ? 'structure' : level <= 1 ? 'word' : 'mixed'
  return { sentenceId, level, cause }
}

// 读懂轨迹：同一类长难句（带原句题的，至少 2 句）按出现顺序排开，看每一句是怎么过的。
// tried：这个学生「先自己试」的句子，要按事件时间算（lib/replay 的 triedFirst）；状态里没有先后顺序，算不准
export function readingTrails(h: Handout, s: StudentState, tried: ReadonlySet<string> = new Set()): Trail[] {
  const byTag = new Map<StructureTag, Sentence[]>()
  for (const x of h.sentences) if (x.tag && x.question) byTag.set(x.tag, [...(byTag.get(x.tag) ?? []), x])
  return [...byTag]
    .filter(([, xs]) => xs.length >= 2)
    .map(([tag, xs]) => ({
      tag,
      steps: xs.map((x): TrailStep => {
        const a = s.answers[x.question!.id]
        const L = s.ladder[x.id] ?? 0
        const outcome: TrailOutcome = !a ? (L ? 'stuck' : 'none') : !a.correct ? 'stuck' : L ? 'ladder' : a.firstTryCorrect ? 'own' : 'retry'
        return { sentenceId: x.id, outcome, ladder: L, attempts: a?.attempts ?? 0, firstTry: !!a?.firstTryCorrect, tryFirst: tried.has(x.id) }
      }),
    }))
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

// 一句的原因短语，如「梯子到第 3 步，原句题第 2 次才答对」（教师端）
function phrases({ w, q, L }: Signals): string {
  const out: string[] = []
  if (L > 0) out.push(`梯子到第 ${L} 步`)
  if (q && q.correct && !q.firstTryCorrect) out.push(`原句题第 ${q.attempts} 次才答对`)
  if (q && !q.correct) out.push('原句题还没答对')
  if (w >= 2) out.push(`有 ${w} 个生词`)
  return out.join('，')
}

export function reviewPicks(h: Handout, students: StudentState[], opts: { targeted: number; random: number; seed: number }): ReviewPick[] {
  const rows = students.map((st) => {
    const U = unknownWords(h, st)
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
