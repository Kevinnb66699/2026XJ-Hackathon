// 适配引擎：纯函数。输入讲义 + 学生状态，输出「你的这一份」。
// 原文一字不改，只适配支架；学生端文案不出现语法术语；不存「已掌握」字段。
import type { Handout, Profile, Sentence, StructureTag, Word } from '../../shared/schema'
import { inflectsTo, syllabusBand, type SyllabusBand } from '../../shared/syllabus'
import type {
  AnswerRecord,
  DeckCard,
  Engine,
  GlossView,
  LadderMode,
  LearnerProfile,
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
import { mulberry32 } from './prng'

const GLOSS_BUDGET = 5 // 每段最多注释 5 个非必练词（必练词另算）
const GOAL_CARDS = 5 // 目标是高考时，「高中新词」卡每篇最多几张
const NOTEBOOK_CARDS = 5 // 单词本里还在练的词，每篇最多进几张词卡（11-08 队长定；注释照加，不受这个限）
const COLLAPSE_REASON = '你第一次就读懂了这句'
const TIER_RANK = { must: 0, focus: 1, other: 2 } as const
// 按年级默认加注哪几档（阶段 7，11-07 定的简单规则，内测有了数据再校准）：课标的必修（1 档）一般高一学，选择性必修（2 档）高二、高三学。
// 初中、高一：1、2 档都加注；高二：只加注 2 档；高三和「其他」不按档加注。档位只在引擎里用，界面上不出现
const GRADE_BANDS: Partial<Record<NonNullable<Profile['grade']>, SyllabusBand[]>> = { 初中: [1, 2], 高一: [1, 2], 高二: [2] }

export function emptyState(sid: string): StudentState {
  return { sid, tappedWords: [], wordMarks: {}, answers: {}, ladder: {}, collectedExpressions: [] }
}

// 全文词义（handout.lexicon）里的词：讲义词表之外的词，按原形或原文写法（不分大小写）找；当普通的注释词用，不是核心词、不出题。
// 先放各词条的原形，再放写法（空着的才放）：点 founded 记的是原形 found，要找到 found 这一条，不能被 find 的写法 found 占了
const lexCache = new WeakMap<Handout, Map<string, Word>>()
function lexIndex(h: Handout): Map<string, Word> {
  let m = lexCache.get(h)
  if (!m) {
    m = new Map()
    const listed = new Set(h.words.map((w) => w.lemma))
    const words = (h.lexicon?.words ?? []).filter((x) => !listed.has(x.lemma)).map((x): Word => ({ ...x, teacherCore: false, familiarTrap: false, tier: 'other', sources: [] }))
    for (const w of words) if (!m.has(w.lemma.toLowerCase())) m.set(w.lemma.toLowerCase(), w)
    for (const w of words) for (const f of w.forms) if (!m.has(f.toLowerCase())) m.set(f.toLowerCase(), w)
    lexCache.set(h, m)
  }
  return m
}

// 一个词的词条：先找讲义词表（按原形），再找全文词义
export function lookupWord(h: Handout, lemma: string): Word | undefined {
  return h.words.find((w) => w.lemma === lemma) ?? lexIndex(h).get(lemma.toLowerCase())
}

// 单词本里的词（别的篇里记的原形）换成这一篇的词条：只认原形相同（不分大小写）的，或者能按规则还原成词条原形的写法
// （以前记的小写原词 phones → phone，全文词义用写法起名的 banning → ban）。不能只按写法认：
// 第一篇的 found（创立）到了第二篇，会被 find 的写法 found 认走，学生没标过的 find 就成了单词本里的词
function practicingWord(h: Handout, lemma: string): Word | undefined {
  const w = lookupWord(h, lemma)
  return w && (w.lemma.toLowerCase() === lemma.toLowerCase() || inflectsTo(lemma, w.lemma)) ? w : undefined
}

// 讲义词表和全文词义里的全部词条，同一个原形只取 lookupWord 查得到的那一条
function entries(h: Handout): Word[] {
  return [...h.words, ...new Set(lexIndex(h).values())].filter((w) => lookupWord(h, w.lemma) === w)
}

// 粗读点过的词，换成词条的原形（以前词表外的词记的是小写原词，如 magazines）；重复的只算一次
function tappedLemmas(h: Handout, s: StudentState): string[] {
  return [...new Set(s.tappedWords.map((l) => lookupWord(h, l)?.lemma ?? l))]
}

// 讲义词表，加上 lemmas 里全文词义有的词（每个词条一次）
function wordsWith(h: Handout, lemmas: Set<string>): Word[] {
  const idx = lexIndex(h)
  const extra = new Set<Word>()
  for (const l of lemmas) {
    const w = idx.get(l.toLowerCase())
    if (w && !h.words.some((x) => x.lemma === l)) extra.add(w)
  }
  return [...h.words, ...extra]
}

// 先猜后看第一次就猜错的词。证据优先于自评：猜错后再点「认识」不算（看过答案再点，多半是「现在认识了」）
function guessedWrong(h: Handout, s: StudentState): Set<string> {
  return new Set(h.words.filter((w) => w.guess && s.answers[w.guess.id]?.firstTryCorrect === false).map((w) => w.lemma))
}

// K：认识的词 = 卡片标「认识」的，减去猜错的
function knownSet(h: Handout, s: StudentState): Set<string> {
  const wrong = guessedWrong(h, s)
  return new Set(Object.keys(s.wordMarks).filter((l) => s.wordMarks[l] === 'known' && !wrong.has(l)))
}

// U：不认识的词 = 粗读点过的 ∪ 卡片标「不认识」的 ∪ 猜错的，再减去 K（卡片标记优先于点击）
export function unknownWords(h: Handout, s: StudentState): Set<string> {
  const U = new Set([...tappedLemmas(h, s), ...Object.keys(s.wordMarks).filter((l) => s.wordMarks[l] === 'unknown'), ...guessedWrong(h, s)])
  for (const l of knownSet(h, s)) U.delete(l)
  return U
}

// 练完一轮的总结：这副卡里精读会加注释的词有几个，其中几个是第一次猜错的（猜错后点了「认识」也照样加注释，要说清原因）
export function deckSummary(h: Handout, deck: DeckCard[], s: StudentState): { total: number; wrong: number } {
  const U = unknownWords(h, s)
  const wrong = guessedWrong(h, s)
  const marked = deck.filter((d) => U.has(d.lemma))
  return { total: marked.length, wrong: marked.filter((d) => wrong.has(d.lemma)).length }
}

// 再练一遍：这一轮标了「不认识」的词；第一轮还算上第一次就猜错的（之后几轮题已经答过，只看这一轮的标记，全标「认识」就练完了）
export function retryDeck(h: Handout, deck: DeckCard[], s: StudentState, firstRound: boolean): DeckCard[] {
  const wrong = firstRound ? guessedWrong(h, s) : new Set<string>()
  return deck.filter((d) => s.wordMarks[d.lemma] !== 'known' || wrong.has(d.lemma))
}

// 词卡上要不要先猜：有二选一，而且这张卡出现时（seen）还没猜过。之前猜过的（再练一遍、别处猜过）不再猜，意思先盖住，点「看意思」再看
export const guessFirst = (w: Word | undefined, seen: StudentState['answers']) => !!w?.guess && !seen[w.guess.id]

const escapeRe = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const formRe = (f: string) => new RegExp(`(^|[^A-Za-z])${escapeRe(f)}([^A-Za-z]|$)`, 'i')

// 词是否出现在句中：按 forms 不区分大小写整词匹配（不用后行断言，兼容旧版 Safari）
function occursIn(word: Word, text: string): boolean {
  return word.forms.some((f) => formRe(f).test(text))
}

// 「高中新词」：课标词表里必修、选择性必修的词（档位 1、2）。档位只在这里用，界面上只贴这个标签。
// 人名、地名、机构名（全文词义的中文以「（人名）」这类开头）、短语不算，派生词不还原（都由 syllabusBand 判断）。单词本（lib/notebook）也用这一个
export const syllabusNew = (w: { lemma: string; zh?: string }): boolean => {
  const b = syllabusBand(w.lemma, w.zh)
  return b === 1 || b === 2
}

// 词在原文里第一次出现的位置：[第几句, 句中第几个字符]，原文里找不到的排最后
function firstAt(h: Handout, w: Word): [number, number] {
  for (let i = 0; i < h.sentences.length; i++) {
    const at = w.forms.flatMap((f) => {
      const m = formRe(f).exec(h.sentences[i].text)
      return m ? [m.index + m[1].length] : []
    })
    if (at.length) return [i, Math.min(...at)]
  }
  return [Infinity, 0]
}

// 按在原文里第一次出现的先后排，同一处的按字母序
function byText(h: Handout, ws: Word[]): Word[] {
  return ws
    .map((w) => ({ w, at: firstAt(h, w) }))
    .sort((a, b) => a.at[0] - b.at[0] || a.at[1] - b.at[1] || (a.w.lemma < b.w.lemma ? -1 : a.w.lemma > b.w.lemma ? 1 : 0))
    .map(({ w }) => w)
}

// 目标是高考时多出来的「高中新词」卡。先只按讲义定下这一篇的几个：讲义词表和全文词义里的高中新词，去掉一直在词卡里的核心词、熟词僻义，
// 按在原文里第一次出现的先后排，取前 GOAL_CARDS 个（11-07 队长定：不按档位排）。再去掉其中已经在词卡里的（点过的、单词本里的）、这一篇标了「认识」的，
// 不往后补：每次进词汇都重新算词卡，往后补的话标完「认识」回来又是新的几张，一篇就不止 5 张了
const alwaysInDeck = (w: Word) => w.teacherCore || w.tier === 'must' || w.familiarTrap
function goalCards(h: Handout, s: StudentState, inDeck: Set<string>): DeckCard[] {
  return byText(h, entries(h).filter((w) => !alwaysInDeck(w) && syllabusNew(w)))
    .slice(0, GOAL_CARDS)
    .filter((w) => !inDeck.has(w.lemma) && s.wordMarks[w.lemma] !== 'known')
    .map((w): DeckCard => ({ lemma: w.lemma, kind: 'goal', word: w, syllabusNew: true }))
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

// profile：引擎用的画像（账号页的开关关着、班级学号、没登录、示例都不传，见 types 的 LearnerProfile）。
// 目标是高考时词卡多一类「高中新词」；单词本里还在练的词加注释、进词卡；按年级（GRADE_BANDS）给几档里的词加注释。不传时输出和以前一样
export function personalize(h: Handout, s: StudentState, profile?: LearnerProfile): PersonalView {
  const K = knownSet(h, s)
  const U = unknownWords(h, s)

  // 画像多出来的两类注释候选（阶段 7）：1 单词本里还在练的词，2 按年级默认加注的档里的词（人名地名、短语没有档位，见 syllabusBand）。
  // 这一篇标了「认识」的不算（在 K 里）
  const practicingWords = new Set((profile?.practicing ?? []).flatMap((l) => practicingWord(h, l) ?? []))
  const practicing = new Set([...practicingWords].map((w) => w.lemma))
  const bands = (profile?.grade && GRADE_BANDS[profile.grade]) || []
  const extra = new Map<string, number>() // 原形 → 1 或 2
  if (practicing.size || bands.length)
    for (const w of entries(h)) {
      const b = syllabusBand(w.lemma, w.zh)
      const rank = practicing.has(w.lemma) ? 1 : b !== undefined && bands.includes(b) ? 2 : 0
      if (rank && !K.has(w.lemma)) extra.set(w.lemma, rank)
    }

  // 注释按段落计算：候选词（讲义词表，加上学生不认识的、画像多出来的全文词义里的词）排序后，前 5 个加注，其余属于 U 的放进 skippableWords。
  // 画像多出来的词排在这一篇自己的候选（rank 0）后面，只用剩下的名额；轮不到的不加注，也不放进 skippableWords（不在 U 里）
  const words = wordsWith(h, new Set([...U, ...extra.keys()]))
  const listed = new Set(h.words)
  const glosses = new Map<string, GlossView[]>()
  const skippable = new Map<string, string[]>()
  for (const p of new Set(h.sentences.map((x) => x.paragraph))) {
    const inPara = h.sentences.filter((x) => x.paragraph === p)
    const cands: { w: Word; first: Sentence; rank: number }[] = []
    for (const w of words) {
      const rank = U.has(w.lemma) || ((w.teacherCore || w.familiarTrap) && !K.has(w.lemma)) ? 0 : extra.get(w.lemma)
      if (rank === undefined) continue
      const first = inPara.find((x) => occursIn(w, x.text))
      if (first) cands.push({ w, first, rank })
    }
    // 这一篇自己的 > 单词本里的 > 按年级的；同一类里：老师核心 > 熟词僻义 > 句子带题 > tier > 讲义词表（AI 挑的值得注释的词）> 全文词义 > 字母序
    const key = (c: (typeof cands)[number]) => [c.rank, c.w.teacherCore ? 0 : 1, c.w.familiarTrap ? 0 : 1, c.first.question ? 0 : 1, TIER_RANK[c.w.tier], listed.has(c.w) ? 0 : 1]
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

  // 学生词卡片：点过的词（讲义词表或全文词义里有的）→ 老师必练词 → 熟词僻义 → 单词本里还在练的词 →（目标是高考时）高中新词。
  // 10-16 去掉了混进去的假词卡（防乱点「认识」用的）：学生看不懂为什么有编出来的词（推广时的反馈）
  const gaokao = profile?.goal === 'gaokao'
  const tag = (w: Word) => (gaokao && syllabusNew(w) ? { syllabusNew: true as const } : {})
  const tapped = tappedLemmas(h, s).flatMap((l) => lookupWord(h, l) ?? [])
  const tappedSet = new Set(tapped.map((w) => w.lemma))
  const isCore = (w: Word) => w.teacherCore || w.tier === 'must'
  const rest = h.words.filter((w) => !tappedSet.has(w.lemma))
  const deck: DeckCard[] = [
    ...tapped.map((w): DeckCard => ({ lemma: w.lemma, kind: 'tapped', word: w, ...tag(w) })),
    ...rest.filter(isCore).map((w): DeckCard => ({ lemma: w.lemma, kind: 'teacher_core', word: w })),
    ...rest.filter((w) => !isCore(w) && w.familiarTrap).map((w): DeckCard => ({ lemma: w.lemma, kind: 'familiar_trap', word: w })),
  ]
  // 单词本里的词：和高中新词卡一样先只按讲义定下这一篇的几个（去掉一直在词卡里的，按原文先后取前 NOTEBOOK_CARDS 个），
  // 再去掉已经在词卡里的、这一篇标了「认识」的，不往后补，一篇最多 NOTEBOOK_CARDS 张（11-08 队长定）
  const inDeck = new Set(deck.map((c) => c.lemma))
  const before = byText(h, [...practicingWords].filter((w) => !alwaysInDeck(w)))
    .slice(0, NOTEBOOK_CARDS)
    .filter((w) => !inDeck.has(w.lemma) && s.wordMarks[w.lemma] !== 'known')
  deck.push(...before.map((w): DeckCard => ({ lemma: w.lemma, kind: 'notebook', word: w, ...tag(w) })))
  if (gaokao) deck.push(...goalCards(h, s, new Set(deck.map((c) => c.lemma))))

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
    w: wordsWith(h, U).filter((wd) => U.has(wd.lemma) && occursIn(wd, x.text)).length,
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
