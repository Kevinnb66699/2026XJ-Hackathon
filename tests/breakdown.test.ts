// 梯子第 2、3 步改成「拆开」+「整句中文」（issue #2 #3）、打卡句不再锁梯子、表达的中文何时显示（issue #4）
import { describe, expect, it } from 'vitest'
import { applyHumanEdits } from '../pipeline/human-edits'
import { validateHandout } from '../pipeline/validate'
import { exprZhShown } from '../src/components/SentenceCard'
import { emptyState, personalize } from '../src/engine'
import { miniHandout } from './fixtures/mini-handout'

const AI = { by: 'llm', model: 'claude-opus-5-5', reviewedBy: 'agent 复核' } as const
const clone = () => JSON.parse(JSON.stringify(miniHandout)) as typeof miniHandout
const errorsOf = (h: unknown) => validateHandout(h).filter((i) => i.level === 'error').map((i) => i.message)
const breakdown = { parts: [{ label: '谁', text: 'a blanket ban' }, { label: '做了什么', text: 'may prove counterproductive', hint: '可能适得其反' }], zh: '但在有更清楚的证据之前，全面禁令可能适得其反。' }

describe('拆开（breakdown）的校验', () => {
  it('合格的拆句通过校验', () => {
    const h = clone()
    applyHumanEdits(h, [{ target: 'sentence', id: 'S03', field: 'breakdown', value: breakdown, by: 'Claude' }], AI)
    expect(errorsOf(h)).toEqual([])
  })

  it('每块必须是原句子串、标签只能用那 7 个、提示和整句中文不出现语法术语', () => {
    const h = clone()
    const bad = { parts: [{ label: '主干', text: 'a total ban' }, { label: '谁', text: 'pending', hint: '这是状语' }], zh: '全面禁令可能适得其反。' }
    applyHumanEdits(h, [{ target: 'sentence', id: 'S03', field: 'breakdown', value: bad, by: 'Claude' }], AI)
    const errs = errorsOf(h).join()
    expect(errs).toMatch(/拆开的一块不是原句子串：a total ban/)
    expect(errs).toMatch(/拆开的标签不在允许的范围里：主干/)
    expect(errs).toMatch(/出现语法术语「状语」/)
    const h2 = clone()
    applyHumanEdits(h2, [{ target: 'sentence', id: 'S03', field: 'breakdown', value: { ...breakdown, zh: '主语是 ban' }, by: 'Claude' }], AI)
    expect(errorsOf(h2).join()).toMatch(/出现语法术语「主语」/)
  })

  it('套用时整块新写的拆句记 llm 来源，不动人工审过的梯子来源', () => {
    const h = clone()
    const before = h.sentences[2].ladder!.provenance
    applyHumanEdits(h, [{ target: 'sentence', id: 'S03', field: 'breakdown', value: breakdown, by: 'Claude' }], AI)
    expect(h.sentences[2].breakdown).toEqual({ ...breakdown, provenance: AI })
    expect(h.sentences[2].ladder!.provenance).toEqual(before)
  })
})

describe('打卡句和拆句透传', () => {
  it('打卡句梯子全开（maxLadderLevel 3），拆句透传到学生视图', () => {
    const h = clone()
    applyHumanEdits(h, [{ target: 'sentence', id: 'S03', field: 'breakdown', value: breakdown, by: 'Claude' }], AI)
    const v = personalize(h, emptyState('x'))
    const checkIns = v.sentences.filter((s) => s.checkIn)
    expect(checkIns.map((s) => s.id)).toEqual(['S03'])
    for (const s of checkIns) {
      expect(s.maxLadderLevel).toBe(3)
      expect(s.breakdown).toEqual(h.sentences.find((x) => x.id === s.id)!.breakdown)
    }
  })
})

describe('表达的中文（issue #4）', () => {
  const s01 = (st = emptyState('x')) => personalize(miniHandout, st).sentences.find((s) => s.id === 'S01')!
  const ok = { firstTryCorrect: true, attempts: 1, correct: true }

  it('开梯子、答对原句题、收进表达本之前不显示', () => {
    expect(exprZhShown(s01(), emptyState('x'), 'E1')).toBe(false)
    const wrong = { ...emptyState('x'), answers: { 'S01-q': { firstTryCorrect: false, attempts: 1, correct: false } } }
    expect(exprZhShown(s01(wrong), wrong, 'E1')).toBe(false)
  })

  it('开过梯子、答对了、或收进了表达本就显示', () => {
    for (const st of [
      { ...emptyState('x'), ladder: { S01: 1 as const } },
      { ...emptyState('x'), answers: { 'S01-q': ok } },
      { ...emptyState('x'), collectedExpressions: ['E1'] },
    ])
      expect(exprZhShown(s01(st), st, 'E1')).toBe(true)
  })

  it('句子没有题也没有梯子时直接显示', () => {
    const s05 = personalize(miniHandout, emptyState('x')).sentences.find((s) => s.id === 'S05')!
    expect(s05.question).toBeUndefined()
    expect(s05.hasLadder).toBe(false)
    expect(exprZhShown(s05, emptyState('x'), 'E9')).toBe(true)
  })
})
