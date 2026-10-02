// ③ 学生词：只练你的词（粗读点过的 + 老师必练里你没点的 + 眼熟但换了意思的），混入 1 个假词。
// 有二选一的先猜后看；假词卡只显示单词，学生选完之后才说明它是编的词（作答先记下来，说明不影响这次判断）。
import { useState } from 'react'
import type { Handout } from '../../../shared/schema'
import { personalize } from '../../engine'
import type { DeckCard, StudentState } from '../../engine/types'
import { RichText } from '../../components/SentenceCard'
import { WordMeaning } from '../../components/WordMeaning'
import { Pill, btn } from '../../components/ui'
import type { Act } from '../../lib/store'
import { markWords, segment } from '../../lib/text'

const KIND: Record<DeckCard['kind'], [string, 'amber' | 'primary'] | undefined> = {
  tapped: ['你在粗读时点过', 'amber'],
  teacher_core: ['老师必练', 'primary'],
  familiar_trap: ['眼熟的词，新的意思', 'amber'],
  fake: undefined,
}

export function Words({ h, state, act, onNext }: { h: Handout; state: StudentState; act: Act; onNext: () => void }) {
  const [deck] = useState(() => personalize(h, state).deck) // 进入时定下卡片，练的过程中不变
  const [i, setI] = useState(0)
  const [peek, setPeek] = useState(false)
  const [fakeShown, setFakeShown] = useState(false) // 假词卡：已作答，正在显示说明
  const c = deck[i]

  if (!c) {
    const unknown = deck.filter((d) => d.word && state.wordMarks[d.lemma] === 'unknown').length
    return (
      <section className="flex flex-col gap-3 rounded-[18px] border border-line bg-surface px-[18px] py-5">
        <h1 className="m-0 text-[20px] font-bold">练完了 {deck.length} 个词</h1>
        <p className="m-0 text-[14px] leading-relaxed text-ink2">
          {unknown ? `其中 ${unknown} 个你还不认识，精读时会在原文里给它们加注释。` : '精读时，你认识的词不再加注释。'}
        </p>
        <button type="button" className={btn.primary} onClick={onNext}>
          去精读
        </button>
        <button type="button" className={btn.secondary} onClick={() => setI(0)}>
          再练一遍
        </button>
      </section>
    )
  }

  const w = c.word
  const sentence = w && h.sentences.find((x) => x.id === w.sentenceIds[0])
  const kind = KIND[c.kind]
  const waiting = !!w?.guess && !state.answers[w.guess.id] // 先猜，猜完才能标认识 / 不认识
  const next = () => {
    setI(i + 1)
    setPeek(false)
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
        <h1 className="m-0 font-serif text-[34px] font-semibold">{c.lemma}</h1>
        {w && sentence && (
          <p className="m-0 font-serif text-[18px] leading-[1.7] text-[#2B312E]">
            <RichText segs={segment(sentence.text, markWords(sentence.text, [w], 'bold'))} />
          </p>
        )}
        {w && (w.guess || peek) && <WordMeaning word={w} state={state} act={act} />}
        {w && !w.guess && !peek && (
          <button type="button" className={btn.secondary} onClick={() => setPeek(true)}>
            看意思
          </button>
        )}
        {fakeShown && (
          <div className="flex flex-col gap-1.5 rounded-xl bg-ground px-3.5 py-3 text-[14px] leading-relaxed">
            <span className="font-semibold">小提示：{c.lemma} 是我们编的词，英语里没有它。</span>
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
