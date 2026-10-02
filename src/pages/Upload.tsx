// 老师上传文章：粘贴原文 → 后台生成（每 1.5 秒查一次进度）→ 入库报告 → 预览（可以按句写老师讲解，或请 AI 起草后审阅修改）→ 发布，给学生链接和二维码。
// 接口见 docs/上传设计.md。不设口令：带一个本机随机生成的设备 id，后端按它限次数；上传过的讲义只记在本机。
import { useCallback, useEffect, useRef, useState, type ChangeEvent, type FormEvent, type ReactNode } from 'react'
import { toDataURL } from 'qrcode'
import type { ArticleProgress as Progress, ArticleReport as Report } from '../../pipeline/article'
import type { Handout } from '../../shared/schema'
import { Pill, Short, SiteHeader, btn, card } from '../components/ui'
import { deviceId, readLS, writeLS } from '../lib/store'
import { findAll, noteQuote } from '../lib/text'

type Job = { status: 'running'; progress?: Progress } | { status: 'done'; handoutId: string; title: string; report: Report } | { status: 'error'; error: string }
interface Mine {
  id: string
  title: string
  createdAt: number
  published: boolean
  key?: string // 讲解的编辑口令（上传时后端给的）；没有的是这个功能之前上传的，不能写讲解
}

const OFFLINE = '连不上服务器，请检查网络'
const MINE_KEY = 'zhishi:uploads'
const PENDING_KEY = 'zhishi:upload-pending' // 正在生成的任务：离开页面再回来，接着查进度

function readPending(): { jobId: string; title: string; key?: string } | null {
  try {
    const v = JSON.parse(readLS(PENDING_KEY) || 'null')
    return v && typeof v.jobId === 'string' && typeof v.title === 'string' && (v.key === undefined || typeof v.key === 'string') ? v : null
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

// 输入框跟着内容撑高：AI 草稿常有五六行，老师不用在小框里来回滚
const fit = (el: HTMLTextAreaElement | null) => {
  if (!el) return
  el.style.height = 'auto'
  el.style.height = `${el.scrollHeight + 2}px`
}

const MAX_NOTE = 600 // 和后端 server/index.mjs 的 MAX_NOTE 一致

// 老师讲解（可选）：按句写，学生精读到这一句就能看到（有题的句子答完题才显示）。可以先请 AI 起草：只给还没有讲解的句子起草，
// 草稿只填进编辑区、标「AI 草稿」，老师看过、改好、点保存才写进讲义，学生才看得到。
// 写了讲解，这一句就和演示讲义一样：有题又不是打卡句的，第一次就读懂的同学讲解先收起；讲解里有一句「如果……某个注释词」
// （照原句写法、不带术语，见 noteQuote），这个词又正好是他不认识的，多一张「给你」便签。
// 要编辑口令（editKey，只存在上传它的那台设备上）；只发改动过的句子，两个标签页各改各的不会互相清掉
function NotesEditor({ id, editKey, onDirty }: { id: string; editKey: string; onDirty: (dirty: boolean) => void }) {
  const [h, setH] = useState<Handout | null>(null)
  const [saved, setSaved] = useState<Record<string, string>>({}) // 服务器上现在的讲解
  const [notes, setNotes] = useState<Record<string, string>>({})
  const [open, setOpen] = useState<Record<string, boolean>>({})
  const [focusId, setFocusId] = useState('') // 老师点「写讲解」「改」的那一句，输入框出来时把光标放进去
  const [loadError, setLoadError] = useState('')
  const [reload, setReload] = useState(0)
  const [status, setStatus] = useState<{ text: string; error?: boolean } | null>(null) // 保存的结果
  const [saving, setSaving] = useState(false)
  const [drafting, setDrafting] = useState(false)
  const [drafts, setDrafts] = useState<Set<string>>(new Set()) // 内容来自 AI、还没保存的句子
  const [draftMsg, setDraftMsg] = useState<{ text: string; error?: boolean } | null>(null) // 起草的结果，显示在按钮下面
  const latest = useRef(notes) // 起草要等十几秒，回来时按这时的内容判断哪些句子还空着（等的时候老师可能又写了几句）
  latest.current = notes
  const alive = useRef(true) // 编辑区关掉后不再查起草进度
  useEffect(() => {
    alive.current = true // 开发模式下组件会挂载、卸载、再挂载一次，再挂载时要设回来
    return () => {
      alive.current = false
    }
  }, [])

  useEffect(() => {
    setLoadError('')
    api<Handout>(`/api/handouts/${encodeURIComponent(id)}`).then(
      (x) => {
        const have = Object.fromEntries(x.sentences.flatMap((s) => (s.teacherNote ? [[s.id, s.teacherNote]] : [])))
        setH(x)
        setSaved(have)
        setNotes(have)
      },
      (err: Error) => setLoadError(err.message),
    )
  }, [id, reload])

  const changed = h ? h.sentences.filter((s) => (notes[s.id] ?? '').trim() !== (saved[s.id] ?? '')).map((s) => s.id) : []
  const dirty = changed.length > 0
  const draftIds = [...drafts].filter((sid) => (notes[sid] ?? '').trim()) // 被老师清空的草稿不算
  // 正在起草也算：这时换讲义，草稿回来就没地方放了
  useEffect(() => onDirty(dirty || drafting), [dirty, drafting, onDirty])
  useEffect(() => () => onDirty(false), [onDirty]) // 编辑区关掉（换一篇、开始生成）时不再算有改动
  // 有没保存的改动时，关页面、刷新先问一下
  useEffect(() => {
    if (!dirty) return
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault()
      e.returnValue = ''
    }
    // 站内链接（顶栏「老师端」、logo）换页面也会丢掉改动：点之前先问
    const guard = (e: MouseEvent) => {
      const a = (e.target as Element | null)?.closest?.('a[href^="#"]')
      if (a && !window.confirm('讲解还没保存，确定离开吗？')) e.preventDefault()
    }
    window.addEventListener('beforeunload', warn)
    document.addEventListener('click', guard, true)
    return () => {
      window.removeEventListener('beforeunload', warn)
      document.removeEventListener('click', guard, true)
    }
  }, [dirty])

  const save = async () => {
    const sent = Object.fromEntries(changed.map((sid) => [sid, (notes[sid] ?? '').trim()]))
    setSaving(true)
    setStatus(null)
    try {
      const r = await api<{ count: number }>(`/api/handouts/${encodeURIComponent(id)}/notes`, { key: editKey, notes: sent })
      setSaved((cur) => Object.fromEntries(Object.entries({ ...cur, ...sent }).filter(([, v]) => v)))
      setDrafts((cur) => new Set([...cur].filter((sid) => !(sid in sent))))
      setStatus({ text: `已保存，${r.count} 句有讲解。已经打开页面的学生要重新打开才看得到。` })
    } catch (err) {
      setStatus({ text: (err as Error).message, error: true })
    } finally {
      setSaving(false)
    }
  }

  // 请 AI 起草：后端建任务马上返回 draftId，这里每 1.5 秒查一次（模型要十几到几十秒，一个请求等太久会被线上网关掐断）。
  // 只填进这时还空着的句子（老师已经写了的、等的时候刚写的都不动），不保存
  const draft = async () => {
    setDrafting(true)
    setDraftMsg(null)
    try {
      const { draftId } = await api<{ draftId: string }>(`/api/handouts/${encodeURIComponent(id)}/notes/draft`, { device: deviceId(), key: editKey })
      let r: { status: string; notes?: Record<string, string>; error?: string } = { status: 'running' }
      for (let i = 0; i < 120 && r.status === 'running'; i++) {
        await new Promise((ok) => setTimeout(ok, 1500))
        if (!alive.current) return
        r = await api<typeof r>(`/api/notes-drafts/${draftId}`).catch((err: Error) => {
          if (err.message === OFFLINE) return { status: 'running' } // 断网时下一轮再查
          throw err
        })
      }
      if (r.status !== 'done' || !r.notes) throw new Error(r.error ?? 'AI 起草暂时不可用，可以先自己写')
      const got = r.notes
      const ids = Object.keys(got).filter((sid) => !(latest.current[sid] ?? '').trim())
      setNotes((cur) => ({ ...cur, ...Object.fromEntries(ids.map((sid) => [sid, got[sid]])) }))
      setOpen((cur) => ({ ...cur, ...Object.fromEntries(ids.map((sid) => [sid, true])) }))
      setDrafts((cur) => new Set([...cur, ...ids]))
      setDraftMsg({ text: ids.length ? `AI 起草了 ${ids.length} 句，标着「AI 草稿」。看过、改好再保存，学生才看得到。` : 'AI 这次没有起草新的讲解。' })
    } catch (err) {
      if (alive.current) setDraftMsg({ text: (err as Error).message, error: true })
    } finally {
      if (alive.current) setDrafting(false)
    }
  }
  const edit = (sid: string, v: string) => {
    setNotes({ ...notes, [sid]: v })
    setStatus(null)
  }
  const drop = (sid: string) => {
    edit(sid, '')
    setOpen({ ...open, [sid]: false })
    setDrafts(new Set([...drafts].filter((x) => x !== sid)))
  }
  const start = (sid: string) => {
    setOpen({ ...open, [sid]: true })
    setFocusId(sid)
  }

  const paragraphs = h ? [...new Set(h.sentences.map((s) => s.paragraph))] : []
  return (
    <section className={`${card} flex flex-col gap-3 p-5`}>
      <h2 className="m-0 text-[18px] font-bold">
        老师讲解（可选）{h && <span className="ml-2 text-[15px] font-normal text-ink2">{h.title}</span>}
      </h2>
      <ul className="m-0 flex flex-col gap-1 pl-5 text-[14px] leading-relaxed text-ink2">
        <li>学生精读到这一句就能看到讲解；有题的句子，答完题才显示。</li>
        <li>有题、又不是打卡句的句子：第一次就答对的同学，讲解先收起。</li>
        <li>
          「给你」便签：讲解里写一句「如果不认识 某个词……」，词照原句写法（每句下面列了能写的词），这一句里别用从句、主语这类说法。不认识这个词的同学答题前就会看到这一句，所以别在这句里写词义。
        </li>
      </ul>
      <p className="m-0 text-[14px] leading-relaxed text-ink2">可以自己写，也可以先请 AI 起草：AI 只给还没有讲解的句子写一稿，你看过、改好、点保存，学生才看得到。</p>
      {h && (
        <button type="button" disabled={drafting || saving} onClick={() => void draft()} className={`${btn.secondary} self-start`}>
          {drafting ? 'AI 正在起草……（大约半分钟）' : 'AI 起草讲解'}
        </button>
      )}
      {/* 常驻的播报区：读屏软件只念已经在页面上的区域里新出现的字 */}
      <p role="status" aria-live="polite" className={`m-0 text-[14px] empty:hidden ${draftMsg?.error ? 'text-red-dark' : 'text-ink2'}`}>
        {draftMsg?.text}
      </p>
      {!h ? (
        loadError ? (
          <div role="alert" className="flex flex-wrap items-center gap-3 text-[14px] text-red-dark">
            {loadError}
            <button type="button" onClick={() => setReload(reload + 1)} className={btn.small}>
              重试
            </button>
          </div>
        ) : (
          <span className="text-[14px] text-muted">正在读取句子……</span>
        )
      ) : (
        paragraphs.map((n) => (
          <div key={n} className="flex flex-col gap-2">
            <span className="text-[12px] text-muted">第 {n} 段</span>
            {h.sentences
              .filter((s) => s.paragraph === n)
              .map((s, k) => {
                const note = notes[s.id] ?? ''
                // 能写进「如果不认识……」的词：原句里整词出现的注释词（和学生端 personalWord 一样，不看 sentenceIds），用原句里的写法
                const nameable = h.words.flatMap((w) => w.forms.filter((f) => findAll(s.text, f).length > 0).slice(0, 1).map((f) => ({ f, forms: w.forms })))
                const hit = nameable.find((x) => noteQuote(note, x.forms))
                const tag = s.checkIn || s.tier === 'must' ? '打卡句：讲解不收起' : !s.question ? '没有题：讲解直接显示' : ''
                return (
                  <div key={s.id} className="flex flex-col gap-1.5 border-t border-line-soft pt-2 first-of-type:border-t-0">
                    <p className="m-0 font-serif text-[16px] leading-relaxed">{s.text}</p>
                    {(tag || nameable.length > 0) && (
                      <span className="text-[12px] leading-relaxed text-muted">
                        {tag}
                        {tag && nameable.length > 0 && ' · '}
                        {nameable.length > 0 && `能写进「如果不认识……」的词：${nameable.map((x) => x.f).join('、')}`}
                      </span>
                    )}
                    {draftIds.includes(s.id) && (
                      <span className="flex items-center gap-2">
                        <Pill tone="amber">AI 草稿，待你确认</Pill>
                        <button type="button" aria-label={`不要第 ${n} 段第 ${k + 1} 句的 AI 草稿`} onClick={() => drop(s.id)} className="text-[13px] text-muted underline">
                          不要这条
                        </button>
                      </span>
                    )}
                    {open[s.id] ? (
                      <>
                        <textarea
                          key={drafts.has(s.id) ? 'draft' : 'own'} // 空框被 AI 填上时重新挂载，按草稿长度撑高
                          ref={fit}
                          rows={3}
                          maxLength={MAX_NOTE}
                          autoFocus={focusId === s.id}
                          onFocus={() => focusId && setFocusId('')} // 只聚焦一次：之后这个框因为草稿状态变化重新挂载时不再抢焦点
                          aria-label={`第 ${n} 段第 ${k + 1} 句的讲解`}
                          value={note}
                          onChange={(e) => {
                            edit(s.id, e.target.value)
                            fit(e.target)
                          }}
                          placeholder="写你上课时会怎么讲这一句"
                          className={`${input} text-[15px] leading-relaxed`}
                        />
                        <span className={`text-[12px] ${note.length > MAX_NOTE - 50 ? 'text-amber-dark' : 'text-muted'}`}>
                          {note.length} / {MAX_NOTE}
                          {hit && ` · 会给不认识 ${hit.f} 的同学一张「给你」便签`}
                          {!hit && note.includes('如果') && nameable.length > 0 && ' · 这条还不会出「给你」便签：词要照原句写法，那一句别用从句、主语这类说法'}
                        </span>
                      </>
                    ) : note.trim() ? (
                      <button type="button" aria-label={`修改第 ${n} 段第 ${k + 1} 句的讲解`} onClick={() => start(s.id)} className="self-start whitespace-pre-line rounded-lg bg-note px-3 py-2 text-left text-[14px] leading-relaxed">
                        {note} <span className="ml-1 text-primary">改</span>
                      </button>
                    ) : (
                      <button type="button" aria-label={`给第 ${n} 段第 ${k + 1} 句写讲解`} onClick={() => start(s.id)} className={`${btn.small} self-start`}>
                        写讲解
                      </button>
                    )}
                  </div>
                )
              })}
          </div>
        ))
      )}
      {h && (
        // 保存栏贴在屏幕底部：句子多时不用滚到最后才能保存，也一直看得到还有几句没保存
        <div className="sticky bottom-0 -mx-5 -mb-5 flex flex-col gap-1.5 rounded-b-2xl border-t border-line bg-surface px-5 py-3">
          <button type="button" disabled={saving || drafting || !dirty} onClick={() => void save()} className={btn.primary}>
            {saving ? '正在保存……' : draftIds.length ? `保存讲解（含 ${draftIds.length} 条 AI 草稿）` : '保存讲解'}
          </button>
          {/* 出错优先，其次是还没保存的改动（比「已保存」更要紧），最后才是保存结果 */}
          <p role="status" aria-live="polite" className={`m-0 text-[13px] ${status?.error ? 'text-red-dark' : dirty ? 'text-amber-dark' : 'text-ink2'}`}>
            {status?.error ? status.text : dirty ? `有 ${changed.length} 句改了还没保存` : status?.text}
          </p>
        </div>
      )}
    </section>
  )
}

export default function UploadPage() {
  const [form, setForm] = useState({ title: '', text: '', mustWords: '', focus: '' })
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
  const [notesFor, setNotesFor] = useState<{ id: string; key: string } | null>(null) // 正在写讲解的讲义：刚生成的，或从下面的列表点开的
  const notesRef = useRef<HTMLDivElement>(null)
  const jobKey = useRef(pending?.key) // 正在生成的这篇的编辑口令
  const notesDirty = useRef(false) // 讲解编辑区有没保存的改动：换讲义、开始生成前先问
  const onNotesDirty = useCallback((d: boolean) => {
    notesDirty.current = d
  }, [])
  const leaveNotes = () => !notesDirty.current || window.confirm('讲解还没保存，确定不要了吗？')
  const errorRef = useRef<HTMLParagraphElement>(null)
  const publishedRef = useRef<HTMLElement>(null)

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
    if (!leaveNotes()) return
    setError('')
    setDone(null)
    setPublished(null)
    setNotesFor(null)
    setProgress(undefined)
    setBusy(true)
    const mustWords = splitBy(form.mustWords, /[,，、\n]/)
    try {
      // 没填的可选项不发（JSON 里 undefined 会被去掉）
      const r = await api<{ jobId: string; editKey: string }>('/api/uploads', {
        device: deviceId(),
        title: form.title.trim(),
        text: form.text,
        mustWords: mustWords.length ? mustWords : undefined,
        focus: form.focus.trim() || undefined,
      })
      writeLS(PENDING_KEY, JSON.stringify({ jobId: r.jobId, title: form.title.trim(), key: r.editKey }))
      jobKey.current = r.editKey
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
            const key = jobKey.current
            if (key && !notesDirty.current) setNotesFor({ id: r.handoutId, key }) // 正在给别的讲义写讲解、还没保存时不换
            saveMine([{ id: r.handoutId, title: r.title, createdAt: Date.now(), published: false, key }, ...readMine().filter((x) => x.id !== r.handoutId)]) // 没填标题时用后端生成的
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
  }, [jobId])

  // 出错时把错误条滚到屏幕中间：手机上按钮在屏幕底部，错误条常在屏幕外，看起来像没反应
  useEffect(() => {
    if (error) errorRef.current?.scrollIntoView({ block: 'center' })
  }, [error])

  // 二维码出现或换了一篇时滚过去：从下面的历史列表点开时，它在屏幕上方
  useEffect(() => {
    if (published) publishedRef.current?.scrollIntoView({ block: 'center' })
  }, [published])

  // 显示学生端二维码和链接；历史里已发布的讲义刷新后也能再调出来
  const showQr = async (id: string) => {
    setCopied(false)
    setPublished({ id, qr: await toDataURL(linkOf(id, 'student'), { margin: 1, width: 240 }) })
  }

  const publish = async (id: string) => {
    setError('')
    setBusy(true)
    try {
      await api(`/api/handouts/${encodeURIComponent(id)}/publish`, {})
      await showQr(id)
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
      <SiteHeader
        label="上传讲义"
        actions={
          <a href="#/teacher" className={`${btn.small} inline-flex items-center`}>
            <Short full="回老师端" short="老师端" />
          </a>
        }
      />

      <main className="mx-auto flex max-w-3xl flex-col gap-5 px-4 py-6">
        <form onSubmit={submit} className={`${card} flex flex-col gap-4 p-5`}>
          <h1 className="m-0 text-[22px] font-bold">上传一篇英文文章</h1>
          <Field label="标题" hint="可不填">
            <input value={form.title} onChange={set('title')} placeholder="不填就由 AI 起一个" className={input} />
          </Field>
          <Field label="文章" hint="段落之间空一行">
            <textarea required rows={12} value={form.text} onChange={set('text')} className={`${input} font-serif leading-relaxed`} />
          </Field>
          <Field label="必练词" hint="可不填，逗号或换行分隔">
            <textarea rows={2} value={form.mustWords} onChange={set('mustWords')} className={input} />
          </Field>
          <Field label="教学重点" hint="可不填">
            <textarea rows={2} value={form.focus} onChange={set('focus')} className={input} />
          </Field>
          <button type="submit" disabled={busy || !!jobId} className={btn.primary}>
            {jobId ? '正在生成……' : '开始生成'}
          </button>
        </form>

        {error && (
          <p ref={errorRef} role="alert" className="m-0 rounded-xl bg-red-light px-4 py-3 text-[14px] leading-relaxed text-red-dark">
            {error}
          </p>
        )}

        {jobId && (
          <section aria-live="polite" className={`${card} flex flex-col gap-3 p-5`}>
            <span className="text-[14px] text-ink2">正在生成：{jobTitle || '（未命名）'}</span>
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

        {notesFor && (
          <div ref={notesRef} className="scroll-mt-20">
            <NotesEditor key={notesFor.id} id={notesFor.id} editKey={notesFor.key} onDirty={onNotesDirty} />
          </div>
        )}

        {published && (
          <section ref={publishedRef} className={`${card} flex flex-col items-center gap-4 p-5 sm:flex-row sm:items-start`}>
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
                    {x.key && (
                      <button
                        type="button"
                        onClick={() => {
                          if (notesFor?.id !== x.id && !leaveNotes()) return
                          setNotesFor({ id: x.id, key: x.key! })
                          setTimeout(() => notesRef.current?.scrollIntoView({ block: 'start' }))
                        }}
                        className={btn.small}
                      >
                        讲解
                      </button>
                    )}
                    {x.published ? (
                      <button type="button" onClick={() => void showQr(x.id)} className={btn.small}>
                        二维码
                      </button>
                    ) : (
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
