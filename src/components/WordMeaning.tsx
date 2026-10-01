// 词义：有二选一的先猜后看，猜完再显示中文和出处
import { useState } from 'react'
import type { Word } from '../../shared/schema'
import type { StudentState } from '../engine/types'
import type { Act } from '../lib/store'
import { Choices } from './ui'

export function WordMeaning({ word, state, act }: { word: Word; state: StudentState; act: Act }) {
  const g = word.guess
  const rec = g ? state.answers[g.id] : undefined
  const [picked, setPicked] = useState<number | null>(null)

  if (g && !rec) {
    return (
      <div className="flex flex-col gap-2 rounded-xl border border-amber-edge bg-amber-soft p-3">
        <span className="text-[14px] font-semibold text-amber-dark">先猜一猜：{g.prompt}</span>
        <Choices
          options={g.options}
          answer={g.answer}
          picked={picked}
          cols={2}
          onPick={(i) => {
            setPicked(i)
            act({ type: 'answer_question', lemma: word.lemma, correct: i === g.answer, firstTry: true })
          }}
        />
      </div>
    )
  }
  const src = word.sources[0]
  return (
    <div className="flex flex-col gap-1 rounded-xl bg-ground px-3.5 py-3">
      <span className="text-[15px] font-semibold">
        {rec ? (rec.firstTryCorrect ? '猜对了：' : '原来是：') : ''}
        {word.zh}
      </span>
      {word.en && <span className="font-serif text-[14px] text-ink2">{word.en}</span>}
      {src && (
        <span className="text-[12px] text-muted">
          出处：老师讲义 Day {src.day} · {src.section}
        </span>
      )}
    </div>
  )
}
