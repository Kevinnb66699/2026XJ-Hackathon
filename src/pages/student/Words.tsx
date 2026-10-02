// ③ 词汇：只练你的词（粗读点过的 + 核心词里你没点的 + 眼熟但换了意思的），混入 1 个假词。
// 有二选一的先猜后看（之前猜过的不再猜，意思先盖住）。假词卡和真词卡长得一样：标签、词性、例句、先猜一猜都有，
// 猜了不判对错、不记录；学生标完认识 / 不认识之后才说明它是编的（作答先记下来，说明不影响这次判断）。
import { useState } from 'react'
import type { Handout } from '../../../shared/schema'
import { FAKE_CARDS, deckSummary, guessFirst, personalize, retryDeck } from '../../engine'
import type { DeckCard, StudentState } from '../../engine/types'
import { RichText } from '../../components/SentenceCard'
import { GuessBox, WordGuess, WordMeaning } from '../../components/WordMeaning'
import { Pill, btn } from '../../components/ui'
import type { Act } from '../../lib/store'
import { markWords, segment } from '../../lib/text'

const KIND: Record<DeckCard['kind'], [string, 'amber' | 'primary'] | undefined> = {
  tapped: ['你在粗读时点过', 'amber'],
  teacher_core: ['核心词', 'primary'],
  familiar_trap: ['眼熟的词，新的意思', 'amber'],
  fake: undefined,
}

export function Words({ h, state, act, onNext }: { h: Handout; state: StudentState; act: Act; onNext: () => void }) {
  const [deck, setDeck] = useState(() => personalize(h, state).deck) // 进入时定下卡片，练的过程中不变；再练一遍只留还不认识的
  const [i, setI] = useState(0)
  const [peek, setPeek] = useState(false)
  const [seen, setSeen] = useState(state.answers) // 这张卡出现时已有的作答（见 guessFirst）
  const [fakePick, setFakePick] = useState<number | null>(null) // 假词卡猜了哪个：不判对错、不记录
  const [fakeShown, setFakeShown] = useState(false) // 假词卡：已作答，正在显示说明
  const [round, setRound] = useState(1)
  const c = deck[i]

  if (!c) {
    // 和精读加注释用同一套判断：猜错的词就算点了「认识」也照样加注释，所以分开说，免得和学生刚点的「认识」对不上
    const { total, wrong, bluff } = deckSummary(h, deck, state)
    const rest = total - wrong
    const them = (n: number) => (n > 1 ? '它们' : '它')
    const summary = !total
      ? '精读时，你认识的词不再加注释。'
      : bluff
        ? `你把编出来的词点成了「认识」，这次点的「认识」先不算，精读时会给其中 ${total} 个词加注释。`
        : !wrong
          ? `其中 ${total} 个你还不认识，精读时会在原文里标出${them(total)}。`
          : !rest
            ? `其中 ${wrong} 个你第一次猜错了，精读时还会在原文里给${them(wrong)}加注释。`
            : `精读时会给其中 ${total} 个词加注释：${rest} 个你标了「不认识」，${wrong} 个你第一次猜错了。`
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
  const fake = c.kind === 'fake' ? FAKE_CARDS[c.lemma] : undefined
  const sentence = w ? h.sentences.find((x) => x.id === w.sentenceIds[0])?.text : fake?.sentence
  // 假词卡用旁边那张真词卡的标签（先看后一张），混在里面看不出来
  const kind = KIND[fake ? (deck[i + 1] ?? deck[i - 1] ?? c).kind : c.kind]
  // 假词也配词性，免得成了唯一没有词性的卡；整副卡都没有词性时（上传的文章）假词也不显示
  const pos = w ? w.pos : deck.some((d) => d.word?.pos) ? fake?.pos : undefined
  const ask = guessFirst(w, seen)
  const waiting = fake ? fakePick === null : !!w?.guess && !state.answers[w.guess.id] // 先猜，猜完才能标认识 / 不认识
  const next = () => {
    setI(i + 1)
    setPeek(false)
    setSeen(state.answers)
    setFakePick(null)
    setFakeShown(false)
  }
  const mark = (value: 'known' | 'unknown') => {
    act({ type: 'word_card', lemma: c.lemma, value })
    if (c.kind === 'fake') setFakeShown(true)
    else next()
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
        {kind && (
          <span className="self-start">
            <Pill tone={kind[1]}>{kind[0]}</Pill>
          </span>
        )}
        <h1 className="m-0 font-serif text-[34px] font-semibold">
          {c.lemma}
          {pos && (
            <>
              {' '}
              <span className="ml-1 font-sans text-[15px] font-normal text-muted">{pos}</span>
            </>
          )}
        </h1>
        {sentence && (
          <p className="m-0 font-serif text-[18px] leading-[1.7] text-[#2B312E]">
            <RichText segs={segment(sentence, markWords(sentence, [w ?? { lemma: c.lemma, forms: [c.lemma] }], 'bold'))} />
          </p>
        )}
        {fake && <GuessBox prompt={`What does “${c.lemma}” most likely mean here?`} options={fake.options} picked={fakePick} pending onPick={setFakePick} />}
        {w && ask && <WordGuess word={w} state={state} act={act} />}
        {w && !ask && peek && <WordMeaning word={w} />}
        {w && !ask && !peek && (
          <button type="button" className={btn.secondary} onClick={() => setPeek(true)}>
            看意思
          </button>
        )}
        {fakeShown && (
          <div className="flex flex-col gap-1.5 rounded-xl bg-ground px-3.5 py-3 text-[14px] leading-relaxed">
            <span className="font-semibold">小提示：{c.lemma} 是我们编的词，英语里没有它；上面的例句也是我们编的，不在原文里。</span>
            <span className="text-ink2">认识就点「认识」，不认识就点「不认识」，精读时的提示才会给在你需要的地方。</span>
          </div>
        )}
      </section>

      {fakeShown ? (
        <button type="button" className={btn.primary} onClick={next}>
          继续
        </button>
      ) : (
        <div className="grid grid-cols-2 gap-2.5">
          <button type="button" className={btn.secondary} disabled={waiting} onClick={() => mark('unknown')}>
            不认识
          </button>
          <button type="button" className={btn.primary} disabled={waiting} onClick={() => mark('known')}>
            认识
          </button>
        </div>
      )}
    </>
  )
}
