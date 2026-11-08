// 学生状态：按 sid 存在 localStorage（读写都包 try/catch，存不了也照常能用）。
// 现场的每个动作 = 一条事件：先用 applyEvent 更新本机状态；选了学号的学生、登录了账号的学生再进队列发给服务器，其他的只在本机。
import { useCallback, useEffect, useState } from 'react'
import { Survey, type Handout, type LearningEvent } from '../../shared/schema'
import { presetState, type PresetId } from '../data/presets'
import { emptyState } from '../engine'
import type { StudentState } from '../engine/types'
import { sendEvent } from './events'
import { applyEvent, replay } from './replay'
import { getParams } from './router'

export type EventInput = Omit<LearningEvent, 'sid' | 'ts' | 'handoutId'>
export type Act = (e: EventInput) => void
export type Patch = (fn: (s: StudentState) => StudentState) => void
type Role = 'student' | 'judge'

export function readLS(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

export function writeLS(key: string, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(key)
    else localStorage.setItem(key, value)
  } catch {
    // 隐私模式、存储已满等：不影响使用
  }
}

// 设备 id：教学建议带上它，后端只用来限次数，不是身份；本地存不了时每次打开页面换一个
const DEVICE_KEY = 'zhishi:device'
export function deviceId(): string {
  const saved = readLS(DEVICE_KEY)
  if (saved && /^[a-z0-9-]{8,64}$/.test(saved)) return saved
  const id = `dev-${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`
  writeLS(DEVICE_KEY, id)
  return id
}

// 正在生成的上传任务（{jobId, title}，jobId 就是讲义 id）：离开页面再回来，接着查进度。上传过的讲义以服务器为准（GET /api/my/handouts），本机不存
export const UPLOAD_PENDING_KEY = 'zhishi:upload-pending'
// 学生贴文章（#/new）正在生成的任务，只存 jobId：关掉页面再回来接着查进度。按账号的 sid 分开存，换了账号不去查别人的任务（查了也是 404）
export const studentUploadKey = (sid: string) => `zhishi:student-upload:${sid}`

const stateKey = (hid: string, sid: string) => `zhishi:state:${hid}:${sid}`
export const sidKey = (role: Role) => `zhishi:sid:${role}`
export const stepKey = (hid: string, sid: string) => `zhishi:step:${hid}:${sid}`
const newSid = (role: Role) => `${role === 'judge' ? 'judge' : 'stu'}-${Math.random().toString(36).slice(2, 8)}`

// 退出账号时清掉这个 sid 在这台设备上每一篇的作答、步骤和写作草稿（写作草稿的键是 Writing.tsx 的 writingKey）。
// 先把要删的键找齐再删：边找边删会跳过下一个键
export function clearSid(sid: string): void {
  try {
    const keys: string[] = []
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i)
      if (k && /^zhishi:(state|step|writing):[^:]+:/.test(k) && k.endsWith(`:${sid}`)) keys.push(k)
    }
    keys.forEach((k) => localStorage.removeItem(k))
  } catch {
    // 存储用不了：本来也没存下什么
  }
}

// 只存在这台设备上的、这个账号的问卷答案（在每一篇的作答状态里）和写作草稿（Writing.tsx 的 writingKey），「下载我的数据」时在浏览器里合进文件。
// 按讲义 id 排；格式不对的问卷、空的草稿不放
export interface LocalData {
  note: string
  surveys: { handoutId: string; survey: Survey }[]
  writingDrafts: { handoutId: string; text: string }[]
}
export function localData(sid: string): LocalData {
  const out: LocalData = { note: '问卷答案和写作草稿只存在这台设备上，下载时在浏览器里加进了这个文件，服务器上没有', surveys: [], writingDrafts: [] }
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const m = /^zhishi:(state|writing):([^:]+):(.+)$/.exec(localStorage.key(i) ?? '')
      if (!m || m[3] !== sid) continue
      const v = localStorage.getItem(m[0]) ?? ''
      if (m[1] === 'writing') {
        if (v.trim()) out.writingDrafts.push({ handoutId: m[2], text: v })
        continue
      }
      let state: { survey?: unknown } | null = null
      try {
        state = JSON.parse(v)
      } catch {
        // 被改坏的作答状态：跳过
      }
      const survey = Survey.safeParse(state?.survey)
      if (survey.success) out.surveys.push({ handoutId: m[2], survey: survey.data })
    }
  } catch {
    // 存储用不了：这台设备上没有
  }
  out.surveys.sort((a, b) => a.handoutId.localeCompare(b.handoutId))
  out.writingDrafts.sort((a, b) => a.handoutId.localeCompare(b.handoutId))
  return out
}

export function loadState(hid: string, sid: string): StudentState {
  const base = emptyState(sid)
  try {
    const v: unknown = JSON.parse(readLS(stateKey(hid, sid)) ?? 'null')
    return v && typeof v === 'object' ? { ...base, ...(v as Partial<StudentState>), sid } : base
  } catch {
    return base
  }
}

// 收进表达本，只改本机（班级学号、没登录时用；账号模式发 collect_expression 事件，见 Student.tsx）。本机的没有「移出」
export const collectExpression = (id: string) => (s: StudentState): StudentState =>
  s.collectedExpressions.includes(id) ? s : { ...s, collectedExpressions: [...s.collectedExpressions, id] }

// ?seed=demo&p=A|B 加载预设画像
export function presetFromUrl(): PresetId | undefined {
  const params = getParams()
  const p = params.get('p')
  return params.get('seed') === 'demo' && (p === 'A' || p === 'B') ? p : undefined
}

// 换了手机用找回码找回（学号）、账号换设备打开一篇：用服务器上这个 sid 在这份讲义里的事件重建状态，存进本机（照旧按「讲义 + sid」存）。
// 问卷没有事件，只在原来的设备上，恢复不了；这台设备上本来就有的留着。
// 表达本：学号的只存在本机（服务器丢掉收、移出事件），本机的留着；账号的（account）收、移出都有事件，以服务器重放的为准，不再并进本机的
export function restoreState(h: Handout, sid: string, events: LearningEvent[], account = false): StudentState {
  const [rebuilt = emptyState(sid)] = replay(h, events.filter((e) => e.sid === sid))
  const local = loadState(h.id, sid)
  const s: StudentState = { ...rebuilt, survey: local.survey, collectedExpressions: account ? rebuilt.collectedExpressions : local.collectedExpressions }
  writeLS(stateKey(h.id, sid), JSON.stringify(s))
  return s
}

// 本机持久化的学生（学生端、评委）。预设画像只在本机演示，重置回到预设。
// sid：班级里学号绑定的 sid（上传的讲义从班级二维码进来），或学生账号的 sid（u- 开头）；不给就用这台设备的匿名 sid（内置讲义、「只是看看」）。
// upload：动作要不要发给服务器，调用方明说；选了学号、登录了账号的学生传 true，其他（内置讲义、只是看看、老师预览、演示画像、评委）只更新本机
export function useStudent(h: Handout, role: Role, preset?: PresetId, sid?: string, upload = false) {
  const [state, setState] = useState<StudentState>(() =>
    preset ? presetState(h, preset) : loadState(h.id, sid || readLS(sidKey(role)) || newSid(role)),
  )
  const [epoch, setEpoch] = useState(0)

  useEffect(() => {
    writeLS(stateKey(h.id, state.sid), JSON.stringify(state))
    if (!preset && !sid) writeLS(sidKey(role), state.sid) // 学号、账号的 sid 不顶替匿名 sid
  }, [h.id, role, preset, sid, state])

  const act: Act = useCallback(
    (e) => {
      const full: LearningEvent = { ...e, sid: state.sid, ts: Date.now(), handoutId: h.id }
      setState((s) => applyEvent(h, s, full))
      if (upload) void sendEvent(full)
    },
    [h, upload, state.sid],
  )
  const patch: Patch = useCallback((fn) => setState(fn), [])

  // 重置演示：清掉本机状态；普通学生换一个新 sid，老师端会当成新同学
  const reset = useCallback(() => {
    writeLS(stateKey(h.id, state.sid), null)
    writeLS(stepKey(h.id, state.sid), null)
    setState(preset ? presetState(h, preset) : emptyState(newSid(role)))
    setEpoch((n) => n + 1)
  }, [h, preset, role, state.sid])

  return { state, act, patch, reset, epoch }
}

// 只在内存里的学生（评委页并排显示的同学 B）：动作照样生效，但不存、不回流
export function useMemoryStudent(h: Handout, init: () => StudentState) {
  const [state, setState] = useState(init)
  const act: Act = useCallback((e) => setState((s) => applyEvent(h, s, { ...e, sid: s.sid, ts: Date.now(), handoutId: h.id })), [h])
  const patch: Patch = useCallback((fn) => setState(fn), [])
  const reset = () => setState(init())
  return { state, act, patch, reset }
}
