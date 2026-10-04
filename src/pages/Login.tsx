// 老师登录 / 用邀请码注册（#/login?next=#/…）。账号只存用户名、称呼和加密后的密码，不收手机号、邮箱；忘了密码由知适团队在服务器上重置。
// 成功后去 next 指定的站内页面（只认 #/ 开头的，见 safeNext），默认上传页。已经登录的人打开这一页：显示「已登录为 X」、退出、去上传页。
// 注册时后端按输入框给的错误（fields）标在对应的输入框下面；两次密码对不上在前端就拦下
import { useEffect, useState, type ChangeEvent, type FormEvent, type ReactNode } from 'react'
import Account from '../components/Account'
import { SiteHeader, btn, card } from '../components/ui'
import { AuthError, getMe, login, logout, register, safeNext, useMe } from '../lib/auth'
import { getParams, go } from '../lib/router'

type Mode = 'login' | 'register'
type Form = { invite: string; username: string; name: string; password: string; password2: string }

const input = 'w-full rounded-xl border border-line-strong bg-surface px-3 py-2.5 text-[16px] text-ink focus:border-primary focus:outline-none'

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

export default function LoginPage() {
  const { loading, teacher } = useMe()
  // 打开登录页时重新问一次后端：会话可能在别的页面开着时过期了（缓存里还算登录着），老师端「登录后才能看」点过来就该是登录表单
  useEffect(() => {
    void getMe(true)
  }, [])
  const [mode, setMode] = useState<Mode>('login')
  const [form, setForm] = useState<Form>({ invite: '', username: '', name: '', password: '', password2: '' })
  const [fields, setFields] = useState<Record<string, string>>({})
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  // 改了哪一格，那一格的红字先去掉
  const set = (k: keyof Form) => (e: ChangeEvent<HTMLInputElement>) => {
    const v = e.target.value
    setForm((f) => ({ ...f, [k]: v }))
    setFields((f) => Object.fromEntries(Object.entries(f).filter(([x]) => x !== k)))
  }
  const pick = (m: Mode) => {
    setMode(m)
    setFields({})
    setError('')
  }

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setError('')
    setFields({})
    if (mode === 'register' && form.password !== form.password2) return setFields({ password2: '两次输入的密码不一样' })
    setBusy(true)
    try {
      if (mode === 'login') await login(form.username.trim(), form.password)
      else await register({ invite: form.invite.trim(), username: form.username.trim(), password: form.password, name: form.name.trim() || undefined })
      go(safeNext(getParams().get('next')))
    } catch (err) {
      setFields((err as AuthError).fields ?? {})
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const out = () => {
    setError('')
    logout().catch((err: Error) => setError(err.message))
  }

  const reg = mode === 'register'
  return (
    <div className="min-h-screen bg-ground">
      <SiteHeader label="老师登录" actions={teacher ? <Account /> : undefined} />
      <main className="mx-auto flex max-w-md flex-col gap-5 px-4 py-6">
        {loading ? (
          <p className="m-0 text-[14px] text-muted">正在加载……</p>
        ) : teacher ? (
          <section className={`${card} flex flex-col gap-4 p-5`}>
            <h1 className="m-0 text-[22px] font-bold">已登录为 {teacher.name}</h1>
            <p className="m-0 text-[14px] text-ink2">用户名：{teacher.username}</p>
            <div className="flex flex-wrap gap-3">
              <a href="#/upload" className={`${btn.primary} inline-flex items-center`}>
                去上传页
              </a>
              <button type="button" onClick={out} className={btn.secondary}>
                退出
              </button>
            </div>
          </section>
        ) : (
          <form onSubmit={submit} className={`${card} flex flex-col gap-4 p-5`}>
            <h1 className="m-0 text-[22px] font-bold">老师账号</h1>
            <div role="group" aria-label="登录还是注册" className="flex self-start overflow-hidden rounded-[10px] border border-line-strong">
              {(['login', 'register'] as const).map((m) => (
                <button key={m} type="button" aria-pressed={mode === m} onClick={() => pick(m)} className={`min-h-[40px] px-4 text-[14px] ${mode === m ? 'bg-primary text-white' : 'bg-surface'}`}>
                  {m === 'login' ? '登录' : '用邀请码注册'}
                </button>
              ))}
            </div>
            {reg && <p className="m-0 text-[14px] leading-relaxed text-ink2">注册目前只对受邀老师开放，邀请码由知适团队发放，一个邀请码注册一个账号。</p>}
            {reg && (
              <Field label="邀请码" error={fields.invite}>
                {/* 码是小写字母和数字：手机上别自动大写、别联想 */}
                <input required value={form.invite} onChange={set('invite')} autoComplete="off" autoCapitalize="off" spellCheck={false} className={input} />
              </Field>
            )}
            <Field label="用户名" hint={reg ? '3–32 个字符，字母、数字、_ . -' : undefined} error={fields.username}>
              <input required value={form.username} onChange={set('username')} maxLength={32} autoComplete="username" autoCapitalize="off" spellCheck={false} aria-invalid={!!fields.username} className={input} />
            </Field>
            {reg && (
              <Field label="称呼" hint="可不填" error={fields.name}>
                <input value={form.name} onChange={set('name')} maxLength={20} placeholder="例：王老师" autoComplete="off" aria-invalid={!!fields.name} className={input} />
              </Field>
            )}
            <Field label="密码" hint={reg ? '至少 8 个字符' : undefined} error={fields.password}>
              <input required type="password" value={form.password} onChange={set('password')} maxLength={128} autoComplete={reg ? 'new-password' : 'current-password'} aria-invalid={!!fields.password} className={input} />
            </Field>
            {reg && (
              <Field label="再输一次密码" error={fields.password2}>
                <input required type="password" value={form.password2} onChange={set('password2')} maxLength={128} autoComplete="new-password" aria-invalid={!!fields.password2} className={input} />
              </Field>
            )}
            <button type="submit" disabled={busy} className={btn.primary}>
              {busy ? (reg ? '正在注册……' : '正在登录……') : reg ? '注册并登录' : '登录'}
            </button>
          </form>
        )}
        {error && (
          <p role="alert" className="m-0 rounded-xl bg-red-light px-4 py-3 text-[14px] leading-relaxed text-red-dark">
            {error}
          </p>
        )}
        {!loading && !teacher && (
          <p className="m-0 text-[13px] leading-relaxed text-muted">
            只保存用户名、称呼和加密后的密码，不收手机号和邮箱。
            <br />
            忘了密码：请联系知适团队重置。
          </p>
        )}
      </main>
    </div>
  )
}
