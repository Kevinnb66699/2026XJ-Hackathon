// 事件 → 学生状态。前端现场更新状态也走同一个 applyEvent，保证「现场」和「重放」一模一样。
// 事件类型到状态字段的对应：
//   tap_word        → tappedWords（value='off' 表示取消）
//   word_card       → wordMarks；词表里没有的词就是假词，点「认识」设置 fakeWordClaimedKnown
//   gist_answer     → answers[段意题 id]（按 paragraph 找）
//   answer_question → answers[原句题 id]（按 sentenceId 找）或 answers[先猜后看 id]（按 lemma 找）
//   open_ladder     → ladder[sentenceId]，只记最高级
//   writing_submit  → 带 sentenceId 的是打卡句初稿 → checkInDrafted；不带的是 Day 5 写作，不改状态
//   feedback        → 不改状态
//   page_view       → 不改状态，只用于诊断（学生端进入某一步）
//   client_error    → 不改状态，只用于诊断（前端报错）
// 问卷和表达本没有对应的事件类型，只存在本机（见报告 proposed_schema_changes）。
import type { EventType, Handout, LearningEvent } from '../../shared/schema'
import { emptyState } from '../engine'
import type { AnswerRecord, LadderLevel, StudentState } from '../engine/types'

// 诊断事件：不是学习行为，不进学生状态，也不算学生人数
export const DIAGNOSTIC_TYPES = new Set<EventType>(['page_view', 'client_error'])
export const learningEvents = (events: LearningEvent[]) => events.filter((e) => !DIAGNOSTIC_TYPES.has(e.type))

function record(prev: AnswerRecord | undefined, correct: boolean): AnswerRecord {
  return prev
    ? { firstTryCorrect: prev.firstTryCorrect, attempts: prev.attempts + 1, correct }
    : { firstTryCorrect: correct, attempts: 1, correct }
}

function questionId(h: Handout, e: LearningEvent): string | undefined {
  if (e.type === 'gist_answer') return h.paragraphs.find((p) => p.n === e.paragraph)?.gist.id
  if (e.sentenceId) return h.sentences.find((x) => x.id === e.sentenceId)?.question?.id
  if (e.lemma) return h.words.find((w) => w.lemma === e.lemma)?.guess?.id
  return undefined
}

export function applyEvent(h: Handout, s: StudentState, e: LearningEvent): StudentState {
  switch (e.type) {
    case 'tap_word': {
      const l = e.lemma
      if (!l) return s
      if (e.value === 'off') return { ...s, tappedWords: s.tappedWords.filter((x) => x !== l) }
      return s.tappedWords.includes(l) ? s : { ...s, tappedWords: [...s.tappedWords, l] }
    }
    case 'word_card': {
      const l = e.lemma
      if (!l || (e.value !== 'known' && e.value !== 'unknown')) return s
      if (!h.words.some((w) => w.lemma === l)) return e.value === 'known' ? { ...s, fakeWordClaimedKnown: true } : s
      return { ...s, wordMarks: { ...s.wordMarks, [l]: e.value } }
    }
    case 'gist_answer':
    case 'answer_question': {
      const id = questionId(h, e)
      if (!id || e.correct === undefined) return s
      return { ...s, answers: { ...s.answers, [id]: record(s.answers[id], e.correct) } }
    }
    case 'open_ladder': {
      const id = e.sentenceId
      if (!id || !e.level || e.level <= (s.ladder[id] ?? 0)) return s
      return { ...s, ladder: { ...s.ladder, [id]: e.level as LadderLevel } }
    }
    case 'writing_submit':
      return e.sentenceId ? { ...s, checkInDrafted: { ...s.checkInDrafted, [e.sentenceId]: true } } : s
    default:
      return s
  }
}

// 把一份讲义的全部事件重建成每个学生的状态（按 sid 排序；每人按 ts 先后重放）。只有诊断事件的 sid 不算学生
export function replay(h: Handout, events: LearningEvent[]): StudentState[] {
  const bySid = new Map<string, LearningEvent[]>()
  for (const e of learningEvents(events)) {
    if (e.handoutId !== h.id) continue
    const list = bySid.get(e.sid)
    if (list) list.push(e)
    else bySid.set(e.sid, [e])
  }
  return [...bySid.keys()].sort().map((sid) =>
    bySid
      .get(sid)!
      .sort((a, b) => a.ts - b.ts)
      .reduce((s, e) => applyEvent(h, s, e), emptyState(sid)),
  )
}
