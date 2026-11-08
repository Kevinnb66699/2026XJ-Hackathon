import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { describe, expect, it } from 'vitest'
import { PROPER_NAME_TAGS, inflectsTo, syllabusBand } from '../shared/syllabus'
import { SYLLABUS_PHRASES, SYLLABUS_WORDS } from '../shared/syllabus-words'

const all = [...SYLLABUS_WORDS, ...SYLLABUS_PHRASES]
const bandOf = (entry: string) => entry.match(/\*+$/)?.[0].length ?? 0
const formsOf = (entry: string) => entry.replace(/\*+$/, '').split('/')

describe('syllabusBand：课标词表档位', () => {
  it('抽样的词档位和原表一致，三档都有', () => {
    const sample: [string, number][] = [
      ['ability', 0], ['dinner', 0], ['hundred', 0], ['month', 0], ['thousand', 0], ['zoo', 0], ['child', 0],
      ['absolutely', 1], ['declare', 1], ['range', 1], ['scene', 1], ['youth', 1], ['within', 1], ['yoghurt', 1],
      ['abandon', 2], ['leadership', 2], ['net', 2], ['vision', 2], ['zone', 2], ['directory', 2], ['wrestle', 2],
    ]
    for (const [w, b] of sample) expect([w, syllabusBand(w)]).toEqual([w, b])
  })

  it('原表印成 million**，按说明的条数改成必修', () => {
    expect(syllabusBand('million')).toBe(1)
    expect(syllabusBand('billion')).toBe(2)
  })

  it('括号里的写法和主写法同档', () => {
    expect(syllabusBand('analyze')).toBe(syllabusBand('analyse'))
    expect(syllabusBand('analyze')).toBe(2)
    expect(syllabusBand('an')).toBe(0)
    expect(syllabusBand('children')).toBe(0)
    expect(syllabusBand('criteria')).toBe(2)
    expect(syllabusBand('is')).toBe(0)
    expect(syllabusBand('kilogram')).toBe(0)
    expect(syllabusBand('towards')).toBe(0)
    expect(syllabusBand('bridegroom')).toBe(2)
    expect(syllabusBand('tofu')).toBe(2)
  })

  it('表外词和派生词不分档', () => {
    for (const w of ['serendipity', 'blockchain', 'xylophone', 'abandonment', 'happiness', '']) expect(syllabusBand(w)).toBeUndefined()
  })

  it('短语和人名、地名不分档', () => {
    for (const p of ['according to', 'mobile phone', 'due to', 'ought to', 'bean curd', 'physical education']) expect(syllabusBand(p)).toBeUndefined()
    expect(syllabusBand('China', '（地名）中国')).toBeUndefined()
    expect(syllabusBand('Kelly', '（人名）凯莉')).toBeUndefined()
    expect(syllabusBand('China', '中国')).toBe(0)
  })

  it('机构名里的单个词也不分档（全文词义的提示词要求人名、地名、机构名都这样写，这里挡的和提示词对得上）', () => {
    for (const [w, zh] of [['Nations', '（机构名）联合国'], ['Organization', '（机构名）世界卫生组织'], ['Journal', '（机构名）华尔街日报'], ['Wired', '（机构名）连线杂志'], ['Nations', '（机构）联合国']])
      expect([w, syllabusBand(w, zh)]).toEqual([w, undefined])
    expect([syllabusBand('Nations'), syllabusBand('Organization'), syllabusBand('Journal'), syllabusBand('Wired')]).toEqual([1, 1, 1, 2]) // 不挡的话会被当成高中新词
    expect(syllabusBand('nations', '国家')).toBe(1) // 只看开头的标记
    const prompt = readFileSync(fileURLToPath(new URL('../pipeline/lexicon.ts', import.meta.url)), 'utf8')
    const named = prompt.match(/zh 是这个词在本段语境里的意思[^\n]*?；([^；\n]+)写成「（/)?.[1]
    expect(named).toBe('人名、地名、机构名')
    for (const tag of named!.split('、')) expect(PROPER_NAME_TAGS).toContain(tag)
  })

  it('变形能还原', () => {
    const cases: [string, number][] = [
      ['abandoned', 2], ['abandoning', 2], ['abandons', 2], ['banned', 2], ['banning', 2], ['declared', 1],
      ['cities', 0], ['boxes', 0], ['studies', 0], ['studied', 0], ['carried', 0], ['stopped', 0],
      ['running', 0], ['making', 0], ['liked', 0], ['wanted', 0], ['ones', 0], ['afterwards', 2],
    ]
    for (const [w, b] of cases) expect([w, syllabusBand(w)]).toEqual([w, b])
  })

  // 课标里成对的词（sky / ski、bit / bite、star / stare、sit / site、win / wine、ton / tone、them / theme、breath / breathe）档位不同，还原的先后决定配到哪个
  it('还原的先后：-ies 先于 -es；-ing 先补 e、再去掉、最后去双写', () => {
    const cases: [string, number][] = [
      ['skies', 0], ['skis', 1], ['flies', 0], ['ties', 0], ['horses', 0], ['uses', 0], ['goes', 0],
      ['staring', 2], ['starring', 0], ['biting', 1], ['breathing', 1], ['sitting', 0], ['siting', 1],
      ['winning', 0], ['wining', 1], ['toning', 2], ['theming', 1], ['hugging', 1], ['quitting', 1], ['hoping', 0], ['ending', 0],
      ['stared', 2], ['starred', 0], ['sited', 1],
    ]
    for (const [w, b] of cases) expect([w, syllabusBand(w)]).toEqual([w, b])
  })

  it('全大写的缩写只按原样查、不还原（AIDS 不是 aid）；本身就是原形的 incoming 不还原成 income', () => {
    expect(syllabusBand('AIDS')).toBeUndefined()
    expect(syllabusBand('aids')).toBe(1) // 小写的是 aid 的变形
    expect([syllabusBand('US'), syllabusBand('TV'), syllabusBand('PE')]).toEqual([0, 0, 0]) // 原表里有的缩写照查
    expect(syllabusBand('incoming')).toBeUndefined()
    expect(syllabusBand('income')).toBe(1)
  })

  it('inflectsTo：写法能不能按规则还原成原形（引擎跨篇认单词本里的词用）', () => {
    expect([inflectsTo('phones', 'phone'), inflectsTo('Phones', 'phone'), inflectsTo('banning', 'ban'), inflectsTo('studied', 'study'), inflectsTo('staring', 'stare')]).toEqual([true, true, true, true, true])
    expect([inflectsTo('found', 'find'), inflectsTo('saw', 'see'), inflectsTo('left', 'leave'), inflectsTo('phone', 'phone')]).toEqual([false, false, false, false])
  })

  it('大小写：先按原表大小写查，对不上再按小写查', () => {
    expect(syllabusBand('China')).toBe(0)
    expect(syllabusBand('china')).toBe(1)
    expect(syllabusBand('March')).toBe(0)
    expect(syllabusBand('march')).toBe(1)
    expect(syllabusBand('Ability')).toBe(0)
    expect(syllabusBand('internet')).toBe(0)
    expect(syllabusBand('cafe')).toBe(1)
    expect(syllabusBand('o’clock')).toBe(0)
  })
})

describe('课标词表数据', () => {
  it('写法没有重复', () => {
    const forms = all.flatMap(formsOf)
    expect(new Set(forms).size).toBe(forms.length)
  })

  it('除了原表大写的专有名词、缩写，全是小写英文；多词条目另放', () => {
    for (const f of SYLLABUS_WORDS.flatMap(formsOf).filter((f) => f !== 'physical education'))
      expect([f, /^[A-Za-zé]+(?:[-.'][A-Za-z]+)*\.?$/.test(f)]).toEqual([f, true])
    for (const p of SYLLABUS_PHRASES) expect(formsOf(p)[0]).toContain(' ')
    // 大写的只有这几类：专有名词（国名、月份、星期……）、缩写、I、Internet 和带大写的复合词
    const caps = SYLLABUS_WORDS.flatMap(formsOf).filter((f) => f !== f.toLowerCase())
    expect(caps.length).toBe(70)
    for (const c of ['China', 'March', 'May', 'US', 'AD', 'PE', 'TV', 'I', 'Mr', 'OK', 'T-shirt', 'Wi-Fi']) expect(caps).toContain(c)
    // 小写后重复的只有这几对，档位不同的是 China / china、March / march
    const lowered = new Map<string, number>()
    for (const f of all.flatMap(formsOf)) lowered.set(f.toLowerCase(), (lowered.get(f.toLowerCase()) ?? 0) + 1)
    expect([...lowered].filter(([, n]) => n > 1).map(([f]) => f).sort()).toEqual(['ad', 'china', 'march', 'may', 'miss', 'us'])
  })

  it('各档条数等于数据文件头写的数，也等于课标说明的 1500 / 500 / 1000', () => {
    const src = readFileSync(fileURLToPath(new URL('../shared/syllabus-words.ts', import.meta.url)), 'utf8')
    const m = src.match(/各档条数：义务教育 (\d+)、必修 (\d+)、选择性必修 (\d+)，共 (\d+)/)
    expect(m).not.toBeNull()
    const counts = [0, 1, 2].map((b) => all.filter((e) => bandOf(e) === b).length)
    expect(counts).toEqual([Number(m![1]), Number(m![2]), Number(m![3])])
    expect(all.length).toBe(Number(m![4]))
    expect(counts).toEqual([1500, 500, 1000])
  })
})
