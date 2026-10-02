import { readdirSync, readFileSync, statSync } from 'fs'
import { join } from 'path'
import { fileURLToPath } from 'url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import socialMedia from '../data/handouts/social-media.json'
import { Handout, type LearningEvent } from '../shared/schema'
import { GRAMMAR_TERMS } from '../pipeline/validate'
import { personalize, emptyState } from '../src/engine'
import { flush, pendingCount, sendEvent } from '../src/lib/events'
import { annotate, findAll, lemmaIndex, markWords, noteQuote, sameWording, segment, tokenize } from '../src/lib/text'
import { checkWriting, safeReason } from '../src/lib/writing'
import { miniHandout as h } from './fixtures/mini-handout'

const join_ = (parts: { text: string }[]) => parts.map((p) => p.text).join('')

describe('原文切分：拼回去与原文逐字一致', () => {
  it('tokenize：每个英文单词单独成块', () => {
    for (const x of h.sentences) expect(join_(tokenize(x.text))).toBe(x.text)
    expect(tokenize("Teachers don’t fret; pupils' phones.").filter((t) => t.word).map((t) => t.text)).toEqual(['Teachers', 'don’t', 'fret', 'pupils', 'phones'])
  })

  it('segment：注释词 + 可跳过词，整句切或按梯子批注一块一块地切', () => {
    const v = personalize(h, { ...emptyState('x'), tappedWords: h.words.map((w) => w.lemma) })
    for (const sv of v.sentences) {
      const x = h.sentences.find((y) => y.id === sv.id)!
      const marks = markWords(sv.text, sv.glosses, 'gloss')
      expect(join_(segment(sv.text, marks))).toBe(x.text)
      const chunks = annotate(sv.text, x.ladder ? [{ text: x.ladder.l1.subject }, { text: x.ladder.l1.predicate }] : [])
      expect(chunks.map((c) => join_(segment(sv.text, marks, c.start, c.end))).join('')).toBe(x.text)
    }
    // 跨块的标记切成两段，各自还带着标记
    const m = { start: 0, end: 7, kind: 'gloss' as const, lemma: 'abc def' }
    expect(segment('abc def!', [m], 2, 5)).toEqual([{ text: 'c d', mark: m }])
    expect(segment('abc def!', [m], 5, 8)).toEqual([{ text: 'ef', mark: m }, { text: '!', mark: undefined }])
  })

  it('findAll 整词、不区分大小写', () => {
    expect(findAll('Pupils and pupil, pupillage', 'pupil')).toEqual([[11, 16]])
    expect(findAll('Pupils and pupil', 'pupils')).toEqual([[0, 6]])
    expect(findAll('abc', '')).toEqual([])
  })

  it('梯子第 1 步在原句上标出「谁」「做了什么」两段子串', () => {
    const x = h.sentences.find((y) => y.id === 'S03')!
    const chunks = annotate(x.text, [{ label: '谁', text: x.ladder!.l1.subject }, { label: '做了什么', text: x.ladder!.l1.predicate }])
    expect(chunks.filter((c) => c.part).map((c) => [c.part!.label, c.text])).toEqual([['谁', 'a blanket ban'], ['做了什么', 'may prove']])
  })
})

describe('annotate：梯子批注把各块放回原句', () => {
  const text = 'Kids barred from sites could flock to obscure ones, and fall victim there.'
  const labels = (parts: { label: string; text: string }[]) =>
    annotate(text, parts).map((c) => (c.part ? `[${c.part.label}]${c.text}` : c.text))

  it('按在原句里的位置排，没盖住的原文夹在中间，拼回去逐字一致', () => {
    const parts = [
      { label: '谁', text: 'Kids barred from sites' },
      { label: '做了什么', text: 'could flock to obscure ones' },
      { label: '怎么样', text: 'fall victim there' },
    ]
    expect(labels([parts[2], parts[0], parts[1]])).toEqual(['[谁]Kids barred from sites', ' ', '[做了什么]could flock to obscure ones', ', and ', '[怎么样]fall victim there', '.'])
    const chunks = annotate(text, parts)
    expect(join_(chunks)).toBe(text)
    for (const c of chunks) expect(text.slice(c.start, c.end)).toBe(c.text)
    expect(annotate(text, [])).toEqual([{ text, start: 0, end: text.length }])
  })

  it('和已放好的块重叠的跳过，先列的优先', () => {
    expect(labels([{ label: '谁', text: 'Kids barred' }, { label: '补充说明', text: 'barred from sites' }, { label: '为什么', text: 'nowhere' }])).toEqual(['[谁]Kids barred', ' from sites could flock to obscure ones, and fall victim there.'])
  })

  it('优先放在整词的位置：it 不落在 With 中间；没有整词的位置才退回任意位置', () => {
    const t = 'With prices up, it is hard.'
    expect(annotate(t, [{ label: '谁', text: 'it' }]).find((c) => c.part)!.start).toBe(16)
    expect(annotate('Withit', [{ label: '谁', text: 'it' }]).find((c) => c.part)!.start).toBe(1)
  })

  it('一块在原句里出现多次时，取不和已放好的块重叠的那一处', () => {
    const t = 'They said they would, and they did.'
    const out = annotate(t, [{ label: '谁', text: 'they would' }, { label: '补充说明', text: 'they' }])
    expect(out.map((c) => [c.part?.label ?? '', c.text])).toEqual([['', 'They said '], ['谁', 'they would'], ['', ', and '], ['补充说明', 'they'], ['', ' did.']])
    expect(join_(out)).toBe(t)
  })

  it('真实讲义：拆开的每一块都放得上，拼回去与原文逐字一致', () => {
    for (const x of Handout.parse(socialMedia).sentences) {
      if (!x.breakdown) continue
      const chunks = annotate(x.text, x.breakdown.parts)
      expect(join_(chunks), x.id).toBe(x.text)
      expect(chunks.filter((c) => c.part).length, x.id).toBe(x.breakdown.parts.length)
    }
  })
})

describe('真实讲义：粗读点词、「给你」便签、梯子第 2 步', () => {
  const real = Handout.parse(socialMedia)
  const sentence = (id: string) => real.sentences.find((x) => x.id === id)!

  it('lemmaIndex：点短语里的单个词也算这个词条', () => {
    const m = lemmaIndex(real.words)
    expect(['toying', 'flock', 'seize', 'arise', 'scrolling'].map((t) => m.get(t))).toEqual(['toy with', 'flock to', 'seize on', 'arise from', 'scroll through'])
    expect(m.get('legislators')).toBe('legislator') // 单词词形照旧
    expect(m.get('for')).toBeUndefined() // for fear of：第一个词是虚词
    expect(m.get('as')).toBeUndefined() // as a whole：太短
  })

  it('lemmaIndex：已被别的词条占用的词不改指（不管词条先后）', () => {
    const m = lemmaIndex([
      { lemma: 'blanket ban', forms: ['blanket bans'] },
      { lemma: 'blanket', forms: ['blanket'] },
      { lemma: 'kick off', forms: ['kicking off'] },
      { lemma: 'kick out', forms: ['kicking out'] },
    ])
    expect(m.get('blanket')).toBe('blanket')
    expect(m.get('kicking')).toBe('kick off')
  })

  it('noteQuote：只引既点名这个词、又带「如果」、没有术语的那一句', () => {
    expect(noteQuote(sentence('S10').teacherNote!, ['fret'])).toBe('第一句话中如果不认识 fret 一词，很大概率可能会不理解本句话的意思')
    expect(noteQuote(sentence('S17').teacherNote!, ['pending'])).toBe('句子结构本身不复杂，但如果对 pending 一词不够熟悉的话，可能会造成理解困难')
    expect(noteQuote(sentence('S28').teacherNote!, ['aired'])).toBeUndefined() // 讲解里讲了词义，不引
    expect(noteQuote(sentence('S17').teacherNote!, ['conclusive'])).toBeUndefined() // 这一句没带「如果」，不拿别的句子凑
    expect(noteQuote('如果不认识 fret，这个从句读不懂。', ['fret'])).toBeUndefined() // 有术语
  })

  it('sameWording：不计首尾空白、空白个数和引号写法', () => {
    expect(sameWording(' It’s  “fine”. ', "It's \"fine\".")).toBe(true)
    expect(sameWording('And even if you wanted', 'Even if you wanted')).toBe(false)
    expect(sameWording(sentence('S10').ladder!.l2, sentence('S10').text)).toBe(true)
    expect(sameWording(sentence('S17').ladder!.l2, sentence('S17').text)).toBe(false)
  })
})

describe('写作反馈不给改写后的句子', () => {
  const example = 'Yet, pending clearer evidence, a blanket ban may prove counterproductive.'
  it('可以引用原文例句和学生原话', () => {
    const r = '和原文 a blanket ban may prove counterproductive 的用法一致。'
    expect(safeReason(r, 'correct', ['I think bans are counterproductive.', example])).toBe(r)
    expect(safeReason('你写的 bans are counterproductive 没问题。', 'correct', ['I think bans are counterproductive.', example])).toContain('bans are counterproductive')
  })
  it('出现原文和学生原话里都没有的英文句子，就换成通用说法', () => {
    const out = safeReason('可以改成 a blanket ban would be counterproductive here。', 'incorrect', ['I think ban is counterproductive.', example])
    expect(out).toBe('对照原文例句再想想。')
  })

  describe('checkWriting：理由可以引用表达本身（原形），改写照样换掉', () => {
    afterEach(() => {
      vi.unstubAllGlobals()
    })
    const reply = (results: unknown) => vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ fallback: false, results }) }))
    // 学生写 toying with a ban；原文例句是 toying with the idea；理由引用表达原形 toy with the idea
    const text = 'Some schools are toying with a ban.'

    it('引用表达原形的理由原样保留', async () => {
      const reason = 'toy with the idea 指不太认真地考虑一个想法，这里的搭配和原文不一样。'
      reply([{ id: 'E1', verdict: 'incorrect', reason }])
      expect(await checkWriting(h, text, ['E1'])).toEqual([{ id: 'E1', verdict: 'incorrect', reason }])
    })

    it('改写后的句子照样换成通用说法；回落或请求失败返回 null', async () => {
      reply([{ id: 'E1', verdict: 'incorrect', reason: '可以改成 schools are toying with the idea of a ban。' }])
      expect((await checkWriting(h, text, ['E1']))?.[0].reason).toBe('对照原文例句再想想。')
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ fallback: true, results: [] }) }))
      expect(await checkWriting(h, text, ['E1'])).toBeNull()
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')))
      expect(await checkWriting(h, text, ['E1'])).toBeNull()
    })
  })
})

describe('学生端文案不出现语法术语', () => {
  const root = fileURLToPath(new URL('../src', import.meta.url))
  const files = (dir: string): string[] =>
    readdirSync(dir).flatMap((f) => {
      const p = join(dir, f)
      return statSync(p).isDirectory() ? files(p) : [p]
    })
  // 教师端（Teacher.tsx）可以显示结构名称；其余页面和组件都是学生或评委看的（writing.ts 里有给学生的兜底理由）
  const studentFiles = [...files(join(root, 'pages/student')), ...files(join(root, 'components')), join(root, 'pages/Judge.tsx'), join(root, 'pages/Home.tsx'), join(root, 'data/presets.ts'), join(root, 'lib/writing.ts')]

  it.each(studentFiles.map((f) => [f.slice(root.length + 1), f]))('%s', (_name, f) => {
    const text = readFileSync(f, 'utf8')
    expect(GRAMMAR_TERMS.filter((t) => text.includes(t))).toEqual([])
  })
})

describe('事件队列：先进队列，失败重试，不报错', () => {
  const e = (n: number): LearningEvent => ({ sid: 's', ts: n, handoutId: h.id, type: 'tap_word', lemma: 'fret' })
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('网络失败留在队列，退避后重试成功', async () => {
    vi.useFakeTimers()
    const fetchMock = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue({ ok: true, status: 200 })
    vi.stubGlobal('fetch', fetchMock)
    await sendEvent(e(1))
    expect(pendingCount()).toBe(1)
    await vi.advanceTimersByTimeAsync(2000)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual([e(1)])
    expect(pendingCount()).toBe(0)
  })

  it('服务器 500 重试；400（数据本身有问题）丢掉', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce({ ok: false, status: 500 }).mockResolvedValueOnce({ ok: false, status: 400 })
    vi.stubGlobal('fetch', fetchMock)
    await sendEvent(e(2))
    expect(pendingCount()).toBe(1)
    await flush()
    expect(pendingCount()).toBe(0)
  })

  it('还没更新的后端拒收诊断事件（400）：只丢诊断事件，同批的学习事件重发', async () => {
    const view: LearningEvent = { sid: 's', ts: 3, handoutId: h.id, type: 'page_view', value: '粗读' }
    const fetchMock = vi.fn().mockResolvedValueOnce({ ok: false, status: 500 }).mockResolvedValueOnce({ ok: false, status: 400 }).mockResolvedValue({ ok: true, status: 200 })
    vi.stubGlobal('fetch', fetchMock)
    await sendEvent(view) // 第一次 500，留在队列
    await sendEvent(e(4)) // 和学习事件攒成一批
    await flush()
    const bodies = fetchMock.mock.calls.map((c) => JSON.parse(c[1].body))
    expect(bodies[1]).toEqual([view, e(4)]) // 这一批被拒收
    expect(bodies[2]).toEqual([e(4)]) // 只重发学习事件
    expect(pendingCount()).toBe(0)
  })
})
