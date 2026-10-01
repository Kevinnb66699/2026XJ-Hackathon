// 评委模式：先做 3 道快题（讲义里前 3 道原句题），再把「评委的这一份」和预设同学 B 并排显示。
// 评委的作答会回流到老师端；同学 B 只在内存里，可以点，但不存、不回流。
import { useMemo, useState } from 'react'
import type { Sentence } from '../../shared/schema'
import { CloseReading } from '../components/SentenceCard'
import { Choices, Pill, btn, card, serifText } from '../components/ui'
import { currentHandout as h } from '../data'
import { PRESET_NAME, presetState } from '../data/presets'
import { personalize } from '../engine'
import { collectExpression, useMemoryStudent, useStudent } from '../lib/store'

export default function JudgePage() {
  const judge = useStudent(h, 'judge')
  const b = useMemoryStudent(h, () => presetState(h, 'B'))
  const quiz = h.sentences.filter((x) => x.question).slice(0, 3)
  const done = quiz.every((x) => judge.state.answers[x.question!.id])
  const [seen, setSeen] = useState(done)
  const [picked, setPicked] = useState<Record<string, number>>({})
  const view = useMemo(() => personalize(h, judge.state), [judge.state])
  const bView = useMemo(() => personalize(h, b.state), [b.state])

  // 并排显示快题所在的段落，再多一段（同类句子「先自己试」常在后面）
  const ps = quiz.map((x) => x.paragraph)
  const paragraphs = ps.length ? [...new Set(h.sentences.map((x) => x.paragraph))].filter((n) => n >= Math.min(...ps) && n <= Math.max(...ps) + 1) : undefined

  const answer = (x: Sentence, i: number) => {
    const q = x.question!
    if (judge.state.answers[q.id]) return
    const correct = i === q.answer
    setPicked((p) => ({ ...p, [x.id]: i }))
    judge.act({ type: 'answer_question', sentenceId: x.id, correct, firstTry: true })
    if (!correct && x.ladder) judge.act({ type: 'open_ladder', sentenceId: x.id, level: 1 }) // 答错：你的这一份里直接打开第 1 步
  }
  const resetAll = () => {
    judge.reset()
    b.reset()
    setPicked({})
    setSeen(false)
  }

  return (
    <div className="min-h-screen bg-ground">
      <header className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-line bg-surface px-4 py-3.5 sm:px-8">
        <a href="#/" className="text-[20px] font-bold tracking-wider text-ink">
          知适 · 评委模式
        </a>
        <span className="order-last w-full text-[15px] text-ink2 sm:order-none sm:w-auto sm:flex-1">同一份讲义，原文一字不改，每个人拿到的梯子不同</span>
        <button type="button" className={`${btn.secondary} ml-auto`} onClick={resetAll}>
          重置演示
        </button>
      </header>

      {!seen ? (
        <main className="mx-auto flex max-w-2xl flex-col gap-4 px-4 py-6">
          <div className="flex flex-col gap-1.5">
            <h1 className="m-0 text-[22px] font-bold">先做 3 道快题</h1>
            <p className="m-0 text-[14px] text-ink2">每题读一句原文，选出它的意思。答完马上看到「你的这一份」。</p>
          </div>
          {quiz.map((x, k) => {
            const q = x.question!
            return (
              <section key={x.id} className={`${card} flex flex-col gap-3 p-4`}>
                <span className="text-[13px] text-muted">
                  第 {k + 1} / {quiz.length} 题
                </span>
                <p className={`m-0 ${serifText}`}>{x.text}</p>
                <span className="text-[15px] font-semibold">{q.prompt}</span>
                <Choices options={q.options} answer={q.answer} picked={picked[x.id] ?? null} onPick={(i) => answer(x, i)} locked={!!judge.state.answers[q.id]} />
              </section>
            )
          })}
          <button
            type="button"
            className={btn.primary}
            disabled={!done}
            onClick={() => {
              setSeen(true)
              window.scrollTo(0, 0)
            }}
          >
            看你的这一份
          </button>
        </main>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2 border-b border-line bg-surface px-4 py-3 text-[14px] sm:px-8">
            <span className="font-semibold">你刚才的 3 道题：</span>
            {quiz.map((x) => {
              const ok = judge.state.answers[x.question!.id]?.firstTryCorrect
              return (
                <Pill key={x.id} tone={ok ? 'green' : 'red'}>
                  {x.question!.prompt} · {ok ? '答对' : '没答对'}
                </Pill>
              )
            })}
          </div>
          <main key={`${judge.state.sid}:${judge.epoch}`} className="mx-auto grid max-w-7xl gap-5 px-4 py-5 sm:px-8 lg:grid-cols-2">
            <div className="flex flex-col gap-3.5 rounded-2xl border-[1.5px] border-blue p-4">
              <h2 className="m-0 text-[18px] font-bold text-blue">评委的这一份</h2>
              <CloseReading h={h} view={view} state={judge.state} act={judge.act} onCollect={(id) => judge.patch(collectExpression(id))} paragraphs={paragraphs} />
            </div>
            <div className="flex flex-col gap-3.5 rounded-2xl border border-line p-4">
              <h2 className="m-0 text-[18px] font-bold">{PRESET_NAME.B}的这一份</h2>
              <CloseReading h={h} view={bView} state={b.state} act={b.act} onCollect={(id) => b.patch(collectExpression(id))} paragraphs={paragraphs} />
            </div>
          </main>
          <footer className="mx-auto flex max-w-7xl flex-wrap items-center gap-4 px-4 pb-8 text-[14px] sm:px-8">
            <span className="font-semibold">原文一字不改 · 终点相同 · 梯子不同</span>
            <span className="flex-1" />
            <a href="#/teacher" className="flex items-center gap-1.5 text-green">
              <span className="h-2 w-2 rounded-full bg-green" />
              你的作答会计入老师端热力图
            </a>
          </footer>
        </>
      )}
    </div>
  )
}
