// 学生账号（前端这一侧）：现在是谁登录着、登录、用邀请码注册、退出、注销、AI 写作检查和「按我以前的记录调整提示」两个开关、问卷答案、用找回码改密码、团队选的文章、这一篇的作答、单词本和表达本、学习记录、下载我的数据、贴文章生成讲义和「我的文章」。
// 会话在 HttpOnly 的 cookie（zhishi_student）里，页面读不到也不用管：同源请求默认带上。和老师的会话互不相认，这个文件不引用老师的 lib/auth.ts。
// GET /api/student/me 的结果在模块里缓存（整个页面共用一份）；登录、注册、退出、改设置后更新，用 useStudentMe 的组件跟着重画
import { useEffect, useState } from 'react'
import { z } from 'zod'
import { LearningEvent, Profile } from '../../shared/schema'
import { cleanCode } from './classes'
import { drain, forget, sendEvent } from './events'
import type { LearnerProfile } from '../engine/types'
import type { Notebook, NotebookExpression, NotebookWord, StudyRecord } from './notebook'
import { clearSid, type LocalData } from './store'

export interface Student {
  username: string
  sid: string // u- 开头，只用在事件和本机存储上
  ai: boolean // 账号上的 AI 写作检查开关（注册时默认开着，学生可以在账号页关掉）
  aiAvailable: boolean // 服务器有没有开放账号学生的 AI 写作检查
  adapt: boolean // 账号上的「按我以前的记录调整提示」开关（默认开，关掉就用标准版）
}
export interface ShelfItem {
  id: string
  title: string
}

const OFFLINE = '连不上服务器，请检查网络'

// 请求失败：message 是后端给的中文提示；status 是状态码（连不上服务器是 0）；fields（输入框 → 提示）标在对应的输入框下面；
// body 是后端回的整个 JSON（贴文章被拒时要看里面的 kind、reason 这些，见 uploadRefusal）
export class StudentError extends Error {
  status: number
  fields: Record<string, string>
  body: Record<string, unknown>
  constructor(message: string, status: number, fields: Record<string, string> = {}, body: Record<string, unknown> = {}) {
    super(message)
    this.status = status
    this.fields = fields
    this.body = body
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
      throw new StudentError(typeof data.error === 'string' ? data.error : `请求失败（${res.status}）`, res.status, fields, data)
    }
    return data
  } finally {
    clearTimeout(timer)
  }
}

export const asStudent = (s: unknown): Student | null => {
  const x = s as Partial<Student> | null | undefined
  return x && typeof x.username === 'string' && typeof x.sid === 'string' && /^u-[0-9a-f]{16}$/.test(x.sid)
    ? { username: x.username, sid: x.sid, ai: x.ai === true, aiAvailable: x.aiAvailable === true, adapt: x.adapt !== false }
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

// 注销账号：要再输一次密码。成功后清掉这个账号在这台设备上的作答、步骤、写作草稿和队列（不先发：账号上的记录本来就要删）；
// 返回服务器有没有一部分这次没删成（incomplete，服务器会再删）。密码不对、失败抛出提示，什么都不动
export async function deleteAccount(password: string): Promise<{ incomplete: boolean }> {
  const sid = me?.sid
  const r = await request<{ incomplete?: unknown }>('/api/student/delete', 'POST', { password })
  if (sid) {
    clearSid(sid)
    forget(sid)
  }
  done(null)
  return { incomplete: r.incomplete === true }
}

// 改设置（PUT /api/student/settings，只发要改的那一项），回来的账号更新缓存
async function saveSetting(body: { ai: boolean } | { adapt: boolean }): Promise<Student> {
  const r = await request<{ student?: unknown }>('/api/student/settings', 'PUT', body)
  const s = asStudent(r.student)
  if (!s) throw new StudentError('服务器的回应不对，请刷新后再试', 200)
  return done(s)!
}
export const saveAi = (ai: boolean) => saveSetting({ ai })
export const saveAdapt = (adapt: boolean) => saveSetting({ adapt })

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

// 单词本和表达本（要登录）：服务器从这个账号读过的每一篇的事件推算（lib/notebook 的 buildNotebook），不另存一份。ai：这条中文是 AI 生成的。
// 格式不对的条目跳过；可选的字段格式不对就当没有。没登录抛出 401。类型照 lib/notebook，对不上编译时就报错
export type { Notebook, NotebookExpression, NotebookWord }
const optional = <T extends z.ZodTypeAny>(t: T) => t.optional().catch(undefined)
const WordShape: z.ZodType<NotebookWord, z.ZodTypeDef, unknown> = z.object({
  lemma: z.string().min(1),
  pos: optional(z.string()),
  zh: z.string(),
  ai: z.boolean(),
  sources: z.array(z.object({ handoutId: z.string(), title: z.string() })),
  example: optional(z.object({ handoutId: z.string(), sentenceId: z.string(), text: z.string() })),
  addedTs: z.number(),
  lastReview: optional(z.object({ ts: z.number(), correct: z.boolean() })),
  syllabusNew: z.boolean().catch(false), // 还没更新的服务器没有这一项：当不是
})
const ExpressionShape: z.ZodType<NotebookExpression, z.ZodTypeDef, unknown> = z.object({
  id: z.string().min(1),
  handoutId: z.string(),
  title: z.string(),
  text: z.string(),
  zh: z.string(),
  ai: z.boolean(),
  example: optional(z.string()),
  pattern: optional(z.string()),
  ts: z.number(),
})

const each = <T>(t: z.ZodType<T, z.ZodTypeDef, unknown>, list: unknown): T[] =>
  Array.isArray(list)
    ? list.flatMap((x) => {
        const r = t.safeParse(x)
        return r.success ? [r.data] : []
      })
    : []

export async function getNotebook(): Promise<Notebook> {
  const r = await request<{ words?: unknown; expressions?: unknown }>('/api/student/notebook')
  return { words: each(WordShape, r.words), expressions: each(ExpressionShape, r.expressions) }
}

// 学习记录（要登录）：服务器从这个账号的事件推算（lib/notebook 的 buildRecords），最近读的在前。格式不对的条目跳过，可选的字段格式不对就当没有；没登录抛出 401
export type { StudyRecord }
const RecordShape: z.ZodType<StudyRecord, z.ZodTypeDef, unknown> = z.object({
  handoutId: z.string().min(1),
  title: z.string(),
  lastTs: z.number(),
  rating: optional(z.string()),
  status: z.enum(['todo', 'done']),
  firstPending: optional(z.string().min(1)),
})
export async function getRecords(): Promise<StudyRecord[]> {
  const r = await request<{ records?: unknown }>('/api/student/records')
  return each(RecordShape, r.records)
}

// 问卷答案（要登录）：账号上的 profile，只有答了的几项。存的时候没答的不发，服务器上就不存；回来的格式不对的那一项当没答。没登录抛出 401
const ProfileShape = z.object({ goal: optional(Profile.shape.goal), grade: optional(Profile.shape.grade), curriculum: optional(Profile.shape.curriculum) })
const asProfile = (v: unknown): Profile => {
  const r = ProfileShape.safeParse(v)
  return r.success ? (Object.fromEntries(Object.entries(r.data).filter(([, x]) => x !== undefined)) as Profile) : {}
}
export async function getProfile(): Promise<Profile> {
  return asProfile((await request<{ profile?: unknown }>('/api/student/profile')).profile)
}
export async function saveProfile(p: Profile): Promise<Profile> {
  return asProfile((await request<{ profile?: unknown }>('/api/student/profile', 'PUT', p)).profile)
}

// 读文章时交给引擎的画像（阶段 7）：同一个接口还回开关 adapt 和单词本里还在练的词的原形（practicing），页面上不显示。
// 开关关着返回 undefined，引擎就用标准版；practicing 里不是字符串的跳过。没登录抛出 401
export async function getLearner(): Promise<LearnerProfile | undefined> {
  const r = await request<{ profile?: unknown; adapt?: unknown; practicing?: unknown }>('/api/student/profile')
  if (r.adapt === false) return undefined
  const practicing = Array.isArray(r.practicing) ? r.practicing.filter((l): l is string => typeof l === 'string' && l.length > 0) : []
  return { ...asProfile(r.profile), practicing }
}

// 单词本、表达本里的动作（复习、移出）：进这个账号的事件队列，和读文章时的作答一样发（没登录时卡着，登录后再发）。
// 单词本里的动作 handoutId 是 NOTEBOOK_ID（shared/schema）
export const notebookEvent = (sid: string, e: Omit<LearningEvent, 'sid' | 'ts'>): Promise<void> => sendEvent({ ...e, sid, ts: Date.now() })

// 贴文章生成讲义（#/new）和「我的文章」，都要登录（接口在 server/index.mjs）。格式不对的条目跳过；没登录抛出 401
const ID = /^[a-z0-9-]{1,64}$/
const isId = (v: unknown): v is string => typeof v === 'string' && ID.test(v)
// 后端给的时间：ISO 字符串或毫秒数都认，认不出是 undefined
const toMs = (v: unknown): number | undefined => {
  const t = typeof v === 'number' || typeof v === 'string' ? new Date(v).getTime() : NaN
  return Number.isFinite(t) ? t : undefined
}
const count = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0)

// enabled：服务器开放了学生贴文章（没开放时首页不放入口）；weekUsed、weekLimit：这周生成了几篇、每周几篇（北京时间周一 0 点清零）；
// pausedUntil：全站的免费名额用完了，到这个时间（毫秒）恢复。不返回钱数
export interface UploadStatus {
  enabled: boolean
  weekUsed: number
  weekLimit: number
  pausedUntil?: number
}
export async function getUploadStatus(): Promise<UploadStatus> {
  const r = await request<{ enabled?: unknown; weekUsed?: unknown; weekLimit?: unknown; paused?: { resumesAt?: unknown } | null }>('/api/upload-status')
  const pausedUntil = toMs(r.paused?.resumesAt)
  return { enabled: r.enabled === true, weekUsed: count(r.weekUsed), weekLimit: count(r.weekLimit), ...(pausedUntil === undefined ? {} : { pausedUntil }) }
}

// 提交：只发原文和三项勾没勾全（confirm，页面上的勾选框；学生不填标题、必练词这些，也不交给管线）。similar：只差标点或大小写时学生选的，use 读那一份，ignore 按自己贴的生成。
// 学生有自己的接口（老师的是 /api/uploads）：同一个浏览器里也登录着老师账号时不会走错。
// 回来三种：已经有现成的讲义（reused，已经放进「我的文章」，不占次数）；开始生成或接上同一篇正在生成的任务（jobId）；只差标点或大小写的那一份（similar）
export type UploadReply = { handoutId: string; reused: true } | { jobId: string } | { similar: { handoutId: string; title: string } }
export async function submitUpload(text: string, confirm: boolean, similar?: 'use' | 'ignore'): Promise<UploadReply> {
  const r = await request<{ handoutId?: unknown; jobId?: unknown; similar?: { handoutId?: unknown; title?: unknown } | null }>('/api/student/uploads', 'POST', { text, confirm, similar })
  if (isId(r.handoutId)) return { handoutId: r.handoutId, reused: true }
  if (isId(r.jobId)) return { jobId: r.jobId }
  if (isId(r.similar?.handoutId)) return { similar: { handoutId: r.similar.handoutId, title: typeof r.similar.title === 'string' ? r.similar.title : '' } }
  throw new StudentError('服务器的回应不对，请刷新后再试', 200)
}

// 查进度。progress 是后端给的中文进度；后端给的是管线的进度对象（stage、done、total）也收下，页面自己写成中文。
// 生成失败（failed）时 error 是后端的中文提示，reason 是被拒的原因（比如 unsafe：内容安全拦截）。
// 任务丢了（服务器重启过）、不是这个账号的任务都抛出 404，丢了的 uploadRefusal(e).lost 为真；退出了、会话过期了抛出 401
export type UploadProgress = string | { stage: string; done?: number; total?: number }
export type UploadJob = { status: 'running'; progress?: UploadProgress } | { status: 'done'; handoutId: string } | { status: 'failed'; error: string; reason?: string }
export async function getUploadJob(jobId: string): Promise<UploadJob> {
  const r = await request<{ status?: unknown; progress?: unknown; handoutId?: unknown; error?: unknown; reason?: unknown }>(`/api/uploads/${encodeURIComponent(jobId)}`)
  if (r.status === 'running') {
    const p = r.progress as { stage?: unknown } | null | undefined
    return { status: 'running', progress: typeof r.progress === 'string' ? r.progress : p && typeof p.stage === 'string' ? (p as UploadProgress) : undefined }
  }
  if (r.status === 'done' && isId(r.handoutId)) return { status: 'done', handoutId: r.handoutId }
  return { status: 'failed', error: typeof r.error === 'string' ? r.error : '', ...(typeof r.reason === 'string' ? { reason: r.reason } : {}) }
}

// 提交被拒、查进度出错时后端给的说明：kind 是哪一种限额（week、busy、fails、spend，crowded 是正在生成的太多、过几分钟再试），reason 是拒收的原因（not_english、exam、personal_info、repeated、length、unsafe），
// resumesAt 是全站恢复生成的时间（毫秒），lost 是任务丢了。不是 StudentError（比如代码出错）时什么都没有
export interface UploadRefusal {
  kind?: string
  reason?: string
  resumesAt?: number
  lost: boolean
}
export function uploadRefusal(e: unknown): UploadRefusal {
  const b = e instanceof StudentError ? e.body : {}
  const resumesAt = toMs(b.resumesAt)
  return {
    ...(typeof b.kind === 'string' ? { kind: b.kind } : {}),
    ...(typeof b.reason === 'string' ? { reason: b.reason } : {}),
    ...(resumesAt === undefined ? {} : { resumesAt }),
    lost: b.lost === true,
  }
}

// 我的文章：自己贴过的（包括直接读的现成讲义），新加的在前。标题只有本人看得到
export interface LibraryItem {
  id: string
  title: string
}
export async function getLibrary(): Promise<LibraryItem[]> {
  const r = await request<{ handouts?: unknown }>('/api/student/library')
  if (!Array.isArray(r.handouts)) return []
  return r.handouts
    .flatMap((x: { id?: unknown; title?: unknown; addedAt?: unknown } | null) => (x && isId(x.id) ? [{ id: x.id, title: typeof x.title === 'string' ? x.title : '', at: toMs(x.addedAt) ?? 0 }] : []))
    .sort((a, b) => b.at - a.at)
    .map(({ id, title }) => ({ id, title }))
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

// 下载的文件里合进这台设备上的问卷答案和写作草稿（lib/store 的 localData）：在浏览器里合，不发给服务器。放在原始记录 events 前面，翻文件时先看到。
// 服务器给的不是 JSON 对象（不该发生）就原样存，不合
export function withLocal(text: string, local: LocalData): string {
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch {
    return text
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return text
  const { events, ...rest } = data as Record<string, unknown>
  return JSON.stringify({ ...rest, local, events }, null, 2)
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
