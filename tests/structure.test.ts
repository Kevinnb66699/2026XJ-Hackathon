// 文章是怎么写的 + 可以借的写法（issue #20）：讲义的 structure 块，AI 起草，套用和校验规则
import { describe, expect, it } from 'vitest'
import socialMedia from '../data/handouts/social-media.json'
import { applyHumanEdits } from '../pipeline/human-edits'
import { validateHandout } from '../pipeline/validate'
import { Handout } from '../shared/schema'
import { miniHandout } from './fixtures/mini-handout'

const AI = { by: 'llm', model: 'claude-opus-5-5', reviewedBy: 'agent 复核' } as const
const clone = () => JSON.parse(JSON.stringify(miniHandout)) as typeof miniHandout
const errorsOf = (h: unknown) => validateHandout(h).filter((i) => i.level === 'error').map((i) => i.message)
const structure = {
  paragraphs: [
    { n: 1, role: '提出观点', summary: '有人想禁手机，但全面禁令可能适得其反' },
    { n: 2, role: '给理由', summary: '证据不足，不如教学生用好手机' },
  ],
  moves: [{ name: '让步再反驳', how: '先说对方的担心，再用“Yet”转回你的看法。', examples: [{ sentenceId: 'S03', quote: 'Yet, pending clearer evidence' }] }],
}
const withStructure = (value: unknown) => {
  const h = clone()
  const log = applyHumanEdits(h, [{ target: 'handout', id: 'mini-phones', field: 'structure', value, by: 'Claude' }], AI)
  return { h, log }
}

describe('文章结构（structure）', () => {
  it('合格的结构通过校验，整块记上 AI 来源', () => {
    const { h, log } = withStructure(structure)
    expect(log).toEqual(['已修改：handout mini-phones structure（Claude）'])
    expect(h.structure).toEqual({ ...structure, provenance: AI })
    expect(errorsOf(h)).toEqual([])
  })

  it('例句不是那一句的原话、句子不存在、段落和原文对不上、出现语法术语，都报错', () => {
    const bad = {
      paragraphs: [{ n: 1, role: '提出观点', summary: '主语是禁令' }],
      moves: [{ name: '让步再反驳', how: '先让步', examples: [{ sentenceId: 'S03', quote: 'Yet pending clearer evidence' }, { sentenceId: 'S99', quote: 'Yet' }] }],
    }
    const errs = errorsOf(withStructure(bad).h).join('\n')
    expect(errs).toMatch(/例句不是 S03 的原话：Yet pending clearer evidence/)
    expect(errs).toMatch(/例句 S99 不存在/)
    expect(errs).toMatch(/段落对不上原文：结构里是 1，原文是 1,2/)
    expect(errs).toMatch(/文章结构里出现语法术语「主语」/)
  })

  it('讲义本身只能改 structure；讲义 id 不对就找不到', () => {
    const h = clone()
    const log = applyHumanEdits(h, [
      { target: 'handout', id: 'mini-phones', field: 'title', value: '改掉标题', by: 'Claude' },
      { target: 'handout', id: 'other', field: 'structure', value: structure, by: 'Claude' },
    ])
    expect(log[0]).toMatch(/^拒绝/)
    expect(log[1]).toMatch(/^未找到/)
    expect(h.title).toBe(miniHandout.title)
    expect(h.structure).toBeUndefined()
  })

  it('演示讲义：每段都有作用和概括，写法的例句都是原话', () => {
    const real = Handout.parse(socialMedia)
    expect(real.structure?.paragraphs.map((p) => p.n)).toEqual([1, 2, 3, 4, 5, 6])
    expect(real.structure?.moves.length).toBeGreaterThan(0)
    expect(real.structure?.provenance).toEqual(AI)
    expect(validateHandout(real).filter((i) => i.where === 'structure')).toEqual([]) // 其他出处校验要老师讲义原文，这里只看结构
  })
})
