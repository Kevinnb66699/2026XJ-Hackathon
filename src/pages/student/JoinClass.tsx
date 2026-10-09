// 进班：学生扫老师发给本班的二维码（?h=讲义&c=班级），第一次选自己的座号，拿到找回码；换了手机用座号 + 找回码找回。
// 这一页只有座号和「已有人」，没有姓名。后端的中文提示（座号被占、找回码不对、试错太多、找不到这个班）原样显示
import { useEffect, useRef, useState, type FormEvent } from 'react'
import { SiteHeader, btn, card } from '../../components/ui'
import { currentHandout as h } from '../../data'
import { ApiError, cleanCode, myProgress, pad, saveBinding, send, type Binding } from '../../lib/classes'
import { restoreState } from '../../lib/store'

type Info = { className: string; seats: { n: number; taken: boolean }[] }

const input = 'w-full rounded-xl border border-line-strong bg-surface px-3 py-2.5 text-[16px] text-ink focus:border-primary focus:outline-none'

// notice：进来之前就有的提示（本机记着的座号被老师清空了）
export function JoinClass({ classId, notice, onJoined }: { classId: string; notice?: string; onJoined: (b: Binding) => void }) {
  const [info, setInfo] = useState<Info | null>(null)
  const [missing, setMissing] = useState(false) // 404：找不到这个班
  const [loadError, setLoadError] = useState('')
  const [reload, setReload] = useState(0)
  const [mode, setMode] = useState<'pick' | 'recover'>('pick')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(notice ?? '')
  const [joined, setJoined] = useState<{ b: Binding; code: string } | null>(null) // 刚选好座号：显示找回码
  const [form, setForm] = useState({ seat: '', code: '' })
  const errorRef = useRef<HTMLParagraphElement>(null)
  const base = `/api/join/${encodeURIComponent(classId)}`

  useEffect(() => {
    setLoadError('')
    send<Info>(`${base}?h=${encodeURIComponent(h.id)}`).then(
      (x) => setInfo({ className: x.className, seats: Array.isArray(x.seats) ? x.seats : [] }),
      (e: ApiError) => {
        setMissing(e.status === 404)
        setLoadError(e.message)
      },
    )
  }, [base, reload])

  // 出错时把提示条滚到屏幕中间：手机上点的是下面几排座号，提示条在座号格子上面，常在屏幕外
  useEffect(() => {
    if (error) errorRef.current?.scrollIntoView({ block: 'center' })
  }, [error])

  const pick = async (n: number) => {
    if (!window.confirm(`你是 ${pad(n)} 号？选好就不能自己改，选错了请找老师。`)) return
    setBusy(true)
    setError('')
    try {
      const r = await send<Binding & { recoveryCode: string }>(base, { h: h.id, seat: n })
      const b = { seat: r.seat, sid: r.sid, token: r.token }
      saveBinding(classId, b) // 先存下：还没点「我记下来了」就关了页面，座号也不会丢
      setJoined({ b, code: r.recoveryCode })
    } catch (e) {
      setError((e as Error).message)
      if ((e as ApiError).status === 409) setReload((k) => k + 1) // 被别人先选了：格子刷新成「已有人」
    } finally {
      setBusy(false)
    }
  }

  const recover = async (e: FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError('')
    try {
      const r = await send<Binding>(`${base}/recover`, { h: h.id, seat: Number(form.seat), code: cleanCode(form.code) })
      const b = { seat: r.seat, sid: r.sid, token: r.token }
      saveBinding(classId, b)
      // 拿回之前的作答重建这份讲义的状态；没拿到也照常进去（作答都还在服务器上，老师那边看得到）
      await myProgress(h.id, classId, b.token).then(
        (events) => restoreState(h, b.sid, events),
        () => undefined,
      )
      onJoined(b)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="min-h-screen bg-ground">
      <SiteHeader label={joined ? '找回码' : mode === 'recover' ? '用找回码找回' : '选座号'} />
      <main className="mx-auto flex max-w-2xl flex-col gap-4 px-4 pb-24 pt-5">
        <span className="text-[13px] text-muted">本周外刊：{h.title}</span>
        {/* 提示放在座号格子上面：一进来就有的提示（座号被清空）也看得到 */}
        {error && !joined && (
          <p ref={errorRef} role="alert" className="m-0 rounded-xl bg-red-light px-4 py-3 text-[14px] leading-relaxed text-red-dark">
            {error}
          </p>
        )}
        {joined ? (
          <section className={`${card} flex flex-col items-center gap-4 p-5 text-center`}>
            <h1 className="m-0 text-[20px] font-bold">你是 {pad(joined.b.seat)} 号</h1>
            <span className="text-[14px] text-ink2">你的找回码</span>
            <span className="select-all rounded-xl bg-ground px-5 py-3 font-mono text-[34px] font-bold tracking-[0.25em]">{joined.code}</span>
            <p className="m-0 text-[15px] leading-relaxed">请截图或抄下来，换手机时要用。</p>
            <p className="m-0 text-[13px] leading-relaxed text-muted">找回码只显示这一次。弄丢了也不要紧，请老师在老师端给你重置。</p>
            <button type="button" className={`${btn.primary} w-full`} onClick={() => onJoined(joined.b)}>
              我记下来了
            </button>
          </section>
        ) : !info ? (
          loadError ? (
            <section role="alert" className={`${card} flex flex-col items-start gap-3 p-5 text-[15px] leading-relaxed`}>
              {loadError}
              {missing ? (
                <span className="text-[14px] text-muted">二维码要用老师发给你们班的那一张；扫过之后还进不来，请问问老师。</span>
              ) : (
                <button type="button" className={btn.small} onClick={() => setReload((k) => k + 1)}>
                  重试
                </button>
              )}
            </section>
          ) : (
            <p className="m-0 text-[14px] text-muted">正在加载……</p>
          )
        ) : mode === 'pick' ? (
          <section className={`${card} flex flex-col gap-4 p-5`}>
            <div className="flex flex-col gap-1">
              <h1 className="m-0 text-[20px] font-bold">{info.className}</h1>
              <span className="text-[15px]">点你的座号</span>
            </div>
            {/* 手机上一行 5 个，格子够大好点；已有人的灰掉、点不了 */}
            <div className="grid grid-cols-5 gap-2 sm:grid-cols-8">
              {info.seats.map((s) => (
                <button
                  key={s.n}
                  type="button"
                  disabled={busy || s.taken}
                  onClick={() => void pick(s.n)}
                  aria-label={s.taken ? `${pad(s.n)} 号，已有人` : `${pad(s.n)} 号`}
                  className={`flex min-h-[52px] flex-col items-center justify-center rounded-xl border text-[17px] font-semibold ${s.taken ? 'border-line-soft bg-line-soft text-dim' : 'border-line-strong bg-surface text-ink hover:border-primary'}`}
                >
                  {pad(s.n)}
                  {s.taken && <span className="text-[11px] font-normal">已有人</span>}
                </button>
              ))}
            </div>
            <p className="m-0 text-[14px] leading-relaxed text-ink2">选好座号后，你的作答会记在这个座号上，只有你的老师能看到。</p>
            <button type="button" onClick={() => (setMode('recover'), setError(''))} className="self-start text-[14px] text-primary underline">
              换了手机？用找回码找回
            </button>
          </section>
        ) : (
          <form onSubmit={recover} className={`${card} flex flex-col gap-4 p-5`}>
            <div className="flex flex-col gap-1">
              <h1 className="m-0 text-[20px] font-bold">{info.className}</h1>
              <span className="text-[14px] leading-relaxed text-ink2">输入你的座号和第一次选座号时拿到的找回码，之前的作答会接着用。</span>
            </div>
            <label className="flex flex-col gap-1.5">
              <span className="text-[14px] font-semibold">座号</span>
              <input required inputMode="numeric" pattern="[0-9]*" maxLength={2} value={form.seat} onChange={(e) => setForm({ ...form, seat: e.target.value.replace(/\D/g, '') })} className={input} />
            </label>
            <label className="flex flex-col gap-1.5">
              <span className="text-[14px] font-semibold">
                找回码<span className="ml-2 text-[12px] font-normal text-muted">不分大小写</span>
              </span>
              <input required value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value })} maxLength={20} autoComplete="off" autoCapitalize="characters" spellCheck={false} className={`${input} font-mono tracking-widest`} />
            </label>
            <p className="m-0 text-[13px] leading-relaxed text-muted">问卷和表达本只存在原来的手机上，找回后要重新填问卷。找不到找回码的话，请老师在老师端给你重置。</p>
            <button type="submit" disabled={busy} className={btn.primary}>
              {busy ? '正在找回……' : '找回'}
            </button>
            <button type="button" onClick={() => (setMode('pick'), setError(''))} className="self-start text-[14px] text-primary underline">
              ← 回到选座号
            </button>
          </form>
        )}
      </main>
    </div>
  )
}
