// 教师端：刚刚 + 今天点评这几个人 + 卡点热力图（按句子 / 按结构）+ 下一届的起点 + 粗读段意题。点一句弹出抽屉：谁卡在这句、为什么。
// 数据：GET /api/events 重建每个学生的状态；拉不到（或还没有人做）就用预设画像生成快照，并标明「示例数据」。
// 实时模式每 5 秒自动拉一次：有人答错、开梯子，「刚刚」里马上出现，热力图里那一句亮一下。
// 教师端可以显示结构名称；学生端不出现这些词。
import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
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

const POLL_MS = 5000 // 自动刷新间隔：展位上评委一答，这边几秒内就能看到
const FLASH_MS = 10000 // 刚有人卡住的句子亮多久
// 下一届的起点：至少 2 人、且不少于三成卡在「中」以上，才算全班的卡点（人少时一个人卡住不算）
const NEXT_MIN = 2
const NEXT_SHARE = 0.3
const NEXT_MAX = 5

type Recent = { key: string; text: string; sentenceId?: string; paragraph?: number; at: number }
const keyOf = (e: LearningEvent) => `${e.sid}|${e.ts}|${e.type}|${e.sentenceId ?? e.paragraph ?? e.lemma ?? ''}`
const lead = (x: Sentence) => `${x.text.split(/\s+/).slice(0, 5).join(' ')}…`
const ago = (ms: number) => (ms < 60000 ? `${Math.max(1, Math.round(ms / 1000))} 秒前` : `${Math.round(ms / 60000)} 分钟前`)

// 「刚刚」：只列看得出卡住的动作（答错、开梯子、不认识的词）；点词太多，不列
function recentOf(e: LearningEvent, name: string): Omit<Recent, 'key' | 'at'> | null {
  const x = e.sentenceId ? h.sentences.find((y) => y.id === e.sentenceId) : undefined
  if (e.type === 'answer_question' && x && e.correct === false) return { text: `${name} · ${x.id}「${lead(x)}」${e.firstTry ? '第一次答错' : '又答错了'}`, sentenceId: x.id }
  if (e.type === 'open_ladder' && x) return { text: `${name} · ${x.id}「${lead(x)}」打开梯子第 ${e.level} 步`, sentenceId: x.id }
  if (e.type === 'gist_answer' && e.correct === false && e.paragraph) return { text: `${name} · 第 ${e.paragraph} 段段意题答错`, paragraph: e.paragraph }
  const known = e.lemma && h.words.some((w) => w.lemma === e.lemma) // 假词不列
  if (e.type === 'answer_question' && !e.sentenceId && known && e.correct === false) return { text: `${name} · ${e.lemma} 猜错了意思` }
  if (e.type === 'word_card' && e.value === 'unknown' && known) return { text: `${name} · 不认识 ${e.lemma}` }
  return null
}

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
  const [drawer, setDrawer] = useState<{ title: string; ids: string[]; gist?: number } | null>(null)
  const [recent, setRecent] = useState<Recent[]>([])
  const [now, setNow] = useState(() => Date.now())
  const dataRef = useRef<Data | null>(null)
  dataRef.current = data
  const refresh = () => {
    setData(null)
    void loadEvents(prefer).then(setData)
  }
  useEffect(() => {
    setRecent([])
    refresh()
  }, [prefer])

  // 自动刷新：不清空页面，只在有新事件时更新；新事件里看得出卡住的，放进「刚刚」。页面在后台时不拉
  useEffect(() => {
    if (prefer === 'demo') return
    const poll = () => {
      if (document.hidden) return
      void loadEvents(prefer).then((next) => {
        const prev = dataRef.current
        if (!prev) return
        if (prev.mode === 'live' && next.mode === 'snapshot') return // 一次没拉到就保持原样，不跳回示例班级
        if (prev.mode === 'snapshot' && next.mode === 'snapshot') {
          if (next.liveCount !== prev.liveCount) setData({ ...prev, liveCount: next.liveCount })
          return
        }
        if (prev.mode === 'live' && next.mode === 'live') {
          const seen = new Set(prev.events.map(keyOf))
          const fresh = next.events.filter((e) => !seen.has(keyOf(e)))
          if (!fresh.length) return
          const names = aliasMap(replay(h, next.events))
          const at = Date.now()
          const items = [...fresh]
            .sort((a, b) => b.ts - a.ts) // 新的在上；不同手机的事件可能交错到达
            .flatMap((e) => {
              const r = recentOf(e, names.get(e.sid) ?? e.sid)
              return r ? [{ ...r, key: keyOf(e), at }] : []
            })
          if (items.length) setRecent((old) => [...items, ...old].slice(0, 5))
        }
        setData(next)
      })
    }
    const t = setInterval(poll, POLL_MS)
    document.addEventListener('visibilitychange', poll) // 切回这个页面时马上拉一次
    return () => {
      clearInterval(t)
      document.removeEventListener('visibilitychange', poll)
    }
  }, [prefer])
  // 「几秒前」和高亮要跟着时间走；没有新动作时不用每秒重画
  const ticking = recent.length > 0
  useEffect(() => {
    if (!ticking) return
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [ticking])
  const flashing = new Set(recent.filter((r) => r.sentenceId && now - r.at < FLASH_MS).map((r) => r.sentenceId!))
  const flashingGist = new Set(recent.filter((r) => r.paragraph && now - r.at < FLASH_MS).map((r) => r.paragraph!))

  const students = useMemo(() => (data ? replay(h, data.events) : []), [data])
  const alias = useMemo(() => aliasMap(students), [students])
  const nameOf = (sid: string) => alias.get(sid) ?? sid
  const picks = useMemo(() => reviewPicks(h, students, { targeted: 2, random: 2, seed: todaySeed() }), [students])
  const rows = useMemo(() => new Map(h.sentences.map((x) => [x.id, students.map((s): Row => ({ s, st: stuck(h, s, x.id) }))])), [students])
  const hard = (id: string) => (rows.get(id) ?? []).filter((r) => lv(r) >= 2) // 卡在「中」以上
  const paragraphs = [...new Set(h.sentences.map((x) => x.paragraph))].sort((a, b) => a - b)
  const tags = [...new Set(h.sentences.flatMap((x) => (x.tag ? [x.tag] : [])))]
  const openSentence = (x: Sentence) => setDrawer({ title: `${x.id} · ${hard(x.id).length} / ${students.length} 人卡住`, ids: [x.id] })

  // 下一届的起点：这一届卡得多的句子（有梯子的），下一版讲义默认先给梯子第 1 步
  const nextMin = Math.max(NEXT_MIN, Math.ceil(students.length * NEXT_SHARE))
  const nextUp = h.sentences
    .filter((x) => x.ladder && hard(x.id).length >= nextMin)
    .sort((a, b) => hard(b.id).length - hard(a.id).length)
    .slice(0, NEXT_MAX)

  // 粗读段意题：第一次就答对的人、第一次答错的人、到现在还没答对的人
  const gists = h.paragraphs.map((p) => {
    const recs = students.flatMap((s) => (s.answers[p.gist.id] ? [{ s, a: s.answers[p.gist.id] }] : []))
    return { p, recs, missed: recs.filter((r) => !r.a.firstTryCorrect), notYet: recs.filter((r) => !r.a.correct) }
  })
  const openGist = (n: number) => {
    const g = gists.find((x) => x.p.n === n)
    if (g) setDrawer({ title: `第 ${n} 段段意题 · ${g.missed.length} / ${g.recs.length} 人第一次答错`, ids: [], gist: n })
  }
  const openRecent = (r: Recent) => {
    const x = r.sentenceId && h.sentences.find((y) => y.id === r.sentenceId)
    if (x) openSentence(x)
    else if (r.paragraph) openGist(r.paragraph)
  }

  return (
    <div className="min-h-screen bg-ground">
      <header className="border-b border-line bg-surface">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3.5 sm:px-8">
          <a href="#/" className="text-[20px] font-bold tracking-wider text-ink">
            知适 · 老师端
          </a>
          <span className="order-last w-full text-[14px] text-ink2 sm:order-none sm:w-auto sm:flex-1">本周外刊：{h.title}</span>
          <div className="ml-auto flex flex-wrap items-center gap-3">
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
            <a href="#/upload" className={`${btn.small} inline-flex items-center`}>
              上传新讲义
            </a>
          </div>
        </div>
      </header>

      {!data ? (
        <p className="mx-auto max-w-6xl px-8 py-6 text-[14px] text-muted">正在加载……</p>
      ) : (
        <main className="mx-auto flex max-w-6xl flex-col gap-6 px-4 py-6 sm:px-8">
          {data.mode === 'live' && (
            <section className={`${card} flex flex-col gap-1.5 p-4`} aria-live="polite">
              <div className="flex items-center gap-2">
                <span className="h-2 w-2 animate-pulse rounded-full bg-green" />
                <h2 className="m-0 text-[16px] font-bold">刚刚</h2>
                <span className="text-[12px] text-muted">每 5 秒自动更新</span>
              </div>
              {recent.length ? (
                recent.map((r) => (
                  <button key={r.key} type="button" onClick={() => openRecent(r)} className="flex min-h-[36px] items-center justify-between gap-3 border-t border-line-soft py-1.5 text-left text-[14px] first-of-type:border-t-0">
                    <span className={now - r.at < FLASH_MS ? 'font-semibold text-amber-dark' : ''}>{r.text}</span>
                    <span className="shrink-0 text-[12px] text-muted">{ago(now - r.at)}</span>
                  </button>
                ))
              ) : (
                <span className="text-[13px] text-muted">学生一答错、一开梯子，这里马上出现，卡住的句子在热力图里会亮一下。</span>
              )}
            </section>
          )}

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
                            className={`cursor-pointer rounded px-[3px] py-0.5 hover:outline hover:outline-2 hover:outline-primary ${flashing.has(x.id) ? 'bg-amber-light outline outline-2 outline-amber' : heat(c)}`}
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

          <section className={`${card} flex flex-col gap-3 rounded-2xl p-5`}>
            <div className="flex flex-wrap items-baseline gap-3">
              <h2 className="m-0 flex-1 text-[18px] font-bold">下一届的起点</h2>
              {nextUp.length > 0 && (
                <a href={`#/next?ids=${nextUp.map((x) => x.id).join(',')}`} target="_blank" rel="noreferrer" className={`${btn.small} inline-flex items-center`}>
                  预览下一版（学生看到的样子）
                </a>
              )}
            </div>
            <p className="m-0 text-[13px] leading-relaxed text-ink2">
              这一届卡得多的句子，下一版讲义里默认先给梯子第 1 步，下一届的同学不用先卡一次。（至少 {nextMin} 人、且不少于三成卡在「中」以上才算）
            </p>
            {nextUp.length ? (
              nextUp.map((x) => (
                <button key={x.id} type="button" onClick={() => openSentence(x)} className="flex min-h-[44px] items-center gap-3 border-t border-line-soft py-2 text-left first-of-type:border-t-0">
                  <span className={`min-w-[64px] rounded-md px-2 py-1 text-center text-[13px] font-semibold ${heat(hard(x.id).length) || 'bg-ground'}`}>
                    {hard(x.id).length} / {students.length} 人
                  </span>
                  <span className="shrink-0 text-[13px] text-ink2">{x.id}</span>
                  <span className="flex-1 font-serif text-[15px] leading-snug">{x.text}</span>
                </button>
              ))
            ) : (
              <span className="text-[14px] text-muted">还没有哪一句卡住的人够多。</span>
            )}
          </section>

          <section className={`${card} flex flex-col gap-3 rounded-2xl p-5`}>
            <div className="flex flex-wrap items-baseline gap-3">
              <h2 className="m-0 text-[18px] font-bold">粗读 · 段意题</h2>
              <span className="text-[13px] text-muted">颜色是第一次答错的人数</span>
            </div>
            {gists.map(({ p, recs, missed, notYet }) => (
              <button
                key={p.n}
                type="button"
                onClick={() => openGist(p.n)}
                className={`flex min-h-[48px] flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border-t border-line-soft px-1 py-2 text-left first-of-type:border-t-0 ${flashingGist.has(p.n) ? 'bg-amber-light outline outline-2 outline-amber' : ''}`}
              >
                <span className={`min-w-[44px] rounded-md px-2 py-1 text-center text-[14px] font-semibold ${heat(missed.length) || 'bg-ground'}`}>{missed.length}</span>
                <span className="shrink-0 text-[14px] font-semibold">第 {p.n} 段</span>
                <span className="min-w-0 flex-1 text-[14px] text-ink2">{p.gist.prompt}</span>
                <span className="shrink-0 text-[13px] text-muted">
                  {recs.length ? `第一次答对 ${recs.length - missed.length} / ${recs.length}${notYet.length ? ` · 还没答对 ${notYet.length}` : ''}` : '还没有人答'}
                </span>
              </button>
            ))}
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
            {drawer.gist !== undefined &&
              (() => {
                const g = gists.find((x) => x.p.n === drawer.gist)
                if (!g) return null
                const order = (r: (typeof g.recs)[number]) => (r.a.correct ? (r.a.firstTryCorrect ? 0 : r.a.attempts) : 99)
                return (
                  <section className="flex flex-col gap-2">
                    <p className="m-0 text-[15px] font-semibold leading-relaxed">{g.p.gist.prompt}</p>
                    <span className="text-[14px] text-ink2">正确答案：{g.p.gist.options[g.p.gist.answer]}</span>
                    <div className="flex flex-col">
                      {[...g.recs]
                        .sort((a, b) => order(b) - order(a))
                        .map((r) => (
                          <div key={r.s.sid} className="flex items-center justify-between gap-3 border-t border-line-soft py-2.5 text-[14px]">
                            <span>{nameOf(r.s.sid)}</span>
                            <Pill tone={r.a.firstTryCorrect ? 'green' : r.a.correct ? 'amber' : 'red'}>
                              {r.a.firstTryCorrect ? '第一次就对' : r.a.correct ? `第 ${r.a.attempts} 次答对` : `答了 ${r.a.attempts} 次还没对`}
                            </Pill>
                          </div>
                        ))}
                      {!g.recs.length && <span className="text-[14px] text-muted">还没有人答这一题</span>}
                    </div>
                    <div className="rounded-[10px] bg-ground p-3 text-[13px] leading-relaxed">
                      <span className="font-semibold">这一段的要点：</span>
                      {g.p.gistEn}
                    </div>
                  </section>
                )
              })()}
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
