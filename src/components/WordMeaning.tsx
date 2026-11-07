// 词义。词汇卡上先猜后看（WordGuess）：有二选一的先猜，猜完再显示中文和英文释义（核心词的英文是老师给的，其余是 AI 起草的）。出处只在教师端显示，学生端不需要
// 精读查词（WordMeaning head）：像查词典，只显示词、词性、中文、英文，不猜
// 来源是 AI 的标「AI 生成」：猜词题看题目自己的来源；词义没有逐条的来源，由调用的地方用 meaningByAi 算好传进来（ai）
import { useState } from 'react'
import type { Word } from '../../shared/schema'
import type { StudentState } from '../engine/types'
import type { Act } from '../lib/store'
import { AiTag, Choices, byAi } from './ui'

// 先猜一猜的框
function GuessBox({ prompt, options, answer = 0, picked, ai, onPick }: {
  prompt: string
  options: string[]
  answer?: number
  picked: number | null
  ai: boolean
  onPick: (i: number) => void
}) {
  return (
    <div className="flex flex-col gap-2 rounded-xl border border-amber-edge bg-amber-soft p-3">
      <span className="flex items-center gap-2">
        <span className="text-[12px] text-amber-dark">先猜一猜</span>
        {ai && <AiTag />}
      </span>
      <span className="text-[14px] font-semibold text-amber-dark">{prompt}</span>
      <Choices options={options} answer={answer} picked={picked} cols={2} onPick={onPick} />
    </div>
  )
}

export function WordGuess({ word, ai, state, act }: { word: Word; ai: boolean; state: StudentState; act: Act }) {
  const g = word.guess
  const rec = g ? state.answers[g.id] : undefined
  const [picked, setPicked] = useState<number | null>(null)

  if (g && !rec) {
    return (
      <GuessBox
        prompt={g.prompt}
        options={g.options}
        answer={g.answer}
        picked={picked}
        ai={byAi(g.provenance)}
        onPick={(i) => {
          setPicked(i)
          act({ type: 'answer_question', lemma: word.lemma, correct: i === g.answer, firstTry: true })
        }}
      />
    )
  }
  return <WordMeaning word={word} ai={ai} prefix={rec ? (rec.firstTryCorrect ? '猜对了：' : '正确答案是：') : ''} />
}

export function WordMeaning({ word, ai, prefix = '', head = false }: { word: Word; ai: boolean; prefix?: string; head?: boolean }) {
  return (
    <div className="flex flex-col gap-1 rounded-xl bg-ground px-3.5 py-3">
      {head && (
        <span className="font-serif text-[17px] font-semibold">
          {word.lemma}
          {word.pos && <span className="ml-1.5 font-sans text-[13px] font-normal text-muted">{word.pos}</span>}
        </span>
      )}
      <span className="text-[15px] font-semibold">
        {prefix}
        {word.zh}
        {ai && <AiTag className="ml-2 align-[2px]" />}
      </span>
      {word.en && <span className="font-serif text-[14px] text-ink2">{word.en}</span>}
    </div>
  )
}
