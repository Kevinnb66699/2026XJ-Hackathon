// #/records 学习记录（要登录）：团队选的文章里动过手的每一篇一行，最近读的在上面。服务器从这个账号的事件推算（GET /api/student/records，lib/notebook 的 buildRecords），本机不另存。
// 每行只有标题、最近一次读的日期（北京时间）、自己选的难度（选过才有）和一句不带数字的状态（还有没答的句子 / 都答过了）。
// 列表里不放任何数字：答了几句、不认识的词有几个、合计、图表都不放，几行连着看会被读成「这篇比上篇好」；数字只在点进去的那篇小结里有。
// 文章之间整页跳转（讲义是整页加载时定下的）：「看小结」带 step=summary，小结页原样复用；还有没答的句子时「接着读」带 jump，跳到精读里第一句没答的。
// 都答过了只有「看小结」：答过、还不对的句子，小结页上有自己的「接着读」
import { useEffect, useState } from 'react'
import { NotebookPage, NotebookStatus } from '../../components/NotebookPage'
import { btn, card } from '../../components/ui'
import { drain } from '../../lib/events'
import { getRecords, getStudent, type StudentError, type StudyRecord } from '../../lib/student-auth'

// 北京时间的日期，如「2026 年 11 月 7 日」（设备的时区不一定是北京）
export const bjDate = (ts: number) => {
  const d = new Date(ts + 8 * 3600 * 1000)
  return `${d.getUTCFullYear()} 年 ${d.getUTCMonth() + 1} 月 ${d.getUTCDate()} 日`
}

const STATUS: Record<StudyRecord['status'], string> = { todo: '还有没答的句子', done: '都答过了' }

// 整页打开这一篇，落到指定的地方（Student.tsx 的 fromLink 认 step、jump）
export const summaryHref = (r: StudyRecord) => `/?h=${encodeURIComponent(r.handoutId)}&step=summary#/student`
export const resumeHref = (r: StudyRecord, sentenceId: string) => `/?h=${encodeURIComponent(r.handoutId)}&jump=${encodeURIComponent(sentenceId)}#/student`

export default function RecordsPage() {
  return (
    <NotebookPage label="学习记录" here="#/records">
      {(me) => <Records sid={me.sid} />}
    </NotebookPage>
  )
}

// 打开时先把这个账号排着的作答发完再拉（发不完也拉，页面上说明）；发不完、拉的时候回 401 都重新问一次登录状态，会话过期了页面换成登录入口
function Records({ sid }: { sid: string }) {
  const [data, setData] = useState<StudyRecord[] | null>(null)
  const [error, setError] = useState('')
  const [unsent, setUnsent] = useState(false)
  useEffect(() => {
    let alive = true
    void (async () => {
      const sent = await drain(sid)
      if (!alive) return
      setUnsent(!sent)
      if (!sent) void getStudent(true)
      await getRecords().then(
        (list) => {
          if (alive) setData(list)
        },
        (e: StudentError) => {
          if (e.status === 401) void getStudent(true)
          if (alive) setError(e.message)
        },
      )
    })()
    return () => {
      alive = false
    }
  }, [sid])

  return (
    <>
      <h1 className="m-0 text-[22px] font-bold">学习记录</h1>
      <p className="m-0 text-[15px] leading-relaxed text-ink2">读团队选的文章和自己贴的文章时动过手的每一篇都在这里，最近读的在上面。点「看小结」，看那一篇是怎么读的。</p>
      <NotebookStatus data={data} error={error} unsent={unsent} />
      {data && !data.length && (
        <section className={`${card} flex flex-col items-start gap-3 p-4`}>
          <p className="m-0 text-[15px] leading-relaxed">学习记录还是空的。读团队选的文章和自己贴的文章时答了题、点了词，那一篇就会列在这里。</p>
          <a href="#/" className={`${btn.secondary} inline-flex items-center no-underline`}>
            去选一篇文章
          </a>
        </section>
      )}
      {data?.map((r) => (
        <section key={r.handoutId} className={`${card} flex flex-col gap-1.5 px-4 py-3.5`}>
          <span className="font-serif text-[17px] leading-snug [overflow-wrap:anywhere]">{r.title}</span>
          <span className="text-[13px] text-muted">最近一次读：{bjDate(r.lastTs)}</span>
          {r.rating && <span className="text-[13px] text-muted">你选的难度：{r.rating}</span>}
          <span className="text-[14px] text-ink2">{STATUS[r.status]}</span>
          <div className="flex flex-wrap gap-2 pt-1.5">
            <a href={summaryHref(r)} className={`${btn.small} inline-flex items-center no-underline`}>
              看小结
            </a>
            {r.status === 'todo' && r.firstPending && (
              <a href={resumeHref(r, r.firstPending)} className={`${btn.small} inline-flex items-center no-underline`}>
                接着读
              </a>
            )}
          </div>
        </section>
      ))}
    </>
  )
}
