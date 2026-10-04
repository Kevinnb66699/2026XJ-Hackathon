// 词汇补全（10-02）：AI 补全（原 pipeline/ai-edits.json）按 llm 来源记账，人工修订在它之后套用、可以覆盖它。
// 10-04 起购买讲义和它的 AI 补全数据已从仓库移除（版权），只针对那份数据的断言一起删了，这里用迷你讲义测套用规则
import { describe, expect, it } from 'vitest'
import { applyHumanEdits } from '../pipeline/human-edits'
import { validateHandout } from '../pipeline/validate'
import { miniHandout } from './fixtures/mini-handout'

const AI = { by: 'llm', model: 'claude-opus-5-5', reviewedBy: 'agent 复核' } as const

describe('AI 补全的套用', () => {
  it('整道新题按传入的来源记账；之后的人工修订覆盖它并改记人工', () => {
    const h = JSON.parse(JSON.stringify(miniHandout)) as typeof miniHandout
    const guess = { id: 'w-counterproductive', prompt: 'What does “counterproductive” most likely mean here?', options: ['适得其反的', '高效的'], answer: 0 }
    applyHumanEdits(h, [{ target: 'word', id: 'counterproductive', field: 'guess', value: guess, by: 'Claude' }], AI)
    const w = h.words.find((x) => x.lemma === 'counterproductive')!
    expect(w.guess).toEqual({ ...guess, provenance: AI })
    expect(validateHandout(h).filter((i) => i.level === 'error')).toEqual([])
    applyHumanEdits(h, [{ target: 'word', id: 'counterproductive', field: 'guess.answer', value: 0, by: '队友2' }])
    expect(w.guess!.provenance).toEqual({ by: 'human', reviewedBy: '队友2' })
  })
})
