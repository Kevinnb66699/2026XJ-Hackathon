// ③ 词汇：只练你的词（粗读点过的 + 核心词里你没点的 + 眼熟但换了意思的）。
// 有二选一的先猜后看（之前猜过的不再猜，意思先盖住）。每张卡下面是原文里这个词所在的那一句（「原文例句」）。
// 10-16 去掉了混进去的假词卡（推广时学生看不懂为什么有编出来的词）
import { useState } from 'react'
import type { Handout } from '../../../shared/schema'
import { deckSummary, guessFirst, personalize, retryDeck } from '../../engine'
import type { DeckCard, StudentState } from '../../engine/types'
import { RichText } from '../../components/SentenceCard'
import { WordGuess, WordMeaning } from '../../components/WordMeaning'
import { Pill, btn } from '../../components/ui'
import type { Act } from '../../lib/store'
import { markWords, segment } from '../../lib/text'

const KIND: Record<DeckCard['kind'], [string, 'amber' | 'primary']> = {
  tapped: ['你在粗读时点过', 'amber'],
  teacher_core: ['核心词', 'primary'],
  familiar_trap: ['眼熟的词，新的意思', 'amber'],
}

export function Words({ h, state, act, onNext }: { h: Handout; state: StudentState; act: Act; onNext: () => void }) {
  const [deck, setDeck] = useState(() => personalize(h, state).deck) // 进入时定下卡片，练的过程中不变；再练一遍只留还不认识的
  const [i, setI] = useState(0)
  const [peek, setPeek] = useState(false)
  const [seen, setSeen] = useState(state.answers) // 这张卡出现时已有的作答（见 guessFirst）
  const [round, setRound] = useState(1)
  const c = deck[i]

  if (!deck.length) {
    // 可能一个要练的词都没有：不说「练完了 0 个词」
    return (
      <section className="flex flex-col gap-3 rounded-[18px] border border-line bg-surface px-[18px] py-5">
        <h1 className="m-0 text-[20px] font-bold">这篇文章没有要你单独练的词</h1>
        <p className="m-0 text-[14px] leading-relaxed text-ink2">直接去精读吧。</p>
        <button type="button" className={btn.primary} onClick={onNext}>
          去精读
        </button>
      </section>
    )
  }

  if (!c) {
    // 和精读加注释用同一套判断：猜错的词就算点了「认识」也照样加注释，所以分开说，免得和学生刚点的「认识」对不上。
    // 不认识的词每段最多注释 5 个，多的在原文里标成灰色「可跳过」，所以数所有不认识的词时说「标出」，不说「加注释」
    const { total, wrong } = deckSummary(h, deck, state)
    const rest = total - wrong
    const them = (n: number) => (n > 1 ? '它们' : '它')
    const summary = !total
      ? '精读时，你认识的词不再加注释。'
      : !wrong
        ? `其中 ${total} 个你还不认识，精读时会在原文里标出${them(total)}。`
        : !rest
          ? `其中 ${wrong} 个你第一次猜错了，精读时还会在原文里给${them(wrong)}加注释。`
          : `精读时会在原文里标出其中 ${total} 个词：${rest} 个你标了「不认识」，${wrong} 个你第一次猜错了。`
    const again = retryDeck(h, deck, state, round === 1)
    return (
      <section className="flex flex-col gap-3 rounded-[18px] border border-line bg-surface px-[18px] py-5">
        <h1 className="m-0 text-[20px] font-bold">练完了 {deck.length} 个词</h1>
        <p className="m-0 text-[14px] leading-relaxed text-ink2">
          {summary}
        </p>
        <button type="button" className={btn.primary} onClick={onNext}>
          去精读
        </button>
        {again.length > 0 && (
          <button
            type="button"
            className={btn.secondary}
            onClick={() => {
              setDeck(again)
              setI(0)
              setRound(round + 1)
              setSeen(state.answers)
            }}
          >
            再练一遍
          </button>
        )}
      </section>
    )
  }

  const w = c.word
  const sentence = h.sentences.find((x) => x.id === w.sentenceIds[0])?.text
  const kind = KIND[c.kind]
  const ask = guessFirst(w, seen)
  const waiting = !!w.guess && !state.answers[w.guess.id] // 先猜，猜完才能标认识 / 不认识
  const mark = (value: 'known' | 'unknown') => {
    act({ type: 'word_card', lemma: c.lemma, value })
    setI(i + 1)
    setPeek(false)
    setSeen(state.answers)
  }

  return (
    <>
      <div className="flex flex-col gap-1.5">
        <div className="flex justify-between text-[13px] text-ink2">
          <span>你的生词</span>
          <span>
            {i + 1} / {deck.length}
          </span>
        </div>
        <div className="h-1.5 rounded-full bg-line">
          <div className="h-1.5 rounded-full bg-primary" style={{ width: `${((i + 1) / deck.length) * 100}%` }} />
        </div>
      </div>

      <section key={c.lemma} className="flex flex-col gap-4 rounded-[18px] border border-line bg-surface px-[18px] py-5">
        <span className="self-start">
          <Pill tone={kind[1]}>{kind[0]}</Pill>
        </span>
        <h1 className="m-0 font-serif text-[34px] font-semibold">
          {c.lemma}
          {w.pos && (
            <>
              {' '}
              <span className="ml-1 font-sans text-[15px] font-normal text-muted">{w.pos}</span>
            </>
          )}
        </h1>
        {sentence && (
          <div className="flex flex-col gap-1">
            <span className="text-[12px] text-muted">原文例句</span>
            <p className="m-0 font-serif text-[18px] leading-[1.7] text-[#2B312E]">
              <RichText segs={segment(sentence, markWords(sentence, [w], 'bold'))} />
            </p>
          </div>
        )}
        {ask && <WordGuess word={w} state={state} act={act} />}
        {!ask && peek && <WordMeaning word={w} />}
        {!ask && !peek && (
          <button type="button" className={btn.secondary} onClick={() => setPeek(true)}>
            看意思
          </button>
        )}
      </section>

      <div className="grid grid-cols-2 gap-2.5">
        <button type="button" className={btn.secondary} disabled={waiting} onClick={() => mark('unknown')}>
          不认识
        </button>
        <button type="button" className={btn.primary} disabled={waiting} onClick={() => mark('known')}>
          认识
        </button>
      </div>
    </>
  )
}
