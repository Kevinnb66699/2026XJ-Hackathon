import { describe, expect, it } from 'vitest'
import { Handout } from '../shared/schema'
import { emptyState, engine, expressionUsed, ladderMode, personalize, readingTrails, reviewPicks, stuck, unknownWords } from '../src/engine'
import { mulberry32 } from '../src/engine/prng'
import type { StudentState } from '../src/engine/types'
import { miniHandout as h } from './fixtures/mini-handout'

const FAKE_WORDS = ['brondle', 'sapture', 'flimber', 'trosk', 'glendary']

// 用种子随机生成学生状态，覆盖「任意状态」
function randomState(hd: Handout, seed: number): StudentState {
  const r = mulberry32(seed)
  const s = emptyState(`R${seed}`)
  for (const w of hd.words) {
    if (r() < 0.4) s.tappedWords.push(w.lemma)
    if (r() < 0.5) s.wordMarks[w.lemma] = r() < 0.5 ? 'known' : 'unknown'
  }
  if (r() < 0.3) s.tappedWords.push('proposal') // 不在词表里的点击
  s.fakeWordClaimedKnown = r() < 0.2
  for (const x of hd.sentences) {
    if (x.question && r() < 0.7) {
      const first = r() < 0.5
      s.answers[x.question.id] = { firstTryCorrect: first, attempts: first ? 1 : 1 + Math.ceil(r() * 3), correct: first || r() < 0.6 }
    }
    s.ladder[x.id] = ([0, 1, 2, 3] as const)[Math.floor(r() * 4)]
    if (x.checkIn) s.checkInDrafted[x.id] = r() < 0.5
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
    expect(emptyState('S1')).toEqual({ sid: 'S1', tappedWords: [], wordMarks: {}, fakeWordClaimedKnown: false, answers: {}, ladder: {}, checkInDrafted: {}, collectedExpressions: [] })
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
  it('任意状态下 must 的词都在 deck 里，且恰好 1 张假词卡', () => {
    for (const s of states) {
      const deck = view(s).deck
      for (const w of h.words.filter((x) => x.tier === 'must')) expect(deck.map((c) => c.lemma)).toContain(w.lemma)
      const fakes = deck.filter((c) => c.kind === 'fake')
      expect(fakes).toHaveLength(1)
      expect(FAKE_WORDS).toContain(fakes[0].lemma)
      expect(fakes[0].word).toBeUndefined()
    }
  })
  it('没点词时：老师必练词 → 假词插在第 3 位 → 熟词僻义', () => {
    const deck = view(emptyState('S-x')).deck
    expect(deck.map((c) => c.kind)).toEqual(['teacher_core', 'teacher_core', 'fake', 'teacher_core', 'familiar_trap'])
    expect(deck.map((c) => c.lemma).filter((_, i) => i !== 2)).toEqual(['pending', 'counterproductive', 'fret', 'blanket'])
  })
  it('点过的词按点击顺序排最前，词表外的点击忽略，重复点击只算一次', () => {
    const deck = view(with_({ tappedWords: ['pupil', 'fret', 'proposal', 'pupil'] })).deck
    expect(deck.map((c) => (c.kind === 'fake' ? 'FAKE' : c.lemma))).toEqual(['pupil', 'fret', 'FAKE', 'pending', 'counterproductive', 'blanket'])
    expect(deck.slice(0, 2).map((c) => c.kind)).toEqual(['tapped', 'tapped'])
    expect(deck[0].word?.zh).toBe('学生')
  })
  it('假词按 sid 确定性地选；词表为空时假词在第 1 位', () => {
    const fake = (sid: string, hd: Handout = h) => view(emptyState(sid), hd).deck.find((c) => c.kind === 'fake')!.lemma
    expect(fake('S17')).toBe(fake('S17'))
    expect(new Set(Array.from({ length: 30 }, (_, i) => fake(`S${i}`))).size).toBeGreaterThan(1)
    const noWords = Handout.parse({ ...h, words: [] })
    expect(view(emptyState('S1'), noWords).deck).toEqual([{ lemma: fake('S1'), kind: 'fake' }])
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
  it('交初稿前 maxLadderLevel 为 1，交初稿后为 3；非打卡句一直是 3', () => {
    expect(sv(emptyState('S-t'), 'S03').maxLadderLevel).toBe(1)
    expect(sv(with_({ checkInDrafted: { S03: false } }), 'S03').maxLadderLevel).toBe(1)
    expect(sv(with_({ checkInDrafted: { S03: true } }), 'S03').maxLadderLevel).toBe(3)
    for (const s of states) for (const x of view(s).sentences) if (!x.checkIn) expect(x.maxLadderLevel).toBe(3)
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

describe('假词与「认识」', () => {
  const allKnown = Object.fromEntries(h.words.map((w) => [w.lemma, 'known' as const]))
  it('卡片标「认识」优先于粗读点击', () => {
    const v = view(with_({ tappedWords: ['distract', 'pupil'], wordMarks: allKnown }))
    expect(v.sentences.every((x) => x.glosses.length === 0 && x.skippableWords.length === 0)).toBe(true)
  })
  it('假词被点成「认识」后，任何词都不算认识', () => {
    const s = with_({ tappedWords: ['distract', 'pupil'], wordMarks: allKnown, fakeWordClaimedKnown: true })
    expect(lemmas(sv(s, 'S03').glosses)).toEqual(['pending', 'counterproductive', 'blanket'])
    expect(lemmas(sv(s, 'S02').glosses)).toEqual(['distract', 'pupil'])
    expect(lemmas(sv(s, 'S04').glosses)).toEqual(['pupil'])
    expect(lemmas(sv(s, 'S05').glosses)).toEqual(['fret', 'distract'])
    expect(stuck(h, s, 'S02')).toEqual({ sentenceId: 'S02', level: 1, cause: 'word' })
  })
})

describe('读懂轨迹 readingTrails', () => {
  const steps = (st: StudentState) => readingTrails(h, st).map((t) => [t.tag, t.steps.map((x) => [x.sentenceId, x.outcome, x.tryFirst])])
  it('只排带原句题、至少 2 句的同类句子；没做过就是 none', () => {
    expect(steps(emptyState('S-t'))).toEqual([['appositive_that', [['S02', 'none', false], ['S04', 'none', false]]]])
  })
  it('前一句自己读懂，后一句要先自己试；没开梯子、第 2 次才答对是 retry', () => {
    const s = with_({ answers: { 'S02-q': ok, 'S04-q': { firstTryCorrect: false, attempts: 2, correct: true } } })
    expect(steps(s)).toEqual([['appositive_that', [['S02', 'own', false], ['S04', 'retry', true]]]])
    expect(readingTrails(h, s)[0].steps[1].attempts).toBe(2)
  })
  it('开了梯子后读懂是 ladder，后一句不算先自己试；开了梯子还没答对是 stuck', () => {
    const s = with_({ answers: { 'S02-q': ok }, ladder: { S02: 2, S04: 1 } })
    expect(steps(s)).toEqual([['appositive_that', [['S02', 'ladder', false], ['S04', 'stuck', false]]]])
  })
  it('tryFirst 和 ladderMode 的规则一致（任意状态）', () => {
    for (const st of states)
      for (const t of readingTrails(h, st))
        for (const x of t.steps) {
          const sentence = h.sentences.find((y) => y.id === x.sentenceId)!
          const own = st.answers[sentence.question!.id]
          if (!own || own.firstTryCorrect) expect(ladderMode(h, st, sentence) === 'tryFirst').toBe(x.tryFirst)
        }
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
      if (!s.fakeWordClaimedKnown) for (const l of Object.keys(s.wordMarks)) if (s.wordMarks[l] === 'known') U.delete(l)
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
      { sid: 'S-d', kind: 'targeted', reason: 'S03 开到第 3 级；S01 开到第 3 级，原句题第 2 次才答对' },
      { sid: 'S-a', kind: 'targeted', reason: 'S03 开到第 2 级' },
      { sid: 'S-b', kind: 'targeted', reason: 'S01 开到第 3 级' },
      { sid: 'S-c', kind: 'targeted', reason: 'S02 原句题第 2 次才答对；S04 开到第 1 级' },
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
