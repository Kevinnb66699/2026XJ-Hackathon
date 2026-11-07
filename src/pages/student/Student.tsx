// 学生端：问卷 → 粗读 → 词汇 → 精读 → 写作（选做）→ 小结。?seed=demo&p=A|B 加载预设画像，直接到精读（重新打开链接就是重新开始）。
// 老师上传的讲义（id 以 up- 开头）要从老师发给本班的二维码进来（?h=讲义&c=班级#/student）：本机记着这个班的学号就直接用学号的 sid，
// 没记着就先选学号（见 JoinClass）；链接里没有班级时说明要扫班级二维码，也可以「只是看看」（匿名做，不记学号，老师的预览也走这里；选学号页上的「只是看看」走同一条路）。
// 老师的「预览学生端」带 look=1，直接「只是看看」；链接里有班级（c）时不认它，免得预览链接转给学生后全班都匿名做、老师端什么都没有。
// 内置讲义照旧匿名。只有选了学号的作答发给服务器、写作才请 AI 检查（老师关了这个学号的 AI 也不请）；没选学号的作答只在本机
// 11-07 起加了学生账号，gated 的讲义分三层：链接带 c 就走学号（就算登录了账号也用学号，账号不参与）；否则用登录的学生账号（作答记在账号上）；
// 都没有就是上面那页说明（团队上架的讲义没登录时读不到，在 main.tsx 就提示登录了，到不了这里）。
// 账号模式打开一篇时先把这个账号排着的作答发完，再拉服务器上这一篇的作答重建状态、替换本机缓存（换设备接着读）；连不上就用本机缓存，页面上说明。
// 链接可以带 step（STEP_IDS 里的一个）或 jump（句子 id，到精读并滚到这一句）：文章之间一律整页跳转，用这两个参数落到指定的地方
import { useEffect, useMemo, useRef, useState } from 'react'
import { CloseReading } from '../../components/SentenceCard'
import StudentBar from '../../components/StudentBar'
import { AiTag, Icon, SiteHeader, StepBar, aiDrafted, btn, byAi, card } from '../../components/ui'
import { currentHandout as h } from '../../data'
import { PRESET_NAME, type PresetId } from '../../data/presets'
import { emptyState, personalize } from '../../engine'
import { ApiError, myProgress, pad, readBinding, saveBinding, type Binding } from '../../lib/classes'
import { drain } from '../../lib/events'
import { getParams } from '../../lib/router'
import { collectExpression, presetFromUrl, readLS, restoreState, stepKey, useStudent, writeLS } from '../../lib/store'
import { fetchMyEvents, getStudent, loginHref, useStudentMe, type Student, type StudentError } from '../../lib/student-auth'
import { noAiNote } from '../../lib/writing'
import { CloseArticle } from './CloseArticle'
import { JoinClass } from './JoinClass'
import { Skim } from './Skim'
import { Summary } from './Summary'
import { Survey } from './Survey'
import { Words } from './Words'
import { Writing, writingKey } from './Writing'

const STEPS = ['问卷', '粗读', '词汇', '精读', '写作', '小结']
const STEP_IDS = ['survey', 'skim', 'words', 'close', 'writing', 'summary'] // 链接里的 step=…
const CLOSE = 3

// 链接里的 step、jump：jump 是这一篇里有的句子 id，到精读并滚到这一句；否则看 step。都没有（或不认识）就照本机记的步骤
function fromLink(): { step?: number; jump?: string } {
  const p = getParams()
  const jump = p.get('jump')
  if (jump && h.sentences.some((x) => x.id === jump)) return { step: CLOSE, jump }
  const n = STEP_IDS.indexOf(p.get('step') ?? '')
  return n >= 0 ? { step: n } : {}
}

export default function StudentPage() {
  const [preset] = useState(presetFromUrl)
  const [classId] = useState(() => getParams().get('c') ?? '')
  const [saved] = useState(() => (classId ? readBinding(classId) : null)) // 打开页面时本机记着的学号
  const [seat, setSeat] = useState<Binding | null>(saved)
  const [preview] = useState(() => getParams().get('look') === '1' && !classId) // 老师预览
  const [look, setLook] = useState(preview) // 点了「只是看看」（没有班级参数时、选学号页上），或老师预览
  const [notice, setNotice] = useState('')
  const gated = h.id.startsWith('up-') && !preset

  // 本机记着的学号先直接用；后台确认一下学号还在：老师清空了这个学号（或这台手机的记录太旧）时后端回 401，忘掉它，回到选学号页。
  // 班级删了、讲义不再发给这个班时回 404：回到选学号页（那里提示重新扫码），本机的学号先留着，老师重新发给这个班后还能直接用。连不上就照常用。
  // 确认成功时顺便更新老师有没有开着这个学号的 AI 写作检查（旧绑定没存，先按开着算）
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
        setNotice('这台手机上记的学号已经不能用了（可能是老师清空了这个学号）。请重新选学号；换了手机的话，用找回码找回。')
        setSeat(null)
      },
    )
  }, [gated, saved, classId])

  if (!gated || look) return <Learn preset={preset} preview={preview} />
  if (seat) return <Learn key={seat.sid} seat={seat} />
  if (!classId) return <ByLogin onLook={() => setLook(true)} />
  return <JoinClass classId={classId} notice={notice} onJoined={setSeat} onLook={() => setLook(true)} />
}

// 链接里没有班级：登录了学生账号就用账号读；没登录（或会话过期了）说明要扫班级二维码，也可以登录、「只是看看」
function ByLogin({ onLook }: { onLook: () => void }) {
  const { loading, student } = useStudentMe()
  if (student) return <Synced key={student.sid} me={student} />
  return (
    <div className="min-h-screen bg-ground">
      <SiteHeader label="学生端" />
      <main className="mx-auto flex max-w-2xl flex-col gap-4 px-4 pb-24 pt-5">
        <span className="text-[13px] text-muted">本周外刊：{h.title}</span>
        {loading ? (
          <p className="m-0 text-[14px] text-muted">正在加载……</p>
        ) : (
          <section className={`${card} flex flex-col items-start gap-4 p-5`}>
            <p className="m-0 text-[16px] leading-relaxed">这份讲义要从老师发给你们班的二维码进入，作答才能记到你的学号上。</p>
            <p className="m-0 text-[15px] leading-relaxed text-ink2">有知适账号的同学，登录后作答记在账号上。</p>
            <div className="flex flex-wrap gap-3">
              <a href={loginHref(`${window.location.pathname}${window.location.search}${window.location.hash}`)} className={`${btn.secondary} inline-flex items-center no-underline`}>
                登录
              </a>
              <button type="button" className={btn.secondary} onClick={onLook}>
                只是看看（不记学号）
              </button>
            </div>
          </section>
        )}
      </main>
    </div>
  )
}

// 账号模式打开这一篇：先把排着的作答发完（发不完就不拉，免得服务器上的旧记录盖掉还没发出去的作答），再拉服务器上的重建状态，存进本机。
// 本机没记着读到哪一步（换了设备）时，用最后一次进入的那一步（page_view 记的步骤名）。没登录（401）就刷新登录状态，回到上面那页
async function sync(sid: string): Promise<boolean> {
  if (!(await drain(sid))) return false
  const events = await fetchMyEvents(h.id).catch((e: StudentError) => {
    if (e.status === 401) void getStudent(true)
    return null
  })
  if (!events) return false
  restoreState(h, sid, events)
  const last = events.filter((e) => e.type === 'page_view').sort((a, b) => a.ts - b.ts).pop()
  const n = STEPS.indexOf(last?.value ?? '')
  if (readLS(stepKey(h.id, sid)) === null && n >= 0) writeLS(stepKey(h.id, sid), String(n))
  return true
}

function Synced({ me }: { me: Student }) {
  const [synced, setSynced] = useState<boolean | null>(null) // null：还在同步
  useEffect(() => {
    let alive = true
    void sync(me.sid).then((ok) => alive && setSynced(ok))
    return () => {
      alive = false
    }
  }, [me.sid])
  if (synced === null)
    return (
      <div className="min-h-screen bg-ground">
        <SiteHeader label="学生端" />
        <main className="mx-auto flex max-w-2xl flex-col gap-4 px-4 pb-24 pt-5">
          <p className="m-0 text-[14px] text-muted">正在同步你的作答……</p>
        </main>
      </div>
    )
  return <Learn me={me} offline={!synced} />
}

// 学习步骤。seat：从班级二维码进来、选好了学号（用学号的 sid，顶栏显示「07 号」，作答发给服务器）；
// me：登录的学生账号（用账号的 sid，顶栏显示用户名，作答发给服务器；offline：打开时没连上服务器，用的是本机缓存）；都没有就是这台设备的匿名 sid，作答只在本机
// preview：老师预览，页面上一直说明作答不进老师端
function Learn({ preset, seat, preview, me, offline }: { preset?: PresetId; seat?: Binding; preview?: boolean; me?: Student; offline?: boolean }) {
  const { state, act, patch } = useStudent(h, 'student', preset, seat?.sid ?? me?.sid, !!seat || !!me)
  const [link] = useState(fromLink)
  const initialStep = () => (preset ? CLOSE : link.step ?? (Number(readLS(stepKey(h.id, state.sid))) || 0))
  const [step, setStep] = useState(initialStep)
  const [bookOpen, setBookOpen] = useState(false)
  const [jump, setJump] = useState<string | null>(link.jump ?? null) // 小结里点了「接着读」、链接带 jump：到精读后滚到这一句
  const view = useMemo(() => personalize(h, state), [state])
  const example = !preset && !h.id.startsWith('up-') // 示例文章（内置讲义）：作答只在本机，小结页可以从头再读一遍

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
  // 要在上面那个回到顶部之后滚，所以写在它后面，等卡片画出来再滚
  useEffect(() => {
    if (step !== CLOSE || !jump) return
    requestAnimationFrame(() => document.querySelector(`[data-sentence="${jump}"]`)?.scrollIntoView({ block: 'start' }))
    setJump(null)
  }, [step, jump])
  // 真实学生每进入一步记一条 page_view（诊断用，不改状态；没选学号的不发出去）。记住上一次发的 sid+步，StrictMode 重跑 effect 也不重复发
  const viewed = useRef('')
  useEffect(() => {
    const key = `${state.sid}:${step}`
    if (preset || viewed.current === key) return
    viewed.current = key
    act({ type: 'page_view', value: STEPS[step] })
  }, [act, preset, state.sid, step])

  const goStep = (n: number) => setStep(Math.max(0, Math.min(STEPS.length - 1, n)))
  const book = h.expressions.filter((e) => state.collectedExpressions.includes(e.id))
  // 从头再读一遍：清掉这台设备上这一篇的作答、表达本、问卷和写作草稿，回到第一步
  const restart = () => {
    if (!window.confirm('清掉这台设备上这一篇的作答，从头再读一遍？')) return
    writeLS(writingKey(h.id, state.sid), null)
    patch((s) => emptyState(s.sid))
    goStep(0)
  }

  return (
    <div className="min-h-screen bg-ground">
      {/* 回上一步用步骤条，回首页点 logo */}
      <SiteHeader
        label={STEPS[step]}
        actions={
          <>
            {seat && <span className="shrink-0 text-[13px] font-semibold text-ink2">{pad(seat.seat)} 号</span>}
            {me && <StudentBar />}
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
            <div className="flex items-center gap-2">
              <h2 className="m-0 text-[16px] font-bold">我的表达本</h2>
              {aiDrafted(h) && book.length > 0 && <AiTag />}
            </div>
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
        {/* 讲义里有 AI 生成的内容，开头说一句；具体哪块是 AI 生成的，各块标题旁有同样的标签。
            只有全文词义（讲义词表以外的词）是 AI 生成的（比如示例文章）：只说词义，不说题目、提示是 AI 写的 */}
        {(aiDrafted(h) || byAi(h.lexicon?.provenance)) && (
          <span className="flex items-start gap-1.5 text-[12px] text-muted">
            <AiTag className="mt-px" />
            {aiDrafted(h) ? '这篇的题目、词义、提示和译文由 AI 生成，可能有错。' : '这篇有些词的意思由 AI 生成，可能有错。'}
          </span>
        )}
        {preset &&<span className="text-[12px] text-muted">演示画像：{PRESET_NAME[preset]}（只在本机，不计入老师端）</span>}
        {preview && <span className="text-[12px] text-muted">预览：作答只存在本机，不进老师端。学生请扫班级二维码进入。</span>}
        {offline && <span className="text-[12px] text-muted">这次没连上服务器，先用这台设备上的记录；新的作答连上以后会记到账号上。</span>}
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
        {step === 4 && <Writing h={h} sid={state.sid} ids={view.writingExpressionIds} noAi={noAiNote(seat, me, example)} account={!!me} act={act} onNext={() => goStep(5)} />}
        {step === 5 && (
          <Summary
            h={h}
            state={state}
            act={act}
            local={!seat && !me}
            account={!!me}
            onRestart={example ? restart : undefined}
            onRead={(id) => {
              setJump(id)
              goStep(CLOSE)
            }}
            onStart={() => goStep(1)}
          />
        )}
      </main>
    </div>
  )
}
