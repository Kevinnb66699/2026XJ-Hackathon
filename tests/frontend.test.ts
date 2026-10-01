import { readdirSync, readFileSync, statSync } from 'fs'
import { join } from 'path'
import { fileURLToPath } from 'url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { LearningEvent } from '../shared/schema'
import { GRAMMAR_TERMS } from '../pipeline/validate'
import { personalize, emptyState } from '../src/engine'
import { flush, pendingCount, sendEvent } from '../src/lib/events'
import { findAll, ladderHighlights, markWords, segment, tokenize } from '../src/lib/text'
import { checkWriting, safeReason } from '../src/lib/writing'
import { miniHandout as h } from './fixtures/mini-handout'

const join_ = (parts: { text: string }[]) => parts.map((p) => p.text).join('')

describe('原文切分：拼回去与原文逐字一致', () => {
  it('tokenize：每个英文单词单独成块', () => {
    for (const x of h.sentences) expect(join_(tokenize(x.text))).toBe(x.text)
    expect(tokenize("Teachers don’t fret; pupils' phones.").filter((t) => t.word).map((t) => t.text)).toEqual(['Teachers', 'don’t', 'fret', 'pupils', 'phones'])
  })

  it('segment：注释词 + 可跳过词 + 梯子高亮', () => {
    const v = personalize(h, { ...emptyState('x'), tappedWords: h.words.map((w) => w.lemma) })
    for (const sv of v.sentences) {
      const x = h.sentences.find((y) => y.id === sv.id)!
      const marks = markWords(sv.text, sv.glosses, 'gloss')
      const hls = x.ladder ? ladderHighlights(sv.text, x.ladder.l1.subject, x.ladder.l1.predicate) : []
      expect(join_(segment(sv.text, marks, hls))).toBe(x.text)
    }
  })

  it('findAll 整词、不区分大小写', () => {
    expect(findAll('Pupils and pupil, pupillage', 'pupil')).toEqual([[11, 16]])
    expect(findAll('Pupils and pupil', 'pupils')).toEqual([[0, 6]])
    expect(findAll('abc', '')).toEqual([])
  })

  it('梯子第 1 步高亮「谁」「做了什么」两段子串', () => {
    const x = h.sentences.find((y) => y.id === 'S03')!
    const segs = segment(x.text, [], ladderHighlights(x.text, x.ladder!.l1.subject, x.ladder!.l1.predicate))
    expect(segs.filter((s) => s.hl === 'who').map((s) => s.text)).toEqual(['a blanket ban'])
    expect(segs.filter((s) => s.hl === 'what').map((s) => s.text)).toEqual(['may prove'])
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
})
