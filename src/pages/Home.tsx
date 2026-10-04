// #/ 入口：标语下面一句大白话说清知适是什么、给谁用，再一行浅色的原标语，再下面两张大卡片入口（手机第一屏能看到）：我是学生 / 我是老师。电脑上左右两栏，手机上从上到下
// 「知适是怎么做的」三条默认收起（和宣传材料重复）
// 「我是学生」进完整的学生流程。比赛期间的演示模式开关（切到评委模式的 3 道快题）10-04 随评委模式一起下线；底部的「演示画像 同学 A / B」按钮也去掉了，链接 #/student?seed=demo&p=A|B 照旧能用（给老师演示时直接发）
import { useState } from 'react'
import { Icon, SiteHeader, card } from '../components/ui'


const STEPS = [
  { n: '1', title: '原文一字不改', desc: '老师的讲义和目标一个不少：重点句、核心词、写作要求都在。' },
  { n: '2', title: '卡住才搭梯子，读懂就撤', desc: '谁 → 做了什么 → 拆开每一块 → 译文，一步一步给；读懂过的同类句子，下次先自己试。' },
  { n: '3', title: '全班卡点回响给老师', desc: '每句有多少人卡住、卡在词还是句子，汇成热力图和「今天点评这几个人」。' },
]

// 两个入口卡片：名字大字，下面一行说明
const entry = 'flex min-h-[88px] flex-col justify-start gap-1 rounded-2xl border-2 px-5 py-4 no-underline lg:min-h-[112px]'
const entryName = 'flex items-center justify-between gap-2 text-[20px] font-bold lg:text-[24px]'

export default function Home() {
  const [how, setHow] = useState(false) // 「知适是怎么做的」默认收起

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
            <p className="m-0 text-[14px] leading-relaxed text-muted">
              同一份讲义，原文一字不改，每个人拿到<span className="whitespace-nowrap">写给自己的梯子。</span>
            </p>
            <div className="grid gap-3 pt-2 sm:grid-cols-2">
              <a href="#/student" className={`${entry} border-transparent bg-primary text-white hover:bg-primary-hover`}>
                <span className={entryName}>
                  我是学生 <span aria-hidden="true">→</span>
                </span>
                <span className="text-[14px] leading-snug text-primary-light">读讲义，卡住时一步步给提示</span>
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
          </div>
          <figure className={`${card} m-0 flex flex-col gap-3 p-5 lg:p-6`}>
            <figcaption className="text-[13px] text-muted">讲义（全班同一份 PDF）</figcaption>
            <p className="m-0 rounded-xl bg-ground px-4 py-3 text-[15px] leading-relaxed text-ink2">
              {/* 迷你讲义 S03 的老师讲解原话。末尾一段不拆行：最后一行不会只剩「难。」」 */}
              「<strong className="text-ink">如果</strong>对 pending 一词不够熟悉，可能会<span className="whitespace-nowrap">造成理解困难。」</span>
            </p>
            <span className="text-[13px] text-muted">知适（写给你的那一份）</span>
            <div className="flex gap-3 rounded-xl border border-dashed border-note-line bg-note px-4 py-3">
              <Icon name="pin" className="mt-0.5 text-amber" />
              <p className="m-0 text-[15px] leading-relaxed">
                <span className="font-semibold text-amber-dark">给你：</span>
                <strong>你</strong>把 pending 标成了「不认识」。老师讲义里写的那句「如果」，刚好戳中了你。
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
      </main>

      <footer className="border-t border-line">
        <div className="mx-auto max-w-6xl px-4 py-5 text-[13px] text-muted sm:px-8">杭州学军中学「回响 · 48H 青年创造营」Echo 赛道作品</div>
      </footer>
    </div>
  )
}
