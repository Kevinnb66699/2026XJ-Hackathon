import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { Handout, NOTEBOOK_ID, type LearningEvent } from '../shared/schema'
import { syllabusBand } from '../shared/syllabus'
import { deckSummary, emptyState, engine, expressionUsed, guessFirst, ladderMode, lookupWord, personalize, readingTrails, retryDeck, reviewPicks, stuck, syllabusNew, unknownWords } from '../src/engine'
import { mulberry32 } from '../src/engine/prng'
import type { LearnerProfile, PersonalView, StudentState } from '../src/engine/types'
import { buildNotebook } from '../src/lib/notebook'
import { miniHandout as h } from './fixtures/mini-handout'


// 用种子随机生成学生状态，覆盖「任意状态」
function randomState(hd: Handout, seed: number): StudentState {
  const r = mulberry32(seed)
  const s = emptyState(`R${seed}`)
  for (const w of hd.words) {
    if (r() < 0.4) s.tappedWords.push(w.lemma)
    if (r() < 0.5) s.wordMarks[w.lemma] = r() < 0.5 ? 'known' : 'unknown'
  }
  if (r() < 0.3) s.tappedWords.push('proposal') // 不在词表里的点击
  for (const x of hd.sentences) {
    if (x.question && r() < 0.7) {
      const first = r() < 0.5
      s.answers[x.question.id] = { firstTryCorrect: first, attempts: first ? 1 : 1 + Math.ceil(r() * 3), correct: first || r() < 0.6 }
    }
    s.ladder[x.id] = ([0, 1, 2, 3] as const)[Math.floor(r() * 4)]
  }
  s.collectedExpressions = hd.expressions.filter(() => r() < 0.5).map((e) => e.id)
  return s
}

const states = [emptyState('S-empty'), ...Array.from({ length: 60 }, (_, i) => randomState(h, i + 1))]

const ok = { firstTryCorrect: true, attempts: 1, correct: true }
const view = (s: StudentState, hd: Handout = h) => personalize(hd, s)
const sv = (s: StudentState, id: string, hd: Handout = h) => view(s, hd).sentences.find((x) => x.id === id)!
const lemmas = (gs: { lemma: string }[]) => gs.map((g) => g.lemma)
const with_ = (patch: Partial<StudentState>, sid = 'S-t'): StudentState => ({ ...emptyState(sid), ...patch })

describe('engine 对象', () => {
  it('导出的 engine 就是各个具名函数', () => {
    expect(engine).toEqual({ emptyState, personalize, ladderMode, stuck, expressionUsed, reviewPicks })
  })
  it('emptyState 各字段为空', () => {
    expect(emptyState('S1')).toEqual({ sid: 'S1', tappedWords: [], wordMarks: {}, answers: {}, ladder: {}, collectedExpressions: [] })
  })
})

describe('原文与题目', () => {
  it('任意状态下句子原文逐字一致，题目原样透传，选项数不减', () => {
    for (const s of states) {
      const v = view(s)
      expect(v.sentences.map((x) => x.id)).toEqual(h.sentences.map((x) => x.id))
      v.sentences.forEach((x, i) => {
        const orig = h.sentences[i]
        expect(x.text).toBe(orig.text)
        expect(x.question).toEqual(orig.question)
        expect(x.question?.options.length).toBe(orig.question?.options.length)
      })
    }
  })
})

describe('学生词卡片', () => {
  it('任意状态下 must 的词都在 deck 里；每张卡都是讲义词表或全文词义里的真词（10-16 起没有编出来的假词卡）', () => {
    for (const s of states) {
      const deck = view(s).deck
      for (const w of h.words.filter((x) => x.tier === 'must')) expect(deck.map((c) => c.lemma)).toContain(w.lemma)
      for (const c of deck) expect(lookupWord(h, c.lemma)).toBe(c.word)
    }
    expect(view(emptyState('S1'), Handout.parse({ ...h, id: 'up-abc123' })).deck.map((c) => c.lemma)).toEqual(view(emptyState('S1')).deck.map((c) => c.lemma)) // 内置和上传的讲义一样
  })
  it('没点词时：老师必练词 → 熟词僻义', () => {
    const deck = view(emptyState('S-x')).deck
    expect(deck.map((c) => c.kind)).toEqual(['teacher_core', 'teacher_core', 'teacher_core', 'familiar_trap'])
    expect(deck.map((c) => c.lemma)).toEqual(['pending', 'counterproductive', 'fret', 'blanket'])
  })
  it('点过的词按点击顺序排最前（词表里的、全文词义里的都算），两边都没有的忽略，重复点击只算一次', () => {
    const deck = view(with_({ tappedWords: ['pupil', 'fret', 'proposal', 'whatever', 'pupil'] })).deck
    expect(deck.map((c) => c.lemma)).toEqual(['pupil', 'fret', 'proposal', 'pending', 'counterproductive', 'blanket'])
    expect(deck.slice(0, 3).map((c) => c.kind)).toEqual(['tapped', 'tapped', 'tapped'])
    expect(deck[0].word.zh).toBe('学生')
  })
  it('词表为空、也没点过词时没有卡片（词汇页另有一句「没有要你单独练的词」）', () => {
    expect(view(emptyState('S1'), Handout.parse({ ...h, words: [] })).deck).toEqual([])
  })
  it('先猜一猜只在这张卡出现时还没猜过才出；之前猜过的（再练一遍、别处猜过）意思先盖住', () => {
    const pending = h.words.find((w) => w.lemma === 'pending')!
    const plain = h.words.find((w) => !w.guess)!
    expect(guessFirst(pending, {})).toBe(true)
    expect(guessFirst(pending, { 'w-pending': { firstTryCorrect: false, attempts: 1, correct: false } })).toBe(false)
    expect(guessFirst(plain, {})).toBe(false)
    expect(guessFirst(undefined, {})).toBe(false)
  })
  it('练完一轮的总结：猜错后点了「认识」的词单独算，不说成「还不认识」', () => {
    const answers = { 'w-blanket': { firstTryCorrect: false, attempts: 1, correct: false } }
    const deck = view(with_({ answers })).deck
    const known = Object.fromEntries(deck.map((c) => [c.lemma, 'known' as const]))
    // 第二轮只剩 blanket，标了「认识」：仍加注释，但原因是第一次猜错
    expect(deckSummary(h, deck.filter((c) => c.lemma === 'blanket'), with_({ wordMarks: known, answers }))).toEqual({ total: 1, wrong: 1 })
    expect(deckSummary(h, deck, with_({ wordMarks: { ...known, fret: 'unknown' }, answers }))).toEqual({ total: 2, wrong: 1 })
    expect(deckSummary(h, deck, with_({ wordMarks: known }))).toEqual({ total: 0, wrong: 0 })
  })
  it('再练一遍：第一轮留标了「不认识」和猜错的词；之后几轮只看这一轮的标记，全标「认识」就为空', () => {
    const answers = { 'w-blanket': { firstTryCorrect: false, attempts: 1, correct: false } }
    const deck = view(with_({ tappedWords: ['pupil'], answers })).deck
    // 练完一轮：每张卡都标过，pupil、fret 标「不认识」，blanket 猜错后标了「认识」
    const known = Object.fromEntries(deck.map((c) => [c.lemma, 'known' as const]))
    const s = with_({ tappedWords: ['pupil'], wordMarks: { ...known, pupil: 'unknown', fret: 'unknown' }, answers })
    expect(retryDeck(h, deck, s, true).map((c) => c.lemma)).toEqual(['pupil', 'fret', 'blanket'])
    expect(retryDeck(h, deck, with_({ wordMarks: known }), true)).toEqual([])
    // 猜错的词第二轮标了「认识」：不再无限重来（第一轮仍算它不会）
    const s2 = with_({ wordMarks: known, answers: s.answers })
    expect(retryDeck(h, deck, s2, true).map((c) => c.lemma)).toEqual(['blanket'])
    expect(retryDeck(h, deck, s2, false)).toEqual([])
  })
})

describe('老师讲解收起', () => {
  it('必练句永不收起', () => {
    for (const s of states) for (const x of view(s).sentences) if (x.tier === 'must') expect(x.teacherNoteCollapsed).toBe(false)
    const s = with_({ answers: { 'S01-q': ok, 'S03-q': ok } })
    expect(sv(s, 'S03').teacherNoteCollapsed).toBe(false)
    expect(sv(s, 'S01').teacherNoteCollapsed).toBe(true)
    expect(sv(s, 'S01').collapseReason).toBe('你第一次就读懂了这句')
  })
  it('首答错、没答、或开过梯子都不收起', () => {
    expect(sv(emptyState('S-t'), 'S01').teacherNoteCollapsed).toBe(false)
    expect(sv(with_({ answers: { 'S01-q': { firstTryCorrect: false, attempts: 2, correct: true } } }), 'S01').teacherNoteCollapsed).toBe(false)
    const opened = sv(with_({ answers: { 'S01-q': ok }, ladder: { S01: 1 } }), 'S01')
    expect(opened.teacherNoteCollapsed).toBe(false)
    expect(opened.collapseReason).toBeUndefined()
  })
  it('收起判断不读取 tag：改掉 tag，收起结果不变', () => {
    const variants = [
      Handout.parse({ ...h, sentences: h.sentences.map((x) => ({ ...x, tag: undefined })) }),
      Handout.parse({ ...h, sentences: h.sentences.map((x) => ({ ...x, tag: 'reference' })) }),
    ]
    const pick = (hd: Handout, s: StudentState) => view(s, hd).sentences.map((x) => [x.teacherNoteCollapsed, x.collapseReason])
    for (const s of states) for (const hd of variants) expect(pick(hd, s)).toEqual(pick(h, s))
  })
})

describe('打卡句', () => {
  it('打卡句不再锁梯子：任何状态下所有句子（含打卡句）maxLadderLevel 都是 3', () => {
    expect(sv(emptyState('S-t'), 'S03').checkIn).toBe(true)
    expect(sv(emptyState('S-t'), 'S03').maxLadderLevel).toBe(3)
    for (const s of states) for (const x of view(s).sentences) expect(x.maxLadderLevel).toBe(3)
  })
  it('hasLadder 跟随讲义', () => {
    expect(view(emptyState('S-t')).sentences.map((x) => x.hasLadder)).toEqual([true, true, true, true, false])
  })
})

describe('先自己试', () => {
  const mode = (s: StudentState, id: string) => sv(s, id).ladderMode
  it('没有作答时全部是 available', () => {
    expect(view(emptyState('S-t')).sentences.every((x) => x.ladderMode === 'available')).toBe(true)
  })
  it('同 tag 的更早句子首答正确后，本句 tryFirst', () => {
    const s = with_({ answers: { 'S02-q': ok } })
    expect(mode(s, 'S04')).toBe('tryFirst')
    expect(mode(s, 'S02')).toBe('available') // 没有更早的同类句
    expect(mode(s, 'S01')).toBe('available') // tag 不同
    expect(ladderMode(h, s, h.sentences[3])).toBe('tryFirst')
    // 本句已首答正确，仍是 tryFirst
    expect(mode(with_({ answers: { 'S02-q': ok, 'S04-q': ok } }), 'S04')).toBe('tryFirst')
  })
  it('更早的同类句是开了梯子之后才答对的，不算「自己读懂过」', () => {
    expect(mode(with_({ answers: { 'S02-q': ok }, ladder: { S02: 3 } }), 'S04')).toBe('available')
    expect(mode(with_({ answers: { 'S02-q': ok }, ladder: { S02: 1 } }), 'S04')).toBe('available')
  })
  it('本句首答错误后变回 available', () => {
    const s = with_({ answers: { 'S02-q': ok, 'S04-q': { firstTryCorrect: false, attempts: 1, correct: false } } })
    expect(mode(s, 'S04')).toBe('available')
  })
  it('更早句子首答错、只有更晚的句子答对、或不同 tag 答对，都不触发', () => {
    expect(mode(with_({ answers: { 'S02-q': { firstTryCorrect: false, attempts: 2, correct: true } } }), 'S04')).toBe('available')
    expect(mode(with_({ answers: { 'S04-q': ok } }), 'S02')).toBe('available')
    expect(mode(with_({ answers: { 'S01-q': ok } }), 'S04')).toBe('available')
  })
  it('任意状态下 tryFirst 都有依据', () => {
    for (const s of states) {
      view(s).sentences.forEach((x, i) => {
        if (x.ladderMode !== 'tryFirst') return
        const orig = h.sentences[i]
        expect(s.answers[orig.question!.id]?.firstTryCorrect ?? true).toBe(true)
        const earlier = h.sentences.slice(0, i).filter((e) => e.tag === orig.tag && e.question && s.answers[e.question.id]?.firstTryCorrect && !(s.ladder[e.id] ?? 0))
        expect(earlier.length).toBeGreaterThan(0)
      })
    }
  })
})

describe('「认识」和粗读点击', () => {
  const allKnown = Object.fromEntries(h.words.map((w) => [w.lemma, 'known' as const]))
  it('卡片标「认识」优先于粗读点击', () => {
    const v = view(with_({ tappedWords: ['distract', 'pupil'], wordMarks: allKnown }))
    expect(v.sentences.every((x) => x.glosses.length === 0 && x.skippableWords.length === 0)).toBe(true)
  })
})

describe('读懂轨迹 readingTrails', () => {
  const steps = (st: StudentState, tried?: Set<string>) => readingTrails(h, st, tried).map((t) => [t.tag, t.steps.map((x) => [x.sentenceId, x.outcome, x.tryFirst])])
  it('只排带原句题、至少 2 句的同类句子；没做过就是 none', () => {
    expect(steps(emptyState('S-t'))).toEqual([['appositive_that', [['S02', 'none', false], ['S04', 'none', false]]]])
  })
  it('没开梯子、第 2 次才答对是 retry；tryFirst 由调用方按时间算好传进来', () => {
    const s = with_({ answers: { 'S02-q': ok, 'S04-q': { firstTryCorrect: false, attempts: 2, correct: true } } })
    expect(steps(s, new Set(['S04']))).toEqual([['appositive_that', [['S02', 'own', false], ['S04', 'retry', true]]]])
    expect(readingTrails(h, s)[0].steps[1].attempts).toBe(2)
  })
  it('开过梯子、最后答对是 ladder（不分先后）；开了梯子还没答题是 stuck；firstTry 只看第一次作答', () => {
    const s = with_({ answers: { 'S02-q': ok }, ladder: { S02: 2, S04: 1 } })
    expect(steps(s)).toEqual([['appositive_that', [['S02', 'ladder', false], ['S04', 'stuck', false]]]])
    expect(readingTrails(h, s)[0].steps.map((x) => x.firstTry)).toEqual([true, false])
  })
})

describe('先猜后看第一次猜错', () => {
  const wrong = { firstTryCorrect: false, attempts: 1, correct: false }
  const marked = { pending: 'known', blanket: 'known' } as const
  it('之后点「认识」也算不认识：照样加注，也算生词', () => {
    const s = with_({ wordMarks: marked, answers: { 'w-pending': wrong, 'w-blanket': wrong } })
    expect(lemmas(sv(s, 'S03').glosses)).toEqual(['pending', 'counterproductive', 'blanket'])
    expect(stuck(h, s, 'S03')).toEqual({ sentenceId: 'S03', level: 1, cause: 'word' })
    expect([...unknownWords(h, s)].sort()).toEqual(['blanket', 'pending'])
  })
  it('第一次猜对再点「认识」：不加注', () => {
    const s = with_({ wordMarks: marked, answers: { 'w-pending': ok, 'w-blanket': ok } })
    expect(lemmas(sv(s, 'S03').glosses)).toEqual(['counterproductive'])
    expect(stuck(h, s, 'S03').level).toBeNull()
    expect(unknownWords(h, s).size).toBe(0)
  })
})

describe('注释', () => {
  // 在迷你讲义上多加一些词，让每段候选词超过 5 个
  const extra = (lemma: string, forms: string[], sentenceIds: string[], tier: 'must' | 'focus' | 'other' = 'other') => ({ lemma, forms, sentenceIds, zh: lemma, tier })
  const big = Handout.parse({
    ...h,
    words: [
      ...h.words,
      extra('school', ['schools'], ['S01']),
      extra('idea', ['idea'], ['S01']),
      extra('phone', ['phones'], ['S01', 'S04', 'S05']),
      extra('parent', ['parents'], ['S01']),
      extra('proposal', ['proposal'], ['S02']),
      extra('worry', ['worry'], ['S02']),
      extra('screen', ['screens'], ['S02']),
      extra('evidence', ['evidence'], ['S03']),
      extra('ban', ['ban'], ['S03']),
      extra('claim', ['claim'], ['S04']),
      extra('support', ['support'], ['S04']),
      extra('teacher', ['teachers'], ['S05'], 'must'), // 原文是大写 Teachers
      extra('instead', ['instead'], ['S05'], 'focus'),
      extra('wisely', ['wisely'], ['S05']),
    ],
  })
  const tapAll = with_({ tappedWords: big.words.filter((w) => !w.teacherCore && !w.familiarTrap).map((w) => w.lemma) })

  it('没点词时：老师核心词和熟词僻义加注，挂在第一次出现的句子上', () => {
    const v = view(emptyState('S-t'))
    expect(v.sentences.map((x) => lemmas(x.glosses))).toEqual([[], [], ['pending', 'counterproductive', 'blanket'], [], ['fret']])
    expect(sv(emptyState('S-t'), 'S03').glosses[0]).toEqual({ lemma: 'pending', forms: ['pending'], zh: '在……之前；等待……期间', guess: h.words[0].guess })
  })
  it('每段非必练词注释预算是 5，必练词另算且永不可跳过（任意状态）', () => {
    for (const hd of [h, big]) {
      const tierOf = new Map(hd.words.map((w) => [w.lemma, w.tier]))
      for (const s of [tapAll, ...Array.from({ length: 40 }, (_, i) => randomState(hd, 100 + i))]) {
        const v = view(s, hd)
        for (const p of [1, 2]) {
          const inPara = v.sentences.filter((x) => x.paragraph === p)
          expect(inPara.reduce((n, x) => n + x.glosses.filter((g) => tierOf.get(g.lemma) !== 'must').length, 0)).toBeLessThanOrEqual(5)
          for (const x of inPara) for (const l of x.skippableWords) expect(tierOf.get(l)).not.toBe('must')
        }
      }
    }
  })
  it('优先级：老师核心 > 熟词僻义 > 句子带题 > tier > 字母序；超预算的生词可跳过', () => {
    const v = view(tapAll, big)
    const g = (id: string) => lemmas(v.sentences.find((x) => x.id === id)!.glosses)
    const sk = (id: string) => v.sentences.find((x) => x.id === id)!.skippableWords
    // 第 1 段
    expect(g('S03')).toEqual(['pending', 'counterproductive', 'blanket', 'ban', 'evidence'])
    expect(g('S02')).toEqual(['distract'])
    expect(g('S01')).toEqual(['idea'])
    expect(sk('S01')).toEqual(['parent', 'phone', 'school'])
    expect(sk('S02')).toEqual(['proposal', 'pupil', 'screen', 'worry'])
    expect(sk('S03')).toEqual([])
    // 第 2 段：必练词 teacher 永远加注、不占预算；普通词占满 5 个名额后才可跳过
    expect(g('S05')).toEqual(['fret', 'teacher', 'instead'])
    expect(g('S04')).toEqual(['claim', 'phone', 'pupil', 'support'])
    expect(sk('S05')).toEqual(['distract', 'wisely'])
  })
  it('skippableWords 只放不认识的词', () => {
    for (const s of states) {
      const v = view(s, big)
      const U = new Set([...s.tappedWords, ...Object.keys(s.wordMarks).filter((l) => s.wordMarks[l] === 'unknown')])
      for (const l of Object.keys(s.wordMarks)) if (s.wordMarks[l] === 'known') U.delete(l)
      for (const x of v.sentences) for (const l of x.skippableWords) expect(U.has(l)).toBe(true)
    }
  })
})

describe('写作表达', () => {
  it('表达本 ∪ 老师要求，去重保序', () => {
    expect(view(with_({ collectedExpressions: ['E1', 'E2'] })).writingExpressionIds).toEqual(['E1', 'E2', 'E3'])
    expect(view(emptyState('S-t')).writingExpressionIds).toEqual(['E2', 'E3'])
  })
  it('expressionUsed 不区分大小写，正则非法时返回 false', () => {
    expect(expressionUsed('A Blanket Ban would backfire.', h.expressions[2].pattern)).toBe(true)
    expect(expressionUsed('Some schools TOYED WITH it.', h.expressions[0].pattern)).toBe(true)
    expect(expressionUsed('Bans are bad.', h.expressions[2].pattern)).toBe(false)
    expect(expressionUsed('anything', '(unclosed')).toBe(false)
  })
})

describe('卡点 stuck', () => {
  const wrongThenRight = { firstTryCorrect: false, attempts: 2, correct: true }
  const cases: [string, Partial<StudentState>, string, ReturnType<typeof stuck>['level'], string | undefined][] = [
    ['没有数据 → null', {}, 'S01', null, undefined],
    ['首答对 → 0', { answers: { 'S01-q': ok } }, 'S01', 0, undefined],
    ['只有 1 个生词 → 0', { tappedWords: ['pending'] }, 'S03', 0, undefined],
    ['开到 1 级、没有生词 → 1 structure', { ladder: { S01: 1 } }, 'S01', 1, 'structure'],
    ['2 个生词 → 1 word', { tappedWords: ['pending', 'blanket'] }, 'S03', 1, 'word'],
    ['开到 1 级 + 1 个生词 → 1 word', { tappedWords: ['pending'], ladder: { S03: 1 } }, 'S03', 1, 'word'],
    ['开到 2 级 → 2 structure', { ladder: { S02: 2 } }, 'S02', 2, 'structure'],
    ['第 2 次才答对 → 2 structure', { answers: { 'S02-q': wrongThenRight } }, 'S02', 2, 'structure'],
    ['首答错、只答了 1 次 → 2', { answers: { 'S02-q': { firstTryCorrect: false, attempts: 1, correct: false } } }, 'S02', 2, 'structure'],
    ['第 2 次才答对 + 生词 → 2 mixed', { answers: { 'S02-q': wrongThenRight }, tappedWords: ['distract'] }, 'S02', 2, 'mixed'],
    ['开到 3 级 → 3 structure', { ladder: { S01: 3 } }, 'S01', 3, 'structure'],
    ['答了 2 次还没对 → 3 structure', { answers: { 'S02-q': { firstTryCorrect: false, attempts: 2, correct: false } } }, 'S02', 3, 'structure'],
    ['开到 3 级 + 2 个生词 → 3 mixed', { ladder: { S02: 3 }, tappedWords: ['distract', 'pupil'] }, 'S02', 3, 'mixed'],
    ['卡片标「认识」优先于点击', { tappedWords: ['pending', 'blanket'], wordMarks: { blanket: 'known' } }, 'S03', 0, undefined],
    ['卡片标「不认识」也算生词', { wordMarks: { pending: 'unknown', blanket: 'unknown' } }, 'S03', 1, 'word'],
  ]
  for (const [name, patch, id, level, cause] of cases) {
    it(name, () => {
      expect(stuck(h, with_(patch), id)).toEqual({ sentenceId: id, level, cause })
    })
  }
  it('整词匹配：distraction 算 distract，大小写不敏感', () => {
    expect(stuck(h, with_({ tappedWords: ['distract', 'fret'] }), 'S05').level).toBe(1)
  })
  it('未知句子 id 报错', () => {
    expect(() => stuck(h, emptyState('S-t'), 'S99')).toThrow()
  })
})

describe('点评名单 reviewPicks', () => {
  const students: StudentState[] = [
    with_({ ladder: { S03: 2 } }, 'S-a'), // 必练句 2 级 → 4 分
    with_({ ladder: { S01: 3 } }, 'S-b'), // 3 分
    with_({ answers: { 'S02-q': { firstTryCorrect: false, attempts: 2, correct: true } }, ladder: { S04: 1 } }, 'S-c'), // 2 + 1 = 3 分
    with_({ ladder: { S01: 3, S03: 3 }, answers: { 'S01-q': { firstTryCorrect: false, attempts: 2, correct: true } } }, 'S-d'), // 3 + 6 = 9 分
    with_({ tappedWords: ['fret', 'distract'] }, 'S-e'), // S05 有 2 个生词 → 1 分
    emptyState('S-f'),
    emptyState('S-g'),
    emptyState('S-h'),
  ]
  it('按分数取定向，必练/打卡句加倍，同分按 sid；原因含句子 id', () => {
    const picks = reviewPicks(h, students, { targeted: 4, random: 0, seed: 1 })
    expect(picks).toEqual([
      { sid: 'S-d', kind: 'targeted', reason: 'S03 梯子到第 3 步；S01 梯子到第 3 步，原句题第 2 次才答对' },
      { sid: 'S-a', kind: 'targeted', reason: 'S03 梯子到第 2 步' },
      { sid: 'S-b', kind: 'targeted', reason: 'S01 梯子到第 3 步' },
      { sid: 'S-c', kind: 'targeted', reason: 'S02 原句题第 2 次才答对；S04 梯子到第 1 步' },
    ])
  })
  it('其他原因短语', () => {
    const picks = reviewPicks(h, [students[4], with_({ answers: { 'S02-q': { firstTryCorrect: false, attempts: 1, correct: false } } }, 'S-x')], { targeted: 2, random: 0, seed: 1 })
    expect(picks.map((p) => p.reason)).toEqual(['S02 原句题还没答对', 'S05 有 2 个生词'])
  })
  it('没有卡点的学生不进定向名单', () => {
    const picks = reviewPicks(h, students, { targeted: 10, random: 0, seed: 1 })
    expect(picks.map((p) => p.sid)).toEqual(['S-d', 'S-a', 'S-b', 'S-c', 'S-e'])
    for (const p of picks) expect(p.reason).toMatch(/S\d\d /)
  })
  it('随机抽查对种子确定，与输入顺序无关，不与定向重复', () => {
    const opts = { targeted: 3, random: 2, seed: 42 }
    const a = reviewPicks(h, students, opts)
    expect(reviewPicks(h, students, opts)).toEqual(a)
    expect(reviewPicks(h, [...students].reverse(), opts)).toEqual(a)
    const rand = a.filter((p) => p.kind === 'random')
    expect(rand).toHaveLength(2)
    expect(rand.every((p) => p.reason === '随机抽查')).toBe(true)
    expect(new Set(a.map((p) => p.sid)).size).toBe(a.length)
    // 不同种子会抽到不同的人
    const outcomes = new Set(Array.from({ length: 20 }, (_, i) => JSON.stringify(reviewPicks(h, students, { ...opts, seed: i }))))
    expect(outcomes.size).toBeGreaterThan(1)
  })
  it('随机人数超过剩余人数时取完为止', () => {
    const picks = reviewPicks(h, students, { targeted: 4, random: 10, seed: 7 })
    expect(picks.filter((p) => p.kind === 'random').map((p) => p.sid).sort()).toEqual(['S-e', 'S-f', 'S-g', 'S-h'])
  })
})

describe('学生端文案', () => {
  // 老师讲解（teacherNote）是老师原话，原样展示，不算我们生成的文案
  const TERMS = ['倒装', '同位语', '从句', '主语', '谓语', '宾语', '定语', '状语', '语法', 'inversion', 'appositive', 'long_subject']
  it('我们生成的学生端文案里不出现语法术语，也不泄露结构标签', () => {
    for (const s of states) {
      const v = view(s)
      const json = JSON.stringify(v, (k, val) => (k === 'teacherNote' ? undefined : val))
      for (const t of TERMS) expect(json).not.toContain(t)
      for (const x of v.sentences) if (x.collapseReason) for (const t of TERMS) expect(x.collapseReason).not.toContain(t)
    }
  })
})

describe('全文词义：词表外点过的词', () => {
  const bare = Handout.parse({ ...h, lexicon: undefined }) // 10-11 之前生成的讲义没有全文词义
  const lex = Handout.parse({
    ...h,
    lexicon: {
      words: [
        { lemma: 'proposal', forms: ['proposal'], sentenceIds: ['S02'], zh: '提议', pos: 'n.' },
        { lemma: 'phone', forms: ['phones'], sentenceIds: ['S01', 'S04', 'S05'], zh: '手机', pos: 'n.' },
        { lemma: 'pending', forms: ['pending'], sentenceIds: ['S03'], zh: '待定的' }, // 和词表里的词同名：以词表为准
      ],
      provenance: { by: 'llm', model: 'm', promptVersion: 'lexicon-v1' },
    },
  })

  it('点过的词全文词义里有：进生词卡片，按点击顺序排最前、带意思；两边都没有的照样忽略', () => {
    const deck = view(with_({ tappedWords: ['proposal', 'fret', 'whatever'] }), lex).deck
    expect(deck.map((c) => c.lemma)).toEqual(['proposal', 'fret', 'pending', 'counterproductive', 'blanket'])
    expect(deck[0]).toMatchObject({ kind: 'tapped', word: { lemma: 'proposal', zh: '提议', pos: 'n.', sentenceIds: ['S02'], tier: 'other', teacherCore: false, familiarTrap: false } })
    expect(view(with_({ tappedWords: ['proposal'] }), bare).deck.some((c) => c.lemma === 'proposal')).toBe(false) // 没有全文词义的讲义还和以前一样
  })

  it('以前记的小写原词（phones）换成原形，和新记的原形只算一次', () => {
    const s = with_({ tappedWords: ['phones', 'phone'] })
    expect(view(s, lex).deck.filter((c) => c.lemma === 'phone')).toHaveLength(1)
    expect([...unknownWords(lex, s)]).toEqual(['phone'])
  })

  it('精读给不认识的全文词义里的词加注释；卡片上标了「认识」就不加', () => {
    expect(sv(with_({ tappedWords: ['proposal'] }), 'S02', lex).glosses).toContainEqual({ lemma: 'proposal', forms: ['proposal'], zh: '提议', guess: undefined })
    expect(lemmas(sv(with_({ tappedWords: ['proposal'], wordMarks: { proposal: 'known' } }), 'S02', lex).glosses)).not.toContain('proposal')
    expect(lemmas(sv(emptyState('S1'), 'S02', lex).glosses)).not.toContain('proposal') // 没点过的不加
  })

  it('lookupWord：先找词表，再按原形或原文写法找全文词义，不分大小写', () => {
    expect(lookupWord(lex, 'pending')?.zh).toBe(h.words.find((w) => w.lemma === 'pending')?.zh)
    expect(lookupWord(lex, 'Phones')?.lemma).toBe('phone')
    expect(lookupWord(lex, 'PHONE')?.lemma).toBe('phone')
    expect(lookupWord(bare, 'proposal')).toBeUndefined()
  })

  it('一个词条的写法正好是另一个词条的原形（find 的 found、founded 的 found）：按原形找到的是 found 那一条', () => {
    const hd = Handout.parse({
      ...h,
      lexicon: {
        words: [
          { lemma: 'find', forms: ['found'], sentenceIds: ['S01'], zh: '发现' },
          { lemma: 'found', forms: ['founded'], sentenceIds: ['S02'], zh: '创立' },
        ],
        provenance: { by: 'llm', model: 'm', promptVersion: 'lexicon-v1' },
      },
    })
    expect(lookupWord(hd, 'found')?.zh).toBe('创立')
    expect(lookupWord(hd, 'find')?.zh).toBe('发现')
    expect(lookupWord(hd, 'founded')?.zh).toBe('创立')
    expect(view(with_({ tappedWords: ['found'] }), hd).deck[0]).toMatchObject({ lemma: 'found', word: { zh: '创立' } })
  })

  it('每段注释名额：同一档里讲义词表的词排在全文词义的词前面', () => {
    // 内置迷你讲义：第 1 段点了 6 个全文词义里的词和词表里的 distract（都是 tier other），名额不够时 distract 先注释
    const v = view(with_({ tappedWords: ['a', 'arise', 'ban', 'be', 'class', 'clear', 'distract'] }))
    const p1 = v.sentences.filter((x) => x.paragraph === 1)
    expect(p1.flatMap((x) => lemmas(x.glosses))).toContain('distract')
    expect(p1.flatMap((x) => x.skippableWords).length).toBeGreaterThan(0)
  })

  it('卡点信号也算全文词义里的生词', () => {
    const s = with_({ tappedWords: ['proposal', 'pupil'] })
    expect(stuck(lex, s, 'S02')).toMatchObject({ level: 1, cause: 'word' })
    expect(stuck(bare, s, 'S02').level).toBe(0) // 没有全文词义时 proposal 不算
  })
})

// 阶段 6：账号上的问卷答案（profile）。目标是高考时词卡多一类「高中新词」（课标里必修、选择性必修的词），每篇最多 5 张、按原文先后排；
// 不传画像、目标不是高考时，引擎输出和以前逐字段一样
describe('画像：目标是高考时的「高中新词」卡', () => {
  const gaokao = { goal: 'gaokao' as const }
  const goal = (s: StudentState, hd: Handout = h) => personalize(hd, s, gaokao).deck.filter((c) => c.kind === 'goal')

  it('不传画像、目标不是高考、只填了年级或课程体系：任意状态下 view 逐字段和不传时一样（词卡不变，也没有 syllabusNew）', () => {
    for (const s of states) {
      const base = view(s)
      expect(personalize(h, s, undefined)).toEqual(base)
      for (const p of [{}, { goal: 'abroad' as const }, { goal: 'interest' as const }, { grade: '高三' as const, curriculum: '普通高中' as const }]) expect(personalize(h, s, p), JSON.stringify(p)).toEqual(base)
      expect(JSON.stringify(base.deck)).not.toContain('syllabusNew')
      expect(base.deck.some((c) => c.kind === 'goal')).toBe(false)
    }
  })

  it('目标是高考：原来的卡一张不少、顺序不变，高中新词卡排在最后；句子、注释、写作表达和不传时一样', () => {
    for (const s of states) {
      const base = view(s)
      const v = personalize(h, s, gaokao)
      expect(v.sentences).toEqual(base.sentences)
      expect(v.writingExpressionIds).toEqual(base.writingExpressionIds)
      expect(v.deck.slice(0, base.deck.length).map((c) => [c.lemma, c.kind, c.word])).toEqual(base.deck.map((c) => [c.lemma, c.kind, c.word]))
      expect(v.deck.slice(base.deck.length).every((c) => c.kind === 'goal')).toBe(true)
    }
  })

  it('任意状态下：每张卡都是讲义词表或全文词义里的真词；高中新词卡不超过 5 张、都是必修或选择性必修的词、不和别的卡重复、不是标了「认识」的词', () => {
    for (const s of states) {
      const deck = personalize(h, s, gaokao).deck
      for (const c of deck) expect(lookupWord(h, c.lemma)).toBe(c.word)
      const g = deck.filter((c) => c.kind === 'goal')
      expect(g.length).toBeLessThanOrEqual(5)
      for (const c of g) {
        expect([1, 2]).toContain(syllabusBand(c.lemma, c.word.zh))
        expect(c.syllabusNew).toBe(true)
        expect(s.wordMarks[c.lemma]).not.toBe('known')
      }
      expect(new Set(deck.map((c) => c.lemma)).size).toBe(deck.length)
    }
  })

  it('迷你讲义：按原文先后取前 5 个（banning → ban 在第一句），一直在词卡里的 blanket（熟词僻义）不算；标了「认识」的不出，也不往后补', () => {
    expect(goal(emptyState('S1')).map((c) => c.lemma)).toEqual(['ban', 'proposal', 'arise', 'evidence', 'prove'])
    expect(goal(with_({ wordMarks: { ban: 'known', arise: 'known' } })).map((c) => c.lemma)).toEqual(['proposal', 'evidence', 'prove'])
    expect(goal(with_({ wordMarks: { ban: 'unknown' } })).map((c) => c.lemma)[0]).toBe('ban') // 标了不认识的照样出
    expect(personalize(h, emptyState('S1'), gaokao).deck.filter((c) => c.lemma === 'blanket').map((c) => c.kind)).toEqual(['familiar_trap'])
  })

  it('点过的词：是高中新词的在「你在粗读时点过」的卡上标 syllabusNew，不再出高中新词卡；不是的不标', () => {
    const deck = personalize(h, with_({ tappedWords: ['evidence', 'pupil'] }), gaokao).deck
    expect(deck.slice(0, 2)).toMatchObject([{ lemma: 'evidence', kind: 'tapped', syllabusNew: true }, { lemma: 'pupil', kind: 'tapped' }])
    expect(deck[1]).not.toHaveProperty('syllabusNew') // pupil 是义务教育阶段的词
    expect(deck.filter((c) => c.kind === 'goal').map((c) => c.lemma)).toEqual(['ban', 'proposal', 'arise', 'prove']) // evidence 是那 5 个之一，已经在词卡里，不往后补
    for (const c of deck.filter((x) => x.kind === 'teacher_core' || x.kind === 'familiar_trap')) expect(c).not.toHaveProperty('syllabusNew')
  })

  // 每次进词汇这一步都重新算词卡（Words.tsx 进入时定下）：往后补的话，同一篇标完「认识」回来又是新的几张，标了「不认识」的下次成了单词本卡、后面又补几张
  it('每篇最多 5 张：任意状态、带不带单词本里的词，高中新词卡都在空状态的那 5 个里；同一篇来回进词汇也不会多出来', () => {
    const five = goal(emptyState('S1')).map((c) => c.lemma)
    for (const s of states) {
      for (const p of [gaokao, { ...gaokao, practicing: five }, { ...gaokao, practicing: ['claim', 'harm', 'limited'] }]) {
        for (const c of personalize(h, s, p).deck.filter((x) => x.kind === 'goal')) expect(five, `${s.sid} ${c.lemma}`).toContain(c.lemma)
      }
    }
    // 5 张全标「认识」以后再进词汇：没有新的高中新词卡
    const known = with_({ wordMarks: Object.fromEntries(five.map((l) => [l, 'known' as const])) })
    expect(goal(known)).toEqual([])
    // 5 张全标「不认识」、进了单词本以后重新打开：这 5 个是单词本卡（照样贴 syllabusNew），不再补别的高中新词卡，贴标签的一共还是 5 张
    const unknown = with_({ wordMarks: Object.fromEntries(five.map((l) => [l, 'unknown' as const])) })
    const deck = personalize(h, unknown, { ...gaokao, practicing: five }).deck
    expect(deck.filter((c) => c.kind === 'goal')).toEqual([])
    expect(deck.filter((c) => c.syllabusNew).map((c) => [c.kind, c.lemma])).toEqual(five.map((l) => ['notebook', l]))
  })

  it('人名、地名、机构名（全文词义的中文以「（人名）」「（地名）」「（机构名）」开头）、短语不出高中新词卡；义务教育阶段的词、表外词也不出', () => {
    const hd = Handout.parse({
      ...h,
      words: [],
      lexicon: {
        words: [
          { lemma: 'James', forms: ['James'], sentenceIds: ['S01'], zh: '（人名）詹姆斯' }, // 按规则会配到 jam
          { lemma: 'Bath', forms: ['Bath'], sentenceIds: ['S01'], zh: '（地名）巴斯' }, // bath 是选择性必修
          { lemma: 'toy with', forms: ['toying with'], sentenceIds: ['S01'], zh: '不太认真地考虑' },
          { lemma: 'school', forms: ['schools'], sentenceIds: ['S01'], zh: '学校' }, // 义务教育
          { lemma: 'counterproductive', forms: ['counterproductive'], sentenceIds: ['S03'], zh: '适得其反的' }, // 表外
          { lemma: 'evidence', forms: ['evidence'], sentenceIds: ['S03'], zh: '证据' },
          { lemma: 'Nations', forms: ['Nations'], sentenceIds: ['S01'], zh: '（机构名）联合国' }, // 还原成 nation，1 档（原文里没有也照样是候选，排在最后）
          { lemma: 'Journal', forms: ['Journal'], sentenceIds: ['S01'], zh: '（机构）华尔街日报' }, // journal 是 1 档
        ],
        provenance: { by: 'llm', model: 'm', promptVersion: 'lexicon-v1' },
      },
    })
    expect([syllabusBand('James'), syllabusBand('Bath'), syllabusBand('Nations'), syllabusBand('Journal')]).toEqual([2, 2, 1, 1]) // 不挡的话会被当成高中新词
    expect(goal(emptyState('S1'), hd).map((c) => c.lemma)).toEqual(['evidence'])
  })

  it('syllabusNew 只看档位 1、2：义务教育阶段、表外、人名不算', () => {
    expect([syllabusNew({ lemma: 'proposal' }), syllabusNew({ lemma: 'abandon' }), syllabusNew({ lemma: 'pupil' }), syllabusNew({ lemma: 'counterproductive' }), syllabusNew({ lemma: 'James', zh: '（人名）詹姆斯' })]).toEqual([true, true, false, false, false])
  })
})

// 阶段 7：引擎用的画像多了年级和单词本里还在练的词（practicing，服务器从事件推算，不另存）。
// 单词本里的词在这一篇出现就加注释、进词卡（「在单词本里」）；按年级给几档的词加注释（初中、高一 1、2 档，高二 2 档，高三和其他不按档）。
// 都只用这一篇自己的候选剩下的注释名额，不进「可跳过」；这一篇标了「认识」的不算；人名地名、短语没有档位
describe('画像：单词本里还在练的词、按年级加注释（阶段 7）', () => {
  const E = emptyState('S-7')
  const gl = (v: PersonalView) => v.sentences.map((x) => lemmas(x.glosses))
  const kinds = (v: PersonalView, kind: string) => v.deck.filter((c) => c.kind === kind).map((c) => c.lemma)
  const lexLemmas = (h.lexicon?.words ?? []).map((w) => w.lemma)
  // 随机状态再加几个点过的全文词义里的词，让每段的名额更紧
  const wide = states.map((s, i) => {
    const r = mulberry32(1000 + i)
    return { ...s, tappedWords: [...s.tappedWords, ...lexLemmas.filter(() => r() < 0.15)] }
  })
  const PRACTICING = ['ban', 'proposal', 'phones', 'harm', 'school', 'pupil', 'fret', 'claim', 'limited', 'toy with', 'nope']
  const profiles: LearnerProfile[] = [
    { grade: '初中' },
    { grade: '高一' },
    { grade: '高二' },
    { practicing: PRACTICING },
    { grade: '高一', goal: 'gaokao', curriculum: '普通高中', practicing: PRACTICING },
    { grade: '高二', goal: 'interest', practicing: ['phone', 'evidence', 'clear'] },
  ]

  it('不传画像：61 个状态下 view 和阶段 6 的引擎逐字段一样；画像里没起作用的（空的、高三、其他、单词本里的词这一篇没有）也一样', () => {
    // 哈希是阶段 7 开工前（阶段 6 做完）的引擎对同一批状态算的 JSON.stringify。真要改不传画像时的输出，先写清为什么，再照这个写法重算
    const json = JSON.stringify(states.map((s) => personalize(h, s)))
    expect(createHash('sha256').update(json).digest('hex')).toBe('9d8dbd2b5191f59d1585b2fb6c10678506491294a999107cf1f6016a336517a1')
    for (const s of states) {
      const base = view(s)
      for (const p of [{}, { grade: '高三' as const }, { grade: '其他' as const }, { practicing: [] }, { practicing: ['nope', 'toy with'] }, { grade: '高三' as const, curriculum: 'IB' as const, practicing: [] }]) {
        expect(personalize(h, s, p), JSON.stringify(p)).toEqual(base)
      }
    }
  })

  it('传了画像（任意状态 × 几种画像）：原文逐字一致、题目原样、选项数不减；每段非必练注释不超过 5 个；可跳过的只有这一篇不认识的词；标了「认识」的不加注；卡片都是真词、不重复', () => {
    const tierOf = (l: string) => lookupWord(h, l)?.tier
    for (const s of [...states, ...wide]) {
      const U = unknownWords(h, s)
      const wrong = (l: string) => {
        const w = h.words.find((x) => x.lemma === l)
        return !!w?.guess && s.answers[w.guess.id]?.firstTryCorrect === false
      }
      for (const p of profiles) {
        const v = personalize(h, s, p)
        const tag = `${s.sid} ${JSON.stringify(p)}`
        v.sentences.forEach((x, i) => {
          const orig = h.sentences[i]
          expect(x.id).toBe(orig.id)
          expect(x.text, tag).toBe(orig.text)
          expect(x.question).toEqual(orig.question)
          expect(x.question?.options.length).toBe(orig.question?.options.length)
          for (const l of x.skippableWords) expect(U.has(l), `${tag} ${l}`).toBe(true) // 画像多出来的词不进「可跳过」
          for (const g of x.glosses) if (s.wordMarks[g.lemma] === 'known') expect(wrong(g.lemma), `${tag} ${g.lemma}`).toBe(true) // 猜错后点「认识」的照旧加注
        })
        for (const n of [1, 2]) {
          const inPara = v.sentences.filter((x) => x.paragraph === n)
          expect(inPara.reduce((k, x) => k + x.glosses.filter((g) => tierOf(g.lemma) !== 'must').length, 0), tag).toBeLessThanOrEqual(5)
        }
        for (const c of v.deck) expect(lookupWord(h, c.lemma)).toBe(c.word)
        expect(new Set(v.deck.map((c) => c.lemma)).size).toBe(v.deck.length)
        for (const l of kinds(v, 'notebook')) expect(s.wordMarks[l], tag).not.toBe('known')
        expect(v.writingExpressionIds).toEqual(view(s).writingExpressionIds)
      }
    }
  })

  it('按年级：初中、高一加注 1、2 档，高二只加注 2 档；用这一篇自己的候选剩下的名额，排序照旧（这里同类按字母序）；没轮到的不加注，也不放进「可跳过」', () => {
    const one = [['ban'], ['arise', 'proposal'], ['pending', 'counterproductive', 'blanket', 'evidence'], ['claim', 'harm', 'limited'], ['fret']]
    expect(gl(personalize(h, E, { grade: '高一' }))).toEqual(one)
    expect(gl(personalize(h, E, { grade: '初中' }))).toEqual(one)
    // 第 1 段：blanket 占 1 个名额，剩下 4 个给 arise、ban、evidence、proposal，prove（1 档）没轮到
    expect(syllabusBand('prove')).toBe(1)
    expect(personalize(h, E, { grade: '高一' }).sentences.flatMap((x) => [...lemmas(x.glosses), ...x.skippableWords])).not.toContain('prove')
    const two = personalize(h, E, { grade: '高二' })
    expect(gl(two)).toEqual([['ban'], ['arise'], ['pending', 'counterproductive', 'blanket', 'evidence'], ['claim', 'harm'], ['fret']])
    expect(two.deck).toEqual(view(E).deck) // 按年级的只加注释，不进词卡
  })

  it('人名、地名、短语不按年级加注（syllabusBand 没有档位）', () => {
    const hd = Handout.parse({
      ...h,
      words: [],
      sentences: h.sentences.map((x) => (x.id === 'S01' ? { ...x, text: 'James from Bath is toying with the idea of a ban.' } : x)),
      lexicon: {
        words: [
          { lemma: 'James', forms: ['James'], sentenceIds: ['S01'], zh: '（人名）詹姆斯' }, // 按规则会配到 jam
          { lemma: 'Bath', forms: ['Bath'], sentenceIds: ['S01'], zh: '（地名）巴斯' }, // bath 是 2 档
          { lemma: 'toy with', forms: ['toying with'], sentenceIds: ['S01'], zh: '不太认真地考虑' },
          { lemma: 'ban', forms: ['ban'], sentenceIds: ['S01'], zh: '禁令' },
        ],
        provenance: { by: 'llm', model: 'm', promptVersion: 'lexicon-v1' },
      },
    })
    expect([syllabusBand('James'), syllabusBand('Bath')]).toEqual([2, 2]) // 不挡的话会被当成 2 档
    expect(lemmas(personalize(hd, E, { grade: '初中' }).sentences[0].glosses)).toEqual(['ban'])
  })

  it('单词本里的词：这一篇里有的加注释、进词卡（「在单词本里」，按原文先后排）；写法（phones）也认得；这一篇没有的不管；原来的卡一张不少、顺序不变', () => {
    const base = view(E)
    const v = personalize(h, E, { practicing: ['proposal', 'phones', 'harm', 'nope'] })
    expect(gl(v)).toEqual([['phone'], ['proposal'], ['pending', 'counterproductive', 'blanket'], ['harm', 'phone'], ['fret']])
    expect(v.deck.slice(0, base.deck.length)).toEqual(base.deck)
    expect(v.deck.slice(base.deck.length)).toMatchObject([
      { lemma: 'phone', kind: 'notebook' },
      { lemma: 'proposal', kind: 'notebook' },
      { lemma: 'harm', kind: 'notebook' },
    ])
    expect(v.deck.some((c) => 'syllabusNew' in c)).toBe(false) // 目标不是高考：不贴「高中新词」
  })

  // 11-08 队长定：单词本卡每篇最多 5 张，先按讲义定下那 5 个，不往后补（和高中新词卡一样）
  it('单词本卡每篇最多 5 张：单词本很大时也只出原文里最先出现的 5 个；标了「认识」的去掉，不往后补', () => {
    const all = [...new Set(h.sentences.flatMap((x) => x.text.split(/[^A-Za-z']+/)).flatMap((t) => lookupWord(h, t.toLowerCase())?.lemma ?? []))]
    expect(all.length).toBeGreaterThan(5)
    const p: LearnerProfile = { practicing: all }
    const first = kinds(personalize(h, E, p), 'notebook')
    expect(first).toHaveLength(5)
    const marked = personalize(h, with_({ wordMarks: { [first[0]]: 'known' } }), p)
    expect(kinds(marked, 'notebook')).toEqual(first.slice(1))
  })

  it('单词本里的词排在按年级的前面；这一篇标了「认识」的不加注、不进词卡；点过的照旧是「你在粗读时点过」，不再出一张', () => {
    const p: LearnerProfile = { grade: '高一', practicing: ['phone', 'school'] }
    expect(lemmas(personalize(h, E, p).sentences[0].glosses)).toEqual(['phone', 'school', 'ban'])
    expect(kinds(personalize(h, E, p), 'notebook')).toEqual(['school', 'phone'])
    const known = personalize(h, with_({ wordMarks: { phone: 'known', ban: 'known', claim: 'known' } }), p)
    for (const l of ['phone', 'ban', 'claim']) expect(known.sentences.flatMap((x) => lemmas(x.glosses)), l).not.toContain(l)
    expect(kinds(known, 'notebook')).toEqual(['school'])
    const tapped = personalize(h, with_({ tappedWords: ['phone'] }), p)
    expect(tapped.deck.filter((c) => c.lemma === 'phone').map((c) => c.kind)).toEqual(['tapped'])
  })

  it('名额满了：画像多出来的词不加注，也不放进「可跳过」，这一段和不传画像时一样', () => {
    const busy = with_({ tappedWords: ['school', 'idea', 'parent', 'screen', 'worry', 'many'] }) // 第 1 段 6 个生词，加上 blanket，超过 5 个
    const p1 = (v: PersonalView) => v.sentences.filter((x) => x.paragraph === 1)
    const base = view(busy)
    expect(p1(base).flatMap((x) => x.skippableWords).length).toBeGreaterThan(0)
    expect(p1(personalize(h, busy, { grade: '初中', practicing: ['proposal', 'ban'] }))).toEqual(p1(base))
  })

  it('单词本里的词跨篇只按原形认：第一篇的 found（创立）不会被第二篇里 find 的写法 found 认走；写法能按规则还原成原形的才认（phones → phone、banning → ban）', () => {
    const lex = (words: { lemma: string; forms: string[]; zh: string }[]) => ({ words: words.map((w) => ({ ...w, sentenceIds: ['S01'] })), provenance: { by: 'llm' as const, model: 'm', promptVersion: 'lexicon-v1' } })
    const S01 = 'Many schools found the idea of banning phones in class; so are some parents.'
    const B = Handout.parse({ ...h, sentences: h.sentences.map((x) => (x.id === 'S01' ? { ...x, text: S01 } : x)), lexicon: lex([{ lemma: 'find', forms: ['found'], zh: '发现' }, { lemma: 'ban', forms: ['banning'], zh: '禁止' }]) })
    expect(lookupWord(B, 'found')?.lemma).toBe('find') // 这一篇里点 found，照旧是 find（同一篇里按写法认）
    const v = personalize(B, E, { practicing: ['found', 'banning'] })
    expect(kinds(v, 'notebook')).toEqual(['ban'])
    expect(v.sentences.flatMap((x) => lemmas(x.glosses))).not.toContain('find')
    expect(personalize(B, E, { practicing: ['found'] })).toEqual(personalize(B, E)) // 单词本里只有 found：这一篇和不传画像一样
    // 这一篇也有 found（创立）这一条时，按原形认的就是它
    const C = Handout.parse({
      ...B,
      sentences: B.sentences.map((x) => (x.id === 'S02' ? { ...x, text: 'The proposal was founded on a worry that screens distract pupils.' } : x)),
      lexicon: lex([{ lemma: 'find', forms: ['found'], zh: '发现' }, { lemma: 'found', forms: ['founded'], zh: '创立' }]),
    })
    expect(personalize(C, E, { practicing: ['found'] }).deck.filter((c) => c.kind === 'notebook')).toMatchObject([{ lemma: 'found', word: { zh: '创立' } }])
  })

  it('目标是高考：单词本里的词是高中新词的也贴 syllabusNew，不再重复出一张高中新词卡', () => {
    const v = personalize(h, E, { goal: 'gaokao', practicing: ['proposal', 'phone'] })
    expect(v.deck.filter((c) => c.kind === 'notebook')).toMatchObject([{ lemma: 'phone' }, { lemma: 'proposal', syllabusNew: true }])
    expect(v.deck.find((c) => c.lemma === 'phone')).not.toHaveProperty('syllabusNew')
    expect(v.deck.filter((c) => c.lemma === 'proposal')).toHaveLength(1)
    expect(kinds(v, 'goal')).toEqual(['ban', 'arise', 'evidence', 'prove']) // proposal 是那 5 个之一，已经是单词本卡，不往后补
  })

  it('换一篇不清零：第一篇里点过、标了不认识的词进单词本（lib/notebook 从事件算），第二篇打开时加注释、进词卡；移出单词本以后就不算了', () => {
    const A = Handout.parse({ ...h, id: 'up-first', title: 'A' })
    const B = Handout.parse({ ...h, id: 'up-second', title: 'B' })
    const sid = 'u-0123456789abcdef'
    const ev = (handoutId: string, ts: number, e: Partial<LearningEvent>) => ({ sid, handoutId, ts, ...e }) as LearningEvent
    const events = [ev(A.id, 1, { type: 'tap_word', lemma: 'harm' }), ev(A.id, 2, { type: 'word_card', lemma: 'pupil', value: 'unknown' })]
    const practicing = buildNotebook([A, B], events).words.map((w) => w.lemma)
    expect([...practicing].sort()).toEqual(['harm', 'pupil'])
    const v = personalize(B, emptyState(sid), { practicing })
    expect(v.sentences.flatMap((x) => lemmas(x.glosses))).toEqual(expect.arrayContaining(['harm', 'pupil']))
    expect(kinds(v, 'notebook')).toEqual(['pupil', 'harm'])
    expect(view(emptyState(sid), B).sentences.flatMap((x) => lemmas(x.glosses))).not.toContain('harm') // 不传画像（开关关着）就没有
    const dropped = buildNotebook([A, B], [...events, ev(NOTEBOOK_ID, 3, { type: 'drop_word', lemma: 'harm' })]).words.map((w) => w.lemma)
    expect(dropped).toEqual(['pupil'])
  })

  it('PersonalView 的 JSON 里没有档位、比例、词汇量、「已掌握」这类字段：每一层的字段都是原来那些（任意状态 × 几种画像）', () => {
    const SENTENCE = ['id', 'paragraph', 'text', 'tier', 'checkIn', 'hasLadder', 'ladderMode', 'maxLadderLevel', 'breakdown', 'question', 'teacherNote', 'teacherNoteCollapsed', 'collapseReason', 'glosses', 'skippableWords']
    const keys = (x: unknown, out = new Set<string>()): Set<string> => {
      if (Array.isArray(x)) x.forEach((y) => keys(y, out))
      else if (x && typeof x === 'object') for (const [k, y] of Object.entries(x)) keys(y, out.add(k))
      return out
    }
    for (const s of states) {
      for (const p of profiles) {
        const v = personalize(h, s, p)
        expect(Object.keys(v)).toEqual(['sentences', 'deck', 'writingExpressionIds'])
        for (const x of v.sentences) {
          for (const k of Object.keys(x)) expect(SENTENCE).toContain(k)
          for (const g of x.glosses) for (const k of Object.keys(g)) expect(['lemma', 'forms', 'zh', 'guess']).toContain(k)
        }
        for (const c of v.deck) for (const k of Object.keys(c)) expect(['lemma', 'kind', 'word', 'syllabusNew']).toContain(k)
        for (const k of keys(JSON.parse(JSON.stringify(v)))) expect(k, k).not.toMatch(/band|ratio|percent|proportion|share|vocab|grade|^level|master|cefr/i)
      }
    }
    expect(Object.keys(emptyState('S1'))).not.toContain('mastered')
  })
})
