// 学生端：问卷 → 粗读 → 词汇 → 精读 → 写作 → 反馈。?seed=demo&p=A|B 加载预设画像，直接到精读。
import { useEffect, useMemo, useRef, useState } from 'react'
import { CloseReading } from '../../components/SentenceCard'
import { Icon, StepBar, TopBar, btn } from '../../components/ui'
import { currentHandout as h } from '../../data'
import { PRESET_NAME } from '../../data/presets'
import { personalize } from '../../engine'
import { go } from '../../lib/router'
import { collectExpression, presetFromUrl, readLS, stepKey, useStudent, writeLS } from '../../lib/store'
import { CloseArticle } from './CloseArticle'
import { Feedback } from './Feedback'
import { Skim } from './Skim'
import { Survey } from './Survey'
import { Words } from './Words'
import { Writing, writingKey } from './Writing'

const STEPS = ['问卷', '粗读', '词汇', '精读', '写作', '反馈']
const DAY = ['', 'Day 1 · ', 'Day 1 · ', 'Day 2–3 · ', 'Day 5 · ', '']
const CLOSE = 3

export default function StudentPage() {
  const [preset] = useState(presetFromUrl)
  const { state, act, patch, reset, epoch } = useStudent(h, 'student', preset)
  const initialStep = () => (preset ? CLOSE : Number(readLS(stepKey(h.id, state.sid))) || 0)
  const [step, setStep] = useState(initialStep)
  const [bookOpen, setBookOpen] = useState(false)
  const view = useMemo(() => personalize(h, state), [state])

  useEffect(() => {
    writeLS(stepKey(h.id, state.sid), String(step))
  }, [state.sid, step])
  useEffect(() => {
    window.scrollTo(0, 0)
  }, [step])
  // 真实学生每进入一步发一条 page_view（诊断用，不改状态）。记住上一次发的 sid+步，StrictMode 重跑 effect 也不重复发
  const viewed = useRef('')
  useEffect(() => {
    const key = `${state.sid}:${step}`
    if (preset || viewed.current === key) return
    viewed.current = key
    act({ type: 'page_view', value: STEPS[step] })
  }, [act, preset, state.sid, step])

  const goStep = (n: number) => setStep(Math.max(0, Math.min(STEPS.length - 1, n)))
  const book = h.expressions.filter((e) => state.collectedExpressions.includes(e.id))

  return (
    <div className="min-h-screen bg-ground">
      <TopBar
        title={`${DAY[step]}${STEPS[step]}`}
        subtitle={`本周外刊：${h.title}`}
        onBack={() => (step > 0 ? goStep(step - 1) : go('#/'))}
        right={
          <>
            <button
              type="button"
              onClick={() => {
                if (!bookOpen) window.scrollTo(0, 0) // 表达本在页面最上面，滚到下面再打开会看不到
                setBookOpen(!bookOpen)
              }}
              aria-expanded={bookOpen}
              className="flex h-9 shrink-0 items-center gap-1.5 rounded-full border border-line bg-surface px-3 text-[13px]"
            >
              <Icon name="book" size={16} />
              表达本 {book.length}
            </button>
            <button
              type="button"
              onClick={() => {
                // 真实学生会清空全部作答，先确认；演示画像直接回到预设
                if (!preset && !window.confirm('清空你在这份讲义里的全部作答，从问卷重新开始？')) return
                writeLS(writingKey(h.id, state.sid), null) // 写作草稿单独存，一起清掉（演示画像的 sid 不变）
                reset()
                setStep(preset ? CLOSE : 0)
                setBookOpen(false)
              }}
              className="h-9 shrink-0 px-1.5 text-[13px] text-muted"
            >
              重置演示
            </button>
          </>
        }
      />
      <StepBar steps={STEPS} current={step} onPick={goStep} />

      {bookOpen && (
        <div className="mx-auto max-w-2xl px-4 pt-3">
          <section className="flex flex-col gap-2 rounded-[14px] border border-line bg-surface p-4">
            <h2 className="m-0 text-[16px] font-bold">我的表达本</h2>
            {book.length === 0 && <p className="m-0 text-[14px] text-muted">精读时点「收进表达本」，表达会出现在这里，写作时用得上。</p>}
            {book.map((e) => (
              <div key={e.id} className="flex flex-col border-t border-line-soft pt-2">
                <span className="font-serif text-[16px]">{e.text}</span>
                <span className="text-[13px] text-ink2">{e.zh}</span>
              </div>
            ))}
          </section>
        </div>
      )}

      <main key={`${state.sid}:${epoch}`} className={`mx-auto flex max-w-2xl flex-col gap-3.5 px-4 pb-24 pt-4 ${step === 1 || step === 3 ? 'lg:max-w-6xl' : ''}`}>
        {preset && <span className="text-[12px] text-muted">演示画像：{PRESET_NAME[preset]}（只在本机，不计入老师端）</span>}
        {step === 0 && (
          <Survey
            initial={state.survey}
            onDone={(survey) => {
              patch((s) => ({ ...s, survey }))
              goStep(1)
            }}
          />
        )}
        {step === 1 && <Skim h={h} state={state} act={act} onNext={() => goStep(2)} />}
        {step === 2 && <Words h={h} state={state} act={act} onNext={() => goStep(3)} />}
        {step === 3 && (
          <CloseArticle h={h}>
            <CloseReading h={h} view={view} state={state} act={act} onCollect={(id) => patch(collectExpression(id))} />
            <button type="button" className={btn.primary} onClick={() => goStep(4)}>
              读完了，去写作
            </button>
          </CloseArticle>
        )}
        {step === 4 && <Writing h={h} sid={state.sid} ids={view.writingExpressionIds} act={act} onNext={() => goStep(5)} />}
        {step === 5 && <Feedback act={act} />}
      </main>
    </div>
  )
}
