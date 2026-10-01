// 事件回流：先进队列（存 localStorage，刷新不丢），POST /api/events 失败就退避重试，不打扰用户。
import type { LearningEvent } from '../../shared/schema'

const KEY = 'zhishi:queue:v1'
const BATCH = 50
const MAX_QUEUE = 2000
const MIN_DELAY = 2000
const MAX_DELAY = 60000

let queue: LearningEvent[] = load()
let busy = false
let delay = MIN_DELAY
let timer: ReturnType<typeof setTimeout> | undefined

function load(): LearningEvent[] {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(KEY) || '[]')
    return Array.isArray(v) ? v : []
  } catch {
    return []
  }
}

function save(): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(queue))
  } catch {
    // 存不了就只留在内存里
  }
}

export const pendingCount = () => queue.length

export function sendEvent(e: LearningEvent): Promise<void> {
  queue.push(e)
  if (queue.length > MAX_QUEUE) queue = queue.slice(-MAX_QUEUE)
  save()
  return flush()
}

export async function flush(): Promise<void> {
  if (busy || !queue.length) return
  busy = true
  const batch = queue.slice(0, BATCH)
  let done = false
  try {
    const res = await fetch('/api/events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(batch),
    })
    // 400/413：这批数据本身有问题，重试也没用，丢掉；其他失败都重试
    done = res.ok || res.status === 400 || res.status === 413
  } catch {
    done = false
  }
  busy = false
  if (done) {
    queue = queue.filter((e) => !batch.includes(e))
    save()
    delay = MIN_DELAY
    return flush()
  }
  clearTimeout(timer)
  timer = setTimeout(() => void flush(), delay)
  delay = Math.min(delay * 2, MAX_DELAY)
}

if (typeof window !== 'undefined') {
  window.addEventListener('online', () => void flush())
  void flush() // 上次没发出去的
}
