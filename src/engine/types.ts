// 适配引擎的接口。引擎是纯函数：输入讲义 + 学生状态，输出「你的这一份」视图。
// 规则见 docs/知适-开发规格.md §2、§3。学生端绝不出现语法术语，也不存「已掌握」字段。
import type { Handout, Question, Sentence, Survey, Tier, Word } from '../../shared/schema'

export type WordMark = 'known' | 'unknown'
export type LadderLevel = 0 | 1 | 2 | 3

export interface AnswerRecord {
  firstTryCorrect: boolean
  attempts: number
  correct: boolean // 最近一次是否答对
}

// 学生状态：只记录行为，不推断「掌握」
export interface StudentState {
  sid: string
  survey?: Survey
  tappedWords: string[] // 粗读时点过的词（lemma）
  wordMarks: Record<string, WordMark> // 学生词卡片的标记（lemma → 认识/不认识）
  fakeWordClaimedKnown: boolean // 是否把假词点成了「认识」
  answers: Record<string, AnswerRecord> // questionId → 作答记录（原句微题、段意题、先猜后看）
  ladder: Record<string, LadderLevel> // sentenceId → 打开到第几级
  checkInDrafted: Record<string, boolean> // 打卡句是否已交初稿
  collectedExpressions: string[] // 表达本（expression id）
}

export type LadderMode = 'available' | 'tryFirst'
export type StuckLevel = 0 | 1 | 2 | 3 // 0 读懂 / 1 轻 / 2 中 / 3 重
export type StuckCause = 'word' | 'structure' | 'mixed'

export interface GlossView {
  lemma: string
  forms: string[]
  zh: string
  guess?: Question // 先猜后看
}

export interface SentenceView {
  id: string
  paragraph: number
  text: string // 必须与讲义原文逐字一致
  tier: Tier
  checkIn: boolean
  hasLadder: boolean
  ladderMode: LadderMode
  maxLadderLevel: LadderLevel // 打卡句交初稿前为 1，其余为 3
  question?: Question
  teacherNote?: string
  teacherNoteCollapsed: boolean
  collapseReason?: string // 如「你第一次就读懂了这句」
  glosses: GlossView[] // 本句要加注的词（受每段预算限制）
  skippableWords: string[] // 不认识但不影响大意、未加注的词
}

export interface DeckCard {
  lemma: string
  kind: 'tapped' | 'teacher_core' | 'familiar_trap' | 'fake'
  word?: Word // fake 卡片没有 word
}

export interface PersonalView {
  sentences: SentenceView[]
  deck: DeckCard[] // 学生词环节的卡片
  writingExpressionIds: string[] // 写作环节要用的表达：表达本 ∪ 老师要求
}

export interface SentenceStuck {
  sentenceId: string
  level: StuckLevel | null // null = 没有数据
  cause?: StuckCause
}

export interface ReviewPick {
  sid: string
  reason: string // 一行原因，如「S17 开到第 3 级，原句题第 2 次才答对」
  kind: 'targeted' | 'random'
}

// 引擎对外 API（实现见 src/engine/index.ts）
export interface Engine {
  emptyState(sid: string): StudentState
  personalize(h: Handout, s: StudentState): PersonalView
  ladderMode(h: Handout, s: StudentState, sentence: Sentence): LadderMode
  stuck(h: Handout, s: StudentState, sentenceId: string): SentenceStuck
  expressionUsed(text: string, pattern: string): boolean
  reviewPicks(h: Handout, students: StudentState[], opts: { targeted: number; random: number; seed: number }): ReviewPick[]
}
