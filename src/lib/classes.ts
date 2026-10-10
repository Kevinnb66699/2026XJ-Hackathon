// 班级和座号（前端这一侧）：老师粘贴的名单怎么解析、座号怎么称呼、学生在本机记住自己的座号、请求班级接口。接口见 deploy/README.md。
// 姓名只在老师侧页面出现（名单、老师端）；学生端只有座号
import { LearningEvent } from '../../shared/schema'
import { readLS, writeLS } from './store'

export const MAX_SEATS = 80 // 一个班最多几人，和后端一致
export const MAX_SEAT_NO = 99
export const MAX_NAME = 20 // 姓名、班级名最多几个字（按字数算，和后端一样）

export interface RosterSeat {
  n: number
  name: string
}

// 座号写成两位：7 →「07」
export const pad = (n: number) => String(n).padStart(2, '0')
// 老师端的称呼：「07 张三」，没有姓名时「07 号」
export const seatName = (n: number, name?: string) => (name ? `${pad(n)} ${name}` : `${pad(n)} 号`)

// 名单解析：每行去掉首尾空白，空行跳过；「座号 分隔符 姓名」，分隔符是 Tab、逗号、顿号、空格中的一个或多个；
// 只有姓名的行按顺序编号（接着上面最大的座号）；只有数字的行是没有姓名的座号。全角数字、全角空格、中文逗号也认。
// errors 是「第几行：…」的中文提示；seats 是能解析的部分，按座号排好（有错时只用来预览，不保存）
export function parseRoster(text: string): { seats: RosterSeat[]; errors: string[] } {
  const seats: RosterSeat[] = []
  const errors: string[] = []
  const lineOf = new Map<number, number>() // 座号 → 在第几行
  let max = 0
  let full = false
  text.split(/\r?\n/).forEach((raw, i) => {
    const line = raw.replace(/[０-９]/g, (d) => String.fromCharCode(d.charCodeAt(0) - 0xfee0)).trim()
    if (!line) return
    const at = `第 ${i + 1} 行`
    const m = /^(\d+)(?:[\t,，、 　]+(.*))?$/.exec(line)
    if (!m && /^\d/.test(line)) return void errors.push(`${at}：座号和姓名之间要用空格、逗号、顿号或 Tab 隔开`)
    const n = m ? Number(m[1]) : max + 1
    const name = (m ? m[2] ?? '' : line).replace(/\s+/g, ' ').trim()
    if (n < 1 || n > MAX_SEAT_NO) return void errors.push(`${at}：座号要在 1–${MAX_SEAT_NO} 之间`)
    max = Math.max(max, n)
    if (lineOf.has(n)) return void errors.push(`${at}：座号 ${n} 重复了（第 ${lineOf.get(n)} 行也是 ${n} 号）`)
    if ([...name].length > MAX_NAME) return void errors.push(`${at}：姓名最多 ${MAX_NAME} 个字`)
    if (seats.length >= MAX_SEATS) {
      if (!full) errors.push(`${at}：一个班最多 ${MAX_SEATS} 人，从这一行起多出来了`)
      full = true
      return
    }
    lineOf.set(n, i + 1)
    seats.push({ n, name })
  })
  return { seats: seats.sort((a, b) => a.n - b.n), errors }
}

// 现有名单写回文本框（改名单时预填），一人一行；parseRoster 读回来不变
export const formatRoster = (seats: RosterSeat[]) => seats.map((s) => (s.name ? `${s.n} ${s.name}` : String(s.n))).join('\n')

// 学生在本机记住的座号：'zhishi:class:<班级 id>' 存 {seat, sid, token, ai}（找回码不存）。格式不对（被改坏、旧版本）当没有，回到选座号页。
// ai：老师有没有开着这个座号的 AI 写作检查；旧版本存的没有 ai，先按开着算，进页面时后台确认（my-progress）回来再更新
export interface Binding {
  seat: number
  sid: string
  token: string
  ai: boolean
}
export const bindingKey = (classId: string) => `zhishi:class:${classId}`

export function asBinding(v: unknown): Binding | null {
  const x = v as Partial<Binding> | null
  if (!x || typeof x !== 'object') return null
  const { seat, sid, token, ai } = x
  return typeof seat === 'number' && Number.isInteger(seat) && seat >= 1 && seat <= MAX_SEAT_NO && typeof sid === 'string' && /^s-[0-9a-f]{16}$/.test(sid) && typeof token === 'string' && /^[0-9a-f]{64}$/.test(token)
    ? { seat, sid, token, ai: ai !== false }
    : null
}

export function readBinding(classId: string): Binding | null {
  try {
    return asBinding(JSON.parse(readLS(bindingKey(classId)) ?? 'null'))
  } catch {
    return null
  }
}

// null：忘掉这个班的座号（老师清空了座号）
export const saveBinding = (classId: string, b: Binding | null) => writeLS(bindingKey(classId), b && JSON.stringify({ seat: b.seat, sid: b.sid, token: b.token, ai: b.ai }))

// 找回码：不分大小写，可以带空格和「-」
export const cleanCode = (code: string) => code.replace(/[\s-]/g, '').toUpperCase()

const OFFLINE = '连不上服务器，请检查网络'

// 请求失败：message 是后端给的中文提示，页面原样显示；status 是状态码（连不上服务器是 0）；
// 建班、改班的 400 带 fields（name、roster → 提示），标在对应的输入框下面
export class ApiError extends Error {
  status: number
  fields: Record<string, string>
  constructor(message: string, status: number, fields: Record<string, string> = {}) {
    super(message)
    this.status = status
    this.fields = fields
  }
}

// 请求班级、进班接口：有 body 就是 POST JSON（后端只收 JSON），否则 GET。会话 cookie 同源请求默认带上
export async function send<T>(path: string, body?: unknown, headers?: Record<string, string>): Promise<T> {
  const init: RequestInit | undefined =
    body !== undefined ? { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) } : headers ? { headers } : undefined
  const res = await fetch(path, init).catch(() => {
    throw new ApiError(OFFLINE, 0)
  })
  const data = (await res.json().catch(() => ({}))) as T & { error?: unknown; fields?: unknown }
  if (!res.ok) {
    const fields = data.fields && typeof data.fields === 'object' ? Object.fromEntries(Object.entries(data.fields).filter(([, v]) => typeof v === 'string')) : {}
    throw new ApiError(typeof data.error === 'string' ? data.error : `请求失败（${res.status}）`, res.status, fields)
  }
  return data
}

// 学生拿回自己这个座号在这份讲义里的作答（找回后重建状态；进页面时顺便确认座号还在、AI 写作检查开没开）。格式不对的事件跳过；
// ai 不是 false 就算开着（和本机旧绑定一样），真正把关的是后端
export async function myProgress(handoutId: string, classId: string, token: string): Promise<{ events: LearningEvent[]; ai: boolean }> {
  const r = await send<{ events?: unknown; ai?: unknown }>(`/api/my-progress?h=${encodeURIComponent(handoutId)}&c=${encodeURIComponent(classId)}`, undefined, { 'X-Student-Token': token })
  const events = Array.isArray(r.events)
    ? r.events.flatMap((e) => {
        const x = LearningEvent.safeParse(e)
        return x.success ? [x.data] : []
      })
    : []
  return { events, ai: r.ai !== false }
}
