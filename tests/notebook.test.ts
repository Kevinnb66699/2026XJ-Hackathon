// 跨篇的单词本、表达本和学习记录（src/lib/notebook.ts）：从一个账号的全部事件推算。讲义用迷你讲义另起几份（id、标题、来源不同）
import fs from 'node:fs'
import { describe, expect, it } from 'vitest'
import { Handout, NOTEBOOK_ID, type LearningEvent } from '../shared/schema'
import { aiDrafted, meaningByAi } from '../src/components/ui'
import { RATINGS, REVIEW_SIZE, buildNotebook, buildRecords, parseHandout, reviewOrder, type Notebook, type NotebookWord } from '../src/lib/notebook'
import { miniHandout } from './fixtures/mini-handout'

const llm = { by: 'llm' as const }
// A：迷你讲义原样（题目、提示是人写的，讲义词表的词义不标 AI；全文词义是 AI 生成的）
const A = Handout.parse({ ...miniHandout, id: 'up-nba', title: 'Phones A' })
// B：同一篇另起一份，段意题是 AI 起草的（讲义词表的词义跟着标 AI）；pending 的意思换一个，看合并时取哪一篇
const B = Handout.parse({
  ...miniHandout,
  id: 'up-nbb',
  title: 'Phones B',
  paragraphs: miniHandout.paragraphs.map((p) => ({ ...p, gist: { ...p.gist, provenance: llm } })),
  words: miniHandout.words.map((w) => (w.lemma === 'pending' ? { ...w, zh: '待定的' } : w)),
})
// C：没有全文词义
const C = Handout.parse({ ...miniHandout, id: 'up-nbc', title: 'Phones C', lexicon: undefined })
const S03 = miniHandout.sentences.find((x) => x.id === 'S03')!.text
const S01 = miniHandout.sentences.find((x) => x.id === 'S01')!.text

type E = Omit<LearningEvent, 'sid' | 'ts' | 'handoutId'>
let t = 0
const ev = (h: Handout | string, e: E, ts = ++t): LearningEvent => ({ sid: 'u-0123456789abcdef', ts, handoutId: typeof h === 'string' ? h : h.id, ...e })
const nb = (e: E, ts?: number) => ev(NOTEBOOK_ID, e, ts)
const tap = (h: Handout, lemma: string, ts?: number) => ev(h, { type: 'tap_word', lemma }, ts)
const lemmas = (n: Notebook) => n.words.map((w) => w.lemma).sort()
const word = (n: Notebook, lemma: string) => n.words.find((w) => w.lemma === lemma)

describe('单词本', () => {
  it('两篇里的同一个词合并成一条、写两处出处（先遇到的在前）；意思、例句取最近一次进来的那一篇；以前记成原词的（phones）按原形合并', () => {
    const n = buildNotebook([A, B], [tap(A, 'pending', 10), ev(B, { type: 'word_card', lemma: 'pending', value: 'unknown' }, 20), tap(A, 'phones', 5), tap(B, 'phone', 30)])
    expect(word(n, 'pending')).toEqual({
      lemma: 'pending',
      zh: '待定的',
      ai: true,
      sources: [{ handoutId: 'up-nba', title: 'Phones A' }, { handoutId: 'up-nbb', title: 'Phones B' }],
      example: { handoutId: 'up-nbb', sentenceId: 'S03', text: S03 },
      addedTs: 10,
    })
    expect(word(n, 'phone')).toEqual({
      lemma: 'phone',
      pos: 'n.',
      zh: '手机',
      ai: true,
      sources: [{ handoutId: 'up-nba', title: 'Phones A' }, { handoutId: 'up-nbb', title: 'Phones B' }],
      example: { handoutId: 'up-nbb', sentenceId: 'S01', text: S01 },
      addedTs: 5,
    })
    expect(n.words.map((w) => w.lemma)).toEqual(['pending', 'phone']) // 最近进来的在前
  })

  it('标了认识的不进；猜错的进；标不认识的进；查不到意思的不进；点了又取消的不进；猜对的不进', () => {
    const n = buildNotebook(
      [A, C],
      [
        tap(A, 'fret'),
        ev(A, { type: 'word_card', lemma: 'fret', value: 'known' }),
        ev(A, { type: 'answer_question', lemma: 'blanket', correct: false, firstTry: true }),
        ev(A, { type: 'word_card', lemma: 'counterproductive', value: 'unknown' }),
        tap(A, 'brondle'), // 讲义里没有这个词
        tap(C, 'proposal'), // C 没有全文词义，查不到意思
        tap(A, 'distract'),
        ev(A, { type: 'tap_word', lemma: 'distract', value: 'off' }),
        ev(A, { type: 'answer_question', lemma: 'pending', correct: true, firstTry: true }),
      ],
    )
    expect(lemmas(n)).toEqual(['blanket', 'counterproductive'])
  })

  it('复习结果取最近一次（事件顺序乱了也按时间）；没有 correct 的复习不算；不在单词本里的词复习了也不进', () => {
    const n = buildNotebook(
      [A],
      [tap(A, 'pending', 1), nb({ type: 'review_word', lemma: 'pending', correct: true }, 50), nb({ type: 'review_word', lemma: 'pending', correct: false }, 40), nb({ type: 'review_word', lemma: 'pending' }, 60), nb({ type: 'review_word', lemma: 'fret', correct: false }, 70)],
    )
    expect(lemmas(n)).toEqual(['pending'])
    expect(word(n, 'pending')!.lastReview).toEqual({ ts: 50, correct: true })
    expect(word(buildNotebook([A], [tap(A, 'pending')]), 'pending')!.lastReview).toBeUndefined()
  })

  it('移出单词本：两篇里的都不在了；之后在某一篇里又点了、标了不认识或猜错，就回来：出处只有回来的那一篇，加入时间算回来的时间，移出之前的复习不算', () => {
    const base = [tap(A, 'pending', 10), ev(B, { type: 'word_card', lemma: 'pending', value: 'unknown' }, 20), tap(A, 'fret', 15), nb({ type: 'review_word', lemma: 'pending', correct: true }, 25), nb({ type: 'drop_word', lemma: 'pending' }, 30)]
    expect(lemmas(buildNotebook([A, B], base))).toEqual(['fret'])

    const back = buildNotebook([A, B], [...base, ev(A, { type: 'tap_word', lemma: 'pending', value: 'off' }, 40), tap(A, 'pending', 41)])
    expect(word(back, 'pending')).toEqual({
      lemma: 'pending',
      zh: '在……之前；等待……期间',
      ai: false,
      sources: [{ handoutId: 'up-nba', title: 'Phones A' }],
      example: { handoutId: 'up-nba', sentenceId: 'S03', text: S03 },
      addedTs: 41,
    })
    expect(word(buildNotebook([A, B, C], [...base, ev(C, { type: 'answer_question', lemma: 'pending', correct: false, firstTry: true }, 50)]), 'pending')!.sources).toEqual([{ handoutId: 'up-nbc', title: 'Phones C' }])
    expect(word(buildNotebook([A, B], [...base, ev(B, { type: 'word_card', lemma: 'pending', value: 'unknown' }, 50)]), 'pending')!.sources).toEqual([{ handoutId: 'up-nbb', title: 'Phones B' }])
    // 回来以后的复习照常算
    expect(word(buildNotebook([A, B], [...base, ev(A, { type: 'tap_word', lemma: 'pending', value: 'off' }, 59), tap(A, 'pending', 60), nb({ type: 'review_word', lemma: 'pending', correct: false }, 70)]), 'pending')!.lastReview).toEqual({ ts: 70, correct: false })
  })

  it('移出以后：只有移出之前的事件、之后标了认识的、别的词的事件，都不会把它带回来；移出不分大小写；不是 notebook 的 drop_word 不算', () => {
    const base = [tap(A, 'pending', 10), tap(A, 'fret', 15), nb({ type: 'drop_word', lemma: 'Pending' }, 30)]
    expect(lemmas(buildNotebook([A, B], base))).toEqual(['fret'])
    expect(lemmas(buildNotebook([A, B], [...base, ev(B, { type: 'word_card', lemma: 'pending', value: 'known' }, 40), tap(B, 'blanket', 41)]))).toEqual(['blanket', 'fret'])
    expect(lemmas(buildNotebook([A, B], [...base, tap(B, 'pending', 40), ev(B, { type: 'word_card', lemma: 'pending', value: 'known' }, 41)]))).toEqual(['fret'])
    expect(lemmas(buildNotebook([A], [tap(A, 'fret', 1), ev(A, { type: 'drop_word', lemma: 'fret' }, 2)]))).toEqual(['fret'])
  })

  it('没动过手的篇不列：只有页面诊断、没有事件的讲义不出现；不在 handouts 里的讲义的事件不看', () => {
    const n = buildNotebook([A, B, C], [ev(B, { type: 'page_view', value: '粗读' }), ev(C, { type: 'client_error', value: 'boom' }), tap(A, 'pending'), tap(miniHandout, 'fret'), ev('up-gone', { type: 'collect_expression', value: 'E1' })])
    expect(n.words.map((w) => [w.lemma, w.sources.map((s) => s.handoutId)])).toEqual([['pending', ['up-nba']]])
    expect(n.expressions).toEqual([])
    expect(buildNotebook([A, B], [])).toEqual({ words: [], expressions: [] })
  })
})

describe('表达本', () => {
  it('各篇收的表达合并（最近收的在前）；收了又移出的不进；讲义里没有了的表达不列；例句是原文原话', () => {
    const n = buildNotebook(
      [A, B],
      [
        ev(A, { type: 'collect_expression', value: 'E1' }, 10),
        ev(A, { type: 'collect_expression', value: 'E3' }, 11),
        ev(A, { type: 'drop_expression', value: 'E3' }, 12),
        ev(B, { type: 'collect_expression', value: 'E2' }, 20),
        ev(B, { type: 'collect_expression', value: 'E9' }, 21),
      ],
    )
    expect(n.expressions).toEqual([
      { id: 'E2', handoutId: 'up-nbb', title: 'Phones B', text: 'counterproductive', zh: '适得其反的', ai: true, example: S03, pattern: '\\bcounterproductive\\b', ts: 20 },
      { id: 'E1', handoutId: 'up-nba', title: 'Phones A', text: 'toy with the idea', zh: '不太认真地考虑这个想法', ai: false, example: S01, pattern: '\\btoy(s|ed|ing)?\\s+with\\b', ts: 10 },
    ])
    expect(n.words).toEqual([])
    // 移出后再收：时间算再收的
    const again = buildNotebook([A], [ev(A, { type: 'collect_expression', value: 'E1' }, 1), ev(A, { type: 'drop_expression', value: 'E1' }, 2), ev(A, { type: 'collect_expression', value: 'E1' }, 3)])
    expect(again.expressions.map((x) => [x.id, x.ts])).toEqual([['E1', 3]])
  })
})

describe('只记发生了什么', () => {
  const big = buildNotebook(
    [A, B],
    [tap(A, 'pending'), tap(A, 'proposal'), tap(B, 'phone'), tap(B, 'fret'), ev(A, { type: 'collect_expression', value: 'E1' }), ev(B, { type: 'collect_expression', value: 'E3' }), nb({ type: 'review_word', lemma: 'fret', correct: true })],
  )

  it('没有「已掌握」、等级、合计数之类的字段', () => {
    expect(Object.keys(big)).toEqual(['words', 'expressions'])
    const wordKeys = ['lemma', 'pos', 'zh', 'ai', 'sources', 'example', 'addedTs', 'lastReview']
    const exprKeys = ['id', 'handoutId', 'title', 'text', 'zh', 'ai', 'example', 'pattern', 'ts']
    for (const w of big.words) for (const k of Object.keys(w)) expect(wordKeys, k).toContain(k)
    for (const x of big.expressions) for (const k of Object.keys(x)) expect(exprKeys, k).toContain(k)
    expect(JSON.stringify(big)).not.toMatch(/master|cefr|score|progress|level/i)
    const src = fs.readFileSync(new URL('../src/lib/notebook.ts', import.meta.url), 'utf8')
    expect(src).not.toMatch(/mastered|cefr/i)
    expect(src).not.toMatch(/from '(react|\.\.\/components)/) // 纯函数：服务器打包用，不引 React 组件
  })

  it('AI 标签和学生端（components/ui.tsx 的 meaningByAi、aiDrafted）一样：按意思出自的那一篇判断', () => {
    const byId = new Map([A, B].map((h) => [h.id, h]))
    expect(big.words.length).toBe(4)
    for (const w of big.words) expect(w.ai, w.lemma).toBe(meaningByAi(byId.get(w.example!.handoutId)!, w.lemma))
    for (const x of big.expressions) expect(x.ai, x.id).toBe(aiDrafted(byId.get(x.handoutId)!))
    expect(big.words.map((w) => w.ai).sort()).toEqual([false, true, true, true]) // A 的 pending 是人写的；全文词义、B 的讲义词表是 AI 的
  })
})

describe('复习顺序', () => {
  const w = (lemma: string, addedTs: number, lastReview?: NotebookWord['lastReview']): NotebookWord => ({ lemma, zh: '', ai: false, sources: [], addedTs, ...(lastReview ? { lastReview } : {}) })

  it('最近一次点了「还不认识」的在前（隔得久的先出），然后是还没复习过的（进来早的先出），最后是点过「认识」的（隔得最久的先出）；一次 10 张', () => {
    const words = [
      w('known-old', 1, { ts: 100, correct: true }),
      w('new-late', 50),
      w('unknown-late', 2, { ts: 300, correct: false }),
      w('known-new', 3, { ts: 200, correct: true }),
      w('new-early', 10),
      w('unknown-early', 4, { ts: 150, correct: false }),
    ]
    expect(reviewOrder(words).map((x) => x.lemma)).toEqual(['unknown-early', 'unknown-late', 'new-early', 'new-late', 'known-old', 'known-new'])
    expect(words[0].lemma).toBe('known-old') // 不改原数组
    expect(REVIEW_SIZE).toBe(10)
  })

  it('复习过又移出、再回来的词，排在还没复习过的里面', () => {
    const n = buildNotebook([A], [tap(A, 'pending', 1), nb({ type: 'review_word', lemma: 'pending', correct: true }, 2), nb({ type: 'drop_word', lemma: 'pending' }, 3), tap(A, 'fret', 4), nb({ type: 'review_word', lemma: 'fret', correct: false }, 5), ev(A, { type: 'tap_word', lemma: 'pending', value: 'off' }, 6), tap(A, 'pending', 7)])
    expect(reviewOrder(n.words).map((x) => x.lemma)).toEqual(['fret', 'pending'])
  })

  it('移出以后、回来之前的复习（另一台设备上还开着旧列表）不算：回来的词排在还没复习过的里面', () => {
    const base = [tap(A, 'pending', 1), tap(A, 'counterproductive', 2), nb({ type: 'drop_word', lemma: 'pending' }, 3)]
    const back = [ev(A, { type: 'tap_word', lemma: 'pending', value: 'off' }, 5), tap(A, 'pending', 6)]
    for (const correct of [true, false]) {
      const n = buildNotebook([A], [...base, nb({ type: 'review_word', lemma: 'pending', correct }, 4), ...back])
      expect(word(n, 'pending')).toMatchObject({ addedTs: 6 })
      expect(word(n, 'pending')!.lastReview, String(correct)).toBeUndefined()
      expect(reviewOrder(n.words).map((x) => x.lemma), String(correct)).toEqual(['counterproductive', 'pending'])
    }
  })
})

describe('parseHandout', () => {
  it('讲义的格式对就返回讲义，不对返回 null', () => {
    expect(parseHandout(JSON.parse(JSON.stringify(A)))).toEqual(A)
    for (const bad of [null, {}, 'x', { ...A, sentences: [] }, { ...A, id: 1 }]) expect(parseHandout(bad)).toBeNull()
  })
})

describe('学习记录（buildRecords）', () => {
  const answer = (h: Handout, sentenceId: string, correct: boolean, ts?: number) => ev(h, { type: 'answer_question', sentenceId, correct }, ts)

  it('每篇一行，最近一次动手的在前；只打开、只看过小结的不列；页面诊断不算读（不改日期）；不在 handouts 里的、handoutId 是 notebook 的不看', () => {
    const r = buildRecords(
      [A, B, C],
      [
        tap(A, 'pending', 10),
        answer(B, 'S01', true, 20),
        ev(A, { type: 'page_view', value: '小结' }, 30), // 看一眼小结
        ev(C, { type: 'page_view', value: '粗读' }, 40), // C 只打开了
        ev(C, { type: 'client_error', value: 'boom' }, 41),
        nb({ type: 'review_word', lemma: 'pending', correct: true }, 50),
        tap(miniHandout, 'fret', 60), // 示例讲义不在 handouts 里
      ],
    )
    expect(r.map((x) => [x.handoutId, x.lastTs])).toEqual([['up-nbb', 20], ['up-nba', 10]])
    expect(buildRecords([A, B], [])).toEqual([])
  })

  it('在表达本页移出一条表达（drop_expression，带的是那一篇的 handoutId）不改那一篇最近一次读的日期；收进表达是读文章时做的，算', () => {
    const r = buildRecords(
      [A, B],
      [tap(A, 'pending', 10), ev(A, { type: 'collect_expression', value: 'E1' }, 11), answer(B, 'S01', true, 20), ev(A, { type: 'drop_expression', value: 'E1' }, 30)],
    )
    expect(r.map((x) => [x.handoutId, x.lastTs])).toEqual([['up-nbb', 20], ['up-nba', 11]])
  })

  it('状态：还有没答的句子时 todo，带第一句没答的（按原文顺序，答错的不算没答）；四句都答过了（有答错的）是 done，不带句子', () => {
    expect(buildRecords([A], [answer(A, 'S02', false, 1), answer(A, 'S01', true, 2)])).toEqual([{ handoutId: 'up-nba', title: 'Phones A', lastTs: 2, status: 'todo', firstPending: 'S03' }])
    expect(buildRecords([A], [tap(A, 'pending', 1)])[0]).toMatchObject({ status: 'todo', firstPending: 'S01' }) // 只点了词，也算动过手
    const all = ['S01', 'S02', 'S03', 'S04'].map((id, i) => answer(A, id, id !== 'S04', i + 1))
    expect(buildRecords([A], all)).toEqual([{ handoutId: 'up-nba', title: 'Phones A', lastTs: 4, status: 'done' }])
  })

  it('自己选的难度：取最近一次（事件顺序乱了也按时间），不是那三个选项的不算；没选过就没有这个字段；只选了难度、没动手的不列', () => {
    const base = [tap(A, 'pending', 1)]
    expect(buildRecords([A], [...base, ev(A, { type: 'feedback', value: '刚好' }, 5), ev(A, { type: 'feedback', value: '太难' }, 3)])[0].rating).toBe('刚好')
    expect(buildRecords([A], [...base, ev(A, { type: 'feedback', value: '太难' }, 3), ev(A, { type: 'feedback', value: '很好' }, 5)])[0].rating).toBe('太难')
    expect(buildRecords([A], base)[0]).not.toHaveProperty('rating')
    expect(buildRecords([A], [ev(A, { type: 'feedback', value: '刚好' }, 1)])).toEqual([])
  })

  it('难度选项和小结页的一样', () => {
    const src = fs.readFileSync(new URL('../src/pages/student/Summary.tsx', import.meta.url), 'utf8')
    expect(src).toContain(`const RATINGS = [${RATINGS.map((x) => `'${x}'`).join(', ')}]`)
  })

  it('不带任何数字（日期除外）：没有答对几句、生词几个、合计这类字段', () => {
    const r = buildRecords([A, B], [answer(A, 'S01', false, 1), tap(A, 'pending', 2), ev(B, { type: 'word_card', lemma: 'fret', value: 'unknown' }, 3), ev(B, { type: 'feedback', value: '太简单' }, 4)])
    expect(r).toHaveLength(2)
    for (const x of r) {
      for (const k of Object.keys(x)) expect(['handoutId', 'title', 'lastTs', 'rating', 'status', 'firstPending'], k).toContain(k)
      for (const [k, v] of Object.entries(x)) if (k !== 'lastTs') expect(typeof v, k).toBe('string')
    }
  })
})
