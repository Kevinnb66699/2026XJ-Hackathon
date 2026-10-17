// 我的讲义（#/upload，老师登录后的落地页）：上传文章三步走——粘贴原文 → 后台生成（每 1.5 秒查一次进度）→ 先预览、选班发布，每个班一张二维码和学生链接；
// 讲解（可以请 AI 起草后审阅修改）和改题目点了才打开。下面是讲义列表（见 Uploader 前的说明）。
// 接口见 docs/上传设计.md。这一页要先登录老师账号（没有账号的向知适团队要邀请码注册，见 #/login）；会话 cookie 是同源请求默认带上的，
// 讲义归上传它的老师：发布、写讲解、改题目、查进度、读还没发布的讲义，后端都按登录的账号查。「我的讲义」从服务器拉，换一台电脑、手机登录也看得到。
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ChangeEvent, type FormEvent, type ReactNode } from 'react'
import { toDataURL } from 'qrcode'
import type { ArticleProgress as Progress, ArticleReport as Report } from '../../pipeline/article'
import { BREAKDOWN_LABELS, type Handout, type Question } from '../../shared/schema'
import Account from '../components/Account'
import { Pill, SiteHeader, btn, card } from '../components/ui'
import { loginHref, useMe } from '../lib/auth'
import { ApiError } from '../lib/classes'
import { UPLOAD_PENDING_KEY as PENDING_KEY, readLS, writeLS } from '../lib/store'
import { findAll, noteQuote } from '../lib/text'
import { NewClass } from './Classes'

type Job = { status: 'running'; progress?: Progress } | { status: 'done'; handoutId: string; title: string; report: Report } | { status: 'error'; error: string }
interface Mine {
  id: string
  title: string
  createdAt: string
  published: boolean
  classes?: string[] // 发布到的班（已经删掉的班后端不列）
}
interface ClassItem {
  id: string
  name: string
  seats: number
}
type Published = { id: string; items: { id: string; name: string; qr: string }[] } // 每个班一张二维码

const OFFLINE = '连不上服务器，请检查网络'
const EXPIRED = '登录已过期，请重新登录' // 后端回 401：会话过期，或团队重置了密码

function readPending(): { jobId: string; title: string } | null {
  try {
    const v = JSON.parse(readLS(PENDING_KEY) || 'null')
    return v && typeof v.jobId === 'string' && typeof v.title === 'string' ? { jobId: v.jobId, title: v.title } : null
  } catch {
    return null
  }
}

// 查进度、读没发布的讲义、查起草结果这几个 GET，没登录时后端和找不到一样回 404。碰到 404 直接问一次后端还登录着没有
// （不刷新全页共用的登录状态：那样整页会换成登录卡片，没保存的内容就丢了）；连不上、出错都当还登录着
const loggedOut = () =>
  fetch('/api/auth/me')
    .then((r) => r.json())
    .then((d: { teacher?: unknown }) => d?.teacher === null, () => false)

// 请求后端；出错时抛出服务器给的中文提示，原样显示给老师；401、没登录时 GET 的 404 一律换成 EXPIRED（显示时带登录链接，见 Msg）
async function api<T>(path: string, body?: unknown): Promise<T> {
  const init: RequestInit | undefined = body === undefined ? undefined : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
  const res = await fetch(path, init).catch(() => {
    throw new Error(OFFLINE)
  })
  const data = (await res.json().catch(() => ({}))) as T & { error?: string }
  if (res.status === 401 || (res.status === 404 && !init && (await loggedOut()))) throw new Error(EXPIRED)
  if (!res.ok) throw new Error(data.error ?? `请求失败（${res.status}）`)
  return data
}

// c：班级 id。学生要从带班级的链接（二维码）进来，作答才记到学号上；老师端带上 c 就先看这个班
const linkOf = (id: string, page: 'student' | 'teacher', c?: string) => `${window.location.origin}/?h=${id}${c ? `&c=${c}` : ''}#/${page}`
// 老师预览：look=1 直接「只是看看」（不带班级，学生端只在没有 c 时认它），页面上一直写着作答不进老师端
const preview = (id: string) => `${window.location.origin}/?h=${id}&look=1#/student`
const splitBy = (s: string, sep: RegExp) => s.split(sep).map((x) => x.trim()).filter(Boolean)

function stageOf(p?: Progress): { text: string; pct: number } {
  if (!p) return { text: '准备中', pct: 2 }
  if (p.stage === 'split') return { text: '把文章切成句子', pct: 5 }
  if (p.stage === 'draft') return { text: `AI 在写第 ${Math.min(p.done + 1, p.total)} / ${p.total} 段的梯子和题目`, pct: 10 + Math.round((70 * p.done) / Math.max(p.total, 1)) }
  if (p.stage === 'repair') return { text: '改掉和原文对不上的地方', pct: 85 }
  if (p.stage === 'validate') return { text: '逐条对照原文检查', pct: 95 }
  return { text: '完成', pct: 100 }
}

const input = 'w-full rounded-xl border border-line-strong bg-surface px-3 py-2.5 text-[16px] text-ink focus:border-primary focus:outline-none'
const link = 'text-primary underline'

// 出错提示；登录过期时带重新登录的链接。登录页在新标签页打开（链接写全地址，不触发「还没保存，确定离开吗」）：
// 这一页没保存的讲解、改动、贴好的文章都还在，登录后回来再点一次
function Msg({ text }: { text: string }) {
  if (text !== EXPIRED) return <>{text}</>
  return (
    <>
      {EXPIRED}（
      <a href={`${window.location.origin}/${loginHref('#/upload')}`} target="_blank" rel="noreferrer" className={link}>
        在新标签页登录
      </a>
      ，这一页没保存的内容不会丢，登录后回来再试一次）
    </>
  )
}

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

// 老师讲解（可选）：按句写，学生精读到这一句就能看到（有题的句子答完题才显示）。可以先请 AI 起草：在还没有讲解的句子里挑值得讲的都起草，
// 草稿只填进编辑区、标「AI 草稿」，老师看过、改好、点保存才写进讲义，学生才看得到。
// 写了讲解，这一句就和演示讲义一样：有题又不是打卡句的，第一次就读懂的同学讲解先收起；讲解里有一句「如果……某个注释词」
// （照原句写法、不带术语，见 noteQuote），这个词又正好是他不认识的，多一张「给你」便签。
// 要上传它的老师登录；只发改动过的句子，两个标签页各改各的不会互相清掉
// onLoaded：句子读回来了（上传页等两块编辑区都读完，再滚到改题目）
function NotesEditor({ id, onDirty, onLoaded }: { id: string; onDirty: (dirty: boolean) => void; onLoaded?: () => void }) {
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
  const [draftStep, setDraftStep] = useState<{ done: number; total: number } | null>(null) // 起草进度（第几批 / 共几批）
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
        onLoaded?.()
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
    // 站内链接（顶栏「老师端」、logo）换页面、顶栏「退出」（带 data-leave 的按钮）也会丢掉改动：点之前先问
    const guard = (e: MouseEvent) => {
      const a = (e.target as Element | null)?.closest?.('a[href^="#"], [data-leave]')
      if (a && !e.defaultPrevented && !window.confirm('讲解还没保存，确定离开吗？')) e.preventDefault()
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
      const r = await api<{ count: number }>(`/api/handouts/${encodeURIComponent(id)}/notes`, { notes: sent })
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
  // 后端按 8 句一批、两批同时起草，长文章最坏要五六分钟（每批超时 60 秒、可能重试一次）：最多查 10 分钟。
  // 只填进这时还空着的句子（老师已经写了的、等的时候刚写的都不动），不保存
  const draft = async () => {
    setDrafting(true)
    setDraftMsg(null)
    setDraftStep(null)
    try {
      const { draftId } = await api<{ draftId: string }>(`/api/handouts/${encodeURIComponent(id)}/notes/draft`, {})
      let r: { status: string; notes?: Record<string, string>; error?: string; message?: string; done?: number; total?: number } = { status: 'running' }
      for (let i = 0; i < 400 && r.status === 'running'; i++) {
        await new Promise((ok) => setTimeout(ok, 1500))
        if (!alive.current) return
        r = await api<typeof r>(`/api/notes-drafts/${draftId}`).catch((err: Error) => {
          if (err.message === OFFLINE) return { status: 'running' } // 断网时下一轮再查
          throw err
        })
        if (r.status === 'running' && typeof r.done === 'number' && typeof r.total === 'number') setDraftStep({ done: r.done, total: r.total })
      }
      if (r.status !== 'done' || !r.notes) throw new Error(r.error ?? 'AI 起草暂时不可用，可以先自己写')
      const got = r.notes
      const ids = Object.keys(got).filter((sid) => !(latest.current[sid] ?? '').trim())
      setNotes((cur) => ({ ...cur, ...Object.fromEntries(ids.map((sid) => [sid, got[sid]])) }))
      setOpen((cur) => ({ ...cur, ...Object.fromEntries(ids.map((sid) => [sid, true])) }))
      setDrafts((cur) => new Set([...cur, ...ids]))
      const base = ids.length ? `AI 起草了 ${ids.length} 句，标着「AI 草稿」。看过、改好再保存，学生才看得到。` : 'AI 这次没有起草新的讲解。'
      setDraftMsg({ text: r.message ? `${base}${r.message}` : base })
    } catch (err) {
      if (alive.current) setDraftMsg({ text: (err as Error).message, error: true })
    } finally {
      if (alive.current) {
        setDrafting(false)
        setDraftStep(null)
      }
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
        <li>有题、又不是重点句的句子：第一次就答对的同学，讲解先收起。</li>
        <li>
          「给你」便签：讲解里写一句「如果不认识 某个词……」，词照原句写法（每句下面列了能写的词），这一句里别用从句、主语这类说法。不认识这个词的同学答题前就会看到这一句，所以别在这句里写词义。
        </li>
      </ul>
      <p className="m-0 text-[14px] leading-relaxed text-ink2">可以自己写，也可以先请 AI 起草：AI 在还没有讲解的句子里，把值得讲的（长句、难读的句子，挡住理解的生词，作者表明观点或转折的地方）都写一稿，简单的句子跳过；你看过、改好、点保存，学生才看得到。</p>
      {/* 还一句讲解都没有（没存过、也没在写）时提示一下：没有讲解，学生端就没有讲解收起和「给你」便签。讲解是可选的，不是发布前必做的（发布的下一步写在入库报告里） */}
      {h && !drafting && !drafts.size && !Object.values(notes).some((v) => v.trim()) && (
        <p className="m-0 rounded-xl border border-dashed border-note-line bg-note px-4 py-3 text-[14px] leading-relaxed">
          <b>可选：</b>这篇还没有讲解。点下面的「AI 起草讲解」，AI 先写一稿；你改好、点保存，学生才看得到讲解，讲解收起和「给你」便签也要有讲解才会出现。
        </p>
      )}
      {h && (
        <button type="button" disabled={drafting || saving} onClick={() => void draft()} className={`${btn.secondary} self-start`}>
          {drafting
            ? draftStep && draftStep.total > 1
              ? `AI 正在起草……第 ${Math.min(draftStep.done + 1, draftStep.total)} / ${draftStep.total} 批（句子多的文章要一两分钟）`
              : 'AI 正在起草……（大约半分钟）'
            : 'AI 起草讲解'}
        </button>
      )}
      {/* 常驻的播报区：读屏软件只念已经在页面上的区域里新出现的字 */}
      <p role="status" aria-live="polite" className={`m-0 text-[14px] empty:hidden ${draftMsg?.error ? 'text-red-dark' : 'text-ink2'}`}>
        {draftMsg && <Msg text={draftMsg.text} />}
      </p>
      {!h ? (
        loadError ? (
          <div role="alert" className="flex flex-wrap items-center gap-3 text-[14px] text-red-dark">
            <span>
              <Msg text={loadError} />
            </span>
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
                const tag = s.checkIn || s.tier === 'must' ? '重点句：讲解不收起' : !s.question ? '没有题：讲解直接显示' : ''
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
            {status?.error ? <Msg text={status.text} /> : dirty ? `有 ${changed.length} 句改了还没保存` : status?.text}
          </p>
        </div>
      )}
    </section>
  )
}

// 题目和梯子的编辑区：一块是一道题（S03.question、P2.gist）、一架梯子（S03.ladder）或梯子新第 2、3 步（S03.breakdown），
// 键和后端 /edits 报错的字段前缀一样
type QForm = { prompt: string; options: string[]; answer: number }
type LForm = { subject: string; predicate: string; l2: string; plain: string; glosses: { term: string; zh: string }[] }
type BForm = { parts: { label: string; text: string; hint: string }[]; zh: string } // 没写提示时是空字符串，发给后端也不存
type Block = QForm | LForm | BForm

function blocksOf(h: Handout): Record<string, Block> {
  const q = (x: Question): QForm => ({ prompt: x.prompt, options: [...x.options], answer: x.answer })
  const out: Record<string, Block> = {}
  for (const s of h.sentences) {
    if (s.question) out[`${s.id}.question`] = q(s.question)
    if (s.ladder) out[`${s.id}.ladder`] = { subject: s.ladder.l1.subject, predicate: s.ladder.l1.predicate, l2: s.ladder.l2, plain: s.ladder.l3.plain, glosses: s.ladder.l3.glosses.map((g) => ({ ...g })) }
    if (s.breakdown) out[`${s.id}.breakdown`] = { parts: s.breakdown.parts.map((p) => ({ label: p.label, text: p.text, hint: p.hint ?? '' })), zh: s.breakdown.zh }
  }
  for (const p of h.paragraphs) out[`P${p.n}.gist`] = q(p.gist)
  return out
}
// 比较和发送都按去掉首尾空白算（后端也这样存）：只多打了个空格不算改动
const trimAll = (b: Block): Block => JSON.parse(JSON.stringify(b, (_k, v: unknown) => (typeof v === 'string' ? v.trim() : v)))
const same = (a?: Block, b?: Block) => !!a && !!b && JSON.stringify(trimAll(a)) === JSON.stringify(trimAll(b))

// 一行字的输入框：手机上选项、原句片段常比屏幕宽，用跟着内容撑高的多行框；回车换成空格（这些内容本来就是一行）。
// 内容变了就重新撑高：删掉拆开的一块后，后面的块挪进前面的框里，框要跟着新内容变高变矮
function Line({ value, max, label, onChange, className = '' }: { value: string; max: number; label?: string; onChange: (v: string) => void; className?: string }) {
  const ref = useRef<HTMLTextAreaElement>(null)
  useLayoutEffect(() => fit(ref.current), [value])
  return (
    <textarea
      ref={ref}
      rows={1}
      maxLength={max}
      aria-label={label}
      value={value}
      onChange={(e) => {
        onChange(e.target.value.replace(/\r?\n/g, ' '))
        fit(e.target)
      }}
      className={`${input} resize-none leading-snug ${className}`}
    />
  )
}

function Err({ text }: { text?: string }) {
  return text ? <span className="text-[13px] leading-relaxed text-red-dark">{text}</span> : null
}

// 一道选择题：题目、2–4 个选项、点圆圈选正确答案（不增删选项，AI 起草几个就是几个）
function QuestionFields({ k, title, q, err, onChange }: { k: string; title: string; q: QForm; err: (f: string) => string | undefined; onChange: (q: QForm) => void }) {
  return (
    <fieldset className="m-0 flex min-w-0 flex-col gap-2 border-0 p-0">
      <legend className="mb-1 p-0 text-[15px] font-semibold">{title}</legend>
      <Field label="题目">
        <textarea ref={fit} rows={2} maxLength={300} value={q.prompt} onChange={(e) => (onChange({ ...q, prompt: e.target.value }), fit(e.target))} className={`${input} leading-relaxed`} />
      </Field>
      <Err text={err(`${k}.prompt`)} />
      <span className="text-[14px] font-semibold">
        选项<span className="ml-2 text-[12px] font-normal text-muted">点左边的圆圈选出正确答案</span>
      </span>
      {q.options.map((o, i) => (
        <div key={i} className="flex flex-col gap-1">
          <div className="flex items-start gap-2">
            <input type="radio" name={`${k}-answer`} checked={q.answer === i} onChange={() => onChange({ ...q, answer: i })} aria-label={`第 ${i + 1} 个选项是正确答案`} className="mt-3.5 h-5 w-5 shrink-0 accent-primary" />
            <Line value={o} max={200} label={`第 ${i + 1} 个选项`} onChange={(v) => onChange({ ...q, options: q.options.map((x, j) => (j === i ? v : x)) })} className="min-w-0 flex-1" />
          </div>
          <Err text={err(`${k}.options.${i}`)} />
        </div>
      ))}
      <Err text={err(`${k}.options`)} />
      <Err text={err(`${k}.answer`)} />
      <Err text={err(k)} />
    </fieldset>
  )
}

// 有拆开（bk、b）的梯子：第 2 步改成一块一块的「拆开」，第 3 步改成整句译文 + 难词，和学生端一样；没有的（旧的上传）还是正常语序和简单英文。
// 正常语序、简单英文这时学生看不到，编辑区也不显示，原样留在 l 里；改梯子时它们跟着发，后端照样检查，不合格就把这两格显示出来让老师改
function LadderFields({ k, l, err, onChange, bk, b, onBreakdown }: { k: string; l: LForm; err: (f: string) => string | undefined; onChange: (l: LForm) => void; bk?: string; b?: BForm; onBreakdown?: (b: BForm) => void }) {
  const setPart = (i: number, p: Partial<BForm['parts'][number]>) => b && onBreakdown?.({ ...b, parts: b.parts.map((x, j) => (j === i ? { ...x, ...p } : x)) })
  // 一改这架梯子红字就去掉，这两格得留着，等老师改完
  const [showOld, setShowOld] = useState(false)
  if (!showOld && (err(`${k}.l2`) || err(`${k}.plain`))) setShowOld(true)
  const text = (f: 'l2' | 'plain', label: string, hint: string) => (
    <>
      <Field label={label} hint={hint}>
        <textarea ref={fit} rows={2} maxLength={400} value={l[f]} onChange={(e) => (onChange({ ...l, [f]: e.target.value }), fit(e.target))} className={`${input} font-serif leading-relaxed`} />
      </Field>
      <Err text={err(`${k}.${f}`)} />
    </>
  )
  return (
    <fieldset className="m-0 flex min-w-0 flex-col gap-2 border-0 p-0">
      <legend className="mb-1 p-0 text-[15px] font-semibold">梯子</legend>
      {(['subject', 'predicate'] as const).map((f) => (
        <div key={f} className="flex flex-col gap-1">
          <Field label={`第 1 步：${f === 'subject' ? '谁' : '做了什么'}`} hint="照抄原句里的原话">
            <Line value={l[f]} max={200} onChange={(v) => onChange({ ...l, [f]: v })} className="font-serif" />
          </Field>
          <Err text={err(`${k}.${f}`)} />
        </div>
      ))}
      {b && bk && onBreakdown ? (
        <>
          <span className="text-[14px] font-semibold">
            第 2 步：拆开<span className="ml-2 text-[12px] font-normal text-muted">每一块照抄原句里的原话，提示用大白话（可不写）</span>
          </span>
          {b.parts.map((p, i) => (
            <div key={i} className="flex flex-col gap-1.5 rounded-lg border border-line-soft p-2">
              {/* 手机上标签和原话并排太挤：上下放 */}
              <select value={p.label} aria-label={`第 ${i + 1} 块的标签`} onChange={(e) => setPart(i, { label: e.target.value })} className={`${input.replace('w-full ', '')} self-start`}>
                {BREAKDOWN_LABELS.map((x) => (
                  <option key={x} value={x}>
                    {x}
                  </option>
                ))}
              </select>
              <Err text={err(`${bk}.parts.${i}.label`)} />
              <Line value={p.text} max={400} label={`第 ${i + 1} 块（原句原话）`} onChange={(v) => setPart(i, { text: v })} className="font-serif" />
              <Err text={err(`${bk}.parts.${i}.text`)} />
              <Field label="提示" hint="可不写">
                <Line value={p.hint} max={80} onChange={(v) => setPart(i, { hint: v })} />
              </Field>
              <Err text={err(`${bk}.parts.${i}.hint`)} />
              {b.parts.length > 1 && (
                <button type="button" onClick={() => onBreakdown({ ...b, parts: b.parts.filter((_, j) => j !== i) })} className="self-start text-[13px] text-muted underline">
                  删掉这一块
                </button>
              )}
            </div>
          ))}
          {b.parts.length < 8 && (
            <button type="button" onClick={() => onBreakdown({ ...b, parts: [...b.parts, { label: '补充说明', text: '', hint: '' }] })} className={`${btn.small} self-start`}>
              加一块
            </button>
          )}
          <Err text={err(`${bk}.parts`)} />
          <Field label="第 3 步：译文" hint="整句的中文意思">
            <textarea ref={fit} rows={2} maxLength={400} value={b.zh} onChange={(e) => (onBreakdown({ ...b, zh: e.target.value }), fit(e.target))} className={`${input} leading-relaxed`} />
          </Field>
          <Err text={err(`${bk}.zh`)} />
          <Err text={err(bk)} />
          {showOld && text('l2', '正常语序（学生看不到）', '英文')}
          {showOld && text('plain', '简单英文（学生看不到）', '用更简单的英文说出意思')}
        </>
      ) : (
        <>
          {text('l2', '第 2 步：换成正常语序', '英文')}
          {text('plain', '第 3 步：简单英文', '用更简单的英文说出意思')}
        </>
      )}
      {l.glosses.map((g, i) => (
        <div key={g.term} className="flex flex-col gap-1">
          <Field label={`难词「${g.term}」的中文意思`}>
            <input value={g.zh} maxLength={60} onChange={(e) => onChange({ ...l, glosses: l.glosses.map((x, j) => (j === i ? { ...x, zh: e.target.value } : x)) })} className={input} />
          </Field>
          <Err text={err(`${k}.glosses.${i}`)} />
        </div>
      ))}
      <Err text={err(`${k}.glosses`)} />
      <Err text={err(k)} />
    </fieldset>
  )
}

// 改题目和梯子（可选）：AI 起草的原句题、梯子、段意题，老师可以直接改。和讲解一样要上传它的老师登录，只发改过的块；
// 后端按和校验器一样的规则检查（梯子第 1 步要是原句原话、选项不重复、不出现术语），不合格的按字段标红，一处都不写。
// 学生重新打开就看到新的；已经答过的记录不变
function ContentEditor({ id, onDirty, onLoaded }: { id: string; onDirty: (dirty: boolean) => void; onLoaded?: () => void }) {
  const [h, setH] = useState<Handout | null>(null)
  const [saved, setSaved] = useState<Record<string, Block>>({}) // 服务器上现在的内容
  const [blocks, setBlocks] = useState<Record<string, Block>>({})
  const [openId, setOpenId] = useState('') // 展开的那一句（S03）或那一段（P2），一次只开一个
  const [fields, setFields] = useState<Record<string, string>>({}) // 后端按字段给的错误
  const [loadError, setLoadError] = useState('')
  const [reload, setReload] = useState(0)
  const [status, setStatus] = useState<{ text: string; error?: boolean } | null>(null)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    setLoadError('')
    api<Handout>(`/api/handouts/${encodeURIComponent(id)}`).then(
      (x) => {
        setH(x)
        setSaved(blocksOf(x))
        setBlocks(blocksOf(x))
        onLoaded?.()
      },
      (err: Error) => setLoadError(err.message),
    )
  }, [id, reload])

  const changed = Object.keys(blocks).filter((k) => !same(blocks[k], saved[k]))
  const dirty = changed.length > 0
  useEffect(() => onDirty(dirty), [dirty, onDirty])
  useEffect(() => () => onDirty(false), [onDirty])
  useEffect(() => {
    if (!dirty) return
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault()
      e.returnValue = ''
    }
    const guard = (e: MouseEvent) => {
      const a = (e.target as Element | null)?.closest?.('a[href^="#"], [data-leave]')
      if (a && !e.defaultPrevented && !window.confirm('题目和梯子的改动还没保存，确定离开吗？')) e.preventDefault()
    }
    window.addEventListener('beforeunload', warn)
    document.addEventListener('click', guard, true)
    return () => {
      window.removeEventListener('beforeunload', warn)
      document.removeEventListener('click', guard, true)
    }
  }, [dirty])

  const err = (f: string) => fields[f]
  const errCount = (owner: string) => Object.keys(fields).filter((f) => f === owner || f.startsWith(`${owner}.`)).length
  const change = (k: string, b: Block) => {
    setBlocks({ ...blocks, [k]: b })
    setFields(Object.fromEntries(Object.entries(fields).filter(([f]) => f !== k && !f.startsWith(`${k}.`)))) // 改了这一块，这一块的红字先去掉
    setStatus(null)
  }

  const save = async () => {
    const sentences: Record<string, Record<string, Block>> = {}
    const paragraphs: Record<string, { gist: Block }> = {}
    for (const k of changed) {
      const [owner, part] = k.split('.')
      if (owner.startsWith('P')) paragraphs[owner.slice(1)] = { gist: trimAll(blocks[k]) }
      else sentences[owner] = { ...sentences[owner], [part]: trimAll(blocks[k]) }
    }
    setSaving(true)
    setStatus(null)
    try {
      // 不用 api()：出错时还要拿到 fields，标在对应的输入框下面
      const res = await fetch(`/api/handouts/${encodeURIComponent(id)}/edits`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sentences, paragraphs }),
      }).catch(() => {
        throw new Error(OFFLINE)
      })
      const data = (await res.json().catch(() => ({}))) as { error?: string; fields?: Record<string, string>; handout?: Handout }
      if (!res.ok || !data.handout) {
        setFields(data.fields ?? {})
        throw new Error(res.status === 401 ? EXPIRED : data.error ?? `请求失败（${res.status}）`)
      }
      setH(data.handout)
      setSaved(blocksOf(data.handout))
      setFields({})
      setStatus({ text: '已保存。已经打开页面的学生要重新打开才看得到；已经答过的记录不变。' })
    } catch (err) {
      setStatus({ text: (err as Error).message, error: true })
    } finally {
      setSaving(false)
    }
  }

  const toggle = (owner: string) => setOpenId(openId === owner ? '' : owner)
  const row = (owner: string, label: string, keys: string[], body: ReactNode, text?: string) => {
    const n = errCount(owner)
    const edited = keys.some((k) => changed.includes(k))
    return (
      <div key={owner} className="flex flex-col gap-2 border-t border-line-soft pt-2 first-of-type:border-t-0">
        {text && <p className={`m-0 font-serif text-[16px] leading-relaxed ${openId === owner ? '' : 'line-clamp-2'}`}>{text}</p>}
        <span className="flex flex-wrap items-center gap-2">
          <button type="button" aria-expanded={openId === owner} onClick={() => toggle(owner)} className={`${btn.small} self-start`}>
            {openId === owner ? '收起' : label}
          </button>
          {n > 0 && <Pill tone="red">有 {n} 处要改</Pill>}
          {edited && !n && <Pill tone="amber">改了，还没保存</Pill>}
        </span>
        {openId === owner && body}
      </div>
    )
  }

  const paragraphs = h ? [...new Set(h.sentences.map((s) => s.paragraph))] : []
  return (
    <section id="edit-content" className={`${card} flex scroll-mt-20 flex-col gap-3 p-5`}>
      <h2 className="m-0 text-[18px] font-bold">改题目和梯子（可选）</h2>
      <p className="m-0 text-[14px] leading-relaxed text-ink2">
        AI 起草的原句题、梯子和段意题，你都可以直接改。题目、选项、梯子（学生端叫「提示」）学生都看得到：用大白话，别用术语。梯子第 1 步、第 2 步拆开的每一块都要照抄原句里的原话。不合格的地方保存时会标红，告诉你改哪里。
      </p>
      {!h ? (
        loadError ? (
          <div role="alert" className="flex flex-wrap items-center gap-3 text-[14px] text-red-dark">
            <span>
              <Msg text={loadError} />
            </span>
            <button type="button" onClick={() => setReload(reload + 1)} className={btn.small}>
              重试
            </button>
          </div>
        ) : (
          <span className="text-[14px] text-muted">正在读取题目和梯子……</span>
        )
      ) : (
        paragraphs.map((n) => {
          const gk = `P${n}.gist`
          const gist = blocks[gk] as QForm | undefined
          return (
            <div key={n} className="flex flex-col gap-2">
              <span className="text-[12px] text-muted">第 {n} 段</span>
              {gist && row(`P${n}`, '改段意题', [gk], <QuestionFields k={gk} title="段意题" q={gist} err={err} onChange={(q) => change(gk, q)} />)}
              {h.sentences
                .filter((s) => s.paragraph === n && (blocks[`${s.id}.question`] || blocks[`${s.id}.ladder`]))
                .map((s) => {
                  const qk = `${s.id}.question`
                  const lk = `${s.id}.ladder`
                  const bk = `${s.id}.breakdown`
                  const q = blocks[qk] as QForm | undefined
                  const l = blocks[lk] as LForm | undefined
                  const b = blocks[bk] as BForm | undefined
                  return row(
                    s.id,
                    '改题目和梯子',
                    [qk, lk, bk],
                    <div className="flex flex-col gap-4 rounded-xl bg-ground p-3">
                      {q && <QuestionFields k={qk} title="原句题" q={q} err={err} onChange={(x) => change(qk, x)} />}
                      {l && <LadderFields k={lk} l={l} err={err} onChange={(x) => change(lk, x)} bk={bk} b={b} onBreakdown={(x) => change(bk, x)} />}
                      <Err text={err(s.id)} />
                    </div>,
                    s.text,
                  )
                })}
            </div>
          )
        })
      )}
      {h && (
        <div className="sticky bottom-0 -mx-5 -mb-5 flex flex-col gap-1.5 rounded-b-2xl border-t border-line bg-surface px-5 py-3">
          <button type="button" disabled={saving || !dirty} onClick={() => void save()} className={btn.primary}>
            {saving ? '正在保存……' : '保存题目和梯子'}
          </button>
          <p role="status" aria-live="polite" className={`m-0 text-[13px] ${status?.error ? 'text-red-dark' : dirty ? 'text-amber-dark' : 'text-ink2'}`}>
            {status?.error ? <Msg text={status.text} /> : dirty ? `有 ${changed.length} 处改了还没保存` : status?.text}
          </p>
        </div>
      )}
    </section>
  )
}

// 顶栏：账号（使用指南、班级、称呼和「退出」，没登录是「老师登录」）。这一页就是老师的「我的讲义」
function Header() {
  return <SiteHeader label="我的讲义" actions={<Account />} />
}

// 投到大屏幕：全屏一张大二维码，下面是学生扫码后要做的事。按 Esc 或点「关闭」退出
function QrScreen({ name, url, onClose }: { name: string; url: string; onClose: () => void }) {
  const [qr, setQr] = useState('')
  useEffect(() => {
    void toDataURL(url, { margin: 1, width: 720 }).then(setQr)
  }, [url])
  useEffect(() => {
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', esc)
    return () => window.removeEventListener('keydown', esc)
  }, [onClose])
  return (
    // 屏幕矮时整页滚动，内容不会被居中顶出上沿（用 m-auto 居中，不用 justify-center）
    <div role="dialog" aria-modal="true" aria-label={`${name} 的二维码`} className="fixed inset-0 z-50 flex overflow-auto bg-surface">
      <button type="button" autoFocus onClick={onClose} className={`${btn.secondary} absolute right-4 top-4`}>
        关闭
      </button>
      <div className="m-auto flex flex-col items-center gap-5 p-6">
        <h2 className="m-0 text-[28px] font-bold sm:text-[36px]">{name}</h2>
        {qr && <img src={qr} alt="" className="h-[min(60vh,80vw)] w-[min(60vh,80vw)]" />}
        <ol className="m-0 list-decimal space-y-1.5 pl-8 text-[18px] leading-relaxed sm:text-[24px]">
          <li>扫码，勾选说明，点自己的学号</li>
          <li>记下屏幕上的找回码</li>
          <li>不在名单上的同学，点「只是看看」</li>
        </ol>
      </div>
    </div>
  )
}

// 上传、写讲解、发布都要先登录：没登录只给登录入口，不显示表单。换了账号（key）整个重来
export default function UploadPage() {
  const { loading, teacher } = useMe()
  if (teacher) return <Uploader key={teacher.id} />
  return (
    <div className="min-h-screen bg-ground">
      <Header />
      <main className="mx-auto flex max-w-3xl flex-col gap-5 px-4 py-6">
        {loading ? (
          <p className="m-0 text-[14px] text-muted">正在加载……</p>
        ) : (
          <section className={`${card} flex flex-col items-start gap-4 p-5`}>
            <h1 className="m-0 text-[22px] font-bold">上传、写讲解、发布都要先登录</h1>
            <a href={loginHref('#/upload')} className={`${btn.primary} inline-flex items-center`}>
              登录
            </a>
            <p className="m-0 text-[14px] leading-relaxed text-ink2">
              还没有账号？向知适团队要邀请码，
              <a href={loginHref('#/upload', true)} className="text-primary underline">
                用邀请码注册
              </a>
              。第一次用先看
              <a href="#/guide" className="text-primary underline">
                使用指南
              </a>
              ，或者先
              {/* 写 /#/teacher：地址里带着 ?h= 时，#/teacher 会打开那一篇，不是示例 */}
              <a href="/#/teacher" className="text-primary underline">
                看看示例班级
              </a>
              。
            </p>
          </section>
        )}
      </main>
    </div>
  )
}

// 10-16 改成三步（老师说第一次用不会走、按钮位置不对、字太多）：① 贴文章 → ② 等 AI 做讲义（等的时候就能在页内建班）→ ③ 发给班级。
// 已经有讲义时，一进来是「我的讲义」列表和「＋ 上传一篇文章」，贴文章框收起；还没有讲义（或正在生成、刚生成完）时直接走三步。
// 第 3 步：先看学生看到的样子，选班卡片紧跟着（只有一个班时默认勾上）；讲解、改题目点了才打开；入库报告的数字收进「AI 做了什么」。
// 列表每篇只有一个主按钮（没发布：发给班级；发布了：二维码），其余收进「⋯」；选班和二维码在这一行里展开，不占三步那块
const FLOW = ['贴文章', '等 AI 做讲义', '发给班级']
const small = 'min-h-[36px] rounded-lg bg-primary px-3 text-[13px] font-semibold text-white hover:bg-primary-hover disabled:opacity-40'
const menuItem = 'flex min-h-[40px] w-full items-center rounded-lg px-3 text-left text-[14px] text-ink no-underline hover:bg-ground disabled:opacity-40'

function Steps({ at }: { at: number }) {
  return (
    <ol className="m-0 flex list-none flex-wrap gap-x-4 gap-y-1 p-0 text-[14px]">
      {FLOW.map((s, i) => (
        <li key={s} aria-current={i + 1 === at ? 'step' : undefined} className={`flex items-center gap-1.5 ${i + 1 === at ? 'font-semibold text-primary' : i + 1 < at ? 'text-ink2' : 'text-muted'}`}>
          <span className={`flex h-5 w-5 items-center justify-center rounded-full text-[12px] ${i + 1 <= at ? 'bg-primary text-white' : 'border border-dim'}`}>{i + 1}</span>
          {s}
        </li>
      ))}
    </ol>
  )
}

const EMPTY_FORM = { title: '', text: '', mustWords: '', focus: '' }

function Uploader() {
  const [form, setForm] = useState(EMPTY_FORM)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [pending] = useState(readPending)
  const [jobId, setJobId] = useState<string | null>(pending?.jobId ?? null)
  const [jobTitle, setJobTitle] = useState(pending?.title ?? '')
  const [progress, setProgress] = useState<Progress>()
  const [done, setDone] = useState<{ handoutId: string; title: string; report: Report } | null>(null)
  const [composing, setComposing] = useState(false) // 点了「＋ 上传一篇文章」
  const [published, setPublished] = useState<Published | null>(null)
  const [copied, setCopied] = useState('') // 复制了哪个班的学生链接
  const [screen, setScreen] = useState<{ name: string; url: string } | null>(null) // 投到大屏幕的那个班
  const [mine, setMine] = useState<Mine[] | null>(null) // 我的讲义（以服务器为准）；null：还没读到
  const [mineError, setMineError] = useState('')
  const [classes, setClasses] = useState<ClassItem[] | null>(null) // 我建的班：发布时选班、列表里显示班级名
  const [classesError, setClassesError] = useState('')
  // 正在选发布到哪些班的讲义；again：已经发布过，改发布的班级；touched：老师自己勾过（之后不再替他默认勾上）
  const [picker, setPicker] = useState<{ id: string; picked: string[]; again: boolean; touched?: boolean } | null>(null)
  const [newClass, setNewClass] = useState<'form' | { id: string; name: string } | null>(null) // 页内建班：打开的表单，或刚建好的班
  const [notesFor, setNotesFor] = useState<string | null>(null) // 正在写讲解、改题目的讲义
  const notesRef = useRef<HTMLDivElement>(null)
  const notesDirty = useRef(false) // 讲解编辑区有没保存的改动：换讲义、开始生成前先问
  const onNotesDirty = useCallback((d: boolean) => {
    notesDirty.current = d
  }, [])
  const editsDirty = useRef(false) // 题目和梯子编辑区有没保存的改动，同上
  const onEditsDirty = useCallback((d: boolean) => {
    editsDirty.current = d
  }, [])
  const leaveNotes = () =>
    (!notesDirty.current || window.confirm('讲解还没保存，确定不要了吗？')) && (!editsDirty.current || window.confirm('题目和梯子的改动还没保存，确定不要了吗？'))
  const errorRef = useRef<HTMLParagraphElement>(null)
  const publishedRef = useRef<HTMLElement>(null)
  const pickerRef = useRef<HTMLElement>(null)

  const set = (k: keyof typeof form) => (e: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    const v = e.target.value
    setForm((f) => ({ ...f, [k]: v }))
  }
  // 打开页面、生成完、发布后都重新拉一次：标题（没填时后端起的）、发布状态以服务器为准
  const loadMine = useCallback(() => {
    setMineError('')
    return api<{ handouts: Mine[] }>('/api/my/handouts').then(
      (r) => setMine(r.handouts),
      (err: Error) => setMineError(err.message),
    )
  }, [])
  const loadClasses = useCallback(() => {
    setClassesError('')
    return api<{ classes: ClassItem[] }>('/api/classes').then(
      (r) => setClasses(r.classes),
      (err: Error) => setClassesError(err.message),
    )
  }, [])
  useEffect(() => {
    void loadMine()
    void loadClasses()
  }, [loadMine, loadClasses])
  const className = (c: string) => classes?.find((x) => x.id === c)?.name

  // 走三步：正在生成、刚生成完、点了「＋ 上传一篇文章」，或者还没有讲义（讲义列表从来没读到时也给上传框）
  const flow = !!jobId || !!done || composing || mine?.length === 0 || (!!mineError && !mine)
  const step = jobId ? 2 : done ? 3 : 1

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (!leaveNotes()) return
    setError('')
    setDone(null)
    setPublished(null)
    setPicker(null)
    setNotesFor(null)
    setProgress(undefined)
    setBusy(true)
    const mustWords = splitBy(form.mustWords, /[,，、\n]/)
    try {
      // 没填的可选项不发（JSON 里 undefined 会被去掉）
      const r = await api<{ jobId: string }>('/api/uploads', {
        title: form.title.trim(),
        text: form.text,
        mustWords: mustWords.length ? mustWords : undefined,
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

  // 每 1.5 秒查一次进度（只有发起的老师查得到，别人查后端当找不到）；断网时下一轮再查，其他错误停下来显示。
  // 登录过期时不停：任务还在后台跑，按钮保持「正在生成……」（免得老师重新提交、同一篇生成两次），每 5 秒再查，
  // 老师在新标签页重新登录后（cookie 各标签页共用）这里自动接上，过期提示去掉
  useEffect(() => {
    if (!jobId) return
    let stopped = false
    let timer = 0
    const tick = async () => {
      let wait = 1500
      try {
        const r = await api<Job>(`/api/uploads/${encodeURIComponent(jobId)}`)
        if (stopped) return
        setError((e) => (e === EXPIRED ? '' : e))
        if (r.status === 'running') setProgress(r.progress)
        else if (r.status === 'done' || r.status === 'error') {
          setJobId(null)
          writeLS(PENDING_KEY, null)
          if (r.status === 'done') {
            setDone(r)
            setPicker((p) => p ?? { id: r.handoutId, picked: [], again: false }) // 第 3 步一打开就是选班；老师正在给别的讲义选班时不抢
            setForm(EMPTY_FORM)
            void loadMine()
          } else setError(r.error)
          return
        }
      } catch (err) {
        if (stopped) return
        const msg = (err as Error).message
        if (msg === EXPIRED) {
          setError(EXPIRED)
          wait = 5000
        } else if (msg !== OFFLINE) {
          // 服务器重启后任务记录会丢、换了账号查不到（404），不再查
          setJobId(null)
          writeLS(PENDING_KEY, null)
          setError(msg)
          return
        }
      }
      timer = window.setTimeout(tick, wait)
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

  // 二维码出现或换了一篇时滚过去（选班框在 pick() 里滚；第 3 步自动打开的选班框就在结果下面，不用滚）
  useEffect(() => {
    if (published) publishedRef.current?.scrollIntoView({ block: 'start' })
  }, [published])
  const pickingId = picker?.id
  const doneId = done?.handoutId

  // 只有一个班时默认勾上（多个班不预选，免得发错班）。班级读回来、页内刚建好班时也照这条补上；老师自己动过勾就不管
  const only = classes?.length === 1 ? classes[0].id : ''
  useEffect(() => {
    if (only) setPicker((p) => (p && !p.again && !p.touched && !p.picked.length ? { ...p, picked: [only] } : p))
  }, [only, pickingId])

  // 「⋯」菜单：点别处就收起
  useEffect(() => {
    const close = (e: MouseEvent) => document.querySelectorAll<HTMLDetailsElement>('details[data-menu][open]').forEach((d) => !d.contains(e.target as Node) && (d.open = false))
    document.addEventListener('click', close)
    return () => document.removeEventListener('click', close)
  }, [])

  // 还没有班时，老师可能在新标签页建班：切回这一页就重新读一次，选班框跟着变
  const noClasses = !!classes && !classes.length
  useEffect(() => {
    if (!noClasses) return
    const onFocus = () => void loadClasses()
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [noClasses, loadClasses])

  // 显示每个班的学生端二维码和链接；列表里已发布的讲义刷新后也能再调出来。已经删掉的班不显示
  const showQr = async (id: string, ids: string[]) => {
    setCopied('')
    const items = await Promise.all(
      ids.flatMap((c) => {
        const name = className(c)
        return name ? [toDataURL(linkOf(id, 'student', c), { margin: 1, width: 240 }).then((qr) => ({ id: c, name, qr }))] : []
      }),
    )
    setPublished({ id, items })
  }

  // 发布：先选发到哪些班（已经发布过的预先勾上），再点「发布」。打开时重新拉一次班级，刚在别的标签页建的班也列得出来。
  // 同一篇的选班框已经开着（比如第 3 步自动打开、勾好了的）就照旧，不清掉勾；选班框可能在页面上方的第 3 步里，点完滚过去
  const pick = (id: string, current: string[] = [], again = false) => {
    setPicker((p) => (p?.id === id && p.again === again ? p : { id, picked: current, again }))
    void loadClasses()
    setTimeout(() => pickerRef.current?.scrollIntoView({ block: 'center' }))
  }
  // 只有上传它的老师能发布，班也只能选自己建的（后端按登录的账号查）。再发布一次就是改发布的班级
  const publish = async () => {
    if (!picker) return
    const { id } = picker
    const picked = picker.picked.filter((c) => className(c)) // 勾上后又在别处删掉的班不发
    setError('')
    setBusy(true)
    try {
      const r = await api<{ classes?: string[] }>(`/api/handouts/${encodeURIComponent(id)}/publish`, { classes: picked })
      setPicker(null)
      await showQr(id, r.classes ?? picked)
      void loadMine()
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  // 打开讲解和改题目（两块一起开，滚到点的那一块）。去改题目时，两块都读完后再滚一次：讲解区读完会在上面撑开好几屏，把改题目顶下去
  const jumpTo = useRef(false)
  const loaded = useRef(new Set<string>())
  const onLoaded = useCallback((which: string) => {
    loaded.current.add(which)
    if (loaded.current.size < 2 || !jumpTo.current) return
    jumpTo.current = false
    setTimeout(() => requestAnimationFrame(() => document.getElementById('edit-content')?.scrollIntoView({ block: 'start' }))) // 等读回来的内容画出来
  }, [])
  const openEditors = (id: string, to: 'notes' | 'edit-content') => {
    if (notesFor !== id && !leaveNotes()) return
    if (notesFor !== id) {
      loaded.current = new Set()
      jumpTo.current = to === 'edit-content'
    }
    setNotesFor(id)
    setTimeout(() => (to === 'notes' ? notesRef.current : document.getElementById('edit-content'))?.scrollIntoView({ block: 'start' }))
  }
  // 离开三步：回到列表，或者再上传一篇。回到列表时页内建班的表单跟着收起，填了一半的名单先问一句（再上传一篇时表单照旧留着）；
  // 「建好了」的提醒留到老师点「知道了」
  const leaveFlow = (again: boolean) => {
    if (!leaveNotes()) return
    if (!again && newClass === 'form') {
      if (!window.confirm('新建班级还没保存，确定不要了吗？')) return
      setNewClass(null)
    }
    setDone(null)
    setPublished(null)
    setPicker(null)
    setNotesFor(null)
    setError('')
    setComposing(again)
  }

  // 页内建班出错：会话过期时不刷新登录状态（整页会换成登录卡片，刚生成的结果就看不到了），只说去新标签页登录
  const classProblem = (e: unknown) => ((e as ApiError).status === 401 ? `${EXPIRED}：在新标签页登录后回来再点保存，填好的名单不会丢` : (e as Error).message)

  const stage = stageOf(progress)
  const rep = done?.report
  const missing = rep?.mustWords.filter((w) => !w.found).map((w) => w.term) ?? []
  const stats: [string, number][] = rep
    ? [
        ['段落', rep.paragraphs],
        ['句子', rep.sentences],
        ['梯子', rep.ladders],
        ['拆开·译文', rep.breakdowns],
        ['原句题', rep.questions],
        ['段意题', rep.gists],
        ['注释词', rep.words],
        ['先猜后看', rep.guesses],
        ['表达', rep.expressions],
        ['重点句', rep.checkIns.length],
      ]
    : []
  const titleOf = (id: string) => mine?.find((x) => x.id === id)?.title ?? ''
  // 刚生成的讲义发布了没有、发到了哪些班：以「我的讲义」为准；刚发布、列表还没重新读回来时看刚显示的二维码。null：还没发布
  const doneMine = done ? mine?.find((x) => x.id === done.handoutId) : undefined
  const doneClasses = doneMine?.published ? doneMine.classes ?? [] : published && published.id === done?.handoutId ? published.items.map((x) => x.id) : null
  // 选班框、二维码：是刚生成的这一篇就放在第 3 步里，否则放在列表那一行里
  const here = (id: string | undefined) => !!id && id === doneId

  const pickerBlock = picker && (
    <section ref={pickerRef} className={`${card} flex flex-col gap-3 p-5`}>
      <h2 className="m-0 text-[18px] font-bold">{picker.again ? '改发布的班级' : '发给哪些班'}</h2>
      {!here(picker.id) && titleOf(picker.id) && <span className="text-[14px] text-ink2">{titleOf(picker.id)}</span>}
      {classesError ? (
        <div role="alert" className="flex flex-wrap items-center gap-3 text-[14px] text-red-dark">
          <span>
            <Msg text={classesError} />
          </span>
          <button type="button" onClick={() => void loadClasses()} className={btn.small}>
            重试
          </button>
        </div>
      ) : !classes ? (
        <p className="m-0 text-[14px] text-muted">正在读取班级……</p>
      ) : !classes.length ? (
        here(picker.id) ? (
          <p className="m-0 text-[15px] leading-relaxed">你还没有建班：在下面新建一个，建好就能选。</p>
        ) : (
          <p className="m-0 text-[15px] leading-relaxed">
            你还没有建班。
            <a href={`${window.location.origin}/#/classes`} target="_blank" rel="noreferrer" className={link}>
              先去建一个班
            </a>
            （新标签页打开），把名单导进去；建好后回到这一页，这里就能选到新建的班。
          </p>
        )
      ) : (
        <div className="flex flex-col">
          {classes.map((c) => (
            <label key={c.id} className="flex min-h-[44px] items-center gap-3 border-t border-line-soft py-2 first:border-t-0">
              <input
                type="checkbox"
                checked={picker.picked.includes(c.id)}
                onChange={(e) => setPicker({ ...picker, touched: true, picked: e.target.checked ? [...picker.picked, c.id] : picker.picked.filter((x) => x !== c.id) })}
                className="h-5 w-5 shrink-0 accent-primary"
              />
              <span className="min-w-0 flex-1 text-[15px]">{c.name}</span>
              <span className="text-[13px] text-muted">{c.seats} 人</span>
            </label>
          ))}
        </div>
      )}
      {picker.again && <p className="m-0 text-[13px] leading-relaxed text-muted">去掉勾的班，学生扫码就进不来了，老师端也不再显示这个班。</p>}
      <div className="flex flex-wrap gap-3">
        <button type="button" disabled={busy || !picker.picked.some((c) => className(c))} onClick={() => void publish()} className={btn.primary}>
          {picker.again ? '保存' : picker.picked.length === 1 && className(picker.picked[0]) ? `发布到 ${className(picker.picked[0])}` : '发布'}
        </button>
        <button type="button" onClick={() => setPicker(null)} className={btn.secondary}>
          {here(picker.id) ? '先不发' : '取消'}
        </button>
      </div>
    </section>
  )

  const qrBlock = published && (
    <section ref={publishedRef} className="flex scroll-mt-20 flex-col gap-3">
      <h2 className="m-0 text-[18px] font-bold">{published.items.length ? '已发布，每个班一张二维码' : '还没有发布到班级'}</h2>
      {!here(published.id) && titleOf(published.id) && <span className="text-[14px] text-ink2">{titleOf(published.id)}</span>}
      {published.items.length > 0 && <p className="m-0 text-[14px] leading-relaxed text-ink2">上课时点「投到大屏幕」让学生扫，或者点「复制」把链接发到班级群。你自己想试，扫码后点「只是看看」，别选学号。</p>}
      {!published.items.length && (
        <div className="flex flex-wrap items-center gap-3 text-[14px] leading-relaxed">
          这份讲义还没有选班（或者选的班已经删掉了），学生扫不了码。
          <button type="button" onClick={() => pick(published.id, mine?.find((x) => x.id === published.id)?.classes ?? [], true)} className={btn.small}>
            改发布的班级
          </button>
        </div>
      )}
      {published.items.map((x) => {
        const url = linkOf(published.id, 'student', x.id)
        return (
          <div key={x.id} className={`${card} flex flex-col items-center gap-4 p-5 sm:flex-row sm:items-start`}>
            <img src={x.qr} alt={`${x.name} 的学生端二维码`} width={200} height={200} className="rounded-lg border border-line" />
            <div className="flex w-full min-w-0 flex-1 flex-col gap-3">
              <h3 className="m-0 text-[18px] font-bold">{x.name}</h3>
              <span className="text-[13px] leading-relaxed text-ink2">只发给这个班：学生扫码进来，第一次选自己的学号。</span>
              <div className="flex gap-2">
                <input readOnly aria-label={`${x.name} 的学生链接`} value={url} onFocus={(e) => e.target.select()} className={`${input} min-w-0 flex-1 text-[14px]`} />
                <button type="button" onClick={() => void navigator.clipboard?.writeText(url).then(() => setCopied(x.id), () => {})} className={btn.secondary}>
                  {copied === x.id ? '已复制' : '复制'}
                </button>
              </div>
              <div className="flex flex-wrap items-center gap-4 text-[14px]">
                <button type="button" onClick={() => setScreen({ name: x.name, url })} className={small}>
                  投到大屏幕
                </button>
                <a href={linkOf(published.id, 'teacher', x.id)} target="_blank" rel="noreferrer" className={link}>
                  这个班的老师端
                </a>
              </div>
            </div>
          </div>
        )
      })}
    </section>
  )

  const list = (
    <section className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="m-0 flex-1 text-[20px] font-bold">我的讲义</h2>
        {!flow && (
          <button type="button" className={btn.primary} onClick={() => setComposing(true)}>
            ＋ 上传一篇文章
          </button>
        )}
      </div>
      {mineError && (
        <div role="alert" className="flex flex-wrap items-center gap-3 text-[14px] text-red-dark">
          <span>
            <Msg text={mineError} />
          </span>
          <button type="button" onClick={() => void loadMine()} className={btn.small}>
            重试
          </button>
        </div>
      )}
      {/* 班级没读到时，下面的「发布到」不显示、「二维码」点不了（班级名对不上，会误以为没发布到班）；选班的框里有同样的提示 */}
      {classesError && !picker && (
        <div role="alert" className="flex flex-wrap items-center gap-3 text-[14px] text-red-dark">
          <span>
            班级读取失败：<Msg text={classesError} />
          </span>
          <button type="button" onClick={() => void loadClasses()} className={btn.small}>
            重试
          </button>
        </div>
      )}
      {!mine ? (
        !mineError && <p className="m-0 text-[14px] text-muted">正在读取……</p>
      ) : !mine.length ? (
        <p className="m-0 text-[14px] text-muted">还没有上传过讲义</p>
      ) : (
        <ul className={`${card} m-0 flex list-none flex-col p-0`}>
          {mine.map((x) => {
            const live = (x.classes ?? []).some((c) => className(c)) // 发布到的班还有没删的
            return (
              <li key={x.id} className="flex flex-col gap-2 border-t border-line-soft px-4 py-3 first:border-t-0">
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
                  <span className="min-w-0 flex-1 text-[15px] font-semibold">{x.title}</span>
                  <Pill tone={x.published ? 'green' : 'gray'}>{x.published ? '已发布' : '未发布'}</Pill>
                  <span className="text-[12px] text-muted">{new Date(x.createdAt).toLocaleString('zh-CN')}</span>
                  {x.published && classes && (
                    <span className="w-full text-[13px] text-ink2">
                      发布到：{(x.classes ?? []).flatMap((c) => className(c) ?? []).join('、') || '还没有选班'}
                    </span>
                  )}
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  {x.published && live ? (
                    <button type="button" disabled={!classes} onClick={() => void showQr(x.id, x.classes ?? [])} className={small}>
                      二维码
                    </button>
                  ) : (
                    <button type="button" disabled={busy} onClick={() => (x.published ? pick(x.id, x.classes ?? [], true) : pick(x.id))} className={small}>
                      发给班级
                    </button>
                  )}
                  {/* 其余的操作收进「⋯」：点了里面哪一项菜单就收起 */}
                  <details data-menu className="relative">
                    <summary aria-label={`${x.title}：更多操作`} className={`${btn.small} flex cursor-pointer list-none items-center [&::-webkit-details-marker]:hidden`}>
                      ⋯
                    </summary>
                    <div
                      onClick={(e) => ((e.currentTarget.parentElement as HTMLDetailsElement).open = false)}
                      className="absolute left-0 z-10 mt-1 flex w-max flex-col rounded-xl border border-line bg-surface p-1 shadow-lg"
                    >
                      <a href={preview(x.id)} target="_blank" rel="noreferrer" className={menuItem}>
                        预览学生端
                      </a>
                      <a href={linkOf(x.id, 'teacher')} target="_blank" rel="noreferrer" className={menuItem}>
                        老师端（看全班数据）
                      </a>
                      <button type="button" onClick={() => openEditors(x.id, 'notes')} className={menuItem}>
                        讲解和题目
                      </button>
                      {x.published && (
                        <button type="button" disabled={busy} onClick={() => pick(x.id, x.classes ?? [], true)} className={menuItem}>
                          改发布的班级
                        </button>
                      )}
                    </div>
                  </details>
                </div>
                {!x.published && <span className="text-[12px] text-muted">发布前只有你（登录后）能打开，学生要等你发给班级后才能用</span>}
                {picker?.id === x.id && !here(x.id) && pickerBlock}
                {published?.id === x.id && !here(x.id) && qrBlock}
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )

  return (
    <div className="min-h-screen bg-ground">
      <Header />

      <main className="mx-auto flex max-w-3xl flex-col gap-5 px-4 py-6">
        {!flow && list}

        {flow && (
          <div className="flex flex-wrap items-center gap-3">
            <Steps at={step} />
            {step === 3 && !!mine?.length && (
              <button type="button" onClick={() => leaveFlow(false)} className="ml-auto text-[13px] text-primary underline">
                回到我的讲义
              </button>
            )}
          </div>
        )}

        {flow && step === 1 && (
          <form onSubmit={submit} className={`${card} flex flex-col gap-4 p-5`}>
            <h1 className="m-0 text-[22px] font-bold">上传一篇英文文章</h1>
            <Field label="文章" hint="段落之间空一行">
              <textarea required rows={12} value={form.text} onChange={set('text')} className={`${input} font-serif leading-relaxed`} />
            </Field>
            <details>
              <summary className="cursor-pointer text-[14px] text-primary">更多设置（都可不填）：标题、必练词、教学重点</summary>
              <div className="mt-3 flex flex-col gap-4">
                <Field label="标题" hint="可不填">
                  <input value={form.title} onChange={set('title')} placeholder="不填就由 AI 起一个" className={input} />
                </Field>
                <Field label="必练词" hint="可不填，逗号或换行分隔">
                  <textarea rows={2} value={form.mustWords} onChange={set('mustWords')} className={input} />
                </Field>
                <Field label="教学重点" hint="可不填">
                  <textarea rows={2} value={form.focus} onChange={set('focus')} className={input} />
                </Field>
              </div>
            </details>
            <div className="flex flex-wrap gap-3">
              <button type="submit" disabled={busy} className={`${btn.primary} flex-1`}>
                {busy ? '正在提交……' : '开始生成'}
              </button>
              {!!mine?.length && (
                <button type="button" onClick={() => setComposing(false)} className={btn.secondary}>
                  取消
                </button>
              )}
            </div>
          </form>
        )}

        {error && (
          <p ref={errorRef} role="alert" className="m-0 rounded-xl bg-red-light px-4 py-3 text-[14px] leading-relaxed text-red-dark">
            <Msg text={error} />
          </p>
        )}

        {flow && step === 2 && (
          <section aria-live="polite" className={`${card} flex flex-col gap-3 p-5`}>
            <span className="text-[14px] text-ink2">正在生成：{jobTitle || '（未命名）'}</span>
            <span className="text-[16px] font-semibold">{stage.text}</span>
            <div className="h-2 overflow-hidden rounded-full bg-line-soft">
              <div className="h-full rounded-full bg-primary transition-[width] duration-500" style={{ width: `${stage.pct}%` }} />
            </div>
            <span className="text-[13px] text-muted">大约 1–2 分钟。关掉这一页也不会中断，回来会接着显示进度。</span>
          </section>
        )}

        {flow && done && rep && (
          <section className={`${card} flex flex-col gap-4 p-5`}>
            <h1 className="m-0 text-[20px] font-bold">讲义做好了{(done.title || titleOf(done.handoutId)) && `：${done.title || titleOf(done.handoutId)}`}</h1>
            {/* 程序核对的是梯子里引的原句、选项不重复、没有术语，不核对题目好不好、译文对不对：照实说，题目请老师扫一眼 */}
            <p className="m-0 text-[15px] leading-relaxed">
              {rep.paragraphs} 段 {rep.sentences} 句，{rep.ladders} 句有梯子，{rep.questions} 道原句题、{rep.gists} 道段意题。梯子里引的原句都逐字对过原文；题目和译文是 AI 写的，请你扫一眼，不合适的点「改题目」。
            </p>
            {missing.length + rep.warnings.length > 0 && (
              <ul className="m-0 flex flex-col gap-1 rounded-xl bg-amber-light px-4 py-3 text-[14px] leading-relaxed text-amber-dark">
                {missing.length > 0 && <li>必练词「{missing.join('」「')}」在原文里没找到，已忽略</li>}
                {rep.warnings.map((w, i) => (
                  <li key={i}>{w}</li>
                ))}
              </ul>
            )}
            <div className="flex flex-wrap gap-3">
              <a href={preview(done.handoutId)} target="_blank" rel="noreferrer" className={`${btn.secondary} inline-flex items-center`}>
                先看看学生看到的样子
              </a>
            </div>
            <div className="flex flex-wrap gap-x-5 gap-y-2 text-[14px]">
              <button type="button" onClick={() => openEditors(done.handoutId, 'edit-content')} className={link}>
                改题目（可选）
              </button>
              <button type="button" onClick={() => openEditors(done.handoutId, 'notes')} className={link}>
                写讲解（可选）
              </button>
            </div>
            <details className="text-[14px] leading-relaxed text-ink2">
              <summary className="cursor-pointer text-primary">AI 做了什么</summary>
              <div className="mt-3 flex flex-col gap-3">
                <dl className="m-0 grid grid-cols-3 gap-2 sm:grid-cols-5">
                  {stats.map(([k, v]) => (
                    <div key={k} className="rounded-xl bg-ground px-3 py-2.5">
                      <dt className="text-[12px] text-muted">{k}</dt>
                      <dd className="m-0 text-[20px] font-bold text-ink">{v}</dd>
                    </div>
                  ))}
                </dl>
                {/* 给老师看的白话（#25）：程序逐条检查 AI 写的内容，对不上原文的已经改好或去掉，老师不用动手 */}
                <p className="m-0">
                  {rep.repaired.length + rep.dropped.length > 0
                    ? `程序逐条检查了 AI 写的内容：改好 ${rep.repaired.length} 处，去掉 ${rep.dropped.length} 处和原文对不上的（学生看不到去掉的内容，你不用处理）。`
                    : '程序逐条检查了 AI 写的内容，都和原文对得上。'}
                  <span className="text-muted">
                    {' '}
                    用时 {rep.seconds} 秒 · {rep.model}
                  </span>
                </p>
                {rep.repaired.length + rep.dropped.length > 0 && (
                  <ul className="m-0 flex flex-col gap-1 pl-5 text-[13px]">
                    {rep.repaired.map((x, i) => (
                      <li key={`r${i}`}>{x}</li>
                    ))}
                    {rep.dropped.map((x, i) => (
                      <li key={`d${i}`}>{x}</li>
                    ))}
                  </ul>
                )}
              </div>
            </details>
          </section>
        )}

        {flow && done && (here(picker?.id) ? pickerBlock : here(published?.id) ? qrBlock : (
          <div className="flex flex-wrap gap-3">
            <button type="button" disabled={busy} onClick={() => pick(done.handoutId, doneClasses ?? [], !!doneClasses)} className={btn.primary}>
              {doneClasses ? '改发布的班级' : '发给班级'}
            </button>
            {doneClasses && (
              <button type="button" disabled={!classes} onClick={() => void showQr(done.handoutId, doneClasses)} className={btn.secondary}>
                二维码
              </button>
            )}
          </div>
        ))}

        {/* 页内建班：等 AI 的时候就提示（第 2、3 步同一个位置、同一个表单，AI 做完时名单不会丢）。两项确认照旧，建好后提醒去关 AI 写作检查 */}
        {flow && (step > 1 || !!newClass) && (noClasses || newClass) && (
          newClass === 'form' ? (
            <NewClass
              compact
              onProblem={classProblem}
              onCancel={() => setNewClass(null)}
              onCreated={(id, name) => {
                setNewClass({ id, name })
                void loadClasses()
              }}
            />
          ) : newClass ? (
            <section className={`${card} flex flex-col gap-2 p-4 text-[14px] leading-relaxed`}>
              <p className="m-0 font-semibold">「{newClass.name}」建好了</p>
              <p className="m-0 text-ink2">
                家长回执第 2 项选了不同意的同学，要在班级页把那一行点成「AI 写作检查：关」。
                <a href={`${window.location.origin}/#/classes?id=${encodeURIComponent(newClass.id)}`} target="_blank" rel="noreferrer" className={link}>
                  打开这个班
                </a>
                （新标签页）
              </p>
              <button type="button" onClick={() => setNewClass(null)} className={`${btn.small} self-start`}>
                知道了
              </button>
            </section>
          ) : (
            <section className={`${card} flex flex-col items-start gap-2 border-primary p-4 text-[14px] leading-relaxed`}>
              <p className="m-0 font-semibold">{step === 2 ? '趁 AI 在做，先建一个班' : '还没有班级'}</p>
              <p className="m-0 text-ink2">发给班级时要选班，学生扫自己班的二维码进来。建班前请先收回家长告知同意书。</p>
              <button type="button" onClick={() => setNewClass('form')} className={btn.secondary}>
                新建班级
              </button>
            </section>
          )
        )}

        {flow && done && (
          <div className="flex flex-wrap gap-3">
            <button type="button" onClick={() => leaveFlow(true)} className={btn.secondary}>
              再上传一篇
            </button>
          </div>
        )}

        {notesFor && (
          <div key={notesFor} ref={notesRef} className="flex scroll-mt-20 flex-col gap-5">
            <div className="flex flex-wrap items-center gap-3">
              {/* 改题目和梯子在讲解下面，手机上要往下翻好几屏，这里给个直达 */}
              <button type="button" className={btn.small} onClick={() => document.getElementById('edit-content')?.scrollIntoView({ behavior: 'smooth', block: 'start' })}>
                改题目和梯子 ↓
              </button>
              <button type="button" className={btn.small} onClick={() => leaveNotes() && setNotesFor(null)}>
                收起讲解和题目
              </button>
            </div>
            <NotesEditor id={notesFor} onDirty={onNotesDirty} onLoaded={() => onLoaded('notes')} />
            <ContentEditor id={notesFor} onDirty={onEditsDirty} onLoaded={() => onLoaded('content')} />
          </div>
        )}

        {flow && !!mine?.length && list}
      </main>
      {screen && <QrScreen name={screen.name} url={screen.url} onClose={() => setScreen(null)} />}
    </div>
  )
}
