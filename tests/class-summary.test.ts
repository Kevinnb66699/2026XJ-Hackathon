// 全班情况：只有汇总数字，口径和教师端热力图、段意题一致
import { describe, expect, it } from 'vitest'
import type { LearningEvent } from '../shared/schema'
import { handouts } from '../src/data'
import { snapshotEvents } from '../src/data/presets'
import { stuck } from '../src/engine'
import { classSummary } from '../src/lib/classSummary'
import { replay } from '../src/lib/replay'
import { miniHandout as h } from './fixtures/mini-handout'

let t = 0
const ev = (sid: string, e: Omit<LearningEvent, 'sid' | 'ts' | 'handoutId'>): LearningEvent => ({ sid, ts: ++t, handoutId: h.id, ...e })
const summaryOf = (events: LearningEvent[]) => classSummary(h, replay(h, events), events)

describe('classSummary', () => {
  it('没有学生：全是 0 和空', () => {
    expect(summaryOf([])).toEqual({
      students: 0,
      reached: { gist: 0, words: 0, close: 0, writing: 0 },
      hardSentences: [],
      hardTag: null,
      words: [],
      wordsTied: 0,
      gist: [],
      firstTry: { correct: 0, answered: 0, pct: 0 },
    })
  })

  it('手算的小班：人数、卡住最多的句子和结构、不认识的词、段意题、原句题首答', () => {
    const events = [
      // stu-a：S01 第一次答错、梯子到第 2 步（中）；S03 第一次答对；P1 第一次答错；pending 标不认识；交了写作
      ev('stu-a', { type: 'gist_answer', paragraph: 1, correct: false, firstTry: true }),
      ev('stu-a', { type: 'gist_answer', paragraph: 1, correct: true, firstTry: false }),
      ev('stu-a', { type: 'word_card', lemma: 'pending', value: 'unknown' }),
      ev('stu-a', { type: 'word_card', lemma: 'counterproductive', value: 'known' }),
      ev('stu-a', { type: 'answer_question', sentenceId: 'S01', correct: false, firstTry: true }),
      ev('stu-a', { type: 'open_ladder', sentenceId: 'S01', level: 1 }),
      ev('stu-a', { type: 'open_ladder', sentenceId: 'S01', level: 2 }),
      ev('stu-a', { type: 'answer_question', sentenceId: 'S01', correct: true, firstTry: false }),
      ev('stu-a', { type: 'answer_question', sentenceId: 'S03', correct: true, firstTry: true }),
      ev('stu-a', { type: 'writing_submit', value: 'MY-PRIVATE-ESSAY' }),
      // stu-b：粗读点了 pending、blanket；S01 自己读懂
      ev('stu-b', { type: 'tap_word', lemma: 'pending' }),
      ev('stu-b', { type: 'tap_word', lemma: 'blanket' }),
      ev('stu-b', { type: 'gist_answer', paragraph: 1, correct: true, firstTry: true }),
      ev('stu-b', { type: 'answer_question', sentenceId: 'S01', correct: true, firstTry: true }),
      // stu-c：S01 梯子开到第 3 步（重）；S04 答错两次（重）；S02 第一次答对；P2 第一次答错
      ev('stu-c', { type: 'gist_answer', paragraph: 1, correct: true, firstTry: true }),
      ev('stu-c', { type: 'gist_answer', paragraph: 2, correct: false, firstTry: true }),
      ev('stu-c', { type: 'open_ladder', sentenceId: 'S01', level: 3 }),
      ev('stu-c', { type: 'answer_question', sentenceId: 'S02', correct: true, firstTry: true }),
      ev('stu-c', { type: 'answer_question', sentenceId: 'S04', correct: false, firstTry: true }),
      ev('stu-c', { type: 'answer_question', sentenceId: 'S04', correct: false, firstTry: false }),
      // stu-d：只交过已删掉的打卡句初稿（带 sentenceId），不算写作
      ev('stu-d', { type: 'writing_submit', sentenceId: 'S03', value: 'old draft' }),
      ev('stu-d', { type: 'feedback', value: 'MY-PRIVATE-FEEDBACK' }),
    ]
    const s = summaryOf(events)
    const note = (id: string) => h.sentences.find((x) => x.id === id)!.teacherNote
    const text = (id: string) => h.sentences.find((x) => x.id === id)!.text
    expect(s).toEqual({
      students: 4,
      reached: { gist: 3, words: 1, close: 3, writing: 1 },
      // 先按人数，再按比例：S01 2/3 排在 S04 1/1 前面
      hardSentences: [
        { id: 'S01', text: text('S01'), tag: 'inversion', n: 2, of: 3, ok: 1, note: note('S01') },
        { id: 'S04', text: text('S04'), tag: 'appositive_that', n: 1, of: 1, ok: 0, note: note('S04') },
      ],
      hardTag: { tag: 'inversion', n: 2, of: 3 },
      // counterproductive 标了认识，不算；distract、pupil 不是核心词
      words: [
        { lemma: 'pending', zh: '在……之前；等待……期间', n: 2, of: 2 },
        { lemma: 'blanket', zh: '全面的', n: 1, of: 1 },
      ],
      wordsTied: 0,
      gist: [{ paragraph: 2, prompt: h.paragraphs[1].gist.prompt, firstTry: 0, of: 1 }],
      firstTry: { correct: 3, answered: 5, pct: 60 },
    })
    // 不带学生编号、写作和反馈原文
    const json = JSON.stringify(s)
    for (const secret of ['stu-', 'MY-PRIVATE', 'old draft']) expect(json).not.toContain(secret)
  })

  it('示例班级：卡住最多的句子和热力图同一口径，按人数从多到少，最多 3 句；词最多 5 个', () => {
    for (const hd of handouts) {
      const events = snapshotEvents(hd)
      const students = replay(hd, events)
      const s = classSummary(hd, students, events)
      const hard = (id: string) => students.filter((st) => (stuck(hd, st, id).level ?? 0) >= 2).length
      const touched = (id: string) => students.filter((st) => stuck(hd, st, id).level !== null).length
      expect(s.students).toBe(12)
      expect(s.hardSentences.length).toBeGreaterThan(0)
      expect(s.hardSentences.length).toBeLessThanOrEqual(3)
      for (const x of s.hardSentences) expect([x.n, x.of]).toEqual([hard(x.id), touched(x.id)])
      const ns = s.hardSentences.map((x) => x.n)
      expect(ns).toEqual([...ns].sort((a, b) => b - a))
      const last = ns[ns.length - 1]
      for (const x of hd.sentences) if (!s.hardSentences.some((y) => y.id === x.id)) expect(hard(x.id)).toBeLessThanOrEqual(last)
      expect(s.words.length).toBeLessThanOrEqual(5)
      expect(s.firstTry.answered).toBeGreaterThan(0)
      expect(JSON.stringify(s)).not.toMatch(/同学 \d/)
    }
  })

  it('并列：段意题比例最低的几段都列上（带题干）；第 5 个词和后面的词数字一样时给出一共几个', () => {
    const tie = [
      ev('stu-a', { type: 'gist_answer', paragraph: 1, correct: false, firstTry: true }),
      ev('stu-a', { type: 'gist_answer', paragraph: 2, correct: false, firstTry: true }),
      ev('stu-b', { type: 'gist_answer', paragraph: 1, correct: true, firstTry: true }),
      ev('stu-b', { type: 'gist_answer', paragraph: 2, correct: true, firstTry: true }),
    ]
    expect(summaryOf(tie).gist).toEqual(h.paragraphs.map((p) => ({ paragraph: p.n, prompt: p.gist.prompt, firstTry: 1, of: 2 })))

    // 示例班级（social-media）：9 个词都是 12 / 12 人，只列 5 个；第 1、4 段都是 6 / 12 人第一次答对
    const hd = handouts.find((x) => x.id === 'social-media')!
    const events = snapshotEvents(hd)
    const s = classSummary(hd, replay(hd, events), events)
    expect(s.words.map((w) => [w.n, w.of])).toEqual(Array(5).fill([12, 12]))
    expect(s.wordsTied).toBe(9)
    const prompt = (n: number) => hd.paragraphs.find((p) => p.n === n)!.gist.prompt
    expect(s.gist).toEqual([1, 4].map((n) => ({ paragraph: n, prompt: prompt(n), firstTry: 6, of: 12 })))
    // 迷你讲义只有 4 个核心词，没有被截掉的
    expect(classSummary(h, replay(h, snapshotEvents(h)), snapshotEvents(h)).wordsTied).toBe(0)
  })
})
