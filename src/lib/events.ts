// 事件回流：先进队列（存 localStorage，刷新不丢），POST /api/events 失败就退避重试，不打扰用户。
// 队列按 sid 分开存（zhishi:queue:v2:<sid>），一批只发一个 sid 的事件：账号的事件回 401（没登录、会话过期、这台设备上登录的是另一个账号）时只卡住这个账号的队列，
// 先留着，登录后 drain 再发；别的 sid 照常发。旧版本整台设备一条的队列（zhishi:queue:v1）打开时按 sid 拆开
import type { LearningEvent } from '../../shared/schema'
import { DIAGNOSTIC_TYPES } from './replay'

const LEGACY = 'zhishi:queue:v1'
const PREFIX = 'zhishi:queue:v2:'
const BATCH = 50
const MAX_QUEUE = 2000 // 每个 sid 最多攒这么多条
const MIN_DELAY = 2000
const MAX_DELAY = 10000

const queues = load()
const held = new Set<string>() // 回过 401 的 sid：不再自动重发，等登录后 drain
let running: Promise<void> | null = null
let delay = MIN_DELAY
let timer: ReturnType<typeof setTimeout> | undefined

function load(): Map<string, LearningEvent[]> {
  const m = new Map<string, LearningEvent[]>()
  const add = (list: unknown) => {
    if (Array.isArray(list)) for (const e of list as LearningEvent[]) if (e && typeof e.sid === 'string') m.set(e.sid, [...(m.get(e.sid) ?? []), e])
  }
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i)
      if (k?.startsWith(PREFIX)) add(JSON.parse(localStorage.getItem(k) || '[]'))
    }
    const old = localStorage.getItem(LEGACY)
    if (old) {
      add(JSON.parse(old))
      m.forEach((_, sid) => save(sid, m))
      localStorage.removeItem(LEGACY)
    }
  } catch {
    // 读不了就从空队列开始
  }
  return m
}

function save(sid: string, m = queues): void {
  try {
    const list = m.get(sid)
    if (list?.length) localStorage.setItem(PREFIX + sid, JSON.stringify(list))
    else localStorage.removeItem(PREFIX + sid)
  } catch {
    // 存不了就只留在内存里
  }
}

// 不给 sid 是整台设备还有几条没发出去
export const pendingCount = (sid?: string) => (sid ? queues.get(sid)?.length ?? 0 : [...queues.values()].reduce((n, l) => n + l.length, 0))

export function sendEvent(e: LearningEvent): Promise<void> {
  const list = [...(queues.get(e.sid) ?? []), e]
  queues.set(e.sid, list.length > MAX_QUEUE ? list.slice(-MAX_QUEUE) : list)
  save(e.sid)
  return flush()
}

// 发一批（同一个 sid）。sent：发出去了或这批本身有问题丢掉了，接着发；held：要登录；failed：连不上或服务器出错，稍后整体重试
async function post(sid: string): Promise<'sent' | 'held' | 'failed'> {
  const batch = (queues.get(sid) ?? []).slice(0, BATCH)
  const drop = (keep: (e: LearningEvent) => boolean) => {
    queues.set(sid, (queues.get(sid) ?? []).filter(keep))
    save(sid)
  }
  const ctrl = new AbortController()
  const abortTimer = setTimeout(() => ctrl.abort(), 5000) // 后端卡住时不让队列一直等
  try {
    const res = await fetch('/api/events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(batch),
      signal: ctrl.signal,
    })
    // 账号的事件，请求没带着这个账号的登录状态：留着，登录后再发
    if (res.status === 401) {
      held.add(sid)
      return 'held'
    }
    // 400：可能是还没更新的后端不认诊断事件。这批里有学习事件的话，只丢诊断事件，学习事件马上重发
    if (res.status === 400 && batch.some((e) => DIAGNOSTIC_TYPES.has(e.type)) && batch.some((e) => !DIAGNOSTIC_TYPES.has(e.type))) {
      drop((e) => !(batch.includes(e) && DIAGNOSTIC_TYPES.has(e.type)))
      return 'sent'
    }
    // 400/413：这批数据本身有问题，重试也没用，丢掉；其他失败都重试
    if (!(res.ok || res.status === 400 || res.status === 413)) return 'failed'
    drop((e) => !batch.includes(e))
    return 'sent'
  } catch {
    return 'failed'
  } finally {
    clearTimeout(abortTimer)
  }
}

async function loop(): Promise<void> {
  for (;;) {
    const sid = [...queues.keys()].find((k) => !held.has(k) && pendingCount(k) > 0)
    if (!sid) {
      delay = MIN_DELAY
      return
    }
    if ((await post(sid)) === 'failed') {
      clearTimeout(timer)
      timer = setTimeout(() => void flush(), delay)
      delay = Math.min(delay * 2, MAX_DELAY)
      return
    }
  }
}

// 正在发的时候再调用，等的是同一轮（这一轮会接着发新进队列的）
export function flush(): Promise<void> {
  if (!running) running = loop().finally(() => (running = null))
  return running
}

// 把这个 sid 排着的事件发完（打开一篇之前、退出之前、登录之后）：发完了或本来就没有返回 true；连不上、还要登录返回 false
export async function drain(sid: string): Promise<boolean> {
  held.delete(sid)
  await flush()
  return pendingCount(sid) === 0
}

// 退出账号：这个 sid 没发出去的事件不要了（退出前先 drain）
export function forget(sid: string): void {
  queues.delete(sid)
  held.delete(sid)
  save(sid)
}

if (typeof window !== 'undefined') {
  window.addEventListener('online', () => void flush())
  void flush() // 上次没发出去的
}
