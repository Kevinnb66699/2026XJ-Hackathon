import { describe, expect, it } from 'vitest'
import { validateHandout } from '../pipeline/validate'
import { miniHandout } from './fixtures/mini-handout'

const clone = () => JSON.parse(JSON.stringify(miniHandout))
const errorsOf = (h: unknown, raw?: Record<number, string>) => validateHandout(h, raw).filter((i) => i.level === 'error').map((i) => i.message)

describe('校验器', () => {
  it('团队样例通过校验', () => {
    expect(errorsOf(miniHandout)).toEqual([])
  })

  it('梯子 L1 不是原句子串时报错', () => {
    const h = clone()
    h.sentences[0].ladder.l1.subject = 'Most schools'
    expect(errorsOf(h).join()).toMatch(/L1「谁」不是原句子串/)
  })

  it('答案超出选项、选项重复都报错', () => {
    const h = clone()
    h.sentences[0].question.answer = 9
    h.sentences[1].question.options = ['a', 'a', 'b']
    const errs = errorsOf(h).join()
    expect(errs).toMatch(/答案序号超出/)
    expect(errs).toMatch(/选项重复/)
  })

  it('学生端出现语法术语时报错，老师讲解不受限', () => {
    const h = clone()
    h.sentences[0].ladder.l2 = '这是倒装句'
    h.sentences[1].teacherNote = '这里是同位语从句'
    const errs = errorsOf(h)
    expect(errs.join()).toMatch(/梯子里出现语法术语「倒装」/)
    expect(errs.filter((e) => e.includes('同位语')).length).toBe(0)
  })

  it('打卡句不是 must、核心词不是 must 都报错', () => {
    const h = clone()
    h.sentences[2].tier = 'focus'
    h.words[0].tier = 'focus'
    const errs = errorsOf(h).join()
    expect(errs).toMatch(/打卡句必须是 must/)
    expect(errs).toMatch(/老师核心词必须是 must/)
  })

  it('出处对不上讲义原文时报错', () => {
    const errs = errorsOf(miniHandout, { 1: 'nothing here', 2: 'nothing', 5: 'nothing' })
    expect(errs.join()).toMatch(/出处不在 Day/)
  })

  it('出处都在讲义原文里时不报错', () => {
    // 按天拼一份「原文」，正好包含迷你讲义里所有出处的原话
    const raw: Record<number, string> = {}
    const collect = (x: unknown): void => {
      if (Array.isArray(x)) return x.forEach(collect)
      if (!x || typeof x !== 'object') return
      const o = x as Record<string, unknown>
      if (typeof o.day === 'number' && typeof o.quote === 'string') raw[o.day] = `${raw[o.day] ?? ''} ${o.quote}`
      Object.values(o).forEach(collect)
    }
    collect(miniHandout)
    expect(Object.keys(raw).length).toBeGreaterThan(1)
    expect(errorsOf(miniHandout, raw)).toEqual([])
  })

  it('老师要求的表达必须进写作要求，正则要能匹配表达本身', () => {
    const h = clone()
    h.writing.requiredExpressionIds = ['E2']
    h.expressions[0].pattern = '\\bnothing\\b'
    const errs = errorsOf(h).join()
    expect(errs).toMatch(/老师要求的表达没放进写作要求/)
    expect(errs).toMatch(/正则匹配不到表达本身/)
  })
})
