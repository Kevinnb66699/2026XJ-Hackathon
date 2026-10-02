// 教师端：刚刚 + 今天点评这几个人 + 卡点热力图（按句子 / 按结构）+ 下一届的起点 + 粗读段意题。点一句弹出抽屉：谁卡在这句、为什么。
// 数据：GET /api/events 重建每个学生的状态；拉不到（或还没有人做）就用预设画像生成快照，并标明「示例数据」。
// 实时模式每 5 秒自动拉一次：有人答错、开梯子，「刚刚」里马上出现，热力图里那一句亮一下。
// 教师端可以显示结构名称；学生端不出现这些词。
import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import { LearningEvent, type Sentence, type StructureTag } from '../../shared/schema'
import { Icon, Pill, btn, card } from '../components/ui'
import { currentHandout as h } from '../data'
import { snapshotEvents } from '../data/presets'
import { emptyState, readingTrails, reviewPicks, stuck } from '../engine'
import type { ReviewPick, SentenceStuck, StuckCause, StudentState, TrailStep } from '../engine/types'
import { learningEvents, replay, triedFirst } from '../lib/replay'
import { getParams } from '../lib/router'

const TAG_NAME: Record<StructureTag, string> = { appositive_that: '同位语从句', inversion: '倒装', long_subject: '长主语', reference: '指代' }
const CAUSE_NAME: Record<StuckCause, string> = { word: '词', structure: '结构', mixed: '词和结构' }
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
  events: LearningEvent[] // 用来重建学生：实时模式是实时事件，示例模式是预设画像
  live: LearningEvent[] // 拉到的实时学习事件（示例模式下也带着，用来判断有没有新动作）
  liveCount: number // 后端已有多少个学生的实时数据
  ok: boolean // 这次请求成功拿到了数据（失败、超时时为 false）
}

// 数据来源：实时数据够 5 人就用实时，否则先显示示例班级（标明「示例数据」），可以手动切换；#/teacher?live=1 直接看实时（展位用）
// 老师自己上传的讲义（id 以 up- 开头）默认看实时，还没人做也不放示例班级
const LIVE_MIN = 5
type Prefer = 'auto' | 'live' | 'demo'
const uploaded = () => h.id.startsWith('up-') // 讲义在页面渲染前才定下来，不能在模块顶层算

const POLL_MS = 5000 // 自动刷新间隔：展位上评委一答，这边几秒内就能看到
const FLASH_MS = 10000 // 刚有人卡住的句子亮多久
const STALE_MS = 3 * 60000 // 手机补发的积压事件超过 3 分钟就不算「刚刚」
const LAG_MS = 15000 // 超过这么久没拉到数据，页面上提示「自动更新中断」
const RECENT_MAX = 8
// 下一届的起点：做过这一句的人里，至少 2 人、且不少于三成卡在「中」以上，才算全班的卡点（人少时一个人卡住不算）
const NEXT_MIN = 2
const NEXT_SHARE = 0.3
const NEXT_MAX = 5

// 「刚刚」里的一条：存 sid，称呼在显示时再取（新同学加入后编号可能变）
type Recent = { key: string; sid: string; text: string; good?: boolean; sentenceId?: string; paragraph?: number; at: number }
type Drawer = { ids: string[]; tag?: StructureTag; gist?: number; sid?: string; from?: string } // from：从哪位同学的轨迹点进来的句子
const keyOf = (e: LearningEvent) => `${e.sid}|${e.ts}|${e.type}|${e.sentenceId ?? e.paragraph ?? e.lemma ?? ''}`
const lead = (x: Sentence) => `${x.text.split(/\s+/).slice(0, 5).join(' ')}…`
const ago = (ms: number) => (ms < 60000 ? `${Math.max(1, Math.round(ms / 1000))} 秒前` : `${Math.round(ms / 60000)} 分钟前`)

// 「刚刚」：看得出卡住的动作（答错、开梯子、猜错意思的词），加上原句题第一次就答对（绿色，评委答对也看得到自己）；点词、标「不认识」太多，不列
function recentOf(e: LearningEvent): Pick<Recent, 'text' | 'good' | 'sentenceId' | 'paragraph'> | null {
  const x = e.sentenceId ? h.sentences.find((y) => y.id === e.sentenceId) : undefined
  if (e.type === 'answer_question' && x && e.correct === false) return { text: `${x.id}「${lead(x)}」${e.firstTry ? '第一次答错' : '又答错了'}`, sentenceId: x.id }
  if (e.type === 'answer_question' && x && e.correct && e.firstTry) return { text: `${x.id}「${lead(x)}」第一次就答对`, good: true, sentenceId: x.id }
  if (e.type === 'open_ladder' && x) return { text: `${x.id}「${lead(x)}」打开梯子第 ${e.level} 步`, sentenceId: x.id }
  if (e.type === 'gist_answer' && e.correct === false && e.paragraph) return { text: `第 ${e.paragraph} 段段意题答错`, paragraph: e.paragraph }
  const known = e.lemma && h.words.some((w) => w.lemma === e.lemma) // 假词不列
  if (e.type === 'answer_question' && !e.sentenceId && known && e.correct === false) return { text: `${e.lemma} 猜错了意思` }
  return null
}

async function loadEvents(prefer: Prefer): Promise<Data> {
  let live: LearningEvent[] = []
  let ok = false
  try {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), 5000) // 后端卡住时 5 秒后放弃（连读响应体一起算）
    try {
      const res = await fetch(`/api/events?handoutId=${encodeURIComponent(h.id)}`, { signal: ctrl.signal })
      if (res.ok) {
        const raw: unknown = await res.json()
        if (Array.isArray(raw)) {
          ok = true
          live = raw.flatMap((e) => {
            const r = LearningEvent.safeParse(e)
            return r.success ? [r.data] : []
          })
        }
      }
    } finally {
      clearTimeout(timer)
    }
  } catch {
    // 后端不可用：用快照
  }
  live = learningEvents(live) // 只打开过页面、只报过错的设备不算学生
  const liveCount = new Set(live.map((e) => e.sid)).size
  const useLive = (live.length > 0 || (prefer === 'live' && uploaded())) && (prefer === 'live' || (prefer === 'auto' && liveCount >= LIVE_MIN))
  return { mode: useLive ? 'live' : 'snapshot', events: useLive ? live : snapshotEvents(h), live, liveCount, ok }
}

// 班级里的称呼：按第一次出现的先后编号，如「同学 07」；新同学只拿下一个号，已有的人编号不变；不显示原始 id
function aliasMap(events: LearningEvent[]): Map<string, string> {
  const first = new Map<string, number>()
  for (const e of events) if (!first.has(e.sid) || e.ts < first.get(e.sid)!) first.set(e.sid, e.ts)
  return new Map(
    [...first]
      .sort((a, b) => a[1] - b[1] || (a[0] < b[0] ? -1 : 1))
      .map(([sid], i) => [sid, `同学 ${String(i + 1).padStart(2, '0')}`]),
  )
}

// 点评名单的种子：当天日期，如 20261001
const todaySeed = () => {
  const d = new Date()
  return d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate()
}

function reasonOf(s: StudentState, x: Sentence, st: SentenceStuck): string {
  const parts: string[] = []
  const L = s.ladder[x.id] ?? 0
  if (L) parts.push(`梯子到第 ${L} 步`)
  const a = x.question && s.answers[x.question.id]
  if (a) parts.push(a.firstTryCorrect ? '原句题首答对' : a.correct ? `原句题第 ${a.attempts} 次答对` : '原句题还没答对')
  if (st.cause) parts.push(`卡在${CAUSE_NAME[st.cause]}`)
  return parts.join(' · ')
}

type Row = { s: StudentState; st: SentenceStuck }
const lv = (r: Row) => r.st.level ?? 0

// 读懂轨迹里一句的写法和颜色。状态里没有先后顺序，所以「梯子」和「答对」并列写，不说谁先谁后
function stepLabel(x: TrailStep): [string, 'green' | 'amber' | 'red' | 'gray'] {
  const nth = (n: number) => (n === 1 ? '第一次答对' : `第 ${n} 次答对`)
  if (x.outcome === 'own') return ['自己读懂', 'green']
  if (x.outcome === 'ladder') return [`梯子到第 ${x.ladder} 步 · ${nth(x.attempts)}`, 'amber']
  if (x.outcome === 'retry') return [`没开梯子 · ${nth(x.attempts)}`, 'amber']
  if (x.outcome === 'stuck') return x.attempts ? [`答了 ${x.attempts} 次还没答对${x.ladder ? ` · 梯子到第 ${x.ladder} 步` : ''}`, 'amber'] : [`梯子到第 ${x.ladder} 步，还没答题`, 'gray']
  return ['还没做', 'gray']
}

export default function TeacherPage() {
  const [data, setData] = useState<Data | null>(null)
  const [prefer, setPrefer] = useState<Prefer>(() => (getParams().get('live') === '1' || uploaded() ? 'live' : 'auto'))
  const [by, setBy] = useState<'sentence' | 'structure'>('sentence')
  const [drawer, setDrawer] = useState<Drawer | null>(null)
  const [recent, setRecent] = useState<Recent[]>([])
  const [flash, setFlash] = useState<Record<string, number>>({}) // 'S16' 或 'P4' → 亮到什么时候
  const [now, setNow] = useState(() => Date.now())
  const [lastOk, setLastOk] = useState(() => Date.now())
  const [refreshing, setRefreshing] = useState(false)
  const dataRef = useRef<Data | null>(null)
  dataRef.current = data
  const seenRef = useRef<Set<string> | null>(null) // 见过的实时事件，只增不减；null 表示还没拉到过
  const busyRef = useRef(false)
  const reqRef = useRef(0)

  // 新到的实时事件：第一次拉到时（含整页刷新）手上的全算新到的；之后每次（自动刷新、手动刷新、切换模式）都按「见过没有」算，和当前显示哪种模式无关
  // 第二个值：是不是第一次拉到
  const absorb = (next: Data): [LearningEvent[], boolean] => {
    if (!next.ok) return [[], false]
    setLastOk(Date.now())
    const seen = seenRef.current
    if (!seen) {
      seenRef.current = new Set(next.live.map(keyOf))
      return [next.live, true]
    }
    const fresh = next.live.filter((e) => !seen.has(keyOf(e)))
    fresh.forEach((e) => seen.add(keyOf(e)))
    return [fresh, false]
  }
  // 放进「刚刚」并让句子亮起来；只在实时模式下做（示例班级里亮评委的句子会误导）
  // 时间按到达时刻算（各手机的钟可能不准）；第一次拉到的按事件自己的时间（不晚于现在），免得把两分钟前的说成几秒前、又亮一遍
  const announce = (fresh: LearningEvent[], first: boolean, mode: Data['mode']) => {
    if (mode !== 'live' || !fresh.length) return
    const now = Date.now()
    const items = fresh
      .map((e, i) => ({ e, i }))
      .filter(({ e }) => now - e.ts < STALE_MS)
      .sort((a, b) => b.e.ts - a.e.ts || b.i - a.i) // 新的在上；不同手机的事件可能交错到达；同一毫秒的（答错和自动开梯子）后到的在上
      .flatMap(({ e }): Recent[] => {
        const r = recentOf(e)
        return r ? [{ ...r, key: keyOf(e), sid: e.sid, at: first ? Math.min(e.ts, now) : now }] : []
      })
    if (!items.length) return
    setRecent((old) => [...items, ...old].slice(0, RECENT_MAX))
    // 亮到这一条之后 10 秒；同一句有好几条时倒过来写，最新的那条算数
    const lit = items
      .filter((r) => !r.good && now - r.at < FLASH_MS)
      .reverse()
      .flatMap((r): [string, number][] => (r.sentenceId ? [[r.sentenceId, r.at + FLASH_MS]] : r.paragraph ? [[`P${r.paragraph}`, r.at + FLASH_MS]] : []))
    if (lit.length) setFlash((old) => ({ ...old, ...Object.fromEntries(lit) }))
  }

  // clear：切换模式时清空重载；手动刷新保留旧数据，右上角只提示「正在刷新…」
  const refresh = (clear: boolean) => {
    const id = ++reqRef.current
    if (clear) setData(null)
    setRefreshing(!clear)
    void loadEvents(prefer).then((next) => {
      if (id !== reqRef.current) return // 期间又切换了模式或又点了刷新，这次的结果作废
      setRefreshing(false)
      announce(...absorb(next), next.mode)
      setData(next)
    })
  }
  useEffect(() => {
    setRecent([])
    setFlash({})
    refresh(true)
  }, [prefer])

  // 自动刷新：不清空页面，只在有变化时更新。页面在后台不拉；上一次还没回来就不再发
  useEffect(() => {
    if (prefer === 'demo') return
    let alive = true
    const poll = () => {
      if (document.hidden || busyRef.current) return
      busyRef.current = true
      void loadEvents(prefer).then((next) => {
        busyRef.current = false
        const prev = dataRef.current
        if (!alive || !prev || !next.ok) return // 没拉到就保持原样，页面上会提示「自动更新中断」
        const [fresh, first] = absorb(next)
        announce(fresh, first, next.mode)
        if (prev.mode === 'snapshot' && next.mode === 'snapshot') {
          if (next.liveCount !== prev.liveCount) setData({ ...prev, live: next.live, liveCount: next.liveCount })
          return
        }
        if (prev.mode === 'live' && next.mode === 'live' && !fresh.length && next.live.length === prev.live.length) return
        if (prev.mode === 'live' && next.mode === 'snapshot') setRecent([]) // 事件被存档后退回示例班级，旧条目清掉
        if (prev.mode !== next.mode) setDrawer((d) => (d?.sid || d?.from ? null : d)) // 换了数据源，原来那位同学不在了
        setData(next)
      })
    }
    const t = setInterval(poll, POLL_MS)
    document.addEventListener('visibilitychange', poll) // 切回这个页面时马上拉一次
    return () => {
      alive = false
      clearInterval(t)
      document.removeEventListener('visibilitychange', poll)
    }
  }, [prefer])
  // 实时模式下每秒走一次：「几秒前」、高亮到期、「自动更新中断」都靠它
  const live = data?.mode === 'live'
  useEffect(() => {
    if (!live) return
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [live])
  const lagging = live && now - lastOk > LAG_MS
  // 抽屉打开时：按 Esc 关闭，背景不滚动
  const drawerOpen = drawer !== null
  useEffect(() => {
    if (!drawerOpen) return
    const overflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setDrawer(null)
    window.addEventListener('keydown', onKey)
    return () => {
      document.body.style.overflow = overflow
      window.removeEventListener('keydown', onKey)
    }
  }, [drawerOpen])
  const lit = (key: string) => (flash[key] ?? 0) > now

  const students = useMemo(() => (data ? replay(h, data.events) : []), [data])
  const alias = useMemo(() => aliasMap(data ? data.events : []), [data])
  const nameOf = (sid: string) => alias.get(sid) ?? '新同学'
  // 点评名单：定向的随数据变；随机的 2 人一旦抽中就固定，免得每来一个新人就换一批
  const randomRef = useRef<string[]>([])
  const picks = useMemo((): ReviewPick[] => {
    const all = reviewPicks(h, students, { targeted: 2, random: 2, seed: todaySeed() })
    const targeted = all.filter((p) => p.kind === 'targeted')
    const present = new Set(students.map((s) => s.sid))
    const taken = new Set(targeted.map((p) => p.sid))
    const keep = randomRef.current.filter((sid) => present.has(sid) && !taken.has(sid))
    const fill = all.filter((p) => p.kind === 'random' && !keep.includes(p.sid)).map((p) => p.sid)
    randomRef.current = [...keep, ...fill].slice(0, 2)
    return [...targeted, ...randomRef.current.map((sid): ReviewPick => ({ sid, kind: 'random', reason: '随机抽查' }))]
  }, [students])
  const rows = useMemo(() => new Map(h.sentences.map((x) => [x.id, students.map((s): Row => ({ s, st: stuck(h, s, x.id) }))])), [students])
  const hard = (id: string) => (rows.get(id) ?? []).filter((r) => lv(r) >= 2) // 卡在「中」以上
  const touched = (id: string) => (rows.get(id) ?? []).filter((r) => r.st.level !== null) // 这一句有数据的人（没碰过这一句的不算进分母）
  const paragraphs = [...new Set(h.sentences.map((x) => x.paragraph))].sort((a, b) => a - b)
  const tags = [...new Set(h.sentences.flatMap((x) => (x.tag ? [x.tag] : [])))]
  const tagIds = (tag: StructureTag) => h.sentences.filter((x) => x.tag === tag).map((x) => x.id)
  const tagCount = (tag: StructureTag) => new Set(tagIds(tag).flatMap((id) => hard(id).map((r) => r.s.sid))).size
  const tagTouched = (tag: StructureTag) => new Set(tagIds(tag).flatMap((id) => touched(id).map((r) => r.s.sid))).size
  const openSentence = (x: Sentence) => setDrawer({ ids: [x.id] })

  // 下一届的起点：这一届卡得多的句子（有梯子的），下一版讲义默认先给梯子第 1 步
  const nextMin = (id: string) => Math.max(NEXT_MIN, Math.ceil(touched(id).length * NEXT_SHARE))
  const nextUp = h.sentences
    .filter((x) => x.ladder && hard(x.id).length >= nextMin(x.id))
    .sort((a, b) => hard(b.id).length - hard(a.id).length)
    .slice(0, NEXT_MAX)

  // 粗读段意题：第一次就答对的人、第一次答错的人、到现在还没答对的人
  const gists = h.paragraphs.map((p) => {
    const recs = students.flatMap((s) => (s.answers[p.gist.id] ? [{ s, a: s.answers[p.gist.id] }] : []))
    return { p, recs, missed: recs.filter((r) => !r.a.firstTryCorrect), notYet: recs.filter((r) => !r.a.correct) }
  })
  const openGist = (n: number) => setDrawer({ ids: [], gist: n })

  // 读懂轨迹：同一类长难句按出现顺序；每句「自己读懂」的人数 / 做过的人数；被要求先自己试时第一次就答对的次数
  const firstTried = useMemo(() => triedFirst(h, data ? data.events : []), [data])
  const trails = useMemo(() => new Map(students.map((s) => [s.sid, readingTrails(h, s, firstTried.get(s.sid))])), [students, firstTried])
  const chains = readingTrails(h, emptyState('-'))
  const chainStats = chains.map((c, i) => ({
    tag: c.tag,
    nodes: c.steps.map((x, k) => {
      const outs = [...trails.values()].map((ts) => ts[i].steps[k]).filter((y) => y.outcome !== 'none')
      return { id: x.sentenceId, own: outs.filter((y) => y.outcome === 'own').length, done: outs.length }
    }),
  }))
  const tried = [...trails.values()].flatMap((ts) => ts.flatMap((t) => t.steps.filter((x) => x.tryFirst && x.outcome !== 'none')))
  const triedOwn = tried.filter((x) => x.firstTry).length
  const openStudent = (sid: string) => setDrawer({ ids: [], sid })
  const byName = [...students].sort((a, b) => nameOf(a.sid).localeCompare(nameOf(b.sid), 'zh', { numeric: true })) // 「看某位同学」按「同学 NN」编号排
  const target = (r: Recent) => (r.sentenceId ? h.sentences.find((y) => y.id === r.sentenceId) : undefined)
  const openRecent = (r: Recent) => {
    const x = target(r)
    if (x) openSentence(x)
    else if (r.paragraph) openGist(r.paragraph)
  }
  // 抽屉标题每次重画都重算，自动刷新后人数和下面的名单一致
  const drawerTitle = (d: Drawer): string => {
    if (d.sid) return `${nameOf(d.sid)} 的读懂轨迹`
    if (d.gist !== undefined) {
      const g = gists.find((x) => x.p.n === d.gist)
      return `第 ${d.gist} 段段意题 · ${g?.missed.length ?? 0} / ${g?.recs.length ?? 0} 人第一次答错`
    }
    if (d.tag) return `${TAG_NAME[d.tag]} · ${tagCount(d.tag)} / ${tagTouched(d.tag)} 人卡住`
    return `${d.ids[0]} · ${hard(d.ids[0]).length} / ${touched(d.ids[0]).length} 人卡住`
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
            {refreshing && <span className="text-[12px] text-muted">正在刷新…</span>}
            <button type="button" className={btn.small} onClick={() => refresh(false)}>
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
                <span className={`h-2 w-2 rounded-full ${lagging ? 'bg-amber' : 'animate-pulse bg-green'}`} />
                <h2 className="m-0 text-[16px] font-bold">刚刚</h2>
                {lagging ? (
                  <span className="text-[12px] text-amber-dark">自动更新中断，最后一次拉到数据是 {ago(now - lastOk)}；可以点右上角「刷新」</span>
                ) : (
                  <span className="text-[12px] text-muted">每 5 秒自动更新</span>
                )}
              </div>
              {recent.length ? (
                recent.map((r) => {
                  const fresh = now - r.at < FLASH_MS
                  const tone = r.good ? 'text-green' : fresh ? 'font-semibold text-amber-dark' : ''
                  const body = (
                    <>
                      <span className={tone}>
                        {nameOf(r.sid)} · {r.text}
                      </span>
                      <span className="shrink-0 text-[12px] text-muted">{ago(now - r.at)}</span>
                    </>
                  )
                  const row = 'flex min-h-[36px] items-center justify-between gap-3 border-t border-line-soft py-1.5 text-left text-[14px] first-of-type:border-t-0'
                  return target(r) || r.paragraph ? (
                    <button key={r.key} type="button" onClick={() => openRecent(r)} className={row}>
                      {body}
                    </button>
                  ) : (
                    <div key={r.key} className={row}>
                      {body}
                    </div>
                  )
                })
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
            {!picks.length && <span className="text-[14px] text-muted">还没有学生做这份讲义。</span>}
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
              {picks.map((p) => (
                <div key={p.sid} className={`${card} flex flex-col gap-2 p-3.5`}>
                  <div className="flex items-center justify-between gap-2">
                    <button type="button" onClick={() => openStudent(p.sid)} className="text-[16px] font-semibold text-primary hover:underline">
                      {nameOf(p.sid)}
                    </button>
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
                            className={`cursor-pointer rounded px-[3px] py-0.5 hover:outline hover:outline-2 hover:outline-primary ${lit(x.id) ? 'bg-amber-light outline outline-2 outline-amber' : heat(c)}`}
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
                  const ids = tagIds(tag)
                  const c = tagCount(tag)
                  return (
                    <button
                      key={tag}
                      type="button"
                      onClick={() => setDrawer({ ids, tag })}
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

          {chainStats.length > 0 && (
            <section className={`${card} flex flex-col gap-3 rounded-2xl p-5`}>
              <div className="flex flex-wrap items-baseline gap-3">
                <h2 className="m-0 text-[18px] font-bold">读懂轨迹</h2>
                {data.mode === 'snapshot' && <Pill tone="amber">示例数据</Pill>}
                <span className="text-[13px] text-muted">同一类长难句按出现顺序：每句「自己读懂」（没开梯子、第一次就答对）的人数 / 做过的人数</span>
              </div>
              {chainStats.map(({ tag, nodes }, i) => (
                <div key={tag} className={`flex flex-wrap items-center gap-x-2 gap-y-2 ${i ? 'border-t border-line-soft pt-3' : ''}`}>
                  <span className="w-[88px] shrink-0 text-[15px] font-semibold">{TAG_NAME[tag]}</span>
                  {nodes.map((n, k) => (
                    <Fragment key={n.id}>
                      {k > 0 && <span className="text-dim">→</span>}
                      <button type="button" onClick={() => setDrawer({ ids: [n.id] })} className="flex items-baseline gap-1.5 rounded-lg border border-line px-2.5 py-1.5 text-[14px] hover:border-primary">
                        <span className="text-ink2">{n.id}</span>
                        <span className="font-semibold text-green">{n.own}</span>
                        <span className="text-muted">/ {n.done} 人</span>
                      </button>
                    </Fragment>
                  ))}
                </div>
              ))}
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[14px]">
                <span className="text-muted">看某位同学：</span>
                {byName.map((s) => (
                  <button key={s.sid} type="button" onClick={() => openStudent(s.sid)} className="text-primary hover:underline">
                    {nameOf(s.sid)}
                  </button>
                ))}
              </div>
              {data.mode === 'live' && (
                <p className="m-0 text-[14px] text-ink2">
                  先自己试的句子（前面同类句子自己读懂过，这一句梯子先收起、要先答题）：共 {tried.length} 次，第一次就答对 {triedOwn} 次。
                </p>
              )}
              <p className="m-0 text-[12px] leading-relaxed text-muted">
                {data.mode === 'snapshot'
                  ? '示例班级：这些数由两种演示画像按规则生成（一种每类第一句就开梯子，后面同类句子大多直接答对），不是真实作答，不能读成进步。'
                  : '前面同类句子自己读懂过的人，到后面要先答题、梯子先收起；题目三选一，蒙也可能答对；后面的句子也可能本来就更容易。轨迹只记每句是怎么过的，不说明读懂能力有变化。'}
              </p>
            </section>
          )}

          <section className={`${card} flex flex-col gap-3 rounded-2xl p-5`}>
            <div className="flex flex-wrap items-baseline gap-3">
              <h2 className="m-0 flex-1 shrink-0 whitespace-nowrap text-[18px] font-bold">下一届的起点</h2>
              {nextUp.length > 0 && (
                <a href={`#/next?ids=${nextUp.map((x) => x.id).join(',')}`} target="_blank" rel="noreferrer" className={`${btn.small} inline-flex items-center`}>
                  预览下一版<span className="hidden sm:inline">（学生看到的样子）</span>
                </a>
              )}
            </div>
            <p className="m-0 text-[13px] leading-relaxed text-ink2">
              这一届卡得多的句子，下一版讲义里默认先给梯子第 1 步，下一届的同学不用先卡一次。（做过这一句的人里，至少 {NEXT_MIN} 人、且不少于三成卡在「中」以上才算）
            </p>
            {nextUp.length ? (
              nextUp.map((x) => (
                <button key={x.id} type="button" onClick={() => openSentence(x)} className="flex min-h-[44px] items-center gap-3 border-t border-line-soft py-2 text-left first-of-type:border-t-0">
                  <span className={`min-w-[64px] rounded-md px-2 py-1 text-center text-[13px] font-semibold ${heat(hard(x.id).length) || 'bg-ground'}`}>
                    {hard(x.id).length} / {touched(x.id).length} 人
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
                className={`flex min-h-[48px] flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border-t border-line-soft px-1 py-2 text-left first-of-type:border-t-0 ${lit(`P${p.n}`) ? 'bg-amber-light outline outline-2 outline-amber' : ''}`}
              >
                <span className={`min-w-[44px] rounded-md px-2 py-1 text-center text-[14px] font-semibold ${heat(missed.length) || 'bg-ground'}`}>{missed.length}</span>
                <span className="shrink-0 text-[14px] font-semibold">第 {p.n} 段</span>
                <span className="min-w-[12rem] flex-1 text-[14px] text-ink2">{p.gist.prompt}</span>
                <span className="w-full text-[13px] text-muted sm:w-auto sm:shrink-0">
                  {recs.length ? `第一次答对 ${recs.length - missed.length} / ${recs.length}${notYet.length ? ` · 还没答对 ${notYet.length}` : ''}` : '还没有人答'}
                </span>
              </button>
            ))}
          </section>
        </main>
      )}

      {drawer && (
        <div className="fixed inset-0 z-30 flex justify-end bg-black/20" onClick={() => setDrawer(null)}>
          <aside role="dialog" aria-label={drawerTitle(drawer)} onClick={(e) => e.stopPropagation()} className="flex h-full w-full max-w-[440px] flex-col gap-5 overflow-y-auto bg-surface p-5 shadow-xl">
            <div className="flex items-start gap-2">
              <h2 className="m-0 flex-1 text-[18px] font-bold">{drawerTitle(drawer)}</h2>
              <button type="button" aria-label="关闭" onClick={() => setDrawer(null)} className="flex h-11 w-11 items-center justify-center">
                <Icon name="close" />
              </button>
            </div>
            {drawer.sid &&
              (() => {
                const ts = trails.get(drawer.sid) ?? []
                const mine = ts.flatMap((t) => t.steps.filter((x) => x.tryFirst && x.outcome !== 'none'))
                const sid = drawer.sid
                return (
                  <section className="flex flex-col gap-4">
                    {ts.map((t) => (
                      <div key={t.tag} className="flex flex-col gap-1.5">
                        <span className="text-[14px] font-semibold">{TAG_NAME[t.tag]}</span>
                        {t.steps.map((x) => {
                          const [label, tone] = stepLabel(x)
                          const sx = h.sentences.find((y) => y.id === x.sentenceId)!
                          return (
                            <button key={x.sentenceId} type="button" onClick={() => setDrawer({ ids: [x.sentenceId], from: sid })} className="flex items-center justify-between gap-3 border-t border-line-soft py-2 text-left text-[14px]">
                              {/* 原文交给 CSS 截断（不再叠 lead() 的「…」）；「先自己试」单独一行，手机上不挤掉原文 */}
                              <span className="flex min-w-0 flex-col text-ink2">
                                <span className="flex min-w-0">
                                  <span className="shrink-0">{x.sentenceId}「</span>
                                  <span className="min-w-0 truncate">{sx.text}</span>
                                  <span className="shrink-0">」</span>
                                </span>
                                {x.tryFirst && x.outcome !== 'none' && <span className="text-[12px] text-muted">先自己试</span>}
                              </span>
                              <span className="shrink-0 whitespace-nowrap">
                                <Pill tone={tone}>{label}</Pill>
                              </span>
                            </button>
                          )
                        })}
                      </div>
                    ))}
                    {!chains.length && <span className="text-[14px] text-muted">这份讲义里没有成串的同类句子。</span>}
                    {data?.mode === 'live' && (
                      <p className="m-0 text-[13px] text-ink2">
                        先自己试 {mine.length} 次，第一次就答对 {mine.filter((x) => x.firstTry).length} 次。
                      </p>
                    )}
                    <p className="m-0 text-[12px] leading-relaxed text-muted">
                      {data?.mode === 'snapshot'
                        ? '示例班级的画像按规则生成，不是真实作答。'
                        : '只记这一篇里每句是怎么过的。标「先自己试」的句子梯子先收起、要先答题，三选一也可能蒙对；后面的句子也可能本来就更容易。不说明读懂能力有变化。'}
                    </p>
                  </section>
                )
              })()}
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
                  {drawer.from &&
                    (() => {
                      const step = trails.get(drawer.from)?.flatMap((t) => t.steps).find((y) => y.sentenceId === id)
                      return (
                        <div className="flex flex-col gap-1.5 rounded-[10px] bg-ground p-3 text-[14px]">
                          {step && (
                            <span className="flex items-center gap-2">
                              {nameOf(drawer.from)} 这一句：<Pill tone={stepLabel(step)[1]}>{stepLabel(step)[0]}</Pill>
                            </span>
                          )}
                          <button type="button" onClick={() => openStudent(drawer.from!)} className="self-start text-primary hover:underline">
                            ← 回到 {nameOf(drawer.from)} 的读懂轨迹
                          </button>
                        </div>
                      )
                    })()}
                  <div className="flex flex-col">
                    {list.map((r) => (
                      <div key={r.s.sid} className="flex items-center justify-between gap-3 border-t border-line-soft py-2.5 text-[14px]">
                        <span className="flex shrink-0 items-center gap-2">
                          <button type="button" onClick={() => openStudent(r.s.sid)} className="text-primary hover:underline">
                            {nameOf(r.s.sid)}
                          </button>
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
