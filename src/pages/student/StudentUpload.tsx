// #/new 贴一篇文章（学生，要登录）：贴英文原文、勾三项确认，AI 在后台生成，每 1.5 秒查一次进度；做好后「开始读」整页打开（/?h=<讲义 id>#/student：讲义是整页加载时定下的）。
// 和老师的上传页（#/upload）分开，不 import 老师的页面：学生只交原文，没有标题、重点这些可填的，也没有发班。
// 同一篇只生成一次，大家复用：已经有现成讲义的直接读、不占次数；只差标点或大小写的让学生自己选；同一篇正在生成就接上那个任务（后端判断）。
// 关掉页面再回来接着显示进度：正在生成的任务记在本机（lib/store 的 studentUploadKey，按账号分开存）。
// 上方写这周还能生成几篇；全站的免费名额用完了就说哪天恢复，贴进来的文章已经有现成讲义的照样能读。接口在 server/index.mjs
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import { articleHref } from '../../components/NotebookPage'
import StudentBar from '../../components/StudentBar'
import { AiTag, SiteHeader, btn, card } from '../../components/ui'
import { readLS, studentUploadKey, writeLS } from '../../lib/store'
import {
  getStudent,
  getUploadJob,
  getUploadStatus,
  loginHref,
  submitUpload,
  uploadRefusal,
  useStudentMe,
  type Student,
  type StudentError,
  type UploadProgress,
  type UploadStatus,
} from '../../lib/student-auth'

// 和后端一样数：去掉首尾空白后的字符数
export const MIN_CHARS = 200
export const MAX_CHARS = 8000
export const charCount = (text: string) => text.trim().length

// 北京时间的「11 月 8 日」（设备的时区不一定是北京）
export const bjMonthDay = (ms: number) => {
  const d = new Date(ms + 8 * 3600 * 1000)
  return `${d.getUTCMonth() + 1} 月 ${d.getUTCDate()} 日`
}
export const pausedText = (ms: number) => `这几天的免费生成名额用完了，${bjMonthDay(ms)}恢复。已经生成过的文章照常能读；贴进来的文章如果已经有现成讲义，也能直接读。`
export const LOST = '重新提交一次，已经生成好的会直接复用'
const FAILED = '这篇没有生成成功，可以再提交一次'

// 拒收的原因（后端的 reason）：说清为什么、怎么办。length 不在这里：后端的 length 还包括段数、句数、一句太长、一长串标点，照后端的说法显示
export const REASONS: Record<string, string> = {
  not_english: '这篇看起来不像英文文章，换一篇英文的吧',
  exam: '这篇像试卷。只贴文章正文，题目和选项不要贴进来',
  personal_info: '这篇里有手机号、身份证号或邮箱，删掉以后再贴',
  repeated: '这篇里同一句重复了太多次，看看是不是贴重了',
  unsafe: '这篇文章里有不适合在这里读的内容，换一篇吧',
}
// 限额（后端的 kind）。走到限额这一步，说明这篇还没有现成的讲义（后端先查复用）
export const KINDS: Record<string, string> = {
  week: '这篇还没有现成的讲义。这周的生成次数用完了，下周一恢复',
  busy: '你还有一篇正在生成，等它做好再贴下一篇',
  fails: '今天没生成成功的次数太多了，明天再试吧',
  spend: '这篇还没有现成的讲义，要等免费名额恢复以后才能生成',
  crowded: '现在同时在生成的文章有点多，过几分钟再试',
}

// 提交被拒、查进度出错时给学生看的话：任务丢了说重新提交；有 reason、kind 的用上面的说法；别的照后端的中文提示
export function refusalText(e: unknown): string {
  const r = uploadRefusal(e)
  if (r.lost) return LOST
  if (r.reason && REASONS[r.reason]) return REASONS[r.reason]
  if (r.kind && KINDS[r.kind]) return KINDS[r.kind]
  return e instanceof Error && e.message ? e.message : FAILED
}

// 进度：后端给的中文进度照用；给的是管线的进度对象（stage、done、total）就照老师上传页的说法写，学生这边叫「提示」。只有对象带得出百分比
export function progressOf(p?: UploadProgress): { text: string; pct?: number } {
  if (!p) return { text: '准备中' }
  if (typeof p === 'string') return { text: p }
  if (p.stage === 'split') return { text: '把文章切成句子', pct: 5 }
  if (p.stage === 'draft') {
    const total = Math.max(p.total ?? 1, 1)
    const done = Math.min(p.done ?? 0, total)
    return { text: `AI 在写第 ${Math.min(done + 1, total)} / ${total} 段的提示和题目`, pct: 10 + Math.round((70 * done) / total) }
  }
  if (p.stage === 'repair') return { text: '改掉和原文对不上的地方', pct: 85 }
  if (p.stage === 'validate') return { text: '逐条对照原文检查', pct: 95 }
  return { text: '快好了', pct: 98 }
}

// 三项都要勾上才能提交（后端也要 confirm）
export const CONFIRMS = ['这篇不是还没公开的考试题或学校内部资料', '这篇不含自己或别人的个人信息', '我有权使用这篇文章']

const input = 'w-full rounded-xl border border-line-strong bg-surface px-3 py-2.5 text-[16px] text-ink focus:border-primary focus:outline-none'

export default function StudentUploadPage() {
  const { loading, student } = useStudentMe()
  return (
    <div className="min-h-screen bg-ground">
      <SiteHeader label="贴一篇文章" actions={<StudentBar />} />
      <main className="mx-auto flex max-w-2xl flex-col gap-4 px-4 pb-24 pt-5">
        {loading ? (
          <p className="m-0 text-[14px] text-muted">正在加载……</p>
        ) : student ? (
          <Compose key={student.sid} me={student} />
        ) : (
          <section className={`${card} flex flex-col items-start gap-4 p-5`}>
            <p className="m-0 text-[16px] leading-relaxed">贴进来的文章记在账号上，登录后才能贴。</p>
            <a href={loginHref('#/new')} className={`${btn.primary} inline-flex items-center no-underline`}>
              登录
            </a>
          </section>
        )}
      </main>
    </div>
  )
}

// result：做好了（reused 为假），或者已经有现成的讲义（reused）
type Result = { handoutId: string; reused: boolean }
const savedJob = (key: string) => {
  const v = readLS(key)
  return v && /^[a-z0-9-]{1,64}$/.test(v) ? v : null
}

function Compose({ me }: { me: Student }) {
  const key = studentUploadKey(me.sid)
  const [status, setStatus] = useState<UploadStatus | null>(null)
  const [statusError, setStatusError] = useState('')
  const [pausedUntil, setPausedUntil] = useState<number>()
  const [text, setText] = useState('')
  const [checks, setChecks] = useState(CONFIRMS.map(() => false))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [similar, setSimilar] = useState<{ handoutId: string; title: string } | null>(null)
  const [jobId, setJobId] = useState(() => savedJob(key))
  const [progress, setProgress] = useState<UploadProgress>()
  const [result, setResult] = useState<Result | null>(null)
  const errorRef = useRef<HTMLParagraphElement>(null)

  // 这周还能生成几篇、全站停了没有：打开时、生成完、被拒以后都重新问一次
  const loadStatus = useCallback(
    () =>
      getUploadStatus().then(
        (s) => {
          setStatus(s)
          setStatusError('')
          setPausedUntil(s.pausedUntil)
        },
        (e: StudentError) => {
          if (e.status === 401) void getStudent(true)
          setStatusError(e.message)
        },
      ),
    [],
  )
  useEffect(() => {
    void loadStatus()
  }, [loadStatus])

  // 每 1.5 秒查一次进度。连不上、服务器出错时下一轮再查；登录过期（401）时刷新登录状态（页面换成登录入口，本机记着的任务留着，登录后接着查），
  // 万一还当登录着就放慢再查。任务丢了、不是这个账号的任务（404）不再查
  useEffect(() => {
    if (!jobId) return
    let stopped = false
    let timer = 0
    const finish = () => {
      writeLS(key, null)
      setJobId(null)
      setProgress(undefined)
      void loadStatus()
    }
    const tick = async () => {
      let wait = 1500
      try {
        const r = await getUploadJob(jobId)
        if (stopped) return
        if (r.status === 'running') setProgress(r.progress)
        else {
          finish()
          if (r.status === 'done') setResult({ handoutId: r.handoutId, reused: false })
          else setError((r.reason && REASONS[r.reason]) || r.error || FAILED)
          return
        }
      } catch (err) {
        if (stopped) return
        const e = err as StudentError
        if (e.status === 401) {
          void getStudent(true)
          wait = 5000
        } else if (e.status !== 0 && e.status < 500) {
          finish()
          setError(refusalText(e))
          return
        }
      }
      timer = window.setTimeout(tick, wait)
    }
    timer = window.setTimeout(tick, 0)
    return () => {
      stopped = true
      clearTimeout(timer)
    }
  }, [jobId, key, loadStatus])

  // 出错时把提示滚到屏幕中间：手机上按钮在屏幕底部，提示常在屏幕外，看起来像没反应
  useEffect(() => {
    if (error) errorRef.current?.scrollIntoView({ block: 'center' })
  }, [error])

  // 提交。choice：只差标点或大小写时学生选的；选了「直接读那一份」就直接打开那一篇。
  // 三项勾没勾全照实发（confirm）：选「直接读」「按我贴的生成」的两个按钮不走表单的必勾检查，勾选框这时还能取消
  const send = async (choice?: 'use' | 'ignore') => {
    setError('')
    setBusy(true)
    try {
      const r = await submitUpload(text, checks.every(Boolean), choice)
      if ('similar' in r) return setSimilar(r.similar)
      setSimilar(null)
      if ('jobId' in r) {
        writeLS(key, r.jobId)
        setProgress(undefined)
        setJobId(r.jobId)
      } else if (choice === 'use') window.location.assign(articleHref(r.handoutId))
      else setResult({ handoutId: r.handoutId, reused: true })
    } catch (err) {
      const e = err as StudentError
      if (e.status === 401) void getStudent(true)
      const r = uploadRefusal(e)
      if (r.kind === 'spend' && r.resumesAt) setPausedUntil(r.resumesAt)
      setError(refusalText(e))
      if (e.status === 403 || e.status === 429) void loadStatus()
    } finally {
      setBusy(false)
    }
  }
  const onSubmit = (ev: FormEvent) => {
    ev.preventDefault()
    const n = charCount(text)
    if (n < MIN_CHARS || n > MAX_CHARS) return setError(`文章长度要在 ${MIN_CHARS} 到 ${MAX_CHARS} 个字符之间（现在 ${n} 个）`)
    void send()
  }
  const again = () => {
    setText('')
    setChecks(CONFIRMS.map(() => false))
    setResult(null)
    setSimilar(null)
    setError('')
  }

  const n = charCount(text)
  const off = !!n && (n < MIN_CHARS || n > MAX_CHARS)
  const confirmed = checks.every(Boolean)
  const closed = status?.enabled === false
  const stage = progressOf(progress)

  return (
    <>
      <h1 className="m-0 text-[22px] font-bold">贴一篇英文文章</h1>
      {!closed && pausedUntil ? (
        <p className="m-0 rounded-xl bg-amber-light px-4 py-3 text-[14px] leading-relaxed text-amber-dark">{pausedText(pausedUntil)}</p>
      ) : (
        status?.enabled && <p className="m-0 text-[15px] text-ink2">这周还能生成 {Math.max(0, status.weekLimit - status.weekUsed)} 篇，下周一恢复</p>
      )}
      {statusError && <p className="m-0 text-[14px] text-muted">{statusError}</p>}

      {jobId ? (
        <section aria-live="polite" className={`${card} flex flex-col gap-3 p-5`}>
          <span className="text-[14px] text-ink2">正在生成</span>
          <span className="text-[16px] font-semibold">{stage.text}</span>
          {stage.pct !== undefined && (
            <div className="h-2 overflow-hidden rounded-full bg-line-soft">
              <div className="h-full rounded-full bg-primary transition-[width] duration-500" style={{ width: `${stage.pct}%` }} />
            </div>
          )}
          <span className="text-[13px] text-muted">大约 1–2 分钟。关掉这一页也不会中断，回来会接着显示进度。</span>
        </section>
      ) : result ? (
        <section className={`${card} flex flex-col items-start gap-4 p-5`}>
          <p className="m-0 text-[16px] leading-relaxed">{result.reused ? '这篇已经有现成的讲义，直接读就行，不占这周的次数。' : '做好了。以后在首页的「我的文章」里也能找到这一篇。'}</p>
          <div className="flex flex-wrap gap-3">
            <a href={articleHref(result.handoutId)} className={`${btn.primary} inline-flex items-center no-underline`}>
              开始读
            </a>
            <button type="button" onClick={again} className={btn.secondary}>
              再贴一篇
            </button>
          </div>
        </section>
      ) : closed ? (
        <section className={`${card} flex flex-col items-start gap-4 p-5`}>
          <p className="m-0 text-[16px] leading-relaxed">贴文章还没开放，先读团队选的文章吧。</p>
          <a href="#/" className={`${btn.secondary} inline-flex items-center no-underline`}>
            回首页
          </a>
        </section>
      ) : (
        <form onSubmit={onSubmit} className={`${card} flex flex-col gap-4 p-5`}>
          <label className="flex flex-col gap-1.5">
            <span className="text-[14px] font-semibold">
              文章原文
              <span className="ml-2 text-[12px] font-normal text-muted">段落之间空一行，只贴正文</span>
            </span>
            <textarea
              required
              rows={12}
              value={text}
              onChange={(e) => {
                setText(e.target.value)
                setSimilar(null)
              }}
              className={`${input} font-serif leading-relaxed`}
            />
            <span className={`text-[13px] ${off ? 'text-amber-dark' : 'text-muted'}`}>
              现在 {n} 个字符，要在 {MIN_CHARS} 到 {MAX_CHARS} 之间
            </span>
          </label>
          <fieldset className="m-0 flex flex-col gap-2.5 border-0 p-0">
            <legend className="mb-1 p-0 text-[14px] font-semibold">提交前确认这三项</legend>
            {CONFIRMS.map((c, i) => (
              <label key={c} className="flex items-start gap-3 text-[15px] leading-relaxed">
                <input
                  type="checkbox"
                  required
                  checked={checks[i]}
                  onChange={(e) => setChecks((xs) => xs.map((x, j) => (j === i ? e.target.checked : x)))}
                  className="mt-0.5 h-5 w-5 shrink-0 accent-primary"
                />
                <span>{c}</span>
              </label>
            ))}
          </fieldset>
          <p className="m-0 flex items-start gap-1.5 text-[13px] leading-relaxed text-muted">
            <AiTag className="mt-px" />
            这篇的标题、题目、词义和提示由 AI 生成，可能有错。原文一字不改。
          </p>
          {similar ? (
            <div className="flex flex-col gap-3 rounded-xl bg-ground px-4 py-3">
              <p className="m-0 text-[15px] leading-relaxed [overflow-wrap:anywhere]">
                有一篇和你贴的只差标点或大小写，已经有现成的讲义{similar.title && <span className="font-serif">：{similar.title}</span>}
              </p>
              <div className="flex flex-wrap gap-3">
                <button type="button" disabled={busy || !confirmed} onClick={() => void send('use')} className={btn.primary}>
                  直接读那一份
                </button>
                <button type="button" disabled={busy || !confirmed} onClick={() => void send('ignore')} className={btn.secondary}>
                  按我贴的生成
                </button>
              </div>
              <span className="text-[13px] text-muted">{confirmed ? '直接读那一份不占这周的次数。' : '先勾上上面三项。'}</span>
            </div>
          ) : (
            <button type="submit" disabled={busy} className={btn.primary}>
              {busy ? '正在提交……' : '开始生成'}
            </button>
          )}
        </form>
      )}

      {error && (
        <p ref={errorRef} role="alert" className="m-0 rounded-xl bg-red-light px-4 py-3 text-[14px] leading-relaxed text-red-dark">
          {error}
        </p>
      )}
    </>
  )
}
