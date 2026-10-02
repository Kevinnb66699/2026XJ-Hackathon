import { describe, expect, it } from 'vitest'
import { applyHumanEdits } from '../pipeline/human-edits'
import { validateHandout } from '../pipeline/validate'
import { miniHandout } from './fixtures/mini-handout'

const clone = () => JSON.parse(JSON.stringify(miniHandout)) as typeof miniHandout

describe('人工修订', () => {
  it('改梯子第 1 步，来源标为人工', () => {
    const h = clone()
    const log = applyHumanEdits(h, [{ target: 'sentence', id: 'S01', field: 'ladder.l1', value: { subject: 'some parents', predicate: 'so are' }, by: '队友2' }])
    expect(h.sentences[0].ladder!.l1).toEqual({ subject: 'some parents', predicate: 'so are' })
    expect(h.sentences[0].ladder!.provenance).toEqual({ by: 'human', reviewedBy: '队友2' })
    expect(log[0]).toMatch(/^已修改/)
  })

  it('替换整道原句题、改词义、改段意题', () => {
    const h = clone()
    applyHumanEdits(h, [
      { target: 'sentence', id: 'S02', field: 'question', value: { id: 'S02-q', prompt: '人们担心什么？', options: ['屏幕让学生分心', '手机太贵', '没人担心'], answer: 0, provenance: { by: 'human' } }, by: '队友2' },
      { target: 'word', id: 'pending', field: 'zh', value: '在……之前', by: '队友2' },
      { target: 'paragraph', id: '1', field: 'gistEn', value: 'A total ban may backfire.', by: '队友2' },
    ])
    expect(h.sentences[1].question!.prompt).toBe('人们担心什么？')
    expect(h.words.find((w) => w.lemma === 'pending')!.zh).toBe('在……之前')
    expect(h.paragraphs[0].gistEn).toBe('A total ban may backfire.')
    expect(h.paragraphs[0].provenance.by).toBe('human')
    expect(validateHandout(h).filter((i) => i.level === 'error')).toEqual([])
  })

  it('删除表达会同步移出写作要求；句子只删模型产出，不删原文', () => {
    const h = clone()
    applyHumanEdits(h, [
      { target: 'expression', id: 'E3', field: 'remove', value: true, by: '队友2' },
      { target: 'sentence', id: 'S04', field: 'remove', value: true, by: '队友2' },
    ])
    expect(h.expressions.map((e) => e.id)).not.toContain('E3')
    expect(h.writing.requiredExpressionIds).not.toContain('E3')
    const s04 = h.sentences.find((s) => s.id === 'S04')!
    expect(s04.text).toBe(miniHandout.sentences[3].text)
    expect(s04.ladder).toBeUndefined()
    expect(s04.question).toBeUndefined()
  })

  it('原文和编号不能改，找不到的目标会在报告里说明', () => {
    const h = clone()
    const log = applyHumanEdits(h, [
      { target: 'sentence', id: 'S01', field: 'text', value: 'changed', by: '队友2' },
      { target: 'word', id: 'nonexistent', field: 'zh', value: 'x', by: '队友2' },
    ])
    expect(h.sentences[0].text).toBe(miniHandout.sentences[0].text)
    expect(log[0]).toMatch(/^拒绝/)
    expect(log[1]).toMatch(/^未找到/)
  })

  it('表达的写法可以改，匹配规则跟着重新生成', () => {
    const h = clone()
    const e = h.expressions[0]
    const log = applyHumanEdits(h, [{ target: 'expression', id: e.id, field: 'text', value: 'kick sb off sth', by: '队友2' }])
    expect(log[0]).toMatch(/^已修改/)
    expect(e.text).toBe('kick sb off sth')
    expect(new RegExp(e.pattern, 'i').test('They kicked many teens off TikTok.')).toBe(true)
  })

  it('改坏了会被校验器拦下', () => {
    const h = clone()
    applyHumanEdits(h, [{ target: 'sentence', id: 'S01', field: 'ladder.l1', value: { subject: 'not in sentence', predicate: 'are' }, by: '队友2' }])
    expect(validateHandout(h).map((i) => i.message).join()).toMatch(/L1「谁」不是原句子串/)
  })
})
