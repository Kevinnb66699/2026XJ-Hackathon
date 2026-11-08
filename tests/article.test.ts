import { mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import { ArticleDraftParagraph, ArticleError, UNSAFE_MESSAGE, buildFromArticle, checkArticle, deriveTitle, findMust, splitArticle, titleByModel, type ArticleInput, type ArticleProgress } from '../pipeline/article'
import { repairLadderL1, type ParagraphInput } from '../pipeline/draft'
import type { GlossFn } from '../pipeline/lexicon'
import type { LlmConfig } from '../pipeline/llm'
import { findForms } from '../pipeline/text-utils'
import { validateHandout } from '../pipeline/validate'

const P1 = 'Cities are planting more trees on busy streets. The shade they give can cool a whole block by several degrees on hot afternoons.'
const P2 = 'Not everyone is pleased. Some shop owners worry that branches will hide their signs, and that falling leaves will block drains in the autumn.'
const P3 = 'Planners say the benefits far outweigh the costs. Trees clean the air, soak up rain and make people want to walk rather than drive.'
const article = `${P1}\n\n${P2}\n\n${P3}`

describe('splitArticle：切段切句', () => {
  it('空行分段，段内换行合并成一个空格，句子编号连续', () => {
    const paras = splitArticle(`  ${P1}\n\n${P2.replace('will hide ', 'will hide\n')}\n   \n\n${P3}\n`)
    expect(paras.map((p) => p.n)).toEqual([1, 2, 3])
    expect(paras.flatMap((p) => p.sentences.map((s) => s.id))).toEqual(['S01', 'S02', 'S03', 'S04', 'S05', 'S06'])
    expect(paras.map((p) => p.sentences.map((s) => s.text).join(' '))).toEqual([P1, P2, P3])
  })

  it('没有空行时按单个换行分段', () => {
    expect(splitArticle(`${P1}\n${P2}\n${P3}`).map((p) => p.sentences.length)).toEqual([2, 2, 2])
  })

  it('缩写不切，引号和括号跟着句子走，数字开头也能切', () => {
    const text = [
      'Mr. Smith moved to the U.S. Government office in 2019. He met Dr. Brown and a few friends, e.g. Paris visitors, there!',
      '"Stop it!" she said. "Why?" He left (quietly). 20 people came. Then John F. Kennedy spoke. “Really?” Yes.',
    ].join('\n\n')
    expect(splitArticle(text).map((p) => p.sentences.map((s) => s.text))).toEqual([
      ['Mr. Smith moved to the U.S. Government office in 2019.', 'He met Dr. Brown and a few friends, e.g. Paris visitors, there!'],
      ['"Stop it!" she said.', '"Why?"', 'He left (quietly).', '20 people came.', 'Then John F. Kennedy spoke.', '“Really?”', 'Yes.'],
    ])
  })

  it('超出限制抛 ArticleError（中文提示）', () => {
    const cases = [
      'Too short.',
      'A cat sat on the mat. '.repeat(400),
      '这是一篇中文文章，并不是英文文章。'.repeat(20),
      Array.from({ length: 13 }, (_, i) => `This is paragraph number ${i + 1} of the text.`).join('\n\n'),
      'Cats sleep a lot. '.repeat(61),
      `${'word '.repeat(90)}end. ${P1}`,
    ]
    for (const c of cases) {
      expect(() => splitArticle(c)).toThrow(ArticleError)
      expect(() => splitArticle(c)).toThrow(/[一-龥]/)
    }
  })
})

// 假的起草：每句都给梯子（带拆开和译文）和原句题；第 2 段 S04 的梯子「谁」不在原句里，S02 的原句题选项重复，
// 第 3 段段意题选项重复，还有一个不存在的词形和一个出处不存在的表达 —— 都应被剔除
function fakeDraft(calls: ParagraphInput[]) {
  return async (p: ParagraphInput): Promise<{ data: ArticleDraftParagraph; model: string }> => {
    calls.push(p)
    const word = (lemma: string, form: string, sentenceIds: string[]) => ({ lemma, forms: [form], sentenceIds, zh: '中文意思', familiarTrap: false, guess: null })
    const extra: Record<number, Pick<ArticleDraftParagraph, 'words' | 'expressions'>> = {
      1: {
        words: [{ ...word('block', 'block', ['S02']), familiarTrap: true, guess: { prompt: 'What does “block” most likely mean here?', options: ['街区', '阻挡'], answer: 0 } }],
        expressions: [{ text: 'on hot afternoons', sentenceId: 'S02', zh: '在炎热的下午', pattern: '' }],
      },
      2: {
        words: [word('pavement', 'pavement', ['S03'])],
        expressions: [
          { text: 'worry that', sentenceId: 'S04', zh: '担心', pattern: '' },
          { text: 'hide signs', sentenceId: 'S99', zh: '挡住招牌', pattern: '' },
        ],
      },
      3: {
        words: [],
        expressions: [
          { text: 'rather than', sentenceId: 'S06', zh: '而不是', pattern: '' },
          { text: 'far outweigh', sentenceId: 'S05', zh: '远远超过', pattern: '' },
        ],
      },
    }
    const must = p.coreVocab.filter((v) => v.term !== 'shade').map((v) => {
      const f = findForms(v.term, p.sentences)
      return { ...word(v.term.toLowerCase().replace(/s$/, ''), f.forms[0], f.sentenceIds), guess: { prompt: `What does “${f.forms[0]}” most likely mean here?`, options: ['对的意思', '错的意思'], answer: 0 } }
    })
    return {
      model: 'fake-model',
      data: {
        gist: { prompt: 'What is this part mainly about?', options: p.n === 3 ? ['Same.', 'Same.', 'Other.'] : [`Point ${p.n}.`, 'Something else.', 'Nothing at all.'], answer: 0 },
        topicSentenceId: p.sentences[0].id,
        gistEn: `The main idea of part ${p.n}.`,
        sentences: p.sentences.map((s) => {
          const w = s.text.split(' ')
          return {
            id: s.id,
            ladder: {
              ...(s.id === 'S04' ? { subject: 'The owners', predicate: 'worry that' } : { subject: w.slice(0, 2).join(' '), predicate: w.slice(2, 4).join(' ') }),
              normalOrder: s.text,
              plain: `In simple words: ${s.text}`,
              glosses: [],
              breakdown: { parts: [{ label: '谁', text: w.slice(0, 2).join(' '), hint: null }, { label: '做了什么', text: ` ${w.slice(2, 4).join(' ')} `, hint: ' 说的是做了什么 ' }], zh: ' 这一句的中文。' },
            },
            question: { prompt: 'What does this sentence tell us?', options: s.id === 'S02' ? ['Same.', 'Same.', 'Other.'] : ['One idea.', 'Another idea.', 'A third idea.'], answer: 0 },
            mainObstacle: 'structure',
            tag: null,
          }
        }),
        words: [...must, ...extra[p.n].words],
        expressions: extra[p.n].expressions,
      },
    }
  }
}

// 不联网：回放模式 + 空缓存目录，自我修正一调用就失败
// 全文词义：问什么答什么，原形就是原文写法
const fakeGloss: GlossFn = async (_p, forms) => ({ data: { words: forms.map((f) => ({ form: f, lemma: f, pos: 'n.', zh: '意思' })) }, model: 'fake-model' })

const llm = (): LlmConfig => ({ baseUrl: 'http://127.0.0.1:9', apiKey: '', model: 'm', cacheDir: mkdtempSync(join(tmpdir(), 'article-')), replay: true, timeoutMs: 1000 })
const input: ArticleInput = { title: 'Street trees', text: article, mustWords: ['outweigh', 'Drains', 'skyscraper', 'shade'], focus: 'opinions about trees' }

describe('buildFromArticle：假起草合成讲义', () => {
  it('合成的讲义通过校验，不合格的产出被剔除，自动挑打卡句', async () => {
    const calls: ParagraphInput[] = []
    const events: ArticleProgress[] = []
    const { handout: h, report } = await buildFromArticle(input, { id: 'up-test1', llm: llm(), draft: fakeDraft(calls), gloss: fakeGloss, onProgress: (p) => events.push(p) })

    expect(validateHandout(h).filter((i) => i.level === 'error')).toEqual([])
    expect(report.errors).toBe(0)
    expect(h).toMatchObject({ id: 'up-test1', title: 'Street trees', rights: '你上传的文章，只供你自己学习使用', writing: { prompt: '用这篇文章学到的表达写 2–3 句：Street trees' } })
    expect(h.sentences.every((s) => s.day === 2 && s.sources.length === 0)).toBe(true)
    expect(h.sentences.map((s) => s.text)).toEqual(splitArticle(article).flatMap((p) => p.sentences.map((s) => s.text)))

    // 必练词：找到的交给模型并标 must，找不到的标 found=false，模型漏掉的写进提醒
    expect(calls.map((c) => c.coreVocab.map((v) => v.term))).toEqual([['shade'], ['Drains'], ['outweigh']])
    expect(report.mustWords).toEqual([
      { term: 'outweigh', found: true },
      { term: 'Drains', found: true },
      { term: 'skyscraper', found: false },
      { term: 'shade', found: true },
    ])
    for (const lemma of ['outweigh', 'drain']) expect(h.words.find((w) => w.lemma === lemma)).toMatchObject({ teacherCore: true, tier: 'must' })
    expect(report.warnings).toContain('必练词「shade」：AI 没给出词义，学生读到时这个词不会加注释')

    // 剔除：S04 梯子（自我修正没有模型可用，失败后剔除）、S02 原句题、第 3 段段意题、不存在的词形。
    // 出处写错（S99）的表达 hide signs 在 S04 认得出，改指过去、保留
    expect(report.repaired).toEqual([])
    // 给老师看的白话（#25）：句子用「第 N 句『开头几个词…』」，不出现 S02 这种编号
    expect(report.dropped.map((d) => d.split('：')[0])).toEqual(['第 2 句「The shade they give can…」的原句题', '第 4 句「Some shop owners worry that…」的梯子', '第 3 段的段意题', '注释词「pavement」'])
    expect(h.expressions.find((e) => e.text === 'hide signs')?.sentenceId).toBe('S04')
    expect(h.sentences.find((s) => s.id === 'S04')!.ladder).toBeUndefined()
    expect(h.paragraphs.map((p) => p.n)).toEqual([1, 2])
    expect(h.expressions.map((e) => e.id)).toEqual(['E01', 'E02', 'E03', 'E04', 'E05'])
    // 写作要求：和必练词 outweigh 对得上的 far outweigh（E05）排第一，其余按文章顺序
    expect(h.writing.requiredExpressionIds).toEqual(['E05', 'E01', 'E02'])

    // 自动打卡句：有梯子和原句题的最长句，每段一句（S02 原句题被剔除，第 1 段换成 S01）
    expect(report.checkIns).toEqual(['S01', 'S03', 'S06'])
    for (const id of report.checkIns) expect(h.sentences.find((s) => s.id === id)).toMatchObject({ checkIn: true, tier: 'must' })
    expect(calls.every((c) => c.sentences.every((s) => !s.checkIn))).toBe(true)

    // 拆开和译文：去掉首尾空白，空的提示不留，来源和梯子一样记 llm；S04 的梯子去掉了，拆开也跟着去掉（不另报）
    expect(h.sentences[0].breakdown).toEqual({
      parts: [{ label: '谁', text: 'Cities are' }, { label: '做了什么', text: 'planting more', hint: '说的是做了什么' }],
      zh: '这一句的中文。',
      provenance: { by: 'llm', model: 'fake-model', promptVersion: 'article-v6' },
    })
    expect(h.sentences.find((s) => s.id === 'S04')!.breakdown).toBeUndefined()
    expect(report).toMatchObject({ paragraphs: 3, sentences: 6, ladders: 5, breakdowns: 5, questions: 5, gists: 2, words: 3, guesses: 3, expressions: 5, model: 'fake-model' })
    expect(events[0]).toMatchObject({ stage: 'split' })
    expect(events.filter((e) => e.stage === 'draft')).toEqual([0, 1, 2, 3].map((done) => ({ stage: 'draft', done, total: 3 })))
    expect(events.slice(-3).map((e) => e.stage)).toEqual(['repair', 'validate', 'done'])

    // 全文词义：词表里有的写法（block、drains、outweigh）不进；AI 没给词义的必练词 shade 在这里有意思
    const lex = h.lexicon!
    expect(lex.provenance).toEqual({ by: 'llm', model: 'fake-model', promptVersion: 'lexicon-v2' })
    expect(report).toMatchObject({ lexicon: lex.words.length, lexiconMissing: 0 })
    expect(lex.words.flatMap((w) => w.forms)).not.toContain('block')
    expect(lex.words.flatMap((w) => w.forms)).not.toContain('drains')
    expect(lex.words.find((w) => w.lemma === 'shade')).toEqual({ lemma: 'shade', forms: ['shade'], sentenceIds: ['S02'], zh: '意思', pos: 'n.' })
    expect(report.warnings.some((w) => w.startsWith('全文词义'))).toBe(false)
    expect(report.lexiconErrors).toBeUndefined()
  })

  it('全文词义没配成不影响生成，给老师一条提醒', async () => {
    const { handout: h, report } = await buildFromArticle(input, {
      id: 'up-test13',
      llm: llm(),
      draft: fakeDraft([]),
      gloss: async () => {
        throw new Error('模型接口返回 502: bad gateway')
      },
    })
    expect(h.lexicon).toBeUndefined()
    expect(report.lexiconErrors).toEqual(['第 1 段：接口返回 502', '第 2 段：接口返回 502', '第 3 段：接口返回 502']) // 后端写日志用
    expect(report).toMatchObject({ lexicon: 0, errors: 0 })
    expect(report.lexiconMissing).toBeGreaterThan(0)
    expect(report.warnings).toContain(`全文词义：有 ${report.lexiconMissing} 个词 AI 这次没配上意思，学生粗读时点了这些词，「生词」里不会出现`)
  })

  it('老师给的打卡句按原文匹配（忽略大小写和多余空白），找不到的写进提醒', async () => {
    const calls: ParagraphInput[] = []
    const checkIns = ['some shop owners WORRY that branches   will hide their signs', 'This line is not in the article']
    const { handout: h, report } = await buildFromArticle({ ...input, checkIns }, { id: 'up-test2', llm: llm(), draft: fakeDraft(calls) })
    expect(report.checkIns).toEqual(['S04'])
    expect(h.sentences.find((s) => s.id === 'S04')).toMatchObject({ checkIn: true, tier: 'must' })
    expect(calls[1].sentences.find((s) => s.id === 'S04')!.checkIn).toBe(true)
    expect(report.warnings).toContain('重点句「This line is not in the article」在原文里没找到，已忽略')
    expect(validateHandout(h).filter((i) => i.level === 'error')).toEqual([])
  })

  it('自我修正成功时保留梯子（修正结果来自缓存，不联网）', async () => {
    const cfg = llm()
    const s04 = splitArticle(article)[1].sentences[1].text
    const key = await repairLadderL1(cfg, s04, { subject: 'The owners', predicate: 'worry that' }).catch((e: Error) => e.message.match(/缓存：(\w+)/)?.[1])
    writeFileSync(join(cfg.cacheDir, `${key}.json`), JSON.stringify({ model: 'fake-model', content: '{"subject":"Some shop owners","predicate":"worry"}' }))
    const { handout: h, report } = await buildFromArticle(input, { id: 'up-test3', llm: cfg, draft: fakeDraft([]) })
    expect(report.repaired).toEqual(['第 4 句「Some shop owners worry that…」：梯子第 1 步「worry that」不是原句原话，已让 AI 重写成「worry」'])
    expect(h.sentences.find((s) => s.id === 'S04')!.ladder!.l1).toEqual({ subject: 'Some shop owners', predicate: 'worry' })
    expect(report.dropped.some((d) => d.startsWith('第 4 句'))).toBe(false)
  })

  it('必练词模型没注释、但放进了表达：用表达的中文补一条注释', async () => {
    const base = fakeDraft([])
    const draft = async (p: ParagraphInput) => {
      const r = await base(p)
      r.data.words = r.data.words.filter((w) => w.lemma !== 'rather than') // 模型只把它放进了表达
      return r
    }
    const { handout: h, report } = await buildFromArticle({ ...input, mustWords: ['rather than'] }, { id: 'up-test5', llm: llm(), draft })
    expect(h.words.find((w) => w.lemma === 'rather than')).toMatchObject({ zh: '而不是', teacherCore: true, tier: 'must' })
    expect(report.warnings.some((w) => w.includes('rather than'))).toBe(false)
    expect(validateHandout(h).filter((i) => i.level === 'error')).toEqual([])
  })

  it('没填标题：请模型起一个英文标题（#26；模型结果来自缓存，不联网），写作题目跟着用；不合格就用原文第一句', async () => {
    const cfg = llm()
    const key = await titleByModel(cfg, article).catch((e: Error) => e.message.match(/缓存：(\w+)/)?.[1])
    const reply = (title: string) => writeFileSync(join(cfg.cacheDir, `${key}.json`), JSON.stringify({ model: 'fake-model', content: JSON.stringify({ title }) }))
    reply(' Why Cities Want More Street Trees ')
    const { handout: h } = await buildFromArticle({ ...input, title: '' }, { id: 'up-test10', llm: cfg, draft: fakeDraft([]) })
    expect(h.title).toBe('Why Cities Want More Street Trees')
    expect(h.writing.prompt).toBe('用这篇文章学到的表达写 2–3 句：Why Cities Want More Street Trees')
    reply("Shop Owners' Worries About Trees") // 撇号可以
    expect((await buildFromArticle({ ...input, title: '' }, { id: 'up-test12', llm: cfg, draft: fakeDraft([]) })).handout.title).toBe("Shop Owners' Worries About Trees")
    for (const bad of ['城市街道种树之争', '"Street Trees"', '“Street Trees”', 'Trees', 'Street Trees 城市种树', 'Street\nTrees', 'A Very Long Title About Why Cities Are Planting So Many More Trees On Busy Streets Today', '']) {
      reply(bad)
      const { handout: w } = await buildFromArticle({ ...input, title: '' }, { id: 'up-test11', llm: cfg, draft: fakeDraft([]) })
      expect(w.title, bad).toBe('Cities are planting more trees on busy streets.')
    }
  })

  it('没填标题、模型起不出来（这里是回放模式没有缓存）：用原文第一句当标题，写作题目跟着用', async () => {
    const { handout: h } = await buildFromArticle({ ...input, title: ' ' }, { id: 'up-test8', llm: llm(), draft: fakeDraft([]) })
    expect(h.title).toBe('Cities are planting more trees on busy streets.')
    expect(h.writing.prompt).toBe('用这篇文章学到的表达写 2–3 句：Cities are planting more trees on busy streets.')
    const wrapped = article.replace('on busy', 'on\nbusy')
    const { handout: w } = await buildFromArticle({ ...input, title: '', text: wrapped }, { id: 'up-test9', llm: llm(), draft: fakeDraft([]) })
    expect(w.title).toBe('Cities are planting more trees on busy streets.')
  })

  it('输入超出限制抛 ArticleError', async () => {
    const opts = { id: 'up-test4', llm: llm(), draft: fakeDraft([]) }
    await expect(buildFromArticle({ ...input, mustWords: Array.from({ length: 21 }, (_, i) => `w${i}`) }, opts)).rejects.toThrow(ArticleError)
    await expect(buildFromArticle({ ...input, checkIns: Array(9).fill('Trees clean the air') }, opts)).rejects.toThrow(ArticleError)
    await expect(buildFromArticle({ ...input, text: 'Too short.' }, opts)).rejects.toThrow(ArticleError)
  })
})

describe('deriveTitle：没填标题时的标题', () => {
  it('第一段的第一句（分段同 splitArticle）；跳过开头的空行；单独一行的标题整行用', () => {
    expect(deriveTitle(article)).toBe('Cities are planting more trees on busy streets.')
    expect(deriveTitle(`\n  \r\n\t\n   ${P2}`)).toBe('Not everyone is pleased.')
    expect(deriveTitle(`Why Cities Want More Trees\n${P1}`)).toBe('Why Cities Want More Trees')
    expect(deriveTitle(`Why Cities Want More Trees\n\n${P1}`)).toBe('Why Cities Want More Trees')
    // 硬换行粘贴的段落：第一句跨行，不能只取第一行的半句
    const wrapped = `Cities are planting more trees on\r\nbusy streets. The shade they give can cool\na whole block.\n\n${P2}`
    expect(deriveTitle(wrapped)).toBe('Cities are planting more trees on busy streets.')
    expect(deriveTitle(wrapped)).toBe(splitArticle(wrapped)[0].sentences[0].text)
    expect(deriveTitle('Mr. Lee planted a tree. It grew.')).toBe('Mr. Lee planted a tree.') // 缩写不切
  })

  it('弯引号：跟着句子走，引号里的问号、感叹号后面接小写不切', () => {
    expect(deriveTitle('“Stop it!” she said. Then she left.')).toBe('“Stop it!” she said.')
    expect(deriveTitle('He said “Go home.” Then he left.')).toBe('He said “Go home.”')
  })

  it('第一句超过 60 个字符：在词的边界截断加「…」，一共不超过 60 个字符', () => {
    const t = deriveTitle(P2.replace('Not everyone is pleased. ', ''))
    expect(t).toBe('Some shop owners worry that branches will hide their signs…')
    expect(t.length).toBeLessThanOrEqual(60)
    expect(deriveTitle(`${'Wordy, '.repeat(9)}end.`)).toBe(`${'Wordy, '.repeat(7)}Wordy…`) // 截断处的逗号去掉
    expect(deriveTitle('x'.repeat(80))).toBe(`${'x'.repeat(59)}…`) // 没有空格就硬切
  })
})

describe('上线前审查修的问题', () => {
  it('必练词按整词和变形匹配，不按词头前缀猜；末尾的 sth 不算进写法', () => {
    const sents = splitArticle(article).flatMap((p) => p.sentences)
    expect(findMust('plant', sents)).toEqual({ forms: ['planting'], sentenceIds: ['S01'] })
    expect(findMust('far outweigh', sents)).toEqual({ forms: ['far outweigh'], sentenceIds: ['S05'] })
    expect(findMust('rai', sents)).toEqual({ forms: [], sentenceIds: [] }) // 不会对上 rain
    expect(findMust('block sth', sents)).toEqual({ forms: ['block'], sentenceIds: ['S02', 'S04'] })
  })

  it('一长串句点或省略号直接拒绝（防止正则回溯卡死）', () => {
    expect(() => splitArticle(`${P1} Teens must make sense of${'…'.repeat(10)}\n\n${P2}\n\n${P3}`)).toThrow(/一长串标点/)
  })

  it('原形以 guess 结尾的词出错时按整词剔除，上传不会失败', async () => {
    const base = fakeDraft([])
    const draft = async (p: ParagraphInput) => {
      const r = await base(p)
      if (p.n === 1) r.data.words.push({ lemma: 'best guess', forms: ['nowhere'], sentenceIds: ['S01'], zh: '最好的猜测', familiarTrap: false, guess: null })
      return r
    }
    const { report } = await buildFromArticle(input, { id: 'up-test6', llm: llm(), draft })
    expect(report.dropped).toContain('注释词「best guess」：和原文里的写法对不上，已去掉')
  })
})

describe('表达和标签的自动整理', () => {
  it('表达在出处句认不出时改指能认出的句子，哪句都认不出就去掉；没有原句题的句子去掉结构标签', async () => {
    const base = fakeDraft([])
    const draft = async (p: ParagraphInput) => {
      const r = await base(p)
      if (p.n === 1) {
        r.data.expressions.push({ text: 'drive', sentenceId: 'S01', zh: '开车', pattern: '' }) // 在第 3 段 S06
        r.data.expressions.push({ text: 'fly a kite', sentenceId: 'S01', zh: '放风筝', pattern: '' }) // 原文没有
        r.data.sentences[0].question = null
        r.data.sentences[0].tag = 'inversion'
      }
      return r
    }
    const { handout: h, report } = await buildFromArticle(input, { id: 'up-test7', llm: llm(), draft })
    expect(h.expressions.find((e) => e.text === 'drive')?.sentenceId).toBe('S06')
    expect(h.expressions.some((e) => e.text === 'fly a kite')).toBe(false)
    expect(report.dropped).toContain('表达「fly a kite」：原文里没有这个说法（AI 写的），已去掉')
    expect(h.sentences[0].tag).toBeUndefined()
    expect(report.warnings.filter((w) => /^(sentence|paragraph|word|expression) |S\d\d/.test(w))).toEqual([]) // 没有校验器的技术提醒、句子编号
  })
})

describe('梯子新第 2、3 步（拆开 + 译文）', () => {
  // 在假起草的基础上改某几句的拆开
  const withBreakdowns = (edit: (id: string, l: NonNullable<ArticleDraftParagraph['sentences'][number]['ladder']>) => void) => {
    const base = fakeDraft([])
    return async (p: ParagraphInput) => {
      const r = await base(p)
      for (const x of r.data.sentences) if (x.ladder) edit(x.id, x.ladder)
      return r
    }
  }

  it('拆开不合格（不是原句原话、标签不对、有术语、译文空）只去掉拆开，梯子和原句题还在，报告里说清楚', async () => {
    const draft = withBreakdowns((id, l) => {
      if (id === 'S01') l.breakdown!.parts[0].text = 'Cities plant'
      if (id === 'S03') l.breakdown!.parts[1].label = '主干'
      if (id === 'S05') l.breakdown!.parts[1].hint = '这是状语'
      if (id === 'S06') l.breakdown!.zh = ' '
    })
    const { handout: h, report } = await buildFromArticle(input, { id: 'up-bd1', llm: llm(), draft })
    expect(validateHandout(h).filter((i) => i.level === 'error')).toEqual([])
    for (const id of ['S01', 'S03', 'S05', 'S06']) {
      const s = h.sentences.find((x) => x.id === id)!
      expect(s.breakdown, id).toBeUndefined()
      expect(s.ladder, id).toBeDefined()
      expect(s.question, id).toBeDefined()
    }
    expect(h.sentences.find((x) => x.id === 'S02')!.breakdown).toBeDefined()
    const tail = '，已去掉（梯子还在，第 2、3 步改用正常语序和简单英文）'
    expect(report.dropped).toEqual(
      expect.arrayContaining([
        `第 1 句「Cities are planting more trees…」的拆开和译文：第 2 步拆开的一块不是原句原话${tail}`,
        `第 3 句「Not everyone is pleased.」的拆开和译文：第 2 步用了不认识的标签「主干」${tail}`,
        `第 5 句「Planners say the benefits far…」的拆开和译文：用了语法术语「状语」${tail}`,
        `第 6 句「Trees clean the air, soak…」的拆开和译文：第 3 步的译文是空的${tail}`,
      ]),
    )
    expect(report.breakdowns).toBe(1) // S02；S04 的梯子去掉了
    expect(report.ladders).toBe(5)
  })

  it('模型没写拆开、或写的格式不对（超过 8 块、缺译文）：梯子照样留着，第 2、3 步用旧版，提醒里写一句（梯子被去掉的不写）', async () => {
    const draft = withBreakdowns((id, l) => {
      if (id === 'S01' || id === 'S04') l.breakdown = null // S04 的梯子「谁」不在原句里，整架梯子会被去掉
      if (id === 'S02') l.breakdown = { parts: Array(9).fill({ label: '谁', text: 'The', hint: null }), zh: '中文' }
      if (id === 'S03') delete (l.breakdown as Partial<NonNullable<typeof l.breakdown>>).zh
    })
    // 走真正的 zod 解析：格式不对的拆开当没写，不让整段失败
    const parsed = (p: ParagraphInput) => draft(p).then((r) => ({ ...r, data: ArticleDraftParagraph.parse(JSON.parse(JSON.stringify(r.data))) }))
    const { handout: h, report } = await buildFromArticle(input, { id: 'up-bd2', llm: llm(), draft: parsed })
    for (const id of ['S01', 'S02', 'S03']) expect(h.sentences.find((x) => x.id === id)!, id).toMatchObject({ ladder: expect.any(Object), breakdown: undefined })
    expect(report.dropped.filter((d) => d.includes('拆开'))).toEqual([]) // 没写不算「去掉和原文对不上的」
    expect(report.dropped.some((d) => d.startsWith('第 4 句') && d.includes('的梯子'))).toBe(true)
    expect(report.warnings.filter((d) => d.includes('AI 没写好'))).toEqual([
      '第 1 句「Cities are planting more trees…」的拆开和译文：AI 没写好，第 2、3 步改用正常语序和简单英文',
      '第 2 句「The shade they give can…」的拆开和译文：AI 没写好，第 2、3 步改用正常语序和简单英文',
      '第 3 句「Not everyone is pleased.」的拆开和译文：AI 没写好，第 2、3 步改用正常语序和简单英文',
    ])
    expect(report.breakdowns).toBe(2) // S05、S06
    expect(validateHandout(h).filter((i) => i.level === 'error')).toEqual([])
  })

  it('标签里的点写成「・」「/」、弯撇号写成直的：按标签表和原句改回来，拆开照样留着', async () => {
    const text = article.replace('Not everyone is pleased.', 'Not everyone’s pleased.')
    const draft = withBreakdowns((id, l) => {
      if (id === 'S01') l.breakdown!.parts[1].label = '对谁・对什么'
      if (id === 'S02') l.breakdown!.parts[1].label = ' 对谁 / 对什么 '
      if (id === 'S03') l.breakdown!.parts[0].text = "Not everyone's"
    })
    const { handout: h, report } = await buildFromArticle({ ...input, text }, { id: 'up-bd3', llm: llm(), draft })
    expect(report.dropped.filter((d) => d.includes('拆开'))).toEqual([])
    expect(h.sentences[0].breakdown!.parts[1].label).toBe('对谁·对什么')
    expect(h.sentences[1].breakdown!.parts[1].label).toBe('对谁·对什么')
    expect(h.sentences[2].breakdown!.parts[0].text).toBe('Not everyone’s')
    expect(validateHandout(h).filter((i) => i.level === 'error')).toEqual([])
  })
})

// 学生上传的内容检查（checkArticle）：样本都是为测试新写的短文，不是真题、真外刊。正常文章要能过（含新闻里的数字和人名、对话、
// 编号列表、Plan B / vitamin C 这类单个大写字母、@ 账号名），法语、拼音、试卷、带手机号、同一句重复的拒收，原因写在 reason 里
describe('checkArticle：学生上传的内容检查', () => {
  const twice = (t: string) => `${t}\n\n${t.split(' ').reverse().join(' ')}` // 凑够 200 个字符，又不让同一句出现两次以上
  const reject = (text: string) => {
    try {
      checkArticle(text)
    } catch (err) {
      expect(err).toBeInstanceOf(ArticleError)
      expect((err as ArticleError).message).toMatch(/[一-龥]/)
      return (err as ArticleError).reason
    }
    return null
  }
  const ok = {
    trees: article,
    news: 'NAIROBI, Kenya — Officials said on Tuesday that 1,200 households had been moved after heavy rains flooded parts of the capital.\n\nThe Kenya Red Cross reported that roads to three districts remained closed, and schools in Mathare, Kibera and Mukuru would stay shut until Friday, when engineers expect the water to go down.',
    story: '"Wait," Mia said, grabbing her brother\'s sleeve. "Did you hear that?" Tom shook his head. Rain hammered the windows.\n\nSomewhere downstairs, a door creaked open, and then slowly, very slowly, it closed again. "No," Tom said. "No." "No." Nobody moved for a long time after that.',
    science: 'Researchers analysed brain scans from 4,000 volunteers aged 18 to 80. Participants who reported sleeping fewer than six hours showed measurable differences in regions linked to memory and attention, though the authors cautioned that the study shows correlation, not causation, and that more work is needed.',
    listicle: 'Three habits can make mornings easier.\n\n1. Go to bed at the same time every night. Your body learns the rhythm, and getting up stops feeling like a fight.\n\n2. Put the phone in another room. A screen at midnight keeps the brain busy long after you stop.\n\n3. Eat something before you leave. Even a banana helps.',
    letters: 'When the bus broke down, the class needed a Plan B. Their teacher suggested walking, but the museum was far away. Someone joked about vitamin C. and fresh air. In the end they took the train to Washington, D.C. and the trip turned out faster than the bus would have been.',
    handle: 'The museum posted the news on its account @citymuseum on Monday, and within hours thousands of people had shared it. Staff said they had never seen so much interest in a single painting, which had been hidden in storage for years before a student found it.',
  }
  it('正常的英文文章能过', () => {
    for (const [k, t] of Object.entries(ok)) expect(reject(t), k).toBeNull()
    // 老师上传不做内容检查：同一句重复 5 遍的照样能切（server-upload.test.ts 里老师上传的样本就是这样）
    const same = 'Many schools are toying with the idea of banning phones in class. '.repeat(5).trim()
    expect(splitArticle(same)).toHaveLength(1)
    expect(reject(same)).toBe('repeated')
  })

  it('不像英文：法语、西班牙语、德语、拼音（带不带声调）、中文都拒收（英文功能词不到一成半）', () => {
    const samples = [
      twice("Le matin, les enfants vont à l'école en vélo. Ils traversent le parc où les arbres sont encore couverts de rosée. La ville a décidé de construire de nouvelles pistes cyclables."),
      twice('Cada mañana, los estudiantes llegan a la escuela en autobús. El viaje dura casi una hora porque la carretera está en malas condiciones. Los padres piden ayuda.'),
      twice('Jeden Morgen fahren die Kinder mit dem Fahrrad zur Schule. Die Stadt will neue Radwege bauen, damit die Schüler sicher unterwegs sind. Viele Eltern finden das gut.'),
      'Wo men de xue xiao hen da, you hen duo shu he hua. Mei tian zao shang, tong xue men dou zai cao chang shang pao bu. Lao shi shuo, duan lian shen ti dui xue xi hen you bang zhu. Wo xi huan he peng you yi qi da lan qiu, ta men ye hen xi huan yun dong.',
      twice('Wǒmen de xuéxiào hěn dà, yǒu hěn duō shù hé huā. Měitiān zǎoshang, tóngxuémen dōu zài cāochǎng shàng pǎobù, lǎoshī shuō duànliàn shēntǐ hěn hǎo.'),
      '这是一篇中文文章，并不是英文文章。'.repeat(20),
    ]
    for (const t of samples) expect(reject(t), t.slice(0, 30)).toBe('not_english')
  })

  it('像试卷：一行一个选项、一行里 A–D 选项、填空横线、中文题型说明、连着的题号问句；一行一个选项、段数超过 12 的也认成试卷，不报段落太多', () => {
    const passage = 'Most teenagers like to sleep late, and scientists now think this is natural rather than lazy, because the body clock moves later during these years.'
    const samples = [
      `${passage}\n21. Why do teenagers sleep late according to the passage?\nA. They are lazy.\nB. Their body clocks change.\nC. They use phones at night.\nD. Schools start too late.\n22. What does the word "moves" mean?\nA. goes\nB. stops\nC. breaks\nD. hides\n23. Which is true?\nA. One.\nB. Two.\nC. Three.\nD. Four.`,
      `${passage}\n\n1. Teenagers sleep late because ____. A. they are lazy B. their clocks shift C. they play games D. they are ill\n\n2. The word "moves" means ____. A. goes B. stops C. breaks D. hides`,
      `Every morning Tom ___1___ to school by bike. He ___2___ the park where old trees ___3___ the road. One day he ___4___ a small dog under a bench, and he decided to take it home with him after school that afternoon.`,
      `第二部分 阅读理解（共两节，满分50分）\n\n${passage} It is hard to change it with willpower alone, the scientists said.`,
      `${passage}\n\n${passage.replace('Most', 'Many')}\n\n1. Why do teenagers sleep late?\n2. What do scientists think now?\n3. How does the body clock change?`,
      `Read the following passage and choose the best answer. ${passage} ${passage.replace('Most', 'Many')}`,
    ]
    for (const t of samples) expect(reject(t), t.slice(0, 40)).toBe('exam')
    expect(() => splitArticle(samples[0])).toThrow(/段落太多/) // 第一个样本按格式查会是段落太多
  })

  it('有手机号、身份证号、邮箱的拒收（都是假的）', () => {
    const club = (contact: string) => `If you want to join the reading club, send a message to ${contact} before Friday. The club meets every Thursday after school in the library, and new members are always welcome to bring a book they love.`
    for (const contact of ['13800000000', '138 0000 0000', '138-0000-0000', '010-12345678', '(555) 010-0000', 'reading.club@example.com']) expect(reject(club(contact)), contact).toBe('personal_info')
    expect(reject(club('the card number 123456200901010000'))).toBe('personal_info')
    expect(reject(club('the card number 12345620090101000X'))).toBe('personal_info')
    // 全角数字、全角＠（中文输入法全角状态下打的）、点号分隔的手机号也认得出
    for (const contact of ['电话 １３８００００００００', '１３８－００００－００００', '138.0000.0000', 'reading.club＠example.com', 'reading.club@example．com']) expect(reject(club(contact)), contact).toBe('personal_info')
    expect(reject(club('the card number １２３４５６２００９０１０１０００Ｘ'))).toBe('personal_info')
    // 年份、带逗号的大数、@ 账号名不算
    expect(reject(club('the club captain (born 2009, member since 2021, one of 1,300 members)'))).toBeNull()
    expect(reject(club('the club captain (the club has 13.5 members per class, up 2.4 points)'))).toBeNull()
  })

  it('同一句（去掉标点、大小写）出现 3 次以上拒收；5 个词以下的短句不算；出现 2 次的不算', () => {
    const tail = 'Reading helps us understand other people and the world around us, and it is one of the cheapest ways to travel.'
    expect(reject(`${'We should all read more books every day. '.repeat(3)}${tail}`)).toBe('repeated')
    expect(reject(`We should all read more books every day. We should ALL read more books, every day! "We should all read more books every day." ${tail}`)).toBe('repeated')
    expect(reject(`${'We should all read more books every day. '.repeat(2)}${tail} ${tail.replace('Reading', 'Writing')}`)).toBeNull()
    expect(reject(`${'Yes. '.repeat(6)}${tail} ${tail.replace('Reading', 'Writing')}`)).toBeNull()
  })

  it('篇幅和格式的问题照 splitArticle 拒收，原因是 length', () => {
    expect(reject('Too short.')).toBe('length')
    expect(reject('A cat sat on the mat. '.repeat(400))).toBe('length')
    expect(reject(Array.from({ length: 13 }, (_, i) => `This is paragraph number ${i + 1} of the text, and it is about cats.`).join('\n\n'))).toBe('length')
    expect(reject(`${P1} Teens must make sense of${'…'.repeat(10)}\n\n${P2}\n\n${P3}`)).toBe('length')
  })
})

// 百炼的内容安全拦截：HTTP 400，错误码 data_inspection_failed（pipeline/llm.ts 报错时带「模型接口返回 400: 响应前 300 字」）
describe('内容安全拦截', () => {
  const BLOCKED = '模型接口返回 400: {"error":{"code":"data_inspection_failed","param":null,"message":"Input data may contain inappropriate content.","type":"data_inspection_failed"},"request_id":"test"}'
  const unsafe = { name: 'ArticleError', reason: 'unsafe', message: UNSAFE_MESSAGE }

  it('起草被拦截：整篇不生成，抛 ArticleError（reason unsafe、专门的提示）；被拦截的段不再试', async () => {
    let n = 0
    const draft = async () => {
      n++
      throw new Error(BLOCKED)
    }
    const err = await buildFromArticle(input, { id: 'up-unsafe1', llm: llm(), draft, gloss: fakeGloss }).catch((e) => e)
    expect(err).toBeInstanceOf(ArticleError)
    expect(err).toMatchObject(unsafe)
    expect(UNSAFE_MESSAGE).toBe('这篇文章里有不适合在这里读的内容，换一篇吧')
    expect(n).toBe(3) // 3 段各一次
  })

  it('起草都成了、全文词义被拦截：照样按拦截处理', async () => {
    const gloss: GlossFn = async () => {
      throw new Error(BLOCKED.replace('Input', 'Output'))
    }
    await expect(buildFromArticle(input, { id: 'up-unsafe2', llm: llm(), draft: fakeDraft([]), gloss })).rejects.toMatchObject(unsafe)
  })

  it('别的 400（参数不对）不是拦截：照旧再试一次，失败是普通的错误（后端给通用提示）', async () => {
    let n = 0
    const draft = async () => {
      n++
      throw new Error('模型接口返回 400: {"error":{"code":"invalid_parameter_error"}}')
    }
    const err = await buildFromArticle(input, { id: 'up-unsafe3', llm: llm(), draft, gloss: fakeGloss }).catch((e) => e)
    expect(err).not.toBeInstanceOf(ArticleError)
    expect(err.message).toMatch(/^起草失败/)
    expect(n).toBe(6)
  })
})
