import { mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import { ArticleError, buildFromArticle, deriveTitle, findMust, splitArticle, type ArticleInput, type ArticleProgress } from '../pipeline/article'
import { repairLadderL1, type DraftParagraph, type ParagraphInput } from '../pipeline/draft'
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

// 假的起草：每句都给梯子和原句题；第 2 段 S04 的梯子「谁」不在原句里，S02 的原句题选项重复，
// 第 3 段段意题选项重复，还有一个不存在的词形和一个出处不存在的表达 —— 都应被剔除
function fakeDraft(calls: ParagraphInput[]) {
  return async (p: ParagraphInput): Promise<{ data: DraftParagraph; model: string }> => {
    calls.push(p)
    const word = (lemma: string, form: string, sentenceIds: string[]) => ({ lemma, forms: [form], sentenceIds, zh: '中文意思', familiarTrap: false, guess: null })
    const extra: Record<number, Pick<DraftParagraph, 'words' | 'expressions'>> = {
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
const llm = (): LlmConfig => ({ baseUrl: 'http://127.0.0.1:9', apiKey: '', model: 'm', fallbacks: [], cacheDir: mkdtempSync(join(tmpdir(), 'article-')), replay: true, timeoutMs: 1000 })
const input: ArticleInput = { title: 'Street trees', text: article, mustWords: ['outweigh', 'Drains', 'skyscraper', 'shade'], focus: 'opinions about trees' }

describe('buildFromArticle：假起草合成讲义', () => {
  it('合成的讲义通过校验，不合格的产出被剔除，自动挑打卡句', async () => {
    const calls: ParagraphInput[] = []
    const events: ArticleProgress[] = []
    const { handout: h, report } = await buildFromArticle(input, { id: 'up-test1', llm: llm(), draft: fakeDraft(calls), onProgress: (p) => events.push(p) })

    expect(validateHandout(h).filter((i) => i.level === 'error')).toEqual([])
    expect(report.errors).toBe(0)
    expect(h).toMatchObject({ id: 'up-test1', title: 'Street trees', rights: '老师上传的文章，仅供本班学习使用', writing: { prompt: '用这篇文章学到的表达写 2–3 句：Street trees' } })
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
    expect(report.warnings).toContain('必练词「shade」模型没有给出注释')

    // 剔除：S04 梯子（自我修正没有模型可用，失败后剔除）、S02 原句题、第 3 段段意题、不存在的词形。
    // 出处写错（S99）的表达 hide signs 在 S04 认得出，改指过去、保留
    expect(report.repaired).toEqual([])
    expect(report.dropped.map((d) => d.split('：')[0])).toEqual(['S02 原句题', 'S04 梯子', '第 3 段段意题', '词 pavement'])
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

    expect(report).toMatchObject({ paragraphs: 3, sentences: 6, ladders: 5, questions: 5, gists: 2, words: 3, guesses: 3, expressions: 5, model: 'fake-model' })
    expect(events[0]).toMatchObject({ stage: 'split' })
    expect(events.filter((e) => e.stage === 'draft')).toEqual([0, 1, 2, 3].map((done) => ({ stage: 'draft', done, total: 3 })))
    expect(events.slice(-3).map((e) => e.stage)).toEqual(['repair', 'validate', 'done'])
  })

  it('老师给的打卡句按原文匹配（忽略大小写和多余空白），找不到的写进提醒', async () => {
    const calls: ParagraphInput[] = []
    const checkIns = ['some shop owners WORRY that branches   will hide their signs', 'This line is not in the article']
    const { handout: h, report } = await buildFromArticle({ ...input, checkIns }, { id: 'up-test2', llm: llm(), draft: fakeDraft(calls) })
    expect(report.checkIns).toEqual(['S04'])
    expect(h.sentences.find((s) => s.id === 'S04')).toMatchObject({ checkIn: true, tier: 'must' })
    expect(calls[1].sentences.find((s) => s.id === 'S04')!.checkIn).toBe(true)
    expect(report.warnings).toContain('打卡句没在原文里找到：「This line is not in the article」')
    expect(validateHandout(h).filter((i) => i.level === 'error')).toEqual([])
  })

  it('自我修正成功时保留梯子（修正结果来自缓存，不联网）', async () => {
    const cfg = llm()
    const s04 = splitArticle(article)[1].sentences[1].text
    const key = await repairLadderL1(cfg, s04, { subject: 'The owners', predicate: 'worry that' }).catch((e: Error) => e.message.match(/缓存：(\w+)/)?.[1])
    writeFileSync(join(cfg.cacheDir, `${key}.json`), JSON.stringify({ model: 'fake-model', content: '{"subject":"Some shop owners","predicate":"worry"}' }))
    const { handout: h, report } = await buildFromArticle(input, { id: 'up-test3', llm: cfg, draft: fakeDraft([]) })
    expect(report.repaired).toEqual(['S04：worry that → worry'])
    expect(h.sentences.find((s) => s.id === 'S04')!.ladder!.l1).toEqual({ subject: 'Some shop owners', predicate: 'worry' })
    expect(report.dropped.some((d) => d.startsWith('S04'))).toBe(false)
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

  it('没填标题：用原文第一句当标题，写作题目跟着用', async () => {
    const { handout: h } = await buildFromArticle({ ...input, title: ' ' }, { id: 'up-test8', llm: llm(), draft: fakeDraft([]) })
    expect(h.title).toBe('Cities are planting more trees on busy streets.')
    expect(h.writing.prompt).toBe('用这篇文章学到的表达写 2–3 句：Cities are planting more trees on busy streets.')
  })

  it('输入超出限制抛 ArticleError', async () => {
    const opts = { id: 'up-test4', llm: llm(), draft: fakeDraft([]) }
    await expect(buildFromArticle({ ...input, mustWords: Array.from({ length: 21 }, (_, i) => `w${i}`) }, opts)).rejects.toThrow(ArticleError)
    await expect(buildFromArticle({ ...input, checkIns: Array(9).fill('Trees clean the air') }, opts)).rejects.toThrow(ArticleError)
    await expect(buildFromArticle({ ...input, text: 'Too short.' }, opts)).rejects.toThrow(ArticleError)
  })
})

describe('deriveTitle：没填标题时的标题', () => {
  it('第一个非空行的第一句；跳过开头的空行；单独一行的标题整行用', () => {
    expect(deriveTitle(article)).toBe('Cities are planting more trees on busy streets.')
    expect(deriveTitle(`\n  \r\n\t\n   ${P2}`)).toBe('Not everyone is pleased.')
    expect(deriveTitle(`Why Cities Want More Trees\n${P1}`)).toBe('Why Cities Want More Trees')
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
    expect(report.dropped).toContain('词 best guess：词形 nowhere 不在句子 S01 里')
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
    expect(report.dropped).toContain('表达「fly a kite」：原文里找不到对应的写法')
    expect(h.sentences[0].tag).toBeUndefined()
    expect(report.warnings.filter((w) => w.startsWith('['))).toEqual([]) // 没有校验器的技术提醒
  })
})
