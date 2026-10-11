// 全文词义（pipeline/lexicon.ts）：按段要配意思的词、模型产出的清洗和补问、合进讲义的规则。模型用假的
import { describe, expect, it } from 'vitest'
import { Handout } from '../shared/schema'
import { addLexicon, formsByParagraph, glossArticle, mergeLexicon, type Gloss, type GlossFn, type GlossResult, type LexParagraph } from '../pipeline/lexicon'
import type { LlmConfig } from '../pipeline/llm'
import { miniHandout } from './fixtures/mini-handout'

const cfg: LlmConfig = { baseUrl: 'http://127.0.0.1:9', apiKey: '', model: 'm', cacheDir: '/nonexistent', replay: true, timeoutMs: 1000 }
const paras: LexParagraph[] = [
  { n: 1, sentences: [{ id: 'S01', text: 'Kelly’s shop sells Magazines.' }, { id: 'S02', text: 'The magazines sell well.' }] },
  { n: 2, sentences: [{ id: 'S03', text: 'Shops sell more magazines now.' }] },
]
// 照问的词全部回答：意思是「<词>的意思」，原形去掉词尾 s
const echo = (calls: string[][] = []): GlossFn => async (_p, forms) => {
  calls.push(forms)
  return { data: { words: forms.map((f) => ({ form: f, lemma: f.replace(/s$/, ''), pos: 'n.', zh: `${f}的意思` })) }, model: 'fake-model' }
}

describe('formsByParagraph', () => {
  it('每段的词：原文写法的小写，去重，前面段落出现过的不再配；带撇号的整个算一个词', () => {
    expect(formsByParagraph(paras)).toEqual([['kelly’s', 'shop', 'sells', 'magazines', 'the', 'sell', 'well'], ['shops', 'more', 'now']])
  })
})

describe('glossArticle', () => {
  it('每段一批，问的是这一段的词', async () => {
    const calls: string[][] = []
    const r = await glossArticle(cfg, paras, echo(calls))
    expect(calls).toEqual(formsByParagraph(paras))
    expect(r).toMatchObject({ model: 'fake-model', failed: 0, missing: 0 })
    expect(r.glosses.find((g) => g.form === 'magazines')).toEqual({ form: 'magazines', lemma: 'magazine', pos: 'n.', zh: 'magazines的意思' })
  })

  it('一段超过 40 个词分几批问', async () => {
    const long: LexParagraph[] = [{ n: 1, sentences: [{ id: 'S01', text: Array.from({ length: 90 }, (_, i) => `w${'abcdefghij'[i % 10]}${'abcdefghij'[Math.floor(i / 10)]}`).join(' ') + '.' }] }]
    const calls: string[][] = []
    const r = await glossArticle(cfg, long, echo(calls))
    expect(calls.map((c) => c.length)).toEqual([40, 40, 10])
    expect(r.glosses).toHaveLength(90)
  })

  it('不合格的丢掉：问里没有的词、没有中文、太长、带语法术语；写法只差大小写和弯撇号算对上；原形不像词就用原文写法', async () => {
    const gloss: GlossFn = async () => ({
      data: {
        words: [
          { form: "KELLY'S", lemma: 'Kelly', pos: 'n.', zh: '（人名）凯莉的' },
          { form: 'shop', lemma: 'shop!!', pos: null, zh: '商店' },
          { form: 'sells', lemma: 'sell', pos: 'v.', zh: 'sells' },
          { form: 'magazines', lemma: 'magazine', pos: 'n.', zh: `杂志${'很长'.repeat(15)}` },
          { form: 'the', lemma: 'the', pos: 'art.', zh: '这里作主语的那个' },
          { form: 'zebra', lemma: 'zebra', pos: 'n.', zh: '斑马' },
          { form: 'sell', lemma: 'sell', pos: 'a very long part of speech', zh: '卖' },
        ],
      },
      model: 'fake-model',
    })
    const r = await glossArticle(cfg, paras.slice(0, 1), gloss)
    expect(r.glosses).toEqual([
      { form: 'kelly’s', lemma: 'Kelly', pos: 'n.', zh: '（人名）凯莉的' },
      { form: 'shop', lemma: 'shop', zh: '商店' },
      { form: 'sell', lemma: 'sell', zh: '卖' },
    ])
  })

  it('模型漏掉的词再问一次（只问漏掉的）；第二次还漏的记进 missing', async () => {
    const calls: string[][] = []
    const gloss: GlossFn = async (_p, forms) => {
      calls.push(forms)
      // 第一次只回答前两个，第二次只回答第一个
      const n = calls.length === 1 ? 2 : 1
      return { data: { words: forms.slice(0, n).map((f) => ({ form: f, lemma: f, zh: '意思' })) }, model: 'fake-model' }
    }
    const r = await glossArticle(cfg, [{ n: 1, sentences: [{ id: 'S01', text: 'one two three four.' }] }], gloss)
    expect(calls).toEqual([['one', 'two', 'three', 'four'], ['three', 'four']])
    expect(r).toMatchObject({ failed: 0, missing: 1, missingForms: ['four'] })
    expect(r.glosses.map((g) => g.form)).toEqual(['one', 'two', 'three'])
  })

  it('出错再试一次；两次都出错算这一批失败，不抛错，别的批照样有', async () => {
    let n = 0
    const gloss: GlossFn = async (p, forms) => {
      n++
      if (p.n === 2) throw new Error('模型接口返回 500: {"error":"upstream"}')
      return echo()(p, forms)
    }
    const r = await glossArticle(cfg, paras, gloss)
    expect(n).toBe(3) // 第 1 段一次，第 2 段两次
    expect(r).toMatchObject({ model: 'fake-model', failed: 1, errors: ['第 2 段：接口返回 500'], missing: 3 })
    expect(r.glosses).toHaveLength(7)
  })

  it('没注入时走 chatJson：回放模式下没有缓存就算失败，不抛错', async () => {
    const r = await glossArticle(cfg, paras)
    expect(r).toEqual({ glosses: [], model: undefined, failed: 2, errors: ['第 1 段：回放模式缺缓存', '第 2 段：回放模式缺缓存'], missing: 10, missingForms: formsByParagraph(paras).flat() })
  })

  it('失败原因只记类别，不带原文和模型输出', async () => {
    const fail = (err: Error): GlossFn => async () => {
      throw err
    }
    const one = [paras[0]]
    const why = async (err: Error) => (await glossArticle(cfg, one, fail(err))).errors
    expect(await why(Object.assign(new Error('This operation was aborted'), { name: 'AbortError' }))).toEqual(['第 1 段：超时'])
    expect(await why(new TypeError('fetch failed'))).toEqual(['第 1 段：连不上模型接口'])
    expect(await why(new Error('模型输出两次都不符合 schema：words.0.zh'))).toEqual(['第 1 段：输出格式不对'])
    expect(await why(new Error('Kelly’s shop sells Magazines.'))).toEqual(['第 1 段：其他错误（Error）'])
  })
})

describe('mergeLexicon', () => {
  const h = () => Handout.parse(JSON.parse(JSON.stringify(miniHandout)))
  const llm = { by: 'llm' as const, model: 'fake-model', promptVersion: 'lexicon-v1' }
  const res = (glosses: Gloss[], missingForms: string[] = []): GlossResult => ({ glosses, model: 'fake-model', failed: 0, errors: [], missing: missingForms.length, missingForms })

  it('词表里已有的写法跳过（含短语的第一个词）；同一原形、意思相同的几种写法合成一条，意思不同的用原文写法另起一条；出现在哪几句按原文重找', () => {
    const hd = h()
    hd.words.push({ lemma: 'toy with', forms: ['toying with'], sentenceIds: ['S01'], zh: '不太认真地考虑', teacherCore: false, familiarTrap: false, tier: 'other', sources: [] })
    const { words: n } = mergeLexicon(
      hd,
      res([
        { form: 'pupils', lemma: 'pupil', zh: '学生们' }, // 词表里有这个写法
        { form: 'toying', lemma: 'toy', zh: '玩弄' }, // 词表短语 toying with 的第一个词：粗读点它算 toy with
        { form: 'phones', lemma: 'phone', pos: 'n.', zh: '手机' },
        { form: 'phone', lemma: 'phone', pos: 'n.', zh: '手机' },
        { form: 'are', lemma: 'be', pos: 'v.', zh: '正在' },
        { form: 'has', lemma: 'be', pos: 'v.', zh: '有' }, // 假设模型把 has 也归到 be：意思不同，另起一条
        { form: 'proposal', lemma: 'proposal', pos: 'n.', zh: '提议' },
        { form: 'nowhere', lemma: 'nowhere', zh: '无处' }, // 原文里没有
      ]),
    )
    expect(n).toBe(4)
    expect(hd.lexicon).toEqual({
      words: [
        { lemma: 'phone', forms: ['phone', 'phones'], sentenceIds: ['S01', 'S04', 'S05'], zh: '手机', pos: 'n.' }, // 原形本身那个写法排前面
        { lemma: 'be', forms: ['are'], sentenceIds: ['S01'], zh: '正在', pos: 'v.' },
        { lemma: 'has', forms: ['has'], sentenceIds: ['S04'], zh: '有', pos: 'v.' },
        { lemma: 'proposal', forms: ['proposal'], sentenceIds: ['S02'], zh: '提议', pos: 'n.' },
      ],
      provenance: llm,
    })
    expect(Handout.parse(hd).lexicon).toEqual(hd.lexicon) // 学生端按 schema 读，字段不丢
  })

  it('原形和词表里的词相同（词表漏了这个写法，或是另一个意思）：用原文写法当词条名，不和词表里的词混', () => {
    const hd = h()
    mergeLexicon(hd, res([{ form: 'distracts', lemma: 'Distract', zh: '使分心' }]))
    // 原文里没有 distracts：整条去掉
    expect(hd.lexicon?.words).toEqual([])
    const hd2 = h()
    hd2.sentences[1].text = 'The proposal arises from a worry that screens distracted pupils.'
    mergeLexicon(hd2, res([{ form: 'distracted', lemma: 'distract', zh: '使分心' }]))
    expect(hd2.lexicon?.words).toEqual([{ lemma: 'distracted', forms: ['distracted'], sentenceIds: ['S02'], zh: '使分心' }])
    expect(hd2.words.find((w) => w.lemma === 'distract')?.forms).toEqual(['distract', 'distraction']) // 词表不动
  })

  it('同一原形意思不同：原形本身那个写法的意思用原形当词条名，别的写法另起一条，先后顺序不影响结果', () => {
    const uses: Gloss = { form: 'uses', lemma: 'use', zh: '使用' }
    const use: Gloss = { form: 'use', lemma: 'use', zh: '用处' }
    const run = (gs: Gloss[]) => {
      const hd = h()
      hd.sentences[3].text = 'The claim that phones harm every pupil uses limited support.'
      mergeLexicon(hd, res(gs))
      return hd.lexicon?.words
    }
    const want = [
      { lemma: 'use', forms: ['use'], sentenceIds: ['S05'], zh: '用处' },
      { lemma: 'uses', forms: ['uses'], sentenceIds: ['S04'], zh: '使用' },
    ]
    expect(run([uses, use])).toEqual(want)
    expect(run([use, uses])).toEqual(want)
  })

  it('还缺意思的词不算词表里已有的写法；模型一批都没答成时不写 lexicon', () => {
    const hd = h()
    delete hd.lexicon
    expect(mergeLexicon(hd, res([], ['pupils', 'zebra']))).toEqual({ words: 0, missing: 1 })
    expect(mergeLexicon(hd, { ...res([], ['zebra']), model: undefined })).toEqual({ words: 0, missing: 1 })
    expect(hd.lexicon).toEqual({ words: [], provenance: llm }) // 第一次模型答了（只是没有词）
    const hd2 = h()
    delete hd2.lexicon
    mergeLexicon(hd2, { ...res([]), model: undefined })
    expect(hd2.lexicon).toBeUndefined()
  })
})

describe('addLexicon', () => {
  it('按讲义的段落请模型，合进讲义，带上模型和提示词版本', async () => {
    const hd = Handout.parse(JSON.parse(JSON.stringify(miniHandout)))
    const calls: string[][] = []
    const r = await addLexicon(cfg, hd, echo(calls))
    expect(calls).toHaveLength(2) // 迷你讲义两段
    expect(r).toMatchObject({ failed: 0, missing: 0 })
    expect(r.words).toBe(hd.lexicon?.words.length)
    expect(hd.lexicon?.provenance).toEqual({ by: 'llm', model: 'fake-model', promptVersion: 'lexicon-v1' })
    expect(hd.lexicon?.words.find((w) => w.lemma === 'proposal')).toEqual({ lemma: 'proposal', forms: ['proposal'], sentenceIds: ['S02'], zh: 'proposal的意思', pos: 'n.' })
    expect(hd.lexicon?.words.some((w) => w.forms.includes('pupils'))).toBe(false) // 词表里有
  })

  it('全部失败时不写 lexicon', async () => {
    const hd = Handout.parse(JSON.parse(JSON.stringify(miniHandout)))
    delete hd.lexicon
    const r = await addLexicon(cfg, hd, async () => {
      throw new Error('断网')
    })
    expect(r.words).toBe(0)
    expect(hd.lexicon).toBeUndefined()
  })
})
