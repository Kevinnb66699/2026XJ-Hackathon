// 老师账号（前端这一侧）：现在是谁登录着、登录、用邀请码注册、退出。接口见 deploy/README.md。
// 会话在 HttpOnly 的 cookie 里，页面读不到也不用管：fetch 默认同源请求会带上。
// GET /api/auth/me 的结果在模块里缓存（整个页面共用一份）；登录、注册、退出后更新，用 useMe 的组件跟着重画
import { useEffect, useState } from 'react'
import { UPLOAD_PENDING_KEY, writeLS } from './store'

export interface Teacher {
  id: string
  username: string
  name: string // 称呼，如「王老师」；注册时没填就是用户名
}

const OFFLINE = '连不上服务器，请检查网络'

// 请求失败：message 是后端给的中文提示；注册的 400 / 409 带 fields（输入框 → 提示），标在对应的输入框下面
export class AuthError extends Error {
  status: number
  fields: Record<string, string>
  constructor(message: string, status: number, fields: Record<string, string> = {}) {
    super(message)
    this.status = status
    this.fields = fields
  }
}

let me: Teacher | null | undefined // undefined：还没问过后端
let asking: Promise<Teacher | null> | null = null
let epoch = 0 // 登录、注册、退出成功一次加一：在那之前发出的 me 请求晚回来时，不再覆盖
const subscribers = new Set<(t: Teacher | null) => void>()
const settle = (t: Teacher | null) => {
  me = t
  subscribers.forEach((f) => f(t))
  return t
}
const asTeacher = (t: unknown): Teacher | null => {
  const x = t as Partial<Teacher> | null | undefined
  return x && typeof x.id === 'string' && typeof x.username === 'string' && typeof x.name === 'string' ? { id: x.id, username: x.username, name: x.name } : null
}

// 现在登录的老师，没登录是 null。默认用缓存；refresh 为 true 时重新问后端。连不上服务器时这次当没登录，但不缓存，下次再问
export function getMe(refresh = false): Promise<Teacher | null> {
  if (me !== undefined && !refresh) return Promise.resolve(me)
  if (asking && !refresh) return asking
  const at = epoch
  const p: Promise<Teacher | null> = fetch('/api/auth/me')
    .then((res) => (res.ok ? res.json() : Promise.reject(new Error(String(res.status)))))
    .then((data: { teacher?: unknown } | null) => (at === epoch ? settle(asTeacher(data?.teacher)) : me ?? null))
    .catch(() => me ?? null)
    .finally(() => {
      if (asking === p) asking = null
    })
  asking = p
  return p
}

// 页面里用：{loading, teacher}。第一次问后端时 loading 为 true
export function useMe(): { loading: boolean; teacher: Teacher | null } {
  const [teacher, setTeacher] = useState(me)
  useEffect(() => {
    subscribers.add(setTeacher)
    void getMe().then(setTeacher)
    return () => {
      subscribers.delete(setTeacher)
    }
  }, [])
  return { loading: teacher === undefined, teacher: teacher ?? null }
}

// 后端要求登录、注册、退出都是 JSON 请求（别的格式回 415）
async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).catch(() => {
    throw new AuthError(OFFLINE, 0)
  })
  const data = (await res.json().catch(() => ({}))) as T & { error?: unknown; fields?: unknown }
  if (!res.ok) {
    const fields = data.fields && typeof data.fields === 'object' ? Object.fromEntries(Object.entries(data.fields).filter(([, v]) => typeof v === 'string')) : {}
    throw new AuthError(typeof data.error === 'string' ? data.error : `请求失败（${res.status}）`, res.status, fields)
  }
  return data
}

const done = (t: Teacher | null) => {
  epoch++
  return settle(t)
}

export async function login(username: string, password: string): Promise<Teacher> {
  const { teacher } = await post<{ teacher: Teacher }>('/api/auth/login', { username, password })
  return done(teacher)!
}

// 称呼可不填（后端用用户名）；成功后就是登录状态
export async function register(input: { invite: string; username: string; password: string; name?: string }): Promise<Teacher> {
  const { teacher } = await post<{ teacher: Teacher }>('/api/auth/register', input)
  return done(teacher)!
}

export async function logout(): Promise<void> {
  await post('/api/auth/logout', {})
  writeLS(UPLOAD_PENDING_KEY, null) // 正在生成的任务是这个账号的：退出就清掉，换一位老师登录不会接着查别人的任务
  done(null)
}

// 去登录页、登录后回到 next（站内的 #/ 地址）的链接
export const loginHref = (next: string) => `#/login?next=${encodeURIComponent(next)}`

// 登录后去哪：只认站内的 #/ 地址，免得别人发来的链接借 next 把老师带到外站；其余一律回上传页
export const safeNext = (next: string | null | undefined): string => (next && next.startsWith('#/') ? next : '#/upload')
