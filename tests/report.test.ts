import fs from 'node:fs'
import { describe, expect, it } from 'vitest'
import { emptyState } from '../src/engine'
import type { StudentState } from '../src/engine/types'
import { handoutReport } from '../src/lib/report'
import { hasGrammarTerm } from '../shared/terms'
import { miniHandout as h } from './fixtures/mini-handout'

const with_ = (patch: Partial<StudentState>): StudentState => ({ ...emptyState('S-r'), ...patch })
const rec = (firstTryCorrect: boolean, correct: boolean, attempts = 1) => ({ firstTryCorrect, correct, attempts })

describe('学生小结（handoutReport）', () => {
  it('什么都没做：没动过手，四句带题的句子都还没答', () => {
    const r = handoutReport(h, emptyState('S-e'))
    expect(r.started).toBe(false)
    expect(r.close).toEqual({ own: 0, answered: 0, total: 4 })
    expect(r.gist).toEqual({ first: 0, answered: 0, total: 2 })
    expect(r.words).toEqual([])
    expect(r.pending.map((p) => [p.id, p.status])).toEqual([['S01', 'todo'], ['S02', 'todo'], ['S03', 'todo'], ['S04', 'todo']])
  })

  it('自己读懂 = 第一次就答对、没开提示；分母是答过的句数；还没答对、还没答的按原文顺序列出', () => {
    const r = handoutReport(
      h,
      with_({
        answers: {
          'S01-q': rec(true, true), // 自己读懂
          'S02-q': rec(true, true), // 第一次就对，但开过提示：不算自己读懂
          'S03-q': rec(false, false, 2), // 还没答对
          'P1-gist': rec(true, true),
          'P2-gist': rec(false, true, 2),
        },
        ladder: { S02: 1, S04: 2 }, // S04 开了提示还没答
      }),
    )
    expect(r.started).toBe(true)
    expect(r.close).toEqual({ own: 1, answered: 3, total: 4 })
    expect(r.gist).toEqual({ first: 1, answered: 2, total: 2 })
    expect(r.pending.map((p) => [p.id, p.paragraph, p.status])).toEqual([['S03', 1, 'wrong'], ['S04', 2, 'todo']])
  })

  it('生词：点过、标了不认识、第一次猜错的，减去标了认识的；只列查得到意思的，个数等于列出来的数', () => {
    const r = handoutReport(
      h,
      with_({
        tappedWords: ['pupil', 'fret'],
        wordMarks: { fret: 'known', counterproductive: 'unknown', brondle: 'unknown' }, // brondle：10-16 前的假词卡留下的标记
        answers: { 'w-pending': rec(false, true, 2) },
      }),
    )
    expect(r.words.map((w) => w.lemma).sort()).toEqual(['counterproductive', 'pending', 'pupil'])
    expect(r.words.every((w) => w.zh)).toBe(true)
  })

  it('只开过提示也算动过手', () => {
    expect(handoutReport(h, with_({ ladder: { S01: 1 } })).started).toBe(true)
  })

  // 学习记录页（阶段 5）同样不说进步、分数
  const code = (f: string) =>
    fs
      .readFileSync(new URL(`../src/pages/student/${f}`, import.meta.url), 'utf8')
      .split('\n')
      .filter((l) => !l.trim().startsWith('//'))
      .join('\n')

  it('小结页、学习记录页的固定文案：不说进步、分数，也不出现「梯子」和语法术语', () => {
    for (const f of ['Summary.tsx', 'Records.tsx']) for (const bad of ['进步', '掌握', '分数', '正确率', '提高', '梯子', '扣分', '排名', '记住了']) expect(code(f), `${f}: ${bad}`).not.toContain(bad)
    expect(hasGrammarTerm(code('Records.tsx'))).toBeUndefined()
  })

  it('学习记录页不放数字：没有「答对」「生词」，不插入计数（没有 {x.length}、「{n} 句」这类写法，也没有小结里的那些数）', () => {
    const c = code('Records.tsx').replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
    for (const bad of ['答对', '生词', '合计', '一共']) expect(c, bad).not.toContain(bad)
    expect(c).not.toMatch(/\.length\s*\}/) // {list.length}
    expect(c).not.toMatch(/\$\{[^}]*\.length/) // `${list.length}`
    expect(c).not.toMatch(/\}\s*(个|句|篇|次|条|段|处)/) // {n} 句
    expect(c).not.toMatch(/\d\s*(个|句|篇|次|条|段|处)/)
    expect(c).not.toMatch(/handoutReport|\.close\b|\.gist\b|\.words\b|\.pending\b/) // 不在页面上自己算小结的数
    // 只显示这几样：标题、日期、自己选的难度、状态
    expect(c).toContain('{r.title}')
    expect(c).toContain('{bjDate(r.lastTs)}')
    expect(c).toContain('{r.rating && ')
    expect(c).toContain('{STATUS[r.status]}')
  })
})
