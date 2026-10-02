// 教师端：今天点评这几个人 + 卡点热力图（按句子 / 按结构）。点一句弹出抽屉：谁卡在这句、为什么。
// 数据：GET /api/events 重建每个学生的状态；拉不到（或还没有人做）就用预设画像生成快照，并标明「示例数据」。
// 教师端可以显示结构名称；学生端不出现这些词。
import { Fragment, useEffect, useMemo, useState } from 'react'
import { LearningEvent, type Sentence, type StructureTag } from '../../shared/schema'
import { Icon, Pill, btn, card } from '../components/ui'
import { currentHandout as h } from '../data'
import { snapshotEvents } from '../data/presets'
import { reviewPicks, stuck } from '../engine'
import type { SentenceStuck, StuckCause, StudentState } from '../engine/types'
import { replay } from '../lib/replay'

const TAG_NAME: Record<StructureTag, string> = { appositive_that: '同位语从句', inversion: '倒装', long_subject: '长主语', reference: '指代' }
const CAUSE_NAME: Record<StuckCause, string> = { word: '词', structure: '结构', mixed: '词和结构都有' }
const LEVEL_NAME = ['读懂', '轻', '中', '重']
const LEVEL_TONE = ['green', 'gray', 'amber', 'red'] as const
const HEAT_LEGEND: [string, string][] = [
  ['bg-heat-1', '1–3'],
  ['bg-heat-2', '4–6'],
  ['bg-heat-3', '7–9'],
  ['bg-heat-4', '10+'],
]
const heat = (n: number) => (n >= 10 ? 'bg-heat-4' : n >= 7 ? 'bg-heat-3' : n >= 4 ? 'bg-heat-2' : n >= 1 ? 'bg-heat-1' : '')

interface Data {
  mode: 'live' | 'snapshot'
  events: LearningEvent[]
  liveCount: number // 后端已有多少个学生的实时数据
}

// 数据来源：实时数据够 5 人就用实时，否则先显示示例班级（标明「示例数据」），可以手动切换
const LIVE_MIN = 5
type Prefer = 'auto' | 'live' | 'demo'

async function loadEvents(prefer: Prefer): Promise<Data> {
  let live: LearningEvent[] = []
  try {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), 5000) // 后端卡住时 5 秒后改用快照
    const res = await fetch(`/api/events?handoutId=${encodeURIComponent(h.id)}`, { signal: ctrl.signal }).finally(() => clearTimeout(timer))
    if (res.ok) {
      const raw: unknown = await res.json()
      live = Array.isArray(raw)
        ? raw.flatMap((e) => {
            const r = LearningEvent.safeParse(e)
            return r.success ? [r.data] : []
          })
        : []
    }
  } catch {
    // 后端不可用：用快照
  }
  const liveCount = new Set(live.map((e) => e.sid)).size
  const useLive = live.length > 0 && (prefer === 'live' || (prefer === 'auto' && liveCount >= LIVE_MIN))
  return useLive ? { mode: 'live', events: live, liveCount } : { mode: 'snapshot', events: snapshotEvents(h), liveCount }
}

// 班级里的称呼：按 sid 排序编号，如「同学 07」；不显示原始 id
function aliasMap(students: StudentState[]): Map<string, string> {
  return new Map([...students.map((s) => s.sid)].sort().map((sid, i) => [sid, `同学 ${String(i + 1).padStart(2, '0')}`]))
}

// 点评名单的种子：当天日期，如 20261001
const todaySeed = () => {
  const d = new Date()
  return d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate()
}

function reasonOf(s: StudentState, x: Sentence, st: SentenceStuck): string {
  const parts: string[] = []
  const L = s.ladder[x.id] ?? 0
  if (L) parts.push(`开到第 ${L} 级`)
  const a = x.question && s.answers[x.question.id]
  if (a) parts.push(a.firstTryCorrect ? '原句题首答对' : a.correct ? `原句题第 ${a.attempts} 次答对` : '原句题还没答对')
  if (st.cause) parts.push(`卡在${CAUSE_NAME[st.cause]}`)
  return parts.join(' · ')
}

type Row = { s: StudentState; st: SentenceStuck }
const lv = (r: Row) => r.st.level ?? 0

export default function TeacherPage() {
  const [data, setData] = useState<Data | null>(null)
  const [prefer, setPrefer] = useState<Prefer>('auto')
  const [by, setBy] = useState<'sentence' | 'structure'>('sentence')
  const [drawer, setDrawer] = useState<{ title: string; ids: string[] } | null>(null)
  const refresh = () => {
    setData(null)
    void loadEvents(prefer).then(setData)
  }
  useEffect(refresh, [prefer])

  const students = useMemo(() => (data ? replay(h, data.events) : []), [data])
  const alias = useMemo(() => aliasMap(students), [students])
  const nameOf = (sid: string) => alias.get(sid) ?? sid
  const picks = useMemo(() => reviewPicks(h, students, { targeted: 2, random: 2, seed: todaySeed() }), [students])
  const rows = useMemo(() => new Map(h.sentences.map((x) => [x.id, students.map((s): Row => ({ s, st: stuck(h, s, x.id) }))])), [students])
  const hard = (id: string) => (rows.get(id) ?? []).filter((r) => lv(r) >= 2) // 卡在「中」以上
  const paragraphs = [...new Set(h.sentences.map((x) => x.paragraph))].sort((a, b) => a - b)
  const tags = [...new Set(h.sentences.flatMap((x) => (x.tag ? [x.tag] : [])))]
  const openSentence = (x: Sentence) => setDrawer({ title: `${x.id} · ${hard(x.id).length} / ${students.length} 人卡住`, ids: [x.id] })

  return (
    <div className="min-h-screen bg-ground">
      <header className="border-b border-line bg-surface">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3.5 sm:px-8">
          <a href="#/" className="text-[20px] font-bold tracking-wider text-ink">
            知适 · 老师端
          </a>
          <span className="order-last w-full text-[14px] text-ink2 sm:order-none sm:w-auto sm:flex-1">本周外刊：{h.title}</span>
          <div className="ml-auto flex items-center gap-3">
            {data?.mode === 'snapshot' && <Pill tone="amber">示例数据</Pill>}
            {data && (
              <span className={`flex items-center gap-1.5 text-[13px] ${data.mode === 'live' ? 'text-green' : 'text-amber-dark'}`}>
                <span className={`h-2 w-2 rounded-full ${data.mode === 'live' ? 'bg-green' : 'bg-amber'}`} />
                {data.mode === 'live' ? '实时' : '快照'} · {students.length} 人
              </span>
            )}
            {data && data.mode === 'snapshot' && data.liveCount > 0 && (
              <button type="button" className={btn.small} onClick={() => setPrefer('live')}>
                看实时数据（{data.liveCount} 人）
              </button>
            )}
            {data && data.mode === 'live' && (
              <button type="button" className={btn.small} onClick={() => setPrefer('demo')}>
                看示例班级
              </button>
            )}
            <button type="button" className={btn.small} onClick={refresh}>
              刷新
            </button>
          </div>
        </div>
      </header>

      {!data ? (
        <p className="mx-auto max-w-6xl px-8 py-6 text-[14px] text-muted">正在加载……</p>
      ) : (
        <main className="mx-auto flex max-w-6xl flex-col gap-6 px-4 py-6 sm:px-8">
          <section className="flex flex-col gap-3">
            <div className="flex flex-wrap items-baseline gap-3">
              <h1 className="m-0 text-[22px] font-bold">今天点评这几个人</h1>
              <span className="text-[13px] text-muted">定向 2 人 + 随机 2 人</span>
            </div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
              {picks.map((p) => (
                <div key={p.sid} className={`${card} flex flex-col gap-2 p-3.5`}>
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[16px] font-semibold">{nameOf(p.sid)}</span>
                    <Pill tone={p.kind === 'targeted' ? 'amber' : 'gray'}>{p.kind === 'targeted' ? '定向' : '随机'}</Pill>
                  </div>
                  <span className="text-[14px] leading-relaxed text-ink2">{p.reason}</span>
                </div>
              ))}
            </div>
          </section>

          <section className={`${card} flex flex-col gap-3.5 rounded-2xl p-5`}>
            <div className="flex flex-wrap items-center gap-3">
              <h2 className="m-0 flex-1 text-[18px] font-bold">卡点热力图</h2>
              <div role="group" aria-label="查看方式" className="flex overflow-hidden rounded-[10px] border border-line-strong">
                {(['sentence', 'structure'] as const).map((k) => (
                  <button key={k} type="button" aria-pressed={by === k} onClick={() => setBy(k)} className={`min-h-[36px] px-3.5 text-[13px] ${by === k ? 'bg-primary text-white' : 'bg-surface'}`}>
                    {k === 'sentence' ? '按句子' : '按结构'}
                  </button>
                ))}
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-2 text-[12px] text-ink2">
              <span>卡在「中」以上的人数</span>
              {HEAT_LEGEND.map(([c, label]) => (
                <Fragment key={c}>
                  <span className={`h-3 w-[22px] rounded-sm border border-line-soft ${c}`} />
                  <span>{label}</span>
                </Fragment>
              ))}
            </div>

            {by === 'sentence' ? (
              paragraphs.map((n) => (
                <p key={n} className="m-0 font-serif text-[17px] leading-loose">
                  {h.sentences
                    .filter((x) => x.paragraph === n)
                    .map((x, k) => {
                      const c = hard(x.id).length
                      return (
                        <Fragment key={x.id}>
                          {k > 0 && ' '}
                          <span
                            role="button"
                            tabIndex={0}
                            onClick={() => openSentence(x)}
                            onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && openSentence(x)}
                            className={`cursor-pointer rounded px-[3px] py-0.5 hover:outline hover:outline-2 hover:outline-primary ${heat(c)}`}
                          >
                            {x.text}
                            <sup className="font-sans text-[11px] text-amber-dark"> {c}</sup>
                          </span>
                        </Fragment>
                      )
                    })}
                </p>
              ))
            ) : (
              <div className="flex flex-col">
                {tags.map((tag) => {
                  const ids = h.sentences.filter((x) => x.tag === tag).map((x) => x.id)
                  const c = new Set(ids.flatMap((id) => hard(id).map((r) => r.s.sid))).size
                  return (
                    <button
                      key={tag}
                      type="button"
                      onClick={() => setDrawer({ title: `${TAG_NAME[tag]} · ${c} / ${students.length} 人卡住`, ids })}
                      className="flex min-h-[48px] items-center gap-3 border-t border-line-soft py-2.5 text-left first:border-t-0"
                    >
                      <span className={`min-w-[44px] rounded-md px-2 py-1 text-center text-[14px] font-semibold ${heat(c) || 'bg-ground'}`}>{c}</span>
                      <span className="flex-1 text-[15px] font-semibold">{TAG_NAME[tag]}</span>
                      <span className="text-[13px] text-muted">{ids.join(' · ')}</span>
                    </button>
                  )
                })}
                <p className="m-0 mt-2 text-[12px] text-muted">数字是至少有一句卡在「中」以上的人数。没有结构标签的句子（卡点主要在词）不计入。</p>
              </div>
            )}
          </section>
        </main>
      )}

      {drawer && (
        <div className="fixed inset-0 z-30 flex justify-end bg-black/20" onClick={() => setDrawer(null)}>
          <aside role="dialog" aria-label={drawer.title} onClick={(e) => e.stopPropagation()} className="flex h-full w-full max-w-[440px] flex-col gap-5 overflow-y-auto bg-surface p-5 shadow-xl">
            <div className="flex items-start gap-2">
              <h2 className="m-0 flex-1 text-[18px] font-bold">{drawer.title}</h2>
              <button type="button" aria-label="关闭" onClick={() => setDrawer(null)} className="flex h-11 w-11 items-center justify-center">
                <Icon name="close" />
              </button>
            </div>
            {drawer.ids.map((id) => {
              const x = h.sentences.find((y) => y.id === id)!
              const list = (rows.get(id) ?? []).filter((r) => lv(r) >= 1).sort((a, b) => lv(b) - lv(a))
              const causes = hard(id).flatMap((r) => (r.st.cause ? [r.st.cause] : []))
              const main = (Object.keys(CAUSE_NAME) as StuckCause[]).sort((a, b) => causes.filter((c) => c === b).length - causes.filter((c) => c === a).length)[0]
              return (
                <section key={id} className="flex flex-col gap-2">
                  <span className="text-[13px] text-ink2">
                    {id}
                    {x.tag ? ` · ${TAG_NAME[x.tag]}` : ''}
                    {causes.length ? ` · 主要原因：${CAUSE_NAME[main]}` : ''}
                  </span>
                  <p className="m-0 font-serif text-[16px] leading-relaxed">{x.text}</p>
                  <div className="flex flex-col">
                    {list.map((r) => (
                      <div key={r.s.sid} className="flex items-center justify-between gap-3 border-t border-line-soft py-2.5 text-[14px]">
                        <span className="flex shrink-0 items-center gap-2">
                          {nameOf(r.s.sid)}
                          <Pill tone={LEVEL_TONE[lv(r)]}>{LEVEL_NAME[lv(r)]}</Pill>
                        </span>
                        <span className="text-right text-ink2">{reasonOf(r.s, x, r.st)}</span>
                      </div>
                    ))}
                    {!list.length && <span className="text-[14px] text-muted">没有人卡在这句</span>}
                  </div>
                  {x.teacherNote && (
                    <div className="rounded-[10px] bg-ground p-3 text-[13px] leading-relaxed">
                      <span className="font-semibold">你的精讲：</span>
                      {x.teacherNote}
                    </div>
                  )}
                </section>
              )
            })}
          </aside>
        </div>
      )}
    </div>
  )
}
