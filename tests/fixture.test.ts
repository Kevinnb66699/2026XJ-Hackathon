import { describe, expect, it } from 'vitest'
import { miniHandout } from './fixtures/mini-handout'

describe('迷你讲义样例', () => {
  it('符合数据契约', () => {
    expect(miniHandout.sentences).toHaveLength(5)
  })
  it('梯子 L1 是原句子串', () => {
    for (const s of miniHandout.sentences) {
      if (!s.ladder) continue
      expect(s.text).toContain(s.ladder.l1.subject)
      expect(s.text).toContain(s.ladder.l1.predicate)
    }
  })
})
