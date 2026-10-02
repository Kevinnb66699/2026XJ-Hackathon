// #/ 入口：标语下面一句大白话说清知适是什么、给谁用，再下面两张大卡片入口（手机第一屏能看到）：我是学生 / 我是老师。电脑上左右两栏，手机上从上到下
// 「知适是怎么做的」三条默认收起（和宣传材料重复）
// 演示模式（比赛期间默认开，存在这个浏览器里；微信和 Safari 各记各的）：「我是学生」直接进评委模式的 3 道快题；关掉就是完整的学生流程
import { useState } from 'react'
import { Icon, SiteHeader, card } from '../components/ui'

const DEMO_KEY = 'zhishi:demo-mode'
let memDemo = true // 存不了时的备份：离开首页再回来也不丢

function readDemo(): boolean {
  try {
    return localStorage.getItem(DEMO_KEY) !== 'off'
  } catch {
    return memDemo
  }
}

const STEPS = [
  { n: '1', title: '原文一字不改', desc: '老师的讲义和目标一个不少：打卡句、核心词、写作要求都在。' },
  { n: '2', title: '卡住才搭梯子，读懂就撤', desc: '谁 → 做了什么 → 拆开每一块 → 译文，一步一步给；读懂过的同类句子，下次先自己试。' },
  { n: '3', title: '全班卡点回响给老师', desc: '每句有多少人卡住、卡在词还是句子，汇成热力图和「今天点评这几个人」。' },
]

// 两个入口卡片：名字大字，下面一行说明
const entry = 'flex min-h-[88px] flex-col justify-center gap-1 rounded-2xl border-2 px-5 py-4 no-underline lg:min-h-[112px]'
const entryName = 'flex items-center justify-between gap-2 text-[20px] font-bold lg:text-[24px]'

export default function Home() {
  const [demo, setDemo] = useState(readDemo)
  const [how, setHow] = useState(false) // 「知适是怎么做的」默认收起
  const toggleDemo = () => {
    const next = !demo
    setDemo(next)
    memDemo = next
    try {
      localStorage.setItem(DEMO_KEY, next ? 'on' : 'off')
    } catch {
      // 存不了就只在这次打开网页期间有效
    }
  }

  return (
    <div className="flex min-h-screen flex-col bg-ground">
      <SiteHeader />

      <main className="mx-auto flex w-full max-w-6xl flex-1 flex-col gap-10 px-4 py-8 sm:px-8 lg:gap-14 lg:py-14">
        <section className="grid items-center gap-8 lg:grid-cols-[1.1fr_1fr] lg:gap-14">
          <div className="flex flex-col gap-4">
            <span className="text-[13px] font-semibold tracking-wider text-primary">英文外刊精读</span>
            <h1 className="m-0 text-[28px] font-bold leading-tight lg:text-[44px]">
              把讲义里的「如果」，
              <br />
              改成「你」
            </h1>
            <p className="m-0 text-[16px] leading-relaxed text-ink2 lg:text-[18px]">
              知适是一个读英文外刊讲义的工具：学生读老师的讲义，卡住时一步一步给提示；老师看到全班卡在哪、今天该点评谁。
            </p>
            <div className="grid gap-3 pt-2 sm:grid-cols-2">
              <a href={demo ? '#/judge' : '#/student'} className={`${entry} border-transparent bg-primary text-white hover:bg-primary-hover`}>
                <span className={entryName}>
                  我是学生 <span aria-hidden="true">→</span>
                </span>
                <span className="text-[14px] leading-snug text-primary-light">读讲义，卡住时一步一步给提示</span>
              </a>
              <a href="#/teacher" className={`${entry} border-primary bg-surface text-primary hover:bg-primary-light`}>
                <span className={entryName}>
                  我是老师 <span aria-hidden="true">→</span>
                </span>
                <span className="text-[14px] leading-snug text-ink2">看全班卡在哪、今天点评谁</span>
              </a>
              {/* 电脑上排在「我是老师」正下方，手机上跟在它后面 */}
              <a href="#/upload" className="inline-flex min-h-[36px] items-center justify-self-end text-[14px] text-primary sm:col-start-2">
                上传一篇文章 →
              </a>
            </div>
            <div className="flex items-start gap-3">
              <button type="button" role="switch" aria-checked={demo} onClick={toggleDemo} className="flex min-h-[36px] shrink-0 items-center gap-2 text-[14px] font-semibold text-ink">
                <span aria-hidden="true" className={`relative h-6 w-10 rounded-full transition-colors ${demo ? 'bg-primary' : 'bg-line-strong'}`}>
                  <span className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-[left] ${demo ? 'left-[18px]' : 'left-0.5'}`} />
                </span>
                演示模式
              </button>
              <span className="pt-2 text-[13px] leading-relaxed text-ink2">
                {demo ? '开：「我是学生」先做 3 道快题，马上看到写给你的那一份。' : '关：「我是学生」走完整流程：问卷 → 粗读 → 词汇 → 精读 → 写作 → 反馈。'}
              </span>
            </div>
          </div>
          <figure className={`${card} m-0 flex flex-col gap-3 p-5 lg:p-6`}>
            <figcaption className="text-[13px] text-muted">讲义（全班同一份 PDF）</figcaption>
            <p className="m-0 rounded-xl bg-ground px-4 py-3 text-[15px] leading-relaxed text-ink2">
              {/* 末尾一段不拆行：电脑上最后一行不会只剩「思。」」 */}
              「<strong className="text-ink">如果</strong>不认识 fret 一词，很大概率可能会<span className="whitespace-nowrap">不理解本句话的意思。」</span>
            </p>
            <span className="text-[13px] text-muted">知适（写给你的那一份）</span>
            <div className="flex gap-3 rounded-xl border border-dashed border-note-line bg-note px-4 py-3">
              <Icon name="pin" className="mt-0.5 text-amber" />
              <p className="m-0 text-[15px] leading-relaxed">
                <span className="font-semibold text-amber-dark">给你：</span>
                <strong>你</strong>把 fret 标成了「不认识」。老师讲义里写的那句「如果」，刚好戳中了你。
              </p>
            </div>
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

        <div className="flex flex-wrap items-center gap-2 text-[14px] text-ink2">
          <span>演示画像：</span>
          <a href="#/student?seed=demo&p=A" className="rounded-full border border-line bg-surface px-3 py-1.5 text-primary">
            同学 A
          </a>
          <a href="#/student?seed=demo&p=B" className="rounded-full border border-line bg-surface px-3 py-1.5 text-primary">
            同学 B
          </a>
        </div>
      </main>

      <footer className="border-t border-line">
        <div className="mx-auto max-w-6xl px-4 py-5 text-[13px] text-muted sm:px-8">杭州学军中学「回响 · 48H 青年创造营」Echo 赛道作品</div>
      </footer>
    </div>
  )
}
