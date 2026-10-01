// 讲义规则抽取：数量、原文拼接、关键答案、出处子串。真实讲义文本在 data/raw/。
import { readFileSync } from 'fs'
import { describe, expect, it } from 'vitest'
import type { Source } from '../shared/schema'
import { extractHandout, OUT_PATH, readRawDays } from '../pipeline/extract'
import { normalizeSpace, normalizeText, stripFooters } from '../pipeline/normalize'

const raw = readRawDays()
const x = extractHandout(raw)

// 递归收集所有 source 字段
function sources(o: unknown, out: Source[] = []): Source[] {
  if (Array.isArray(o)) o.forEach((v) => sources(v, out))
  else if (o && typeof o === 'object')
    for (const [k, v] of Object.entries(o)) {
      if (k === 'source') out.push(v as Source)
      else sources(v, out)
    }
  return out
}

describe('normalize', () => {
  it('去页脚、去换页符、合并断行、去中文间空格', () => {
    expect(stripFooters('a\n       —3—\n\fb')).toEqual(['a', 'b'])
    expect(normalizeSpace('直 到 … … 为\n止 ； 在')).toBe('直到……为止；在')
    expect(normalizeSpace('  bans will do\n   more harm  ')).toBe('bans will do more harm')
  })
})

describe('讲义抽取', () => {
  it('提交的 extract.json 和当前代码的输出一致', () => {
    expect(JSON.parse(readFileSync(OUT_PATH, 'utf8'))).toEqual(x)
  })

  it('各项数量', () => {
    expect(x.article.paragraphs).toHaveLength(6)
    expect(x.article.sentences.map((s) => s.id)).toEqual(Array.from({ length: 29 }, (_, i) => `S${String(i + 1).padStart(2, '0')}`))
    expect(x.coreVocab).toHaveLength(15)
    expect(x.vocabQuiz).toHaveLength(20)
    expect(x.summaryCloze.blanks.map((b) => b.n)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
    expect(x.detailQuestions.filter((q) => q.day === 2)).toHaveLength(5)
    expect(x.detailQuestions.filter((q) => q.day === 3)).toHaveLength(5)
    expect(x.functionCloze.filter((c) => c.day === 2)).toHaveLength(10)
    expect(x.functionCloze.filter((c) => c.day === 3)).toHaveLength(10)
    expect(x.checkIn).toHaveLength(4)
    expect(x.analyses.blocks.filter((b) => b.day === 2)).toHaveLength(6)
    expect(x.analyses.blocks.filter((b) => b.day === 3)).toHaveLength(8)
    expect(x.sightTranslation).toHaveLength(2)
    expect(x.retellKeywords).toHaveLength(4)
    expect(x.day5.questions).toHaveLength(3)
  })

  it('句子拼回去等于原段落', () => {
    for (const p of x.article.paragraphs) {
      const text = x.article.sentences.filter((s) => s.paragraph === p.n).map((s) => s.text).join(' ')
      expect(text).toBe(p.text)
    }
  })

  it('精读覆盖：Day 2 = 第 1-3 段，Day 3 = 第 4-6 段', () => {
    expect(x.dayCoverage.map((c) => [c.day, c.paragraphs])).toEqual([
      [2, [1, 2, 3]],
      [3, [4, 5, 6]],
    ])
  })

  it('核心词 15 条，字段齐全', () => {
    for (const v of x.coreVocab) for (const k of ['term', 'pos', 'zh', 'enHint'] as const) expect(v[k]).not.toBe('')
    const pending = x.coreVocab.find((v) => v.term === 'pending')!
    expect(pending.zh).toBe('直到……为止；在等待……期间')
    expect(pending.enHint).toBe('until sth happens; while waiting for sth to happen')
  })

  it('选择题都是 4 个选项、没有答案', () => {
    for (const q of [...x.vocabQuiz, ...x.detailQuestions]) {
      expect(q.options).toHaveLength(4)
      expect(q.answer).toBeNull()
    }
  })

  it('总结填空：(1) 推断为 legislators；没推断的为 null', () => {
    expect(x.summaryCloze.blanks[0]).toMatchObject({ initial: 'l', answer: 'legislators', inferred: true })
    for (const b of x.summaryCloze.blanks) expect(b.inferred).toBe(b.answer !== null)
  })

  it('功能词填空的关键空', () => {
    const at = (day: number, n: number) => x.functionCloze.find((c) => c.day === day && c.n === n)
    expect(at(2, 10)).toMatchObject({ answer: 'with', sentenceId: 'S09' })
    expect(at(3, 4)).toMatchObject({ answer: 'pending', sentenceId: 'S17' })
    expect(at(3, 2)).toMatchObject({ answer: 'that', sentenceId: 'S16' })
  })

  it('功能词填空的答案就是原文那句里的词', () => {
    for (const c of x.functionCloze) {
      const s = x.article.sentences.find((s) => s.id === c.sentenceId)!
      expect(s.text.split(' ').some((w) => w.startsWith(c.answer))).toBe(true)
    }
  })

  it('打卡句 = S08、S10、S17、S24', () => {
    expect(x.checkIn.map((c) => c.sentenceId)).toEqual(['S08', 'S10', 'S17', 'S24'])
  })

  it('视译两段对应的句子', () => {
    expect(x.sightTranslation.map((s) => s.sentenceIds)).toEqual([
      ['S01', 'S02'],
      ['S20', 'S21'],
    ])
  })

  it('精读：fret 那段的行序已调回', () => {
    const fret = x.analyses.bySentence.S10.notes[0]
    expect(fret).toContain('confident 后接的宾语从句，harm 此时是名词；“that their offspring... memes”是动词 fret 后的宾语从句')
  })

  it('Day 5 要求的表达', () => {
    expect(x.day5.writing.requiredExpressions.map((e) => e.text)).toEqual(['counterproductive', 'blanket bans', 'predators'])
  })

  it('所有 source.quote 归一化后都是该天讲义原文的子串', () => {
    const days = raw.map(normalizeText)
    const all = sources(x)
    expect(all.length).toBeGreaterThan(200)
    for (const s of all) {
      expect(s.quote.length).toBeGreaterThan(0)
      if (!days[s.day - 1].includes(normalizeSpace(s.quote))) throw new Error(`Day ${s.day} ${s.section} 的出处不是原文子串：${s.quote}`)
    }
  })
})
