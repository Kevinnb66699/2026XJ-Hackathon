// 学生账号（前端这一侧）：现在是谁登录着、登录、用邀请码注册、退出、AI 写作检查开关、用找回码改密码、团队选的文章、这一篇的作答、下载我的数据。
// 会话在 HttpOnly 的 cookie（zhishi_student）里，页面读不到也不用管：同源请求默认带上。和老师的会话互不相认，这个文件不引用老师的 lib/auth.ts。
// GET /api/student/me 的结果在模块里缓存（整个页面共用一份）；登录、注册、退出、改设置后更新，用 useStudentMe 的组件跟着重画
import { useEffect, useState } from 'react'
import { LearningEvent } from '../../shared/schema'
import { cleanCode } from './classes'
import { drain, forget } from './events'
import { clearSid } from './store'

export interface Student {
  username: string
  sid: string // u- 开头，只用在事件和本机存储上
  ai: boolean // 账号上的 AI 写作检查开关（注册时默认开着，学生可以在账号页关掉）
  aiAvailable: boolean // 服务器有没有开放账号学生的 AI 写作检查
}
export interface ShelfItem {
  id: string
  title: string
}

const OFFLINE = '连不上服务器，请检查网络'

// 请求失败：message 是后端给的中文提示；status 是状态码（连不上服务器是 0）；fields（输入框 → 提示）标在对应的输入框下面
export class StudentError extends Error {
  status: number
  fields: Record<string, string>
  constructor(message: string, status: number, fields: Record<string, string> = {}) {
    super(message)
    this.status = status
    this.fields = fields
  }
}

// 请求：有 body 就发 JSON（后端只收 JSON）。10 秒没回应算连不上
async function request<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 10000)
  const init: RequestInit = body === undefined ? { signal: ctrl.signal } : { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: ctrl.signal }
  try {
    const res = await fetch(path, init).catch(() => {
      throw new StudentError(OFFLINE, 0)
    })
    const data = (await res.json().catch(() => ({}))) as T & { error?: unknown; fields?: unknown }
    if (!res.ok) {
      const fields = data.fields && typeof data.fields === 'object' ? Object.fromEntries(Object.entries(data.fields).filter(([, v]) => typeof v === 'string')) : {}
      throw new StudentError(typeof data.error === 'string' ? data.error : `请求失败（${res.status}）`, res.status, fields)
    }
    return data
  } finally {
    clearTimeout(timer)
  }
}

export const asStudent = (s: unknown): Student | null => {
  const x = s as Partial<Student> | null | undefined
  return x && typeof x.username === 'string' && typeof x.sid === 'string' && /^u-[0-9a-f]{16}$/.test(x.sid)
    ? { username: x.username, sid: x.sid, ai: x.ai === true, aiAvailable: x.aiAvailable === true }
    : null
}

let me: Student | null | undefined // undefined：还没问过后端
let asking: Promise<Student | null> | null = null
let epoch = 0 // 登录、注册、退出成功一次加一：在那之前发出的 me 请求晚回来时，不再覆盖
const subscribers = new Set<(s: Student | null) => void>()
const settle = (s: Student | null) => {
  me = s
  subscribers.forEach((f) => f(s))
  return s
}
const done = (s: Student | null) => {
  epoch++
  return settle(s)
}

// 现在登录的学生，没登录是 null。默认用缓存；refresh 为 true 时重新问后端。连不上服务器时这次当没登录，但不缓存，下次再问
export function getStudent(refresh = false): Promise<Student | null> {
  if (me !== undefined && !refresh) return Promise.resolve(me)
  if (asking && !refresh) return asking
  const at = epoch
  const p: Promise<Student | null> = fetch('/api/student/me')
    .then((res) => (res.ok ? res.json() : Promise.reject(new Error(String(res.status)))))
    .then((data: { student?: unknown } | null) => (at === epoch ? settle(asStudent(data?.student)) : me ?? null))
    .catch(() => me ?? null)
    .finally(() => {
      if (asking === p) asking = null
    })
  asking = p
  return p
}

// 页面里用：{loading, student}。第一次问后端时 loading 为 true
export function useStudentMe(): { loading: boolean; student: Student | null } {
  const [student, setStudent] = useState(me)
  useEffect(() => {
    subscribers.add(setStudent)
    void getStudent().then(setStudent)
    return () => {
      subscribers.delete(setStudent)
    }
  }, [])
  return { loading: student === undefined, student: student ?? null }
}

// 登录、注册以后：这个账号之前因为没登录发不出去的作答，现在发
const signedIn = (s: Student | null) => {
  if (!s) throw new StudentError('服务器的回应不对，请刷新后再试', 200)
  done(s)
  void drain(s.sid)
  return s
}

export async function login(username: string, password: string): Promise<Student> {
  const r = await request<{ student?: unknown }>('/api/student/login', 'POST', { username, password })
  return signedIn(asStudent(r.student))
}

// birth：'YYYY-MM'，后端只用来判断年龄，不保存。agree：勾了隐私说明。成功后就是登录状态，找回码只在这里拿到一次
export async function register(input: { invite: string; username: string; password: string; birth: string; agree: true }): Promise<{ student: Student; recoveryCode: string }> {
  const r = await request<{ student?: unknown; recoveryCode?: unknown }>('/api/student/register', 'POST', input)
  const student = signedIn(asStudent(r.student))
  return { student, recoveryCode: typeof r.recoveryCode === 'string' ? r.recoveryCode : '' }
}

// 退出：先在页面上 drain 过（没发完的学生自己确认过不要了）。退出成功才清这个账号在这台设备上的作答、步骤、写作草稿和队列；退出失败什么都不动
export async function logout(): Promise<void> {
  const sid = me?.sid
  await request('/api/student/logout', 'POST', {})
  if (sid) {
    clearSid(sid)
    forget(sid)
  }
  done(null)
}

export async function saveAi(ai: boolean): Promise<Student> {
  const r = await request<{ student?: unknown }>('/api/student/settings', 'PUT', { ai })
  const s = asStudent(r.student)
  if (!s) throw new StudentError('服务器的回应不对，请刷新后再试', 200)
  return done(s)!
}

// 用找回码改密码：返回新的找回码（旧的作废）。所有设备上的登录都会失效，这台也要用新密码重新登录
export async function resetPassword(input: { username: string; code: string; newPassword: string }): Promise<string> {
  const r = await request<{ recoveryCode?: unknown }>('/api/student/reset', 'POST', { ...input, code: cleanCode(input.code) })
  void getStudent(true)
  return typeof r.recoveryCode === 'string' ? r.recoveryCode : ''
}

// 团队选的文章（要登录）。格式不对的跳过
export async function fetchShelf(): Promise<ShelfItem[]> {
  const r = await request<{ handouts?: unknown }>('/api/student/shelf')
  return Array.isArray(r.handouts)
    ? r.handouts.flatMap((x: Partial<ShelfItem>) => (x && typeof x.id === 'string' && /^[a-z0-9-]{1,64}$/.test(x.id) && typeof x.title === 'string' ? [{ id: x.id, title: x.title }] : []))
    : []
}

// 本账号在这一篇里的事件（换设备时重建状态）。格式不对的跳过；没登录抛出 401
export async function fetchMyEvents(handoutId: string): Promise<LearningEvent[]> {
  const r = await request<{ events?: unknown }>(`/api/student/events?h=${encodeURIComponent(handoutId)}`)
  return Array.isArray(r.events)
    ? r.events.flatMap((e) => {
        const x = LearningEvent.safeParse(e)
        return x.success ? [x.data] : []
      })
    : []
}

// 下载我的数据：拿到文件内容和文件名（文件名只留字母、数字和 _ . -），页面再存成文件
export async function fetchExport(): Promise<{ blob: Blob; filename: string }> {
  const res = await fetch('/api/student/export').catch(() => {
    throw new StudentError(OFFLINE, 0)
  })
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { error?: unknown }
    throw new StudentError(typeof data.error === 'string' ? data.error : `请求失败（${res.status}）`, res.status)
  }
  const named = /filename="?(\w[\w.-]*)"?\s*(?:;|$)/.exec(res.headers.get('Content-Disposition') ?? '')?.[1]
  return { blob: await res.blob(), filename: named || 'zhishi-my-data.json' }
}

// 去学生登录页、登录后回到 next 的链接
export const loginHref = (next: string) => `#/me?next=${encodeURIComponent(next)}`

// 登录后去哪：只认站内的 #/ 地址，或者整页打开一篇的 /?h=<讲义 id>…#/ 地址；别人发来的链接借 next 带去外站的一律不认，回首页
const NEXT = /^(?:#\/|\/\?h=[a-z0-9-]{1,64}(?:&[\w.%=-]*)*#\/)/
export const safeNext = (next: string | null | undefined): string => (next && NEXT.test(next) ? next : '#/')

// 按 safeNext 的结果走：/?h= 开头的整页打开（讲义是整页加载时定下的），#/ 开头的只换哈希
export const goNext = (next: string) => {
  if (next.startsWith('/')) window.location.assign(next)
  else window.location.hash = next
}
