// 老师上传文章：粘贴原文 → 后台生成（每 1.5 秒查一次进度）→ 入库报告 → 预览 → 发布，给学生链接和二维码。
// 接口见 docs/上传设计.md。不设口令：带一个本机随机生成的设备 id，后端按它限次数；上传过的讲义只记在本机。
import { useEffect, useState, type ChangeEvent, type FormEvent, type ReactNode } from 'react'
import { toDataURL } from 'qrcode'
import type { ArticleProgress as Progress, ArticleReport as Report } from '../../pipeline/article'
import { Pill, btn, card } from '../components/ui'
import { readLS, writeLS } from '../lib/store'

type Job = { status: 'running'; progress?: Progress } | { status: 'done'; handoutId: string; report: Report } | { status: 'error'; error: string }
interface Mine {
  id: string
  title: string
  createdAt: number
  published: boolean
}

const OFFLINE = '连不上服务器，请检查网络'
const DEVICE_KEY = 'zhishi:device'
const MINE_KEY = 'zhishi:uploads'
const PENDING_KEY = 'zhishi:upload-pending' // 正在生成的任务：离开页面再回来，接着查进度

// 设备 id：只用来让后端限次数，不是身份；本地存不了时每次打开页面换一个
function deviceId(): string {
  const saved = readLS(DEVICE_KEY)
  if (saved && /^[a-z0-9-]{8,64}$/.test(saved)) return saved
  const id = `dev-${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`
  writeLS(DEVICE_KEY, id)
  return id
}

function readPending(): { jobId: string; title: string } | null {
  try {
    const v = JSON.parse(readLS(PENDING_KEY) || 'null')
    return v && typeof v.jobId === 'string' && typeof v.title === 'string' ? v : null
  } catch {
    return null
  }
}

function readMine(): Mine[] {
  try {
    const v = JSON.parse(readLS(MINE_KEY) || '[]')
    return Array.isArray(v) ? v : []
  } catch {
    return []
  }
}

// 请求后端；出错时抛出服务器给的中文提示，原样显示给老师
async function api<T>(path: string, body?: unknown): Promise<T> {
  const init = body === undefined ? undefined : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
  const res = await fetch(path, init).catch(() => {
    throw new Error(OFFLINE)
  })
  const data = (await res.json().catch(() => ({}))) as T & { error?: string }
  if (!res.ok) throw new Error(data.error ?? `请求失败（${res.status}）`)
  return data
}

const linkOf = (id: string, page: 'student' | 'teacher' | 'judge') => `${window.location.origin}/?h=${id}#/${page}`
const splitBy = (s: string, sep: RegExp) => s.split(sep).map((x) => x.trim()).filter(Boolean)

function stageOf(p?: Progress): { text: string; pct: number } {
  if (!p) return { text: '准备中', pct: 2 }
  if (p.stage === 'split') return { text: '切句', pct: 5 }
  if (p.stage === 'draft') return { text: `起草第 ${Math.min(p.done + 1, p.total)} / ${p.total} 段`, pct: 10 + Math.round((70 * p.done) / Math.max(p.total, 1)) }
  if (p.stage === 'repair') return { text: '修正', pct: 85 }
  if (p.stage === 'validate') return { text: '校验', pct: 95 }
  return { text: '完成', pct: 100 }
}

const input = 'w-full rounded-xl border border-line-strong bg-surface px-3 py-2.5 text-[16px] text-ink focus:border-primary focus:outline-none'
const link = 'text-primary underline'

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-[14px] font-semibold">
        {label}
        {hint && <span className="ml-2 text-[12px] font-normal text-muted">{hint}</span>}
      </span>
      {children}
    </label>
  )
}

export default function UploadPage() {
  const [form, setForm] = useState({ title: '', text: '', mustWords: '', checkIns: '', focus: '' })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [pending] = useState(readPending)
  const [jobId, setJobId] = useState<string | null>(pending?.jobId ?? null)
  const [jobTitle, setJobTitle] = useState(pending?.title ?? '')
  const [progress, setProgress] = useState<Progress>()
  const [done, setDone] = useState<{ handoutId: string; report: Report } | null>(null)
  const [published, setPublished] = useState<{ id: string; qr: string } | null>(null)
  const [copied, setCopied] = useState(false)
  const [mine, setMine] = useState<Mine[]>(readMine)

  const set = (k: keyof typeof form) => (e: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    const v = e.target.value
    setForm((f) => ({ ...f, [k]: v }))
  }
  const saveMine = (next: Mine[]) => {
    setMine(next)
    writeLS(MINE_KEY, JSON.stringify(next.slice(0, 30)))
  }

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setError('')
    setDone(null)
    setPublished(null)
    setProgress(undefined)
    setBusy(true)
    const mustWords = splitBy(form.mustWords, /[,，、\n]/)
    const checkIns = splitBy(form.checkIns, /\n/)
    try {
      // 没填的可选项不发（JSON 里 undefined 会被去掉）
      const r = await api<{ jobId: string }>('/api/uploads', {
        device: deviceId(),
        title: form.title.trim(),
        text: form.text,
        mustWords: mustWords.length ? mustWords : undefined,
        checkIns: checkIns.length ? checkIns : undefined,
        focus: form.focus.trim() || undefined,
      })
      writeLS(PENDING_KEY, JSON.stringify({ jobId: r.jobId, title: form.title.trim() }))
      setJobTitle(form.title.trim())
      setJobId(r.jobId)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  // 每 1.5 秒查一次进度；断网时下一轮再查，其他错误停下来显示
  useEffect(() => {
    if (!jobId) return
    let stopped = false
    let timer = 0
    const tick = async () => {
      try {
        const r = await api<Job>(`/api/uploads/${encodeURIComponent(jobId)}`)
        if (stopped) return
        if (r.status === 'running') setProgress(r.progress)
        else if (r.status === 'done' || r.status === 'error') {
          setJobId(null)
          writeLS(PENDING_KEY, null)
          if (r.status === 'done') {
            setDone(r)
            saveMine([{ id: r.handoutId, title: jobTitle, createdAt: Date.now(), published: false }, ...readMine().filter((x) => x.id !== r.handoutId)])
          } else setError(r.error)
          return
        }
      } catch (err) {
        if (stopped) return
        if ((err as Error).message !== OFFLINE) {
          setJobId(null)
          writeLS(PENDING_KEY, null) // 服务器重启后任务记录会丢（404），不再查
          setError((err as Error).message)
          return
        }
      }
      timer = window.setTimeout(tick, 1500)
    }
    timer = window.setTimeout(tick, 1500)
    return () => {
      stopped = true
      clearTimeout(timer)
    }
    // jobTitle 和 jobId 同时设置，不需要因为它重新轮询
  }, [jobId])

  const publish = async (id: string) => {
    setError('')
    setBusy(true)
    try {
      await api(`/api/handouts/${encodeURIComponent(id)}/publish`, {})
      setCopied(false)
      setPublished({ id, qr: await toDataURL(linkOf(id, 'student'), { margin: 1, width: 240 }) })
      saveMine(readMine().map((x) => (x.id === id ? { ...x, published: true } : x)))
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const stage = stageOf(progress)
  const rep = done?.report
  const missing = rep?.mustWords.filter((w) => !w.found).map((w) => w.term) ?? []
  const stats: [string, number][] = rep
    ? [
        ['段落', rep.paragraphs],
        ['句子', rep.sentences],
        ['梯子', rep.ladders],
        ['原句题', rep.questions],
        ['段意题', rep.gists],
        ['注释词', rep.words],
        ['先猜后看', rep.guesses],
        ['表达', rep.expressions],
        ['打卡句', rep.checkIns.length],
      ]
    : []
  const studentLink = published ? linkOf(published.id, 'student') : ''

  return (
    <div className="min-h-screen bg-ground">
      <header className="border-b border-line bg-surface">
        <div className="mx-auto flex max-w-3xl items-center gap-4 px-4 py-3.5">
          <a href="#/" className="text-[20px] font-bold tracking-wider text-ink">
            知适 · 上传讲义
          </a>
          <a href="#/teacher" className={`${btn.small} ml-auto inline-flex items-center`}>
            回老师端
          </a>
        </div>
      </header>

      <main className="mx-auto flex max-w-3xl flex-col gap-5 px-4 py-6">
        <form onSubmit={submit} className={`${card} flex flex-col gap-4 p-5`}>
          <h1 className="m-0 text-[22px] font-bold">上传一篇英文文章</h1>
          <Field label="标题">
            <input required value={form.title} onChange={set('title')} className={input} />
          </Field>
          <Field label="文章" hint="段落之间空一行">
            <textarea required rows={12} value={form.text} onChange={set('text')} className={`${input} font-serif leading-relaxed`} />
          </Field>
          <Field label="必练词" hint="可不填，逗号或换行分隔">
            <textarea rows={2} value={form.mustWords} onChange={set('mustWords')} className={input} />
          </Field>
          <Field label="打卡句" hint="可不填，从原文复制，每行一句">
            <textarea rows={3} value={form.checkIns} onChange={set('checkIns')} className={`${input} font-serif`} />
          </Field>
          <Field label="教学重点" hint="可不填">
            <textarea rows={2} value={form.focus} onChange={set('focus')} className={input} />
          </Field>
          <button type="submit" disabled={busy || !!jobId} className={btn.primary}>
            {jobId ? '正在生成……' : '开始生成'}
          </button>
        </form>

        {error && (
          <p role="alert" className="m-0 rounded-xl bg-red-light px-4 py-3 text-[14px] leading-relaxed text-red-dark">
            {error}
          </p>
        )}

        {jobId && (
          <section aria-live="polite" className={`${card} flex flex-col gap-3 p-5`}>
            <span className="text-[16px] font-semibold">{stage.text}</span>
            <div className="h-2 overflow-hidden rounded-full bg-line-soft">
              <div className="h-full rounded-full bg-primary transition-[width] duration-500" style={{ width: `${stage.pct}%` }} />
            </div>
            {progress && 'message' in progress && <span className="text-[13px] text-muted">{progress.message}</span>}
            <span className="text-[13px] text-muted">大约需要 1–2 分钟，请不要关闭这个页面。</span>
          </section>
        )}

        {done && rep && (
          <section className={`${card} flex flex-col gap-4 p-5`}>
            <h2 className="m-0 text-[18px] font-bold">入库报告</h2>
            <dl className="m-0 grid grid-cols-3 gap-2 sm:grid-cols-5">
              {stats.map(([k, v]) => (
                <div key={k} className="rounded-xl bg-ground px-3 py-2.5">
                  <dt className="text-[12px] text-muted">{k}</dt>
                  <dd className="m-0 text-[20px] font-bold">{v}</dd>
                </div>
              ))}
            </dl>
            <p className="m-0 text-[14px] text-ink2">
              自动修正了 {rep.repaired.length} 条，剔除了 {rep.dropped.length} 条 · 用时 {rep.seconds} 秒 · {rep.model}
            </p>
            {rep.repaired.length + rep.dropped.length > 0 && (
              <details className="text-[13px] leading-relaxed text-ink2">
                <summary className="cursor-pointer text-primary">修正和剔除明细</summary>
                <ul className="m-0 mt-2 flex flex-col gap-1 pl-5">
                  {rep.repaired.map((x, i) => (
                    <li key={`r${i}`}>修正：{x}</li>
                  ))}
                  {rep.dropped.map((x, i) => (
                    <li key={`d${i}`}>剔除：{x}</li>
                  ))}
                </ul>
              </details>
            )}
            {missing.length + rep.warnings.length > 0 && (
              <ul className="m-0 flex flex-col gap-1 rounded-xl bg-amber-light px-4 py-3 text-[14px] leading-relaxed text-amber-dark">
                {missing.length > 0 && <li>必练词在原文里没找到：{missing.join('、')}</li>}
                {rep.warnings.map((w, i) => (
                  <li key={i}>{w}</li>
                ))}
              </ul>
            )}
            <div className="flex flex-wrap gap-3">
              <a href={linkOf(done.handoutId, 'student')} target="_blank" rel="noreferrer" className={`${btn.secondary} inline-flex items-center`}>
                预览学生端
              </a>
              <button type="button" disabled={busy || published?.id === done.handoutId} onClick={() => void publish(done.handoutId)} className={btn.primary}>
                {published?.id === done.handoutId ? '已发布' : '发布'}
              </button>
            </div>
          </section>
        )}

        {published && (
          <section className={`${card} flex flex-col items-center gap-4 p-5 sm:flex-row sm:items-start`}>
            <img src={published.qr} alt="学生端二维码" width={200} height={200} className="rounded-lg border border-line" />
            <div className="flex w-full min-w-0 flex-1 flex-col gap-3">
              <h2 className="m-0 text-[18px] font-bold">已发布，学生扫码就能用</h2>
              <div className="flex gap-2">
                <input readOnly aria-label="学生链接" value={studentLink} onFocus={(e) => e.target.select()} className={`${input} min-w-0 flex-1 text-[14px]`} />
                <button type="button" onClick={() => void navigator.clipboard?.writeText(studentLink).then(() => setCopied(true), () => {})} className={btn.secondary}>
                  {copied ? '已复制' : '复制'}
                </button>
              </div>
              <div className="flex flex-wrap gap-4 text-[14px]">
                <a href={linkOf(published.id, 'teacher')} target="_blank" rel="noreferrer" className={link}>
                  老师端
                </a>
                <a href={linkOf(published.id, 'judge')} target="_blank" rel="noreferrer" className={link}>
                  评委模式
                </a>
              </div>
            </div>
          </section>
        )}

        <section className="flex flex-col gap-3">
          <h2 className="m-0 text-[18px] font-bold">这台设备上传过的讲义</h2>
          {!mine.length ? (
            <p className="m-0 text-[14px] text-muted">还没有上传过讲义</p>
          ) : (
            <ul className={`${card} m-0 flex list-none flex-col p-0`}>
              {mine.map((x) => (
                <li key={x.id} className="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-t border-line-soft px-4 py-3 first:border-t-0">
                  <span className="min-w-0 flex-1 text-[15px] font-semibold">{x.title}</span>
                  <Pill tone={x.published ? 'green' : 'gray'}>{x.published ? '已发布' : '未发布'}</Pill>
                  <span className="text-[12px] text-muted">{new Date(x.createdAt).toLocaleString('zh-CN')}</span>
                  <span className="flex items-center gap-3 text-[13px]">
                    <a href={linkOf(x.id, 'student')} target="_blank" rel="noreferrer" className={link}>
                      学生端
                    </a>
                    <a href={linkOf(x.id, 'teacher')} target="_blank" rel="noreferrer" className={link}>
                      老师端
                    </a>
                    <a href={linkOf(x.id, 'judge')} target="_blank" rel="noreferrer" className={link}>
                      评委模式
                    </a>
                    {!x.published && (
                      <button type="button" disabled={busy} onClick={() => void publish(x.id)} className={btn.small}>
                        发布
                      </button>
                    )}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </main>
    </div>
  )
}
