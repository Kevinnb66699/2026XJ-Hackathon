// 学生状态：按 sid 存在 localStorage（读写都包 try/catch，存不了也照常能用）。
// 现场的每个动作 = 一条事件：先用 applyEvent 更新本机状态，再进队列回流到老师端。
import { useCallback, useEffect, useState } from 'react'
import type { Handout, LearningEvent } from '../../shared/schema'
import { presetState, type PresetId } from '../data/presets'
import { emptyState } from '../engine'
import type { StudentState } from '../engine/types'
import { sendEvent } from './events'
import { applyEvent } from './replay'
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

// 设备 id：上传和教学建议带上它，后端只用来限次数，不是身份；本地存不了时每次打开页面换一个
const DEVICE_KEY = 'zhishi:device'
export function deviceId(): string {
  const saved = readLS(DEVICE_KEY)
  if (saved && /^[a-z0-9-]{8,64}$/.test(saved)) return saved
  const id = `dev-${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`
  writeLS(DEVICE_KEY, id)
  return id
}

const stateKey = (hid: string, sid: string) => `zhishi:state:${hid}:${sid}`
export const sidKey = (role: Role) => `zhishi:sid:${role}`
export const stepKey = (hid: string, sid: string) => `zhishi:step:${hid}:${sid}`
const newSid = (role: Role) => `${role === 'judge' ? 'judge' : 'stu'}-${Math.random().toString(36).slice(2, 8)}`

export function loadState(hid: string, sid: string): StudentState {
  const base = emptyState(sid)
  try {
    const v: unknown = JSON.parse(readLS(stateKey(hid, sid)) ?? 'null')
    return v && typeof v === 'object' ? { ...base, ...(v as Partial<StudentState>), sid } : base
  } catch {
    return base
  }
}

// 收进表达本（表达本没有对应的事件类型，只存在本机）
export const collectExpression = (id: string) => (s: StudentState): StudentState =>
  s.collectedExpressions.includes(id) ? s : { ...s, collectedExpressions: [...s.collectedExpressions, id] }

// ?seed=demo&p=A|B 加载预设画像
export function presetFromUrl(): PresetId | undefined {
  const params = getParams()
  const p = params.get('p')
  return params.get('seed') === 'demo' && (p === 'A' || p === 'B') ? p : undefined
}

// 本机持久化的学生（学生端、评委）。预设画像只在本机演示：动作不回流，重置回到预设。
export function useStudent(h: Handout, role: Role, preset?: PresetId) {
  const [state, setState] = useState<StudentState>(() =>
    preset ? presetState(h, preset) : loadState(h.id, readLS(sidKey(role)) || newSid(role)),
  )
  const [epoch, setEpoch] = useState(0)

  useEffect(() => {
    writeLS(stateKey(h.id, state.sid), JSON.stringify(state))
    if (!preset) writeLS(sidKey(role), state.sid)
  }, [h.id, role, preset, state])

  const act: Act = useCallback(
    (e) => {
      const full: LearningEvent = { ...e, sid: state.sid, ts: Date.now(), handoutId: h.id }
      setState((s) => applyEvent(h, s, full))
      if (!preset) void sendEvent(full)
    },
    [h, preset, state.sid],
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
