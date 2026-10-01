import { describe, expect, it } from 'vitest'
import { findForms, patternFor } from '../pipeline/text-utils'

const sentences = [
  { id: 'S01', text: 'A dozen countries are now toying with the idea; so are legislators in many states.' },
  { id: 'S02', text: 'Algorithms shovelled them content about self-harm.' },
  { id: 'S03', text: 'Blanket bans appear to offer an easy answer.' },
  { id: 'S04', text: 'Proponents ignore how bans would deprive children of the benefits.' },
]

describe('findForms：老师核心词在原文里的写法', () => {
  it('找得到变形', () => {
    expect(findForms('toy with', sentences)).toEqual({ forms: ['toying'], sentenceIds: ['S01'] })
    expect(findForms('shovel', sentences)).toEqual({ forms: ['shovelled'], sentenceIds: ['S02'] })
    expect(findForms('legislator', sentences)).toEqual({ forms: ['legislators'], sentenceIds: ['S01'] })
    expect(findForms('deprive...of...', sentences)).toEqual({ forms: ['deprive'], sentenceIds: ['S04'] })
    expect(findForms('blanket ban', sentences).sentenceIds).toEqual(['S03'])
  })
  it('原文里没有就返回空', () => {
    expect(findForms('draconian', sentences)).toEqual({ forms: [], sentenceIds: [] })
  })
})

describe('patternFor：表达「有没有用上」', () => {
  const used = (expr: string, text: string) => new RegExp(patternFor(expr), 'i').test(text)
  it('认得时态和单复数变化', () => {
    expect(used('toy with', 'Many countries are toying with the idea.')).toBe(true)
    expect(used('toy with', 'Britain toyed with it.')).toBe(true)
    expect(used('blanket bans', 'A blanket ban is unwise.')).toBe(true)
    expect(used('predators', 'Kids may meet a predator online.')).toBe(true)
    expect(used('counterproductive', 'Bans are Counterproductive.')).toBe(true)
  })
  it('认得可跳过的部分和拆开的短语动词', () => {
    expect(used('only too ... to ...', 'Politicians are only too happy to seize on it.')).toBe(true)
    expect(used('deprive...of...', 'Bans would deprive children of the benefits.')).toBe(true)
    expect(used('kick off', 'They support kicking under-16s off such sites.')).toBe(true)
    expect(used('threaten to do sth', 'Such measures threaten to be counterproductive.')).toBe(true)
  })
  it('模式能匹配表达自身的写法', () => {
    for (const e of ['only too ... to ...', 'deprive...of...', 'do more harm than good', 'seize on', 'for once']) expect(used(e, e)).toBe(true)
  })
  it('没用上或搭配不对时不算', () => {
    expect(used('toy with', 'Many countries toy the idea of a ban.')).toBe(false)
    expect(used('blanket bans', 'She bought a blanket.')).toBe(false)
  })
})
