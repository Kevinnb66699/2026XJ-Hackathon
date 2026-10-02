import { describe, expect, it } from 'vitest'
import type { LearningEvent } from '../shared/schema'
import { presetEvents, presetState, snapshotEvents } from '../src/data/presets'
import { emptyState, personalize, reviewPicks, stuck } from '../src/engine'
import type { StudentState } from '../src/engine/types'
import { applyEvent, learningEvents, replay, triedFirst } from '../src/lib/replay'
import { miniHandout as h } from './fixtures/mini-handout'

let t = 0
const ev = (sid: string, e: Omit<LearningEvent, 'sid' | 'ts' | 'handoutId'>, ts = ++t): LearningEvent => ({ sid, ts, handoutId: h.id, ...e })
const one = (events: LearningEvent[]) => {
  const out = replay(h, events)
  expect(out).toHaveLength(1)
  return out[0]
}

describe('replay：事件 → 学生状态', () => {
  it('没有事件就没有学生', () => {
    expect(replay(h, [])).toEqual([])
  })

  it('按 sid 分组并排序，每人按 ts 先后重放，忽略别的讲义', () => {
    const out = replay(h, [
      ev('s2', { type: 'tap_word', lemma: 'fret' }, 5),
      ev('s1', { type: 'open_ladder', sentenceId: 'S01', level: 2 }, 9),
      ev('s1', { type: 'open_ladder', sentenceId: 'S01', level: 1 }, 3),
      { ...ev('s3', { type: 'tap_word', lemma: 'pending' }), handoutId: 'other' },
    ])
    expect(out.map((s) => s.sid)).toEqual(['s1', 's2'])
    expect(out[0].ladder).toEqual({ S01: 2 })
    expect(out[1].tappedWords).toEqual(['fret'])
  })

  it('点词：去重；value=off 取消', () => {
    const s = one([
      ev('a', { type: 'tap_word', lemma: 'pending' }),
      ev('a', { type: 'tap_word', lemma: 'blanket' }),
      ev('a', { type: 'tap_word', lemma: 'pending' }),
      ev('a', { type: 'tap_word', lemma: 'blanket', value: 'off' }),
      ev('a', { type: 'tap_word', lemma: 'proposal' }), // 词表外的词也记下
    ])
    expect(s.tappedWords).toEqual(['pending', 'proposal'])
  })

  it('学生词卡片：真词进 wordMarks（后标覆盖先标）；词表外的词是假词，点「认识」才设 fakeWordClaimedKnown', () => {
    const honest = one([ev('a', { type: 'word_card', lemma: 'fret', value: 'unknown' }), ev('a', { type: 'word_card', lemma: 'brondle', value: 'unknown' })])
    expect(honest.wordMarks).toEqual({ fret: 'unknown' })
    expect(honest.fakeWordClaimedKnown).toBe(false)

    const s = one([
      ev('b', { type: 'word_card', lemma: 'fret', value: 'unknown' }),
      ev('b', { type: 'word_card', lemma: 'fret', value: 'known' }),
      ev('b', { type: 'word_card', lemma: 'brondle', value: 'known' }),
      ev('b', { type: 'word_card', lemma: 'pending', value: 'maybe' }), // 非法 value 忽略
    ])
    expect(s.wordMarks).toEqual({ fret: 'known' })
    expect(s.fakeWordClaimedKnown).toBe(true)
  })

  it('作答：原句题按 sentenceId、段意题按 paragraph、先猜后看按 lemma 找题；attempts 累加，firstTryCorrect 只看第一次', () => {
    const s = one([
      ev('a', { type: 'answer_question', sentenceId: 'S03', correct: false, firstTry: true }),
      ev('a', { type: 'answer_question', sentenceId: 'S03', correct: false, firstTry: false }),
      ev('a', { type: 'answer_question', sentenceId: 'S03', correct: true, firstTry: false }),
      ev('a', { type: 'gist_answer', paragraph: 2, correct: true, firstTry: true }),
      ev('a', { type: 'answer_question', lemma: 'pending', correct: false, firstTry: true }),
    ])
    expect(s.answers).toEqual({
      'S03-q': { firstTryCorrect: false, attempts: 3, correct: true },
      'P2-gist': { firstTryCorrect: true, attempts: 1, correct: true },
      'w-pending': { firstTryCorrect: false, attempts: 1, correct: false },
    })
  })

  it('梯子只记最高级', () => {
    const s = one([
      ev('a', { type: 'open_ladder', sentenceId: 'S02', level: 1 }),
      ev('a', { type: 'open_ladder', sentenceId: 'S02', level: 3 }),
      ev('a', { type: 'open_ladder', sentenceId: 'S02', level: 2 }),
    ])
    expect(s.ladder).toEqual({ S02: 3 })
  })

  it('writing_submit 带 sentenceId = 打卡句交了初稿；不带的（Day 5 写作）和 feedback 不改状态', () => {
    const s = one([
      ev('a', { type: 'writing_submit', sentenceId: 'S03', value: '初稿' }),
      ev('a', { type: 'writing_submit', value: 'I think a blanket ban is counterproductive.' }),
      ev('a', { type: 'feedback', value: '太难' }),
    ])
    expect(s).toEqual({ ...emptyState('a'), checkInDrafted: { S03: true } })
  })

  it('诊断事件（page_view、client_error）不改状态；只有诊断事件的 sid 不算学生', () => {
    const events = [
      ev('a', { type: 'page_view', value: '粗读' }),
      ev('a', { type: 'tap_word', lemma: 'fret' }),
      ev('a', { type: 'client_error', value: 'TypeError: x is undefined' }),
      ev('b', { type: 'page_view', value: '问卷' }),
      ev('c', { type: 'client_error', value: 'boom' }),
    ]
    expect(learningEvents(events).map((e) => e.type)).toEqual(['tap_word'])
    expect(replay(h, events)).toEqual([{ ...emptyState('a'), tappedWords: ['fret'] }])
    // 现场 applyEvent 原样返回同一个对象，学生端发 page_view 不会触发重新渲染
    const s = emptyState('a')
    expect(applyEvent(h, s, events[0])).toBe(s)
    expect(applyEvent(h, s, events[2])).toBe(s)
  })

  it('找不到的句子、段落、词，缺字段的事件：忽略，不报错', () => {
    const s = one([
      ev('a', { type: 'answer_question', sentenceId: 'S99', correct: true }),
      ev('a', { type: 'answer_question', sentenceId: 'S05', correct: true }), // S05 没有原句题
      ev('a', { type: 'answer_question', lemma: 'fret', correct: true }), // fret 没有先猜后看
      ev('a', { type: 'gist_answer', paragraph: 9, correct: true }),
      ev('a', { type: 'answer_question', sentenceId: 'S01' }), // 没有 correct
      ev('a', { type: 'open_ladder', sentenceId: 'S01' }), // 没有 level
      ev('a', { type: 'tap_word' }),
      ev('a', { type: 'word_card', lemma: 'fret' }),
    ])
    expect(s).toEqual(emptyState('a'))
  })

  it('现场逐条 applyEvent（前端的做法）与重放结果一致', () => {
    const events = snapshotEvents(h)
    for (const st of replay(h, events)) {
      let live: StudentState = emptyState(st.sid)
      for (const e of events.filter((x) => x.sid === st.sid)) live = applyEvent(h, live, e)
      expect(live).toEqual(st)
    }
  })
})

describe('triedFirst：按时间顺序算「先自己试」', () => {
  const q = (sid: string, id: string, correct: boolean, ts: number) => ev(sid, { type: 'answer_question', sentenceId: id, correct, firstTry: true }, ts)
  const tried = (events: LearningEvent[]) => [...(triedFirst(h, events).get('s') ?? [])]
  it('先 S02 自己读懂、再做 S04：S04 是先自己试', () => {
    expect(tried([q('s', 'S02', true, 1), q('s', 'S04', true, 2)])).toEqual(['S04'])
  })
  it('先做 S04、再回去把 S02 读懂：S04 当时不是先自己试', () => {
    expect(tried([q('s', 'S04', true, 1), q('s', 'S02', true, 2)])).toEqual([])
  })
  it('S04 先自己试之后，回头在 S02 开梯子：不改写 S04 当时的情况', () => {
    expect(tried([q('s', 'S02', true, 1), q('s', 'S04', true, 2), ev('s', { type: 'open_ladder', sentenceId: 'S02', level: 1 }, 3)])).toEqual(['S04'])
  })
  it('S04 先开了梯子，之后 S02 才自己读懂、再答 S04：S04 不是先自己试', () => {
    expect(tried([ev('s', { type: 'open_ladder', sentenceId: 'S04', level: 1 }, 1), q('s', 'S02', true, 2), q('s', 'S04', true, 3)])).toEqual([])
  })
})

describe('预设画像', () => {
  const A = presetState(h, 'A')
  const B = presetState(h, 'B')
  const stuckIds = (s: StudentState) => h.sentences.filter((x) => (stuck(h, s, x.id).level ?? 0) >= 2).map((x) => x.id)

  it('预设状态 = 重放预设事件 + 问卷 + 表达本', () => {
    const [replayed] = replay(h, presetEvents(h, 'A'))
    expect({ ...A, survey: undefined, collectedExpressions: [] }).toEqual({ ...replayed, survey: undefined })
    expect(A.sid).toBe('demo-A')
    expect(A.survey?.stuckOn).toBe('words')
    expect(B.survey?.stuckOn).toBe('long_sentences')
    expect(B.collectedExpressions).toEqual(['E1'])
  })

  it('A、B 的卡点不同：A 卡在打卡句 S03（有生词），B 卡在 S01（结构）', () => {
    expect(stuckIds(A)).toEqual(['S03'])
    expect(stuckIds(B)).toEqual(['S01'])
    expect(stuck(h, A, 'S03')).toMatchObject({ level: 2, cause: 'mixed' })
    expect(stuck(h, B, 'S01')).toMatchObject({ level: 3, cause: 'structure' })
  })

  it('A 点过的词进学生词卡片；B 认识 pending，精读不再给它加注，counterproductive 照样加注', () => {
    expect(A.tappedWords).toEqual(['pending', 'counterproductive', 'blanket', 'fret'])
    expect(personalize(h, A).deck.filter((c) => c.kind === 'tapped').map((c) => c.lemma)).toEqual(A.tappedWords)
    const s03 = personalize(h, B).sentences.find((x) => x.id === 'S03')!
    expect(s03.glosses.map((g) => g.lemma)).toEqual(['counterproductive'])
  })

  it('B 第一次就读懂了 S02，同类的 S04 轮到「先自己试」；B 交过打卡句初稿，梯子全开', () => {
    const v = personalize(h, B)
    expect(v.sentences.find((x) => x.id === 'S02')!.teacherNoteCollapsed).toBe(true)
    expect(v.sentences.find((x) => x.id === 'S04')!.ladderMode).toBe('tryFirst')
    expect(v.sentences.find((x) => x.id === 'S03')!.maxLadderLevel).toBe(3)
  })

  it('班级快照：12 人，可复现，能选出定向 2 人 + 随机 2 人', () => {
    const students = replay(h, snapshotEvents(h))
    expect(students).toHaveLength(12)
    expect(snapshotEvents(h)).toEqual(snapshotEvents(h))
    const picks = reviewPicks(h, students, { targeted: 2, random: 2, seed: 20261001 })
    expect(picks.map((p) => p.kind)).toEqual(['targeted', 'targeted', 'random', 'random'])
    expect(new Set(picks.map((p) => p.sid)).size).toBe(4)
    // 热力图有颜色：至少一句有人卡在「中」以上
    expect(h.sentences.some((x) => students.some((s) => (stuck(h, s, x.id).level ?? 0) >= 2))).toBe(true)
  })
})
