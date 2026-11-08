// #/ 入口：11-07 起只做学生端（不做老师端了）。标语下面一句大白话说清知适是什么，再一行浅色的说明，再一句「小范围内测、只能用邀请码注册」。
// 右边是一句原文和它的提示第 1、2 步（迷你讲义 S03），只写现在真有的功能。电脑上左右两栏，手机上从上到下
// 没登录：「登录」（#/me，有邀请码的在那里注册）和示例文章入口（内置迷你讲义，只存本机，小结页能「从头再读一遍」）。
// 登录了：最上面是「团队选的文章」，点进去整页打开（/?h=<讲义 id>#/student：讲义是整页加载时定下的）。示例链接写 /#/student，不带上地址里的 ?h=
// 标题旁是「学习记录」（#/records）「单词本」（#/notebook）「表达本」（#/expressions）三个入口：读过的每一篇攒在一起，自己回头看、复习。
// 下面是「我的文章」：自己贴进来的（GET /api/student/library），标题只有自己看得到，也是整页打开。服务器开放了贴文章才放「贴一篇文章」入口（#/new）；
// 没开放、自己也没贴过的，这一块整个不显示
// 「知适是怎么做的」默认收起。
// 老师端不再开发，入口收起来：已有的老师从页脚的小字「老师登录」进（#/upload，没登录先登录），老师的路由和班级二维码照旧能用
import { useEffect, useState } from 'react'
import StudentBar from '../components/StudentBar'
import { Icon, Pill, SiteHeader, btn, card } from '../components/ui'
import { fetchShelf, getLibrary, getStudent, getUploadStatus, useStudentMe, type LibraryItem, type ShelfItem, type StudentError } from '../lib/student-auth'

const STEPS = [
  { n: '1', title: '原文一字不改', desc: '文章原样保留，不删、不改写；注释和提示都放在旁边。' },
  { n: '2', title: '卡住才给提示，读懂就撤', desc: '谁 → 做了什么 → 拆开每一块 → 译文，一步一步给；读懂过的同类句子，下次先自己试。' },
  { n: '3', title: '自己复习', desc: '登录后，读团队选的文章和自己贴的文章时不认识的词和收进表达本的表达都攒在一起，可以回头复习。' },
]

const EXAMPLE = '/#/student'

// 团队选的文章（登录后）。会话过期（401）时刷新登录状态，顶栏换回「登录」
function Shelf() {
  const [items, setItems] = useState<ShelfItem[] | null>(null)
  const [error, setError] = useState('')
  useEffect(() => {
    fetchShelf().then(setItems, (e: StudentError) => {
      setError(e.message)
      if (e.status === 401) void getStudent(true)
    })
  }, [])
  return (
    <section className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="m-0 text-[20px] font-bold">团队选的文章</h2>
        <div className="flex gap-2">
          <a href="#/records" className={`${btn.small} inline-flex items-center gap-1.5 no-underline`}>
            <Icon name="list" size={15} />
            学习记录
          </a>
          <a href="#/notebook" className={`${btn.small} inline-flex items-center gap-1.5 no-underline`}>
            <Icon name="book" size={15} />
            单词本
          </a>
          <a href="#/expressions" className={`${btn.small} inline-flex items-center gap-1.5 no-underline`}>
            <Icon name="book" size={15} />
            表达本
          </a>
        </div>
      </div>
      {error ? (
        <p className="m-0 text-[15px] text-ink2">{error}</p>
      ) : !items ? (
        <p className="m-0 text-[14px] text-muted">正在加载……</p>
      ) : !items.length ? (
        <p className="m-0 text-[15px] leading-relaxed text-ink2">
          团队还没有选好文章，可以先读
          <a href={EXAMPLE} className="text-primary underline">
            示例文章
          </a>
          。
        </p>
      ) : (
        <ul className="m-0 grid list-none gap-3 p-0 sm:grid-cols-2">
          {items.map((x) => (
            <li key={x.id}>
              <a href={`/?h=${encodeURIComponent(x.id)}#/student`} className={`${card} flex min-h-[64px] items-center justify-between gap-3 px-4 py-3 text-ink no-underline hover:border-primary`}>
                <span className="font-serif text-[17px] leading-snug">{x.title}</span>
                <span className="shrink-0 text-[13px] text-primary">开始读</span>
              </a>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

// 我的文章（登录后）。会话过期（401）时刷新登录状态；问不到开没开放（连不上、出错）就当没开放，不放入口
function Mine() {
  const [items, setItems] = useState<LibraryItem[] | null>(null)
  const [error, setError] = useState('')
  const [enabled, setEnabled] = useState(false)
  useEffect(() => {
    getLibrary().then(setItems, (e: StudentError) => {
      setError(e.message)
      if (e.status === 401) void getStudent(true)
    })
    getUploadStatus().then(
      (s) => setEnabled(s.enabled),
      () => undefined,
    )
  }, [])
  if (!enabled && !items?.length) return null
  return (
    <section className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="m-0 text-[20px] font-bold">我的文章</h2>
        {enabled && (
          <a href="#/new" className={`${btn.small} inline-flex items-center no-underline`}>
            贴一篇文章
          </a>
        )}
      </div>
      {error ? (
        <p className="m-0 text-[15px] text-ink2">{error}</p>
      ) : !items ? (
        <p className="m-0 text-[14px] text-muted">正在加载……</p>
      ) : !items.length ? (
        <p className="m-0 text-[15px] leading-relaxed text-ink2">还没有贴过文章。想读哪篇英文文章，点「贴一篇文章」把原文贴进来。</p>
      ) : (
        <ul className="m-0 grid list-none gap-3 p-0 sm:grid-cols-2">
          {items.map((x) => (
            <li key={x.id}>
              <a href={`/?h=${encodeURIComponent(x.id)}#/student`} className={`${card} flex min-h-[64px] items-center justify-between gap-3 px-4 py-3 text-ink no-underline hover:border-primary`}>
                <span className="min-w-0 font-serif text-[17px] leading-snug [overflow-wrap:anywhere]">{x.title || '没有标题的文章'}</span>
                <span className="shrink-0 text-[13px] text-primary">开始读</span>
              </a>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

export default function Home() {
  const [how, setHow] = useState(false) // 「知适是怎么做的」默认收起
  const { loading, student } = useStudentMe()

  return (
    <div className="flex min-h-screen flex-col bg-ground">
      <SiteHeader actions={<StudentBar />} />

      <main className="mx-auto flex w-full max-w-6xl flex-1 flex-col gap-10 px-4 py-8 sm:px-8 lg:gap-14 lg:py-14">
        {student && <Shelf />}
        {student && <Mine />}
        <section className="grid items-center gap-8 lg:grid-cols-[1.1fr_1fr] lg:gap-14">
          <div className="flex flex-col gap-4">
            <span className="text-[13px] font-semibold tracking-wider text-primary">英文外刊精读</span>
            <h1 className="m-0 text-[28px] font-bold leading-tight lg:text-[44px]">
              读英文外刊，
              <br />
              卡住才给提示
            </h1>
            <p className="m-0 text-[16px] leading-relaxed text-ink2 lg:text-[18px]">
              知适帮你精读英文文章：哪一句读不懂，就一步一步给提示，读懂了就收起。读完有一篇小结，列出还没答对的句子和这一篇的生词。
            </p>
            <p className="m-0 text-[14px] leading-relaxed text-muted">
              同一篇文章，原文一字不改，每个人拿到<span className="whitespace-nowrap">写给自己的提示。</span>
            </p>
            <p className="m-0 flex items-center gap-2 self-start rounded-xl border border-line bg-surface px-4 py-3 text-[14px] text-ink2">
              <Icon name="info" className="text-muted" />
              知适正在小范围内测，只能用邀请码注册。
            </p>
            {!loading && !student && (
              <div className="flex flex-col gap-2">
                <div className="flex flex-wrap gap-3">
                  <a href="#/me" className={`${btn.primary} inline-flex items-center no-underline`}>
                    登录
                  </a>
                  <a href={EXAMPLE} className={`${btn.secondary} inline-flex items-center no-underline`}>
                    先读一篇示例文章
                  </a>
                </div>
                <span className="text-[13px] text-muted">收到邀请码的同学点「登录」，在那里注册。示例文章不用登录，作答只存在这台设备上。</span>
              </div>
            )}
          </div>
          <figure className={`${card} m-0 flex flex-col gap-3 p-5 lg:p-6`}>
            <figcaption className="text-[13px] text-muted">原文（一字不改）</figcaption>
            {/* 迷你讲义 S03 和它的提示第 1、2 步（tests/fixtures/mini-handout.ts） */}
            <p className="m-0 font-serif text-[17px] leading-relaxed">Yet, pending clearer evidence, a blanket ban may prove counterproductive.</p>
            <div className="flex flex-col gap-1.5 rounded-xl bg-ground px-4 py-3">
              <span className="flex items-center gap-2 text-[13px] text-ink2">
                <Pill tone="primary">提示第 1 步</Pill>谁 → 做了什么
              </span>
              <p className="m-0 font-serif text-[16px]">
                <strong>a blanket ban</strong> → <strong>may prove</strong>
              </p>
            </div>
            <div className="flex flex-col gap-1.5 rounded-xl bg-ground px-4 py-3">
              <span className="flex items-center gap-2 text-[13px] text-ink2">
                <Pill tone="primary">提示第 2 步</Pill>换成正常语序
              </span>
              <p className="m-0 font-serif text-[16px] leading-relaxed">Yet a blanket ban may prove counterproductive, pending clearer evidence.</p>
            </div>
            <span className="text-[13px] text-muted">还卡着，再点一步；读懂了就收起。</span>
          </figure>
        </section>

        <section className="flex flex-col gap-4">
          <button type="button" aria-expanded={how} onClick={() => setHow(!how)} className="flex min-h-[36px] items-center gap-1.5 self-start text-[15px] font-semibold text-primary">
            知适是怎么做的
            <span aria-hidden="true" className={`transition-transform ${how ? 'rotate-180' : ''}`}>
              ▾
            </span>
          </button>
          {how && (
            <div className="grid gap-4 lg:grid-cols-3">
              {STEPS.map((s) => (
                <div key={s.n} className="flex gap-3">
                  <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary-light text-[14px] font-bold text-primary">{s.n}</span>
                  <div className="flex flex-col gap-1">
                    <span className="text-[16px] font-semibold">{s.title}</span>
                    <span className="text-[14px] leading-relaxed text-ink2">{s.desc}</span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>
      </main>

      <footer className="border-t border-line">
        <div className="mx-auto flex max-w-6xl flex-col gap-2 px-4 py-5 text-[13px] text-muted sm:px-8">
          <span className="flex items-start gap-2 text-ink2">
            <Icon name="cheese" className="text-amber" />
            知适读作「芝士」：知道每个学生卡在哪，再给刚好适合的那一点帮助。
          </span>
          <span>杭州学军中学「回响 · 48H 青年创造营」Echo 赛道作品</span>
          {/* 老师端关闭之前留着：已有的老师不一定存了书签 */}
          <a href="#/upload" className="inline-flex min-h-[36px] items-center self-start text-muted hover:underline">
            老师登录
          </a>
        </div>
      </footer>
    </div>
  )
}
