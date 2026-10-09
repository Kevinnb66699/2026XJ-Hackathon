// 班级（#/classes）：老师建班、导入名单（座号 + 姓名），看谁已经进班；学生找回码丢了给他换一个新的、选错座号给他清空；改名单、改班名、删班。
// 一位老师可以建多个班（最多 20 个），发布讲义时选发到哪些班，每个班一张二维码（在上传页）。要先登录，没登录只给登录入口（和上传页一样）。
// 姓名只在这一页和老师端出现，学生端只有座号。请求碰到 401（会话过期）时刷新登录状态，整页换成登录入口。接口见 deploy/README.md
import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react'
import Account from '../components/Account'
import { Pill, SiteHeader, btn, card } from '../components/ui'
import { getMe, loginHref, useMe } from '../lib/auth'
import { ApiError, MAX_NAME, formatRoster, pad, parseRoster, seatName, send, type RosterSeat } from '../lib/classes'
import { getParams } from '../lib/router'

interface ClassItem {
  id: string
  name: string
  createdAt: string
  seats: number // 名单人数
  joined: number // 已进班（选了座号）的人数
}
interface Seat extends RosterSeat {
  joined: boolean
}
interface Detail {
  id: string
  name: string
  createdAt: string
  seats: Seat[]
}

const PRIVACY = '姓名保存在服务器上你的账号下，只有你登录后能看到；学生端只显示座号。删除班级会一起删掉名单。'
const input = 'w-full rounded-xl border border-line-strong bg-surface px-3 py-2.5 text-[16px] text-ink focus:border-primary focus:outline-none'

// 出错时给老师看的话；会话过期（401）顺便刷新登录状态，整页换成登录入口
const problem = (e: unknown) => {
  if ((e as ApiError).status === 401) void getMe(true)
  return (e as Error).message
}

function Header() {
  return (
    <SiteHeader
      label="班级"
      actions={
        <>
          <Account />
          <a href="#/upload" className={`${btn.small} inline-flex items-center`}>
            上传讲义
          </a>
        </>
      }
    />
  )
}

function Alert({ text }: { text: string }) {
  return text ? (
    <p role="alert" className="m-0 rounded-xl bg-red-light px-4 py-3 text-[14px] leading-relaxed text-red-dark">
      {text}
    </p>
  ) : null
}

export default function ClassesPage() {
  const { loading, teacher } = useMe()
  if (teacher) return <Classes key={teacher.id} />
  return (
    <div className="min-h-screen bg-ground">
      <Header />
      <main className="mx-auto flex max-w-3xl flex-col gap-5 px-4 py-6">
        {loading ? (
          <p className="m-0 text-[14px] text-muted">正在加载……</p>
        ) : (
          <section className={`${card} flex flex-col items-start gap-4 p-5`}>
            <h1 className="m-0 text-[22px] font-bold">建班、导入名单要先登录</h1>
            <a href={loginHref('#/classes')} className={`${btn.primary} inline-flex items-center`}>
              登录
            </a>
            <p className="m-0 text-[14px] leading-relaxed text-ink2">还没有账号？向知适团队要邀请码注册。</p>
          </section>
        )}
      </main>
    </div>
  )
}

function Classes() {
  const [list, setList] = useState<ClassItem[] | null>(null)
  const [listError, setListError] = useState('')
  const [openId, setOpenId] = useState(() => getParams().get('id') ?? '') // 正在看的班
  const [creating, setCreating] = useState(false)
  const detailRef = useRef<HTMLDivElement>(null)

  const load = useCallback(() => {
    setListError('')
    return send<{ classes: ClassItem[] }>('/api/classes').then(
      (r) => setList(r.classes),
      (e) => setListError(problem(e)),
    )
  }, [])
  useEffect(() => {
    void load()
  }, [load])
  const open = (id: string) => {
    setOpenId(id)
    setTimeout(() => detailRef.current?.scrollIntoView({ block: 'start' }))
  }

  return (
    <div className="min-h-screen bg-ground">
      <Header />
      <main className="mx-auto flex max-w-3xl flex-col gap-5 px-4 py-6">
        <section className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="m-0 flex-1 text-[22px] font-bold">我的班级</h1>
            {!creating && (
              <button type="button" className={btn.secondary} onClick={() => setCreating(true)}>
                新建班级
              </button>
            )}
          </div>
          <p className="m-0 text-[14px] leading-relaxed text-ink2">发布讲义时选发到哪些班，每个班一张二维码。学生扫自己班的码进来，第一次选自己的座号，老师端就按座号和姓名显示。</p>
          {listError && (
            <div role="alert" className="flex flex-wrap items-center gap-3 text-[14px] text-red-dark">
              <span>{listError}</span>
              <button type="button" onClick={() => void load()} className={btn.small}>
                重试
              </button>
            </div>
          )}
          {!list ? (
            !listError && <p className="m-0 text-[14px] text-muted">正在读取……</p>
          ) : !list.length ? (
            !creating && <p className="m-0 text-[14px] text-muted">还没有建班。点「新建班级」，把名单粘贴进来。</p>
          ) : (
            <ul className={`${card} m-0 flex list-none flex-col p-0`}>
              {list.map((c) => (
                <li key={c.id} className="border-t border-line-soft first:border-t-0">
                  <button type="button" onClick={() => open(c.id)} aria-current={openId === c.id ? 'true' : undefined} className={`flex min-h-[52px] w-full flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3 text-left ${openId === c.id ? 'bg-ground' : ''}`}>
                    <span className="min-w-0 flex-1 text-[15px] font-semibold">{c.name}</span>
                    <span className="text-[13px] text-ink2">
                      {c.seats} 人 · 已进班 {c.joined} 人
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>

        {creating && (
          <NewClass
            onCancel={() => setCreating(false)}
            onCreated={(id) => {
              setCreating(false)
              void load()
              open(id)
            }}
          />
        )}

        <div ref={detailRef} className="scroll-mt-20">
          {openId && (
            <ClassDetail
              key={openId}
              id={openId}
              onChanged={() => void load()}
              onDeleted={() => {
                setOpenId('')
                void load()
              }}
            />
          )}
        </div>
      </main>
    </div>
  )
}

function Field({ label, hint, error, children }: { label: string; hint?: string; error?: string; children: ReactNode }) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-[14px] font-semibold">
        {label}
        {hint && <span className="ml-2 text-[12px] font-normal text-muted">{hint}</span>}
      </span>
      {children}
      {error && <span className="text-[13px] leading-relaxed text-red-dark">{error}</span>}
    </label>
  )
}

// 名单文本框 + 解析出来的表格预览（保存前先看清楚）+ 隐私说明；第几行有问题标红
function RosterField({ text, onChange, error }: { text: string; onChange: (v: string) => void; error?: string }) {
  const { seats, errors } = parseRoster(text)
  return (
    <div className="flex flex-col gap-2">
      <Field label="名单" hint="一人一行：座号 + 姓名，或者只有姓名（按顺序编号）" error={error}>
        <textarea rows={8} value={text} onChange={(e) => onChange(e.target.value)} placeholder={'1 张三\n2 李四\n3 王五'} spellCheck={false} className={`${input} leading-relaxed`} />
      </Field>
      <p className="m-0 text-[13px] leading-relaxed text-ink2">可以从表格里复制「座号、姓名」两列直接粘贴；座号和姓名之间用空格、逗号、顿号或 Tab 隔开都行。{PRIVACY}</p>
      {errors.length > 0 && (
        <ul className="m-0 flex flex-col gap-1 rounded-xl bg-red-light px-4 py-3 pl-8 text-[14px] leading-relaxed text-red-dark">
          {errors.map((x, i) => (
            <li key={i}>{x}</li>
          ))}
        </ul>
      )}
      {seats.length > 0 && (
        <div className="flex flex-col gap-1.5">
          <span className="text-[13px] text-muted">预览：共 {seats.length} 人</span>
          <div className="max-h-72 overflow-y-auto rounded-xl border border-line">
            <table className="w-full border-collapse text-[14px]">
              <thead className="sticky top-0 bg-ground text-left text-[12px] text-muted">
                <tr>
                  <th className="w-16 px-3 py-1.5 font-normal">座号</th>
                  <th className="px-3 py-1.5 font-normal">姓名</th>
                </tr>
              </thead>
              <tbody>
                {seats.map((s) => (
                  <tr key={s.n} className="border-t border-line-soft">
                    <td className="px-3 py-1.5 font-semibold">{pad(s.n)}</td>
                    <td className="px-3 py-1.5">{s.name || <span className="text-muted">（没填姓名）</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  )
}

function NewClass({ onCreated, onCancel }: { onCreated: (id: string) => void; onCancel: () => void }) {
  const [name, setName] = useState('')
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [fields, setFields] = useState<Record<string, string>>({})
  const { seats, errors } = parseRoster(text)

  const save = async (e: FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError('')
    setFields({})
    try {
      const r = await send<{ class: Detail }>('/api/classes', { name: name.trim(), roster: seats })
      onCreated(r.class.id)
    } catch (err) {
      setError(problem(err))
      setFields((err as ApiError).fields ?? {})
    } finally {
      setBusy(false)
    }
  }

  return (
    <form onSubmit={save} className={`${card} flex flex-col gap-4 p-5`}>
      <h2 className="m-0 text-[18px] font-bold">新建班级</h2>
      <Field label="班级名" hint={`最多 ${MAX_NAME} 个字`} error={fields.name}>
        <input required value={name} onChange={(e) => setName(e.target.value)} maxLength={MAX_NAME} placeholder="例：高一 3 班" className={input} />
      </Field>
      <RosterField text={text} onChange={setText} error={fields.roster} />
      <div className="flex flex-wrap gap-3">
        <button type="submit" disabled={busy || !seats.length || errors.length > 0} className={btn.primary}>
          {busy ? '正在保存……' : seats.length ? `保存（${seats.length} 人）` : '保存'}
        </button>
        <button type="button" onClick={onCancel} className={btn.secondary}>
          取消
        </button>
      </div>
      <Alert text={error} />
    </form>
  )
}

// 一个班：名单（座号、姓名、进没进班），已进班的座号可以换新找回码、清空；改名单、改班名、删班
function ClassDetail({ id, onChanged, onDeleted }: { id: string; onChanged: () => void; onDeleted: () => void }) {
  const [c, setC] = useState<Detail | null>(null)
  const [loadError, setLoadError] = useState('')
  const [reload, setReload] = useState(0)
  const [codes, setCodes] = useState<Record<number, string>>({}) // 刚换的新找回码，只显示这一次
  const [editing, setEditing] = useState<'' | 'name' | 'roster'>('')
  const [newName, setNewName] = useState('')
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [fields, setFields] = useState<Record<string, string>>({})
  const base = `/api/classes/${encodeURIComponent(id)}`

  useEffect(() => {
    setLoadError('')
    send<{ class: Detail }>(base).then(
      (r) => setC(r.class),
      (e) => setLoadError(problem(e)),
    )
  }, [base, reload])

  // 发一个改动；成功后班级列表的人数跟着刷新
  const run = async (fn: () => Promise<void>) => {
    setBusy(true)
    setError('')
    setFields({})
    try {
      await fn()
      onChanged()
    } catch (err) {
      setError(problem(err))
      setFields((err as ApiError).fields ?? {})
    } finally {
      setBusy(false)
    }
  }

  if (!c)
    return loadError ? (
      <div role="alert" className="flex flex-wrap items-center gap-3 text-[14px] text-red-dark">
        <span>{loadError}</span>
        <button type="button" onClick={() => setReload((k) => k + 1)} className={btn.small}>
          重试
        </button>
      </div>
    ) : (
      <p className="m-0 text-[14px] text-muted">正在读取名单……</p>
    )

  const parsed = parseRoster(text)
  const joined = c.seats.filter((s) => s.joined).length

  const resetCode = (s: Seat) => {
    if (!window.confirm(`给 ${seatName(s.n, s.name)} 换一个新的找回码？旧的找回码马上作废，已经进班的手机照常能用。`)) return
    void run(async () => {
      const r = await send<{ recoveryCode: string }>(`${base}/seats/${s.n}/reset-code`, {})
      setCodes((x) => ({ ...x, [s.n]: r.recoveryCode }))
    })
  }
  const clear = (s: Seat) => {
    if (!window.confirm(`清空 ${seatName(s.n, s.name)} 的座号？这位同学要重新选座号，之前的作答不再算在这个座号名下。`)) return
    void run(async () => {
      await send(`${base}/seats/${s.n}/clear`, {})
      setC({ ...c, seats: c.seats.map((x) => (x.n === s.n ? { n: x.n, name: x.name, joined: false } : x)) })
      setCodes((x) => Object.fromEntries(Object.entries(x).filter(([n]) => Number(n) !== s.n)))
    })
  }
  const saveRoster = () => {
    // 删掉的座号连进班记录一起删：已经进班的先问一下
    const gone = c.seats.filter((s) => s.joined && !parsed.seats.some((x) => x.n === s.n))
    if (gone.length && !window.confirm(`${gone.map((s) => seatName(s.n, s.name)).join('、')} 已经进班。删掉这些座号会连进班记录一起删：这些同学要重新选座号，之前的作答不再算在这个座号名下。确定保存吗？`)) return
    void run(async () => {
      const r = await send<{ class: Detail }>(base, { roster: parsed.seats })
      setC(r.class)
      setEditing('')
    })
  }
  const saveName = (e: FormEvent) => {
    e.preventDefault()
    void run(async () => {
      const r = await send<{ class: Detail }>(base, { name: newName.trim() })
      setC(r.class)
      setEditing('')
    })
  }
  const remove = () => {
    if (!window.confirm(`删除「${c.name}」？名单和学生的座号记录会一起删掉，学生扫这个班的二维码就进不来了。`)) return
    setBusy(true)
    setError('')
    send(`${base}/delete`, {}).then(onDeleted, (e) => {
      setError(problem(e))
      setBusy(false)
    })
  }
  const edit = (k: '' | 'name' | 'roster') => {
    setEditing(k)
    setError('')
    setFields({})
    if (k === 'name') setNewName(c.name)
    if (k === 'roster') setText(formatRoster(c.seats))
  }

  return (
    <section className={`${card} flex flex-col gap-4 p-5`}>
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h2 className="m-0 text-[20px] font-bold">{c.name}</h2>
        <span className="text-[13px] text-ink2">
          {c.seats.length} 人 · 已进班 {joined} 人
        </span>
      </div>
      <div className="flex flex-wrap gap-2">
        <button type="button" disabled={busy} aria-expanded={editing === 'roster'} onClick={() => edit(editing === 'roster' ? '' : 'roster')} className={btn.small}>
          改名单
        </button>
        <button type="button" disabled={busy} aria-expanded={editing === 'name'} onClick={() => edit(editing === 'name' ? '' : 'name')} className={btn.small}>
          改班名
        </button>
        <button type="button" disabled={busy} onClick={remove} className={`${btn.small} text-red-dark`}>
          删除班级
        </button>
      </div>

      {editing === 'name' && (
        <form onSubmit={saveName} className="flex flex-col gap-3 rounded-xl bg-ground p-3">
          <Field label="班级名" hint={`最多 ${MAX_NAME} 个字`} error={fields.name}>
            <input required value={newName} onChange={(e) => setNewName(e.target.value)} maxLength={MAX_NAME} className={input} />
          </Field>
          <div className="flex flex-wrap gap-3">
            <button type="submit" disabled={busy || !newName.trim()} className={btn.secondary}>
              保存班名
            </button>
            <button type="button" onClick={() => edit('')} className="text-[14px] text-muted underline">
              取消
            </button>
          </div>
        </form>
      )}

      {editing === 'roster' && (
        <div className="flex flex-col gap-3 rounded-xl bg-ground p-3">
          <RosterField text={text} onChange={setText} error={fields.roster} />
          <p className="m-0 text-[13px] leading-relaxed text-amber-dark">保存后整份名单换成上面这份：留下的座号不变（姓名可以改）；删掉的座号会连学生的进班记录一起删，这位同学要重新选座号。</p>
          <div className="flex flex-wrap gap-3">
            <button type="button" disabled={busy || !parsed.seats.length || parsed.errors.length > 0} onClick={saveRoster} className={btn.secondary}>
              保存名单（{parsed.seats.length} 人）
            </button>
            <button type="button" onClick={() => edit('')} className="text-[14px] text-muted underline">
              取消
            </button>
          </div>
        </div>
      )}

      <Alert text={error} />

      <ul className="m-0 flex list-none flex-col p-0">
        {c.seats.map((s) => (
          <li key={s.n} className="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-t border-line-soft py-2.5 first:border-t-0">
            <span className="w-7 shrink-0 text-[15px] font-semibold">{pad(s.n)}</span>
            {/* 姓名留够宽度：手机上放不下时按钮换到下一行，不把姓名挤成一字一行 */}
            <span className="min-w-[6em] flex-1 text-[15px]">{s.name || <span className="text-muted">（没填姓名）</span>}</span>
            <Pill tone={s.joined ? 'green' : 'gray'}>{s.joined ? '已进班' : '未进班'}</Pill>
            {s.joined && (
              <span className="ml-auto flex gap-2">
                <button type="button" disabled={busy} onClick={() => resetCode(s)} className={btn.small}>
                  新找回码
                </button>
                <button type="button" disabled={busy} onClick={() => clear(s)} className={btn.small}>
                  清空座号
                </button>
              </span>
            )}
            {codes[s.n] && (
              <span className="w-full rounded-lg bg-note px-3 py-2 text-[14px] leading-relaxed">
                新找回码 <b className="font-mono text-[17px] tracking-widest">{codes[s.n]}</b>：只显示这一次，请告诉这位同学（旧的已经作废）。
              </span>
            )}
          </li>
        ))}
      </ul>
      <p className="m-0 text-[12px] leading-relaxed text-muted">学生换了手机，用座号和找回码就能接着用；找回码丢了，点「新找回码」给他一个新的。选错了座号，点「清空座号」让他重新选。</p>
    </section>
  )
}
