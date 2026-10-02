// 词汇补全（10-02）：真实讲义每个词都有词性、英文释义、先猜一猜；核心词词性按规则取自老师词汇表；
// AI 补全（pipeline/ai-edits.json）按 llm 来源记账，人工修订在它之后套用、可以覆盖它
import { describe, expect, it } from 'vitest'
import extract from '../data/extract/social-media.extract.json'
import socialMedia from '../data/handouts/social-media.json'
import { applyHumanEdits, loadHumanEdits } from '../pipeline/human-edits'
import { validateHandout } from '../pipeline/validate'
import { Handout } from '../shared/schema'
import { miniHandout } from './fixtures/mini-handout'

const real = Handout.parse(socialMedia)
const ai = loadHumanEdits('pipeline/ai-edits.json')
const human = loadHumanEdits()
const AI = { by: 'llm', model: 'claude-opus-5-5', reviewedBy: 'agent 复核' } as const

describe('真实讲义：每个词都有词性、英文释义和先猜一猜', () => {
  it('pos、en、guess 一个不缺', () => {
    for (const w of real.words) {
      expect(w.pos, w.lemma).toMatch(/^(n|v|adj|adv|prep|phr)\.$/)
      expect(w.en?.trim(), w.lemma).toBeTruthy()
      expect(w.guess, w.lemma).toBeDefined()
    }
  })

  it('先猜一猜：恰好两个选项、答案在范围内、题干引的词形出现在这个词的第一句里', () => {
    for (const w of real.words) {
      const g = w.guess!
      expect(g.options, w.lemma).toHaveLength(2)
      expect([0, 1], w.lemma).toContain(g.answer)
      const quoted = /“(.+?)”/.exec(g.prompt)?.[1]
      expect(quoted, w.lemma).toBeTruthy()
      const text = real.sentences.find((s) => s.id === w.sentenceIds[0])!.text
      // 整词匹配、不分大小写（句首大写不算）；algorithm、blanket ban 两道是队友 2 校对过的原题，题干引的是原形
      const word = new RegExp(`(^|[^A-Za-z])${quoted!.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^A-Za-z]|$)`, 'i')
      if (!['algorithm', 'blanket ban'].includes(w.lemma)) expect(word.test(text), w.lemma).toBe(true)
      expect(g.prompt, w.lemma).toMatch(/^What does “.+” most likely mean here\?$/)
    }
  })

  it('核心词的词性来自老师词汇表（规则抽取），AI 补全不写核心词的词性', () => {
    const core = real.words.filter((w) => w.teacherCore)
    expect(core).toHaveLength(extract.coreVocab.length)
    for (const w of core) expect(w.pos, w.lemma).toBe(extract.coreVocab.find((v) => v.source.quote === w.sources[0].quote)!.pos)
    const coreLemmas = new Set(core.map((w) => w.lemma))
    expect(ai.filter((e) => e.field === 'pos' && coreLemmas.has(e.id))).toEqual([])
  })
})

describe('AI 补全（pipeline/ai-edits.json）', () => {
  it('词只补 pos / en / guess，句子只补 breakdown（梯子第 2、3 步），署名和备注如实', () => {
    for (const e of ai) {
      expect(e.by).toBe('Claude 起草 + agent 复核（待队友 2 抽查）')
      if (e.target === 'sentence') {
        expect(e.field).toBe('breakdown')
        expect(e.note).toBe('10-02 梯子第 2、3 步（issue #2 #3）')
        continue
      }
      expect(e.target).toBe('word')
      expect(['pos', 'en', 'guess']).toContain(e.field)
      expect(e.note).toBe('10-02 词汇补全')
    }
  })

  it('入库结果里都已套用：没被人工修订覆盖的值原样在，先猜一猜记为 llm 来源', () => {
    const touchedByHuman = (e: (typeof ai)[number]) => human.some((x) => x.target === 'word' && x.id === e.id && x.field.split('.')[0] === e.field)
    for (const e of ai.filter((x) => x.target === 'word' && !touchedByHuman(x))) {
      const w = real.words.find((x) => x.lemma === e.id)!
      if (e.field === 'guess') expect(w.guess).toEqual({ ...(e.value as object), provenance: AI })
      else expect(w[e.field as 'pos' | 'en']).toBe(e.value)
    }
  })

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
