import { describe, expect, it } from 'vitest'
import { applyHumanEdits } from '../pipeline/human-edits'
import { parseGlosses, parseLadder, parseQuestion, parseWord, sheetToEdits } from '../pipeline/review-import'
import { validateHandout } from '../pipeline/validate'
import { miniHandout } from './fixtures/mini-handout'

const clone = () => JSON.parse(JSON.stringify(miniHandout)) as typeof miniHandout
const cell = (x: string) => `"${x.replace(/"/g, '""')}"`
const sheet = (rows: string[][]) =>
  ['校对表', ['序号', '优先级', '类型', '编号', '原文', '待校对的内容', '自动体检提示', '改成', '结论（对 / 改 / 删）', '备注'].join(','), ...rows.map((r) => r.map(cell).join(','))].join('\r\n')
const row = (no: string, kind: string, id: string, to: string, verdict = '改') => [no, 'P1', kind, id, '', '', '', to, verdict, '']

describe('校对表格式解析', () => {
  it('难词里中文自带的「；」不会被拆成新的一条', () => {
    expect(parseGlosses('claim=说法；主张；as a whole=整体上')).toEqual([
      { term: 'claim', zh: '说法；主张' },
      { term: 'as a whole', zh: '整体上' },
    ])
  })
  it('梯子必须正好一组「谁 / 做了什么」', () => {
    expect(() => parseLadder('① 谁：A\n   做了什么：b\n   谁：C\n   做了什么：d\n② 正常语序：x\n③ 简单英文：y')).toThrow(/正好一个/)
  })
  it('题目要正好一个 ✔', () => {
    expect(parseQuestion(['问什么？', '   A. 甲', '✔ B. 乙'])).toEqual({ prompt: '问什么？', options: ['甲', '乙'], answer: 1 })
    expect(() => parseQuestion(['问什么？', '   A. 甲', '   B. 乙'])).toThrow(/✔/)
  })
  it('单词卡不认识的栏位会报错', () => {
    expect(() => parseWord('中文：巧妙的\n英文（建议修正）：clever')).toThrow(/没有这一栏/)
  })
})

describe('校对表 → 人工修订 → 校验', () => {
  it('梯子、原句题、段意题、单词卡、表达都能套上，校验通过', () => {
    const csv = sheet([
      row('1', '梯子', 'S01', '① 谁：Many schools\n   做了什么：are toying with the idea\n② 正常语序：Many schools are toying with the idea of banning phones in class; some parents are also toying with it.\n③ 简单英文：Many schools, and some parents, are thinking about a phone ban, but not very seriously.\n   难词：toying with=不太认真地考虑'),
      row('2', '原句题', 'S02', '这个提议源于什么？\n   A. 学生想用手机\n✔ B. 担心屏幕让学生分心\n   C. 老师想省事'),
      row('3', '段意题', '第 1 段', '第一段主要讲了什么？\n✔ A. 禁手机的想法很多，但可能适得其反\n   B. 手机让学生成绩变好\n   C. 家长反对学校\n要点（英文）：Many want to ban phones in class, but a ban may backfire.'),
      row('4', '注释词（老师核心词）', 'pending', '中文：在等待……期间\n先猜后看：这里的 pending 最可能是？\n✔ A. 在等待……期间\n   B. 没有解决的'),
      row('5', '表达', 'E3', 'blanket ban = 全面禁令'),
      row('6', '注释词', 'pupil', '', '对'),
    ])
    const edits = sheetToEdits(csv, '队友2')
    const h = clone()
    const log = applyHumanEdits(h, edits)
    expect(log.every((l) => l.startsWith('已修改'))).toBe(true)
    expect(h.sentences[0].ladder!.l1.predicate).toBe('are toying with the idea')
    expect(h.sentences[0].ladder!.provenance).toEqual({ by: 'human', reviewedBy: '队友2' })
    expect(h.sentences[1].question).toMatchObject({ id: 'S02-q', answer: 1, provenance: { by: 'human' } })
    expect(h.paragraphs[0].gistEn).toBe('Many want to ban phones in class, but a ban may backfire.')
    expect(h.words.find((w) => w.lemma === 'pending')!.guess).toMatchObject({ options: ['在等待……期间', '没有解决的'], answer: 0 })
    expect(validateHandout(h).filter((i) => i.level === 'error')).toEqual([])
  })

  it('「谁」不是原句原文时，校验器会拦下', () => {
    const edits = sheetToEdits(sheet([row('1', '梯子', 'S01', '① 谁：Many schools（指学校）\n   做了什么：are toying with\n② 正常语序：x\n③ 简单英文：y')]), '队友2')
    const h = clone()
    applyHumanEdits(h, edits)
    expect(validateHandout(h).map((i) => i.message).join()).toMatch(/L1「谁」不是原句子串/)
  })
})
