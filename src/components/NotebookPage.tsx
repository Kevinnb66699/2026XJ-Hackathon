// 单词本（#/notebook）、表达本（#/expressions）两页共用：要登录，没登录给登录入口，登录后回到这一页。
// 内容都是服务器从这个账号读过的每一篇的事件推算的（GET /api/student/notebook），本机不另存一份。
import { Fragment, useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { drain } from '../lib/events'
import { getNotebook, getStudent, loginHref, notebookEvent, useStudentMe, type Notebook, type Student, type StudentError } from '../lib/student-auth'
import StudentBar from './StudentBar'
import { SiteHeader, btn, card } from './ui'

// 整页打开一篇（讲义是整页加载时定下的）
export const articleHref = (handoutId: string) => `/?h=${encodeURIComponent(handoutId)}#/student`

export function NotebookPage({ label, here, children }: { label: string; here: string; children: (me: Student) => ReactNode }) {
  const { loading, student } = useStudentMe()
  return (
    <div className="min-h-screen bg-ground">
      <SiteHeader label={label} actions={<StudentBar />} />
      <main className="mx-auto flex max-w-2xl flex-col gap-4 px-4 pb-24 pt-5">
        {loading ? (
          <p className="m-0 text-[14px] text-muted">正在加载……</p>
        ) : student ? (
          <Fragment key={student.sid}>{children(student)}</Fragment>
        ) : (
          <section className={`${card} flex flex-col items-start gap-4 p-5`}>
            <p className="m-0 text-[16px] leading-relaxed">{label}记在账号上，登录后才能看。</p>
            <a href={loginHref(here)} className={`${btn.primary} inline-flex items-center no-underline`}>
              登录
            </a>
          </section>
        )}
      </main>
    </div>
  )
}

// 这个账号的单词本和表达本。打开时先把这个账号排着的动作发完再拉（发不完也拉，unsent 为真时页面上说明）。
// record：复习、移出进这个账号的事件队列。refresh：发完再拉一次；发不完就不拉，页面上先用自己改好的（update），免得服务器上的旧结果盖掉刚做的。
// 发不完、拉的时候回 401：都重新问一次登录状态，会话过期了页面就换成登录入口（登录后排着的会发出去）；只是连不上就还当登录着。
// seq：每次拉、每次页面上改都加一。拉回来时已经变了（后面又拉了，或者页面上刚改过），这次的结果和出错都不用，免得晚回来的旧结果盖掉刚改的
export function useNotebook(sid: string) {
  const [data, setData] = useState<Notebook | null>(null)
  const [error, setError] = useState('')
  const [unsent, setUnsent] = useState(false)
  const seq = useRef(0)

  const refresh = useCallback(
    async (always = false) => {
      const mine = ++seq.current
      const sent = await drain(sid)
      setUnsent(!sent)
      if (!sent) void getStudent(true)
      if (!sent && !always) return
      await getNotebook().then(
        (n) => {
          if (seq.current !== mine) return
          setData(n)
          setError('')
        },
        (e: StudentError) => {
          if (e.status === 401) void getStudent(true)
          if (seq.current !== mine) return
          setError(e.message)
        },
      )
    },
    [sid],
  )
  useEffect(() => {
    void refresh(true)
  }, [refresh])

  const record = useCallback((e: Parameters<typeof notebookEvent>[1]) => void notebookEvent(sid, e), [sid])
  const update = useCallback((fn: (n: Notebook) => Notebook) => {
    seq.current++
    setData((n) => n && fn(n))
  }, [])
  return { data, error, unsent, record, refresh, update }
}

// 加载中、出错、还有没发出去的：两页同样的几行说明。有内容时出错只说一行，内容照样显示
export function NotebookStatus({ data, error, unsent }: { data: Notebook | null; error: string; unsent: boolean }) {
  return (
    <>
      {!data && !error && <p className="m-0 text-[14px] text-muted">正在加载……</p>}
      {error && <p className={`m-0 text-[14px] ${data ? 'text-muted' : 'text-ink2'}`}>{error}</p>}
      {unsent && <p className="m-0 text-[13px] text-muted">有几条记录还没发出去，连上以后会自动发。</p>}
    </>
  )
}
