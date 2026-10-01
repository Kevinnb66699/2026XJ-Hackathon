import { describe, expect, it } from 'vitest'
import { Handout } from '../shared/schema'

describe('数据契约', () => {
  it('拒绝缺少句子的讲义', () => {
    const r = Handout.safeParse({ id: 'x', title: 't', rights: 'r', paragraphs: [], sentences: [], words: [], expressions: [], writing: { prompt: 'p', requiredExpressionIds: [] } })
    expect(r.success).toBe(false)
  })
})
