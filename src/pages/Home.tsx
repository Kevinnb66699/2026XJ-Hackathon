// #/ 入口：选学生 / 老师 / 评委模式
import { card } from '../components/ui'

const MODES = [
  { href: '#/student', title: '我是学生', desc: '问卷 → 粗读 → 学生词 → 精读 → 写作 → 反馈' },
  { href: '#/teacher', title: '我是老师', desc: '今天点评这几个人，全班卡在哪几句' },
  { href: '#/judge', title: '我是评委', desc: '3 道题，马上看到「你的这一份」' },
]

export default function Home() {
  return (
    <div className="min-h-screen bg-ground">
      <header className="flex h-14 items-center border-b border-line bg-surface px-4">
        <span className="text-[18px] font-bold tracking-wider">知适</span>
      </header>
      <main className="mx-auto flex max-w-3xl flex-col gap-6 px-4 py-8">
        <div className="flex flex-col gap-2">
          <h1 className="m-0 text-[24px] font-bold leading-snug">同一份讲义，原文一字不改，每个人拿到写给自己的梯子</h1>
          <p className="m-0 text-[15px] text-ink2">把讲义里的「如果」，改成「你」。</p>
        </div>
        <div className="grid gap-3 sm:grid-cols-3">
          {MODES.map((m) => (
            <a key={m.href} href={m.href} className={`${card} flex min-h-[120px] flex-col gap-2 p-5 no-underline hover:border-primary`}>
              <span className="text-[18px] font-bold text-primary">{m.title}</span>
              <span className="text-[14px] leading-relaxed text-ink2">{m.desc}</span>
            </a>
          ))}
        </div>
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
    </div>
  )
}
