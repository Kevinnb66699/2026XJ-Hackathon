// #/me 学生账号页（?mode=register 直接打开注册，?next= 登录后去哪）。没登录：登录 / 用邀请码注册两种模式，还有「用找回码改密码」；
// 登录了：用户名、AI 写作检查开关（服务器开放了才有）、「按我以前的记录调整提示」开关（默认开）、用找回码改密码、问卷、下载我的数据（服务器的完整导出，在浏览器里合进这台设备上的写作草稿和以前每篇里填的问卷）、退出、注销账号（要再输一次密码，成功后回首页）。
// 注册填邀请码、用户名（旁边提示不要用真实姓名或手机号）、密码两次、出生年月（两个下拉框）、必勾隐私说明；没有「称呼」，也没有 AI 的勾选（AI 写作检查默认开着，在账号页可以关掉）。
// 选的出生年月不满 14 周岁（student-auth 的 underGuardianAge，算法同后端）时，下面多一项必勾的「家长已经看过隐私说明并同意」（11-08 队长定）。
// 年龄够不够由后端判断（不满的这个码作废），前端不先拦：先拦的话改一个年份再交就绕过去了。家长那一项前端只管显示，要不要勾也以后端为准。注册成功显示一次找回码，「我记下来了」以后做一次问卷（可以跳过）。
// 账号页能看、能改问卷答案（GET / PUT /api/student/profile）。
// 登录、注册成功后去 next（只认站内地址，见 student-auth 的 safeNext），默认回首页。不引用老师的 lib/auth 和 components/Account
import { useEffect, useState, type ChangeEvent, type FormEvent, type ReactNode } from 'react'
import type { Profile } from '../../shared/schema'
import { SiteHeader, btn, card } from '../components/ui'
import { drain } from '../lib/events'
import { getParams } from '../lib/router'
import { localData } from '../lib/store'
import { GUARDIAN_AGE, StudentError, deleteAccount, fetchExport, getProfile, goNext, login, logout, register, resetPassword, safeNext, saveAdapt, saveAi, saveProfile, underGuardianAge, useStudentMe, withLocal, type Student } from '../lib/student-auth'
import { GOAL_LABEL, Survey } from './student/Survey'

type Mode = 'login' | 'register' | 'reset'
type Form = { invite: string; username: string; password: string; password2: string; year: string; month: string; code: string }
type Shown = { code: string; after: 'register' | 'reset'; username: string } // 刚拿到的找回码

const input = 'w-full rounded-xl border border-line-strong bg-surface px-3 py-2.5 text-[16px] text-ink focus:border-primary focus:outline-none'
const EMPTY: Form = { invite: '', username: '', password: '', password2: '', year: '', month: '', code: '' }
// 出生年份：从 5 岁到 60 岁都列出来，年龄不够的也能如实选（后端会拒），不靠下拉框的范围把关
const THIS_YEAR = new Date().getFullYear()
const YEARS = Array.from({ length: 56 }, (_, i) => String(THIS_YEAR - 5 - i))
const MONTHS = Array.from({ length: 12 }, (_, i) => String(i + 1))
// 家长那一项没勾：和后端的提示一样
const GUARDIAN_MISSING = `不满 ${GUARDIAN_AGE} 周岁要先请家长看过隐私说明并同意，勾上以后再注册`

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

function Alert({ text }: { text: string }) {
  return text ? (
    <p role="alert" className="m-0 rounded-xl bg-red-light px-4 py-3 text-[14px] leading-relaxed text-red-dark">
      {text}
    </p>
  ) : null
}

export default function StudentLoginPage() {
  const { loading, student } = useStudentMe()
  const [mode, setMode] = useState<Mode>(() => (getParams().get('mode') === 'register' ? 'register' : 'login'))
  const [shown, setShown] = useState<Shown | null>(null)
  const [asking, setAsking] = useState(false) // 刚注册好、看过找回码：做一次问卷
  const [notice, setNotice] = useState('') // 改好密码以后：请用新密码登录

  // 找回码只显示这一次：不管登录状态怎么变，先显示它
  const page = asking ? (
    <FirstSurvey onLeave={() => goNext(safeNext(getParams().get('next')))} />
  ) : shown ? (
    <CodeScreen
      shown={shown}
      onDone={() => {
        setShown(null)
        if (shown.after === 'register') return setAsking(true)
        setMode('login')
        setNotice('密码改好了，请用新密码登录。')
      }}
    />
  ) : loading ? (
    <p className="m-0 text-[14px] text-muted">正在加载……</p>
  ) : student && mode !== 'reset' ? (
    <MyPage me={student} onReset={() => setMode('reset')} />
  ) : mode === 'reset' ? (
    <ResetForm username={student?.username ?? ''} onDone={setShown} onBack={() => setMode('login')} />
  ) : (
    <SignIn mode={mode} notice={notice} onMode={setMode} onRegistered={setShown} />
  )

  return (
    <div className="min-h-screen bg-ground">
      <SiteHeader label={asking ? '问卷' : student && !shown ? '我的账号' : '学生登录'} />
      <main className="mx-auto flex max-w-md flex-col gap-5 px-4 py-6">{page}</main>
    </div>
  )
}

// 登录 / 用邀请码注册。注册时后端按输入框给的错误（fields）标在对应的输入框下面；两次密码对不上在前端就拦下
function SignIn({ mode, notice, onMode, onRegistered }: { mode: Mode; notice: string; onMode: (m: Mode) => void; onRegistered: (s: Shown) => void }) {
  const [form, setForm] = useState<Form>(EMPTY)
  const [agree, setAgree] = useState(false)
  const [guardian, setGuardian] = useState(false)
  const [fields, setFields] = useState<Record<string, string>>({})
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const reg = mode === 'register'
  const birth = `${form.year}-${form.month.padStart(2, '0')}`
  const young = reg && underGuardianAge(birth) // 不满 14 周岁：多一项家长的勾选

  // 改了哪一格，那一格的红字先去掉
  const set = (k: keyof Form) => (e: ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
    const v = e.target.value
    setForm((f) => ({ ...f, [k]: v }))
    setFields((f) => Object.fromEntries(Object.entries(f).filter(([x]) => x !== k && !(x === 'birth' && (k === 'year' || k === 'month')))))
  }
  const pick = (m: Mode) => {
    onMode(m)
    setFields({})
    setError('')
  }

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setError('')
    setFields({})
    if (reg && form.password !== form.password2) return setFields({ password2: '两次输入的密码不一样' })
    if (reg && !agree) return setError('请先勾选「我读过隐私说明，同意按账号保存学习记录」。')
    if (young && !guardian) return setError(GUARDIAN_MISSING)
    setBusy(true)
    try {
      if (!reg) {
        await login(form.username.trim(), form.password)
        return goNext(safeNext(getParams().get('next')))
      }
      const r = await register({ invite: form.invite.trim(), username: form.username.trim(), password: form.password, birth, agree: true, ...(young ? { guardian: true as const } : {}) })
      onRegistered({ code: r.recoveryCode, after: 'register', username: r.student.username })
    } catch (err) {
      setFields((err as StudentError).fields ?? {})
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <form onSubmit={submit} className={`${card} flex flex-col gap-4 p-5`}>
        <h1 className="m-0 text-[22px] font-bold">学生账号</h1>
        <div role="group" aria-label="登录还是注册" className="flex self-start overflow-hidden rounded-[10px] border border-line-strong">
          {(['login', 'register'] as const).map((m) => (
            <button key={m} type="button" aria-pressed={mode === m} onClick={() => pick(m)} className={`min-h-[40px] px-4 text-[14px] ${mode === m ? 'bg-primary text-white' : 'bg-surface'}`}>
              {m === 'login' ? '登录' : '用邀请码注册'}
            </button>
          ))}
        </div>
        {notice && !reg && <p className="m-0 rounded-xl bg-green-light px-4 py-3 text-[14px] text-green-dark">{notice}</p>}
        {reg ? (
          <p className="m-0 text-[14px] leading-relaxed text-ink2">知适在小范围内测，注册要用团队发的邀请码，一个邀请码注册一个账号。</p>
        ) : (
          <p className="m-0 text-[14px] leading-relaxed text-ink2">第一次来、手里有邀请码？点上面的「用邀请码注册」。</p>
        )}
        {reg && (
          <Field label="邀请码" error={fields.invite}>
            {/* 手机上别自动大写、别联想 */}
            <input required value={form.invite} onChange={set('invite')} autoComplete="off" autoCapitalize="off" spellCheck={false} aria-invalid={!!fields.invite} className={input} />
          </Field>
        )}
        <Field label="用户名" hint={reg ? '不要用真实姓名或手机号' : undefined} error={fields.username}>
          <input required value={form.username} onChange={set('username')} maxLength={32} autoComplete="username" autoCapitalize="off" spellCheck={false} aria-invalid={!!fields.username} className={input} />
          {reg && <span className="text-[12px] text-muted">3–32 个字符，字母、数字、_ . -</span>}
        </Field>
        <Field label="密码" hint={reg ? '至少 8 个字符' : undefined} error={fields.password}>
          <input required type="password" value={form.password} onChange={set('password')} maxLength={128} autoComplete={reg ? 'new-password' : 'current-password'} aria-invalid={!!fields.password} className={input} />
        </Field>
        {reg && (
          <>
            <Field label="再输一次密码" error={fields.password2}>
              <input required type="password" value={form.password2} onChange={set('password2')} maxLength={128} autoComplete="new-password" aria-invalid={!!fields.password2} className={input} />
            </Field>
            {/* 出生年月：两个下拉框，默认不选。只用来确认年龄，不保存 */}
            <div role="group" aria-labelledby="birth-label" className="flex flex-col gap-1.5">
              <span id="birth-label" className="text-[14px] font-semibold">
                出生年月<span className="ml-2 text-[12px] font-normal text-muted">只用来确认年龄，不保存</span>
              </span>
              <div className="flex gap-2">
                <select required aria-label="出生年份" value={form.year} onChange={set('year')} aria-invalid={!!fields.birth} className={input}>
                  <option value="">年</option>
                  {YEARS.map((y) => (
                    <option key={y} value={y}>
                      {y} 年
                    </option>
                  ))}
                </select>
                <select required aria-label="出生月份" value={form.month} onChange={set('month')} aria-invalid={!!fields.birth} className={input}>
                  <option value="">月</option>
                  {MONTHS.map((m) => (
                    <option key={m} value={m}>
                      {m} 月
                    </option>
                  ))}
                </select>
              </div>
              {fields.birth && <span className="text-[13px] leading-relaxed text-red-dark">{fields.birth}</span>}
            </div>
            {/* 必勾。隐私说明在新标签页打开：本页一离开，填了一半的表单就没了 */}
            <label className="flex items-start gap-3 text-[15px] leading-relaxed">
              <input type="checkbox" required checked={agree} onChange={(e) => setAgree(e.target.checked)} className="mt-0.5 h-5 w-5 shrink-0 accent-primary" />
              <span>
                我读过
                <a href="#/privacy" target="_blank" rel="noreferrer" className="text-primary underline">
                  隐私说明
                </a>
                ，同意按账号保存学习记录
              </span>
            </label>
            {/* 不满 14 周岁才有，也是必勾。链接打开隐私说明里不满 14 周岁的那一节 */}
            {young && (
              <label className="flex items-start gap-3 text-[15px] leading-relaxed">
                <input type="checkbox" required checked={guardian} onChange={(e) => setGuardian(e.target.checked)} className="mt-0.5 h-5 w-5 shrink-0 accent-primary" />
                <span>
                  我不满 {GUARDIAN_AGE} 周岁，家长已经看过
                  <a href="#/privacy?s=minors" target="_blank" rel="noreferrer" className="text-primary underline">
                    隐私说明
                  </a>
                  并同意我注册
                </span>
              </label>
            )}
          </>
        )}
        <button type="submit" disabled={busy} className={btn.primary}>
          {busy ? (reg ? '正在注册……' : '正在登录……') : reg ? '注册并登录' : '登录'}
        </button>
        {!reg && (
          <button type="button" onClick={() => pick('reset')} className="self-start text-[14px] text-primary underline">
            忘了密码？用找回码改密码
          </button>
        )}
      </form>
      <Alert text={error} />
      <p className="m-0 text-[13px] leading-relaxed text-muted">不收手机号和邮箱；出生年月只用来确认年龄，不保存。账号连续 12 个月没用会自动删除，删之前没法通知你。</p>
    </>
  )
}

// 用找回码改密码：没登录时从登录页进来，登录了从账号页进来（用户名先填好）。成功后显示新的找回码，所有设备上的登录都失效
function ResetForm({ username, onDone, onBack }: { username: string; onDone: (s: Shown) => void; onBack: () => void }) {
  const [form, setForm] = useState<Form>({ ...EMPTY, username })
  const [error, setError] = useState('')
  const [fields, setFields] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  const set = (k: keyof Form) => (e: ChangeEvent<HTMLInputElement>) => {
    const v = e.target.value
    setForm((f) => ({ ...f, [k]: v }))
  }

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setError('')
    setFields({})
    if (form.password !== form.password2) return setFields({ password2: '两次输入的密码不一样' })
    setBusy(true)
    try {
      const code = await resetPassword({ username: form.username.trim(), code: form.code, newPassword: form.password })
      onDone({ code, after: 'reset', username: form.username.trim() })
    } catch (err) {
      setFields((err as StudentError).fields ?? {})
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <form onSubmit={submit} className={`${card} flex flex-col gap-4 p-5`}>
        <h1 className="m-0 text-[22px] font-bold">用找回码改密码</h1>
        <p className="m-0 text-[14px] leading-relaxed text-ink2">改好以后，所有设备上的登录都会退出，要用新密码重新登录；找回码也会换一个新的。</p>
        <Field label="用户名" error={fields.username}>
          <input required value={form.username} onChange={set('username')} maxLength={32} autoComplete="username" autoCapitalize="off" spellCheck={false} className={input} />
        </Field>
        <Field label="找回码" hint="注册时拿到的，不分大小写" error={fields.code}>
          <input required value={form.code} onChange={set('code')} maxLength={20} autoComplete="off" autoCapitalize="characters" spellCheck={false} className={`${input} font-mono tracking-widest`} />
        </Field>
        <Field label="新密码" hint="至少 8 个字符" error={fields.newPassword ?? fields.password}>
          <input required type="password" value={form.password} onChange={set('password')} maxLength={128} autoComplete="new-password" className={input} />
        </Field>
        <Field label="再输一次新密码" error={fields.password2}>
          <input required type="password" value={form.password2} onChange={set('password2')} maxLength={128} autoComplete="new-password" className={input} />
        </Field>
        <button type="submit" disabled={busy} className={btn.primary}>
          {busy ? '正在改……' : '改密码'}
        </button>
        <button type="button" onClick={onBack} className="self-start text-[14px] text-primary underline">
          ← 回去
        </button>
      </form>
      <Alert text={error} />
    </>
  )
}

function CodeScreen({ shown, onDone }: { shown: Shown; onDone: () => void }) {
  return (
    <section className={`${card} flex flex-col items-center gap-4 p-5 text-center`}>
      {/* 用户名最长 32 个字母数字、中间没处可断：允许在任意处折行，窄手机上不撑出横向滚动 */}
      <h1 className="m-0 max-w-full text-[20px] font-bold [overflow-wrap:anywhere]">{shown.after === 'register' ? `注册好了：${shown.username}` : '密码改好了'}</h1>
      <span className="text-[14px] text-ink2">你的找回码</span>
      <span className="select-all rounded-xl bg-ground px-5 py-3 font-mono text-[34px] font-bold tracking-[0.25em]">{shown.code}</span>
      <p className="m-0 text-[15px] leading-relaxed">请截图或抄下来。忘了密码时，用用户名和找回码改密码。</p>
      <p className="m-0 text-[13px] leading-relaxed text-muted">找回码只显示这一次。{shown.after === 'reset' ? '旧的找回码已经不能用了。' : ''}</p>
      <button type="button" className={`${btn.primary} w-full`} onClick={onDone}>
        我记下来了
      </button>
    </section>
  )
}

// 注册好、看过找回码以后做一次问卷：保存或跳过以后去 next（同登录）。保存没成功就留在这一页，可以再试或者跳过
function FirstSurvey({ onLeave }: { onLeave: () => void }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const done = async (p: Profile) => {
    setError('')
    setBusy(true)
    try {
      await saveProfile(p)
      onLeave()
    } catch (err) {
      setError((err as Error).message)
      setBusy(false)
    }
  }
  return (
    <>
      <section className={`${card} flex flex-col gap-4 p-5`}>
        <h1 className="m-0 text-[22px] font-bold">再问 3 个问题</h1>
        <Survey busy={busy} doneLabel="保存，去读文章" skipLabel="跳过" onDone={(p) => void done(p)} onSkip={onLeave} />
      </section>
      <Alert text={error} />
    </>
  )
}

// 账号页的问卷：打开时拉一次答案，点「改一改」在这里改，保存后显示新的答案。没答的不显示
function ProfileSection({ disabled }: { disabled: boolean }) {
  const [profile, setProfile] = useState<Profile | null>(null) // null：还在拉
  const [editing, setEditing] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => {
    let alive = true
    getProfile().then(
      (p) => alive && setProfile(p),
      (err: Error) => alive && setError(err.message),
    )
    return () => {
      alive = false
    }
  }, [])
  const save = async (p: Profile) => {
    setError('')
    setBusy(true)
    try {
      setProfile(await saveProfile(p))
      setEditing(false)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }
  const lines = profile
    ? [profile.grade && `年级：${profile.grade}`, profile.curriculum && `课程体系：${profile.curriculum}`, profile.goal && `读英文主要为了：${GOAL_LABEL[profile.goal]}`].filter(Boolean)
    : []

  return (
    <section className={`${card} flex flex-col items-start gap-3 p-5`}>
      <h2 className="m-0 text-[16px] font-bold">问卷</h2>
      {editing && profile ? (
        <Survey initial={profile} busy={busy} doneLabel="保存" skipLabel="不改了" onDone={(p) => void save(p)} onSkip={() => setEditing(false)} />
      ) : (
        <>
          {!profile && !error && <p className="m-0 text-[14px] text-muted">正在加载……</p>}
          {profile && <p className="m-0 text-[15px] leading-relaxed text-ink2">{lines.length ? lines.join('；') : '还没填。'}</p>}
          {profile && (
            <button type="button" disabled={disabled} onClick={() => setEditing(true)} className={btn.secondary}>
              改一改
            </button>
          )}
          <span className="text-[13px] leading-relaxed text-muted">答案记在账号上，用来决定词卡里要不要放「高中新词」，年级也用来调整精读的注释，课程体系只用来帮你先选好目标；不会给你打等级。关掉上面的开关就不用。</span>
        </>
      )}
      <Alert text={error} />
    </section>
  )
}

// 登录以后的账号页
function MyPage({ me, onReset }: { me: Student; onReset: () => void }) {
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const run = async (fn: () => Promise<void>) => {
    setError('')
    setBusy(true)
    try {
      await fn()
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  // 下载我的数据：服务器给的文件里合进这台设备上的问卷答案和写作草稿（只在浏览器里合，不发给服务器），存成一个 JSON 文件
  const download = () =>
    run(async () => {
      const { blob, filename } = await fetchExport()
      const url = URL.createObjectURL(new Blob([withLocal(await blob.text(), localData(me.sid))], { type: 'application/json' }))
      const a = document.createElement('a')
      a.href = url
      a.download = filename
      a.click()
      setTimeout(() => URL.revokeObjectURL(url), 1000)
    })

  // 退出：先把这个账号排着的作答发完；发不完（连不上）先问一句，确定了再退出，退出后清掉这台设备上这个账号的记录
  const out = () =>
    run(async () => {
      if (!(await drain(me.sid)) && !window.confirm('还有作答没传到账号上（可能是网络不好）。现在退出，这些作答会丢掉。确定退出吗？')) return
      await logout()
    })

  return (
    <>
      <section className={`${card} flex flex-col gap-3 p-5`}>
        <h1 className="m-0 text-[22px] font-bold">我的账号</h1>
        <p className="m-0 text-[15px] text-ink2">用户名：{me.username}</p>
        <a href="#/" className={`${btn.secondary} inline-flex items-center self-start no-underline`}>
          去读文章
        </a>
      </section>

      {me.aiAvailable && (
        <section className={`${card} flex flex-col gap-3 p-5`}>
          <div className="flex items-center justify-between gap-3">
            <h2 className="m-0 text-[16px] font-bold">AI 写作检查</h2>
            <button
              type="button"
              role="switch"
              aria-checked={me.ai}
              aria-label="AI 写作检查"
              disabled={busy}
              onClick={() => void run(async () => {
                await saveAi(!me.ai)
              })}
              className={`min-h-[36px] shrink-0 rounded-lg border px-3 text-[13px] ${me.ai ? 'border-primary bg-primary text-white' : 'border-line-strong bg-surface text-ink2'}`}
            >
              {me.ai ? '开' : '关'}
            </button>
          </div>
          <p className="m-0 text-[14px] leading-relaxed text-ink2">
            打开以后，在写作页点「检查一下」，你写的英文句子会发给 AI，看表达用得对不对、哪里可能写错；知适不保存原文。关着的时候只检查有没有用上要求的表达。
          </p>
        </section>
      )}

      {/* 阶段 7：关掉以后读文章时不把画像交给引擎（Student.tsx 的 getLearner），和班级的同学看到的一样。页面上不显示推算出来的任何东西 */}
      <section className={`${card} flex flex-col gap-3 p-5`}>
        <div className="flex items-center justify-between gap-3">
          <h2 className="m-0 text-[16px] font-bold">
            按我以前的记录调整提示<span className="font-normal text-ink2">（关掉就用标准版）</span>
          </h2>
          <button
            type="button"
            role="switch"
            aria-checked={me.adapt}
            aria-label="按我以前的记录调整提示"
            disabled={busy}
            onClick={() => void run(async () => {
              await saveAdapt(!me.adapt)
            })}
            className={`min-h-[36px] shrink-0 rounded-lg border px-3 text-[13px] ${me.adapt ? 'border-primary bg-primary text-white' : 'border-line-strong bg-surface text-ink2'}`}
          >
            {me.adapt ? '开' : '关'}
          </button>
        </div>
        <p className="m-0 text-[14px] leading-relaxed text-ink2">
          开着的时候，读文章会根据你填的问卷和单词本里的词调整注释和词卡：单词本里的词在新文章里出现，会加注释、放进词卡。不会给你打等级。关掉以后，只按你在这一篇里的作答调整。
        </p>
      </section>

      <ProfileSection disabled={busy} />

      <section className={`${card} flex flex-col items-start gap-3 p-5`}>
        <h2 className="m-0 text-[16px] font-bold">密码和数据</h2>
        <button type="button" disabled={busy} onClick={onReset} className={btn.secondary}>
          用找回码改密码
        </button>
        <button type="button" disabled={busy} onClick={() => void download()} className={btn.secondary}>
          下载我的数据
        </button>
        <span className="text-[13px] leading-relaxed text-muted">
          一个 JSON 文件：用户名、注册时间、设置、问卷答案、我的文章、学习记录、单词本、表达本，还有账号上原样的每一条记录。这台设备上的写作草稿（还有以前每篇开头填的问卷），下载时在浏览器里直接加进文件，不发给服务器。标了 AI 生成的中文由 AI 生成，可能有错。
        </span>
      </section>

      <section className={`${card} flex flex-col items-start gap-3 p-5`}>
        <button type="button" disabled={busy} onClick={() => void out()} className={btn.secondary}>
          退出
        </button>
        <span className="text-[13px] leading-relaxed text-muted">退出会清掉这台设备上的写作草稿、表达本和读到哪一步。作答、表达本和问卷答案记在账号上，再登录还在；写作草稿只存在这台设备上，清掉就没有了。</span>
      </section>
      <Alert text={error} />
      <DeleteAccount disabled={busy} />
    </>
  )
}

// 注销账号：先点开，看清删掉什么、备份里还留多久、码不能再用，再输一次密码。
// 成功后这台设备上这个账号的记录已经清掉（deleteAccount），先说一句已经注销（有一部分没删成的，说服务器会再删），再回首页
function DeleteAccount({ disabled }: { disabled: boolean }) {
  const [open, setOpen] = useState(false)
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setError('')
    setBusy(true)
    try {
      const { incomplete } = await deleteAccount(password)
      // 删完了也说：回首页后顶栏变回「登录」，和退出、会话过期看起来一样
      window.alert(incomplete ? '账号已经注销。有一部分学习记录这次没删成，服务器会自动再删。' : '账号已经注销，账号上的学习记录已经从服务器上删掉。')
      goNext('#/')
    } catch (err) {
      setError((err as Error).message)
      setBusy(false)
    }
  }
  const close = () => {
    setOpen(false)
    setPassword('')
    setError('')
  }

  if (!open) {
    return (
      <section className={`${card} flex flex-col items-start gap-3 p-5`}>
        <button type="button" disabled={disabled} onClick={() => setOpen(true)} className={`${btn.secondary} text-red-dark`}>
          注销账号
        </button>
      </section>
    )
  }
  return (
    <form onSubmit={submit} className={`${card} flex flex-col gap-4 p-5`}>
      <h2 className="m-0 text-[16px] font-bold">注销账号</h2>
      <ul className="m-0 flex list-disc flex-col gap-1.5 pl-5 text-[14px] leading-relaxed text-ink2">
        <li>账号和账号上的学习记录马上从服务器上删掉，不能恢复：用户名、密码、设置、问卷答案，还有你在每一篇里的作答、单词本和表达本。</li>
        <li>这台设备上这个账号的作答、读到哪一步、问卷、表达本和写作草稿也一起清掉。</li>
        <li>服务器的备份里最多还会留 30 天，到期自动删掉。</li>
        <li>用过的邀请码不能再注册。这个用户名以后别人可以注册。</li>
        <li>想留一份，先点上面的「下载我的数据」。</li>
      </ul>
      <Field label="再输一次密码">
        <input required type="password" value={password} onChange={(e) => setPassword(e.target.value)} maxLength={128} autoComplete="current-password" className={input} />
      </Field>
      <div className="flex flex-wrap gap-3">
        <button type="submit" disabled={busy} className="min-h-[46px] rounded-xl border border-red-dark bg-surface px-4 text-[15px] font-semibold text-red-dark hover:bg-red-light disabled:opacity-40">
          {busy ? '正在注销……' : '注销账号'}
        </button>
        <button type="button" disabled={busy} onClick={close} className={btn.secondary}>
          不注销了
        </button>
      </div>
      <Alert text={error} />
    </form>
  )
}
