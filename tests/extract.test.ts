// 讲义规则抽取。10-04 起购买讲义的原文（data/raw/）和抽取结果已从仓库移除（版权），
// 只针对那份讲义数据的断言（数量、关键答案、出处子串）一起删了；这里留下不依赖讲义的清洗工具测试。
import { describe, expect, it } from 'vitest'
import { normalizeSpace, normalizeText, stripFooters } from '../pipeline/normalize'

describe('normalize', () => {
  it('去页脚、去换页符、合并断行、去中文间空格', () => {
    expect(stripFooters('a\n       —3—\n\fb')).toEqual(['a', 'b'])
    expect(normalizeSpace('直 到 … … 为\n止 ； 在')).toBe('直到……为止；在')
    expect(normalizeSpace('  bans will do\n   more harm  ')).toBe('bans will do more harm')
  })

  it('整天文本归一：去页脚、断行接成一段', () => {
    expect(normalizeText('第 一 行\n   —1—\n\fsecond\r\nline')).toBe('第一行 second line')
  })
})
