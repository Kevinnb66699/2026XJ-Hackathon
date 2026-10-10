// 学生端：问卷 → 粗读 → 词汇 → 精读 → 写作 → 反馈。?seed=demo&p=A|B 加载预设画像，直接到精读（重新打开链接就是重新开始）。
// 老师上传的讲义（id 以 up- 开头）要从老师发给本班的二维码进来（?h=讲义&c=班级#/student）：本机记着这个班的座号就直接用座号的 sid，
// 没记着就先选座号（见 JoinClass）；链接里没有班级时说明要扫班级二维码，也可以「只是看看」（匿名做，不记座号，老师的预览也走这里；选座号页上的「只是看看」走同一条路）。
// 内置讲义照旧匿名。只有选了座号的作答发给服务器、写作才请 AI 检查（老师关了这个座号的 AI 也不请）；没选座号的作答只在本机
import { useEffect, useMemo, useRef, useState } from 'react'
import { CloseReading } from '../../components/SentenceCard'
import { Icon, SiteHeader, StepBar, btn, card } from '../../components/ui'
import { currentHandout as h } from '../../data'
import { PRESET_NAME, type PresetId } from '../../data/presets'
import { personalize } from '../../engine'
import { ApiError, myProgress, pad, readBinding, saveBinding, type Binding } from '../../lib/classes'
import { getParams } from '../../lib/router'
import { collectExpression, presetFromUrl, readLS, stepKey, useStudent, writeLS } from '../../lib/store'
import { noAiNote } from '../../lib/writing'
import { CloseArticle } from './CloseArticle'
import { Feedback } from './Feedback'
import { JoinClass } from './JoinClass'
import { Skim } from './Skim'
import { Survey } from './Survey'
import { Words } from './Words'
import { Writing, writingKey } from './Writing'

const STEPS = ['问卷', '粗读', '词汇', '精读', '写作', '反馈']
const CLOSE = 3

export default function StudentPage() {
  const [preset] = useState(presetFromUrl)
  const [classId] = useState(() => getParams().get('c') ?? '')
  const [saved] = useState(() => (classId ? readBinding(classId) : null)) // 打开页面时本机记着的座号
  const [seat, setSeat] = useState<Binding | null>(saved)
  const [look, setLook] = useState(false) // 点了「只是看看」（没有班级参数时、选座号页上）
  const [notice, setNotice] = useState('')
  const gated = h.id.startsWith('up-') && !preset

  // 本机记着的座号先直接用；后台确认一下座号还在：老师清空了这个座号（或这台手机的记录太旧）时后端回 401，忘掉它，回到选座号页。
  // 班级删了、讲义不再发给这个班时回 404：回到选座号页（那里提示重新扫码），本机的座号先留着，老师重新发给这个班后还能直接用。连不上就照常用。
  // 确认成功时顺便更新老师有没有开着这个座号的 AI 写作检查（旧绑定没存，先按开着算）
  useEffect(() => {
    if (!gated || !saved) return
    myProgress(h.id, classId, saved.token).then(
      ({ ai }) => {
        if (ai === saved.ai) return
        saveBinding(classId, { ...saved, ai })
        setSeat((s) => (s?.sid === saved.sid ? { ...s, ai } : s))
      },
      (e: ApiError) => {
        if (e.status === 404) return setSeat(null)
        if (e.status !== 401) return
        saveBinding(classId, null)
        setNotice('这台手机上记的座号已经不能用了（可能是老师清空了这个座号）。请重新选座号；换了手机的话，用找回码找回。')
        setSeat(null)
      },
    )
  }, [gated, saved, classId])

  if (!gated || look) return <Learn preset={preset} />
  if (seat) return <Learn key={seat.sid} seat={seat} />
  if (!classId)
    return (
      <div className="min-h-screen bg-ground">
        <SiteHeader label="学生端" />
        <main className="mx-auto flex max-w-2xl flex-col gap-4 px-4 pb-24 pt-5">
          <span className="text-[13px] text-muted">本周外刊：{h.title}</span>
          <section className={`${card} flex flex-col items-start gap-4 p-5`}>
            <p className="m-0 text-[16px] leading-relaxed">这份讲义要从老师发给你们班的二维码进入，作答才能记到你的座号上。</p>
            <button type="button" className={btn.secondary} onClick={() => setLook(true)}>
              只是看看（不记座号）
            </button>
          </section>
        </main>
      </div>
    )
  return <JoinClass classId={classId} notice={notice} onJoined={setSeat} onLook={() => setLook(true)} />
}

// 学习步骤。seat：从班级二维码进来、选好了座号（用座号的 sid，顶栏显示「07 号」，作答发给服务器）；没有就是这台设备的匿名 sid，作答只在本机
function Learn({ preset, seat }: { preset?: PresetId; seat?: Binding }) {
  const { state, act, patch } = useStudent(h, 'student', preset, seat?.sid, !!seat)
  const initialStep = () => (preset ? CLOSE : Number(readLS(stepKey(h.id, state.sid))) || 0)
  const [step, setStep] = useState(initialStep)
  const [bookOpen, setBookOpen] = useState(false)
  const view = useMemo(() => personalize(h, state), [state])

  useEffect(() => {
    writeLS(stepKey(h.id, state.sid), String(step))
  }, [state.sid, step])
  // 演示画像的 sid 固定（demo-A / demo-B）：打开时清掉上次留在本机的写作草稿，重新打开链接就是重新开始
  useEffect(() => {
    if (preset) writeLS(writingKey(h.id, state.sid), null)
  }, [preset, state.sid])
  useEffect(() => {
    window.scrollTo(0, 0)
  }, [step])
  // 真实学生每进入一步记一条 page_view（诊断用，不改状态；没选座号的不发出去）。记住上一次发的 sid+步，StrictMode 重跑 effect 也不重复发
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
      {/* 回上一步用步骤条，回首页点 logo */}
      <SiteHeader
        label={STEPS[step]}
        actions={
          <>
            {seat && <span className="shrink-0 text-[13px] font-semibold text-ink2">{pad(seat.seat)} 号</span>}
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
          </>
        }
      />
      <StepBar steps={STEPS} current={step} onPick={goStep} note={`本周外刊：${h.title}`} />

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

      <main className={`mx-auto flex max-w-2xl flex-col gap-3.5 px-4 pb-24 pt-4 ${step === 1 || step === 3 ? 'lg:max-w-6xl lg:px-8' : ''}`}>
        <span className="text-[13px] text-muted sm:hidden">本周外刊：{h.title}</span>
        {preset && <span className="text-[12px] text-muted">演示画像：{PRESET_NAME[preset]}（只在本机，不计入老师端）</span>}
        {step === 0 && (
          <Survey
            initial={state.survey}
            onDone={(survey) => {
              patch((s) => ({ ...s, survey }))
              goStep(1)
            }}
            onSkip={() => goStep(1)}
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
        {step === 4 && <Writing h={h} sid={state.sid} ids={view.writingExpressionIds} noAi={noAiNote(seat)} act={act} onNext={() => goStep(5)} />}
        {step === 5 && <Feedback act={act} local={!seat} />}
      </main>
    </div>
  )
}
