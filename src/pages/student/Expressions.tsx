// #/expressions 表达本（要登录）：读过的每一篇里收进表达本的表达（收了又移出的不算），服务器从这个账号的事件推算，本机不另存。
// 按文章分组，最近收过的那一篇在上面；每条显示表达、中文（AI 生成的带标签）、原文例句（表达加粗，和写作页同一个 Example），出处是这一组的文章，可以点开。
// 可以「移出表达本」（drop_expression，handoutId 是那一篇）；之后打开那一篇时表达本以服务器为准，句卡上变回「收进表达本」
import { useState } from 'react'
import { Example } from '../../components/Example'
import { NotebookPage, NotebookStatus, articleHref, useNotebook } from '../../components/NotebookPage'
import { AiTag, btn, card } from '../../components/ui'
import type { NotebookExpression } from '../../lib/student-auth'

// 按文章分组：组按最近一次收的时间从新到旧，组里按收的先后
export function byArticle(list: NotebookExpression[]): { handoutId: string; title: string; items: NotebookExpression[] }[] {
  const groups = new Map<string, NotebookExpression[]>()
  for (const e of [...list].sort((a, b) => a.ts - b.ts)) groups.set(e.handoutId, [...(groups.get(e.handoutId) ?? []), e])
  return [...groups.values()]
    .sort((a, b) => b[b.length - 1].ts - a[a.length - 1].ts)
    .map((items) => ({ handoutId: items[0].handoutId, title: items[0].title, items }))
}

export default function ExpressionsPage() {
  return (
    <NotebookPage label="表达本" here="#/expressions">
      {(me) => <Expressions sid={me.sid} />}
    </NotebookPage>
  )
}

function Expressions({ sid }: { sid: string }) {
  const { data, error, unsent, record, refresh, update } = useNotebook(sid)
  const [notice, setNotice] = useState('')
  const drop = (e: NotebookExpression) => {
    record({ handoutId: e.handoutId, type: 'drop_expression', value: e.id })
    update((n) => ({ ...n, expressions: n.expressions.filter((x) => !(x.handoutId === e.handoutId && x.id === e.id)) }))
    setNotice(`移出了「${e.text}」。想收回来，在那一篇的精读里再点「收进表达本」。`)
    void refresh()
  }
  const groups = data ? byArticle(data.expressions) : []

  return (
    <>
      <h1 className="m-0 text-[22px] font-bold">表达本</h1>
      <p className="m-0 text-[15px] leading-relaxed text-ink2">读团队选的文章时收进表达本的表达都在这里，按文章分开，写作时用得上。</p>
      <NotebookStatus data={data} error={error} unsent={unsent} />
      {notice && (
        <p role="status" className="m-0 text-[14px] text-ink2">
          {notice}
        </p>
      )}
      {data && !groups.length && (
        <section className={`${card} flex flex-col items-start gap-3 p-4`}>
          <p className="m-0 text-[15px] leading-relaxed">表达本还是空的。读团队选的文章时点「收进表达本」，表达会攒在这里。</p>
          <a href="#/" className={`${btn.secondary} inline-flex items-center no-underline`}>
            去选一篇文章
          </a>
        </section>
      )}
      {groups.map((g) => (
        <section key={g.handoutId} className={`${card} flex flex-col px-4 py-3.5`}>
          <span className="text-[12px] text-muted">出自</span>
          <a href={articleHref(g.handoutId)} className="font-serif text-[17px] leading-snug text-primary underline [overflow-wrap:anywhere]">
            {g.title}
          </a>
          {g.items.map((e) => (
            <div key={e.id} className="mt-3 flex flex-col gap-1 border-t border-line-soft pt-3">
              <span className="font-serif text-[17px] font-semibold">{e.text}</span>
              <span className="text-[14px] text-ink2">
                {e.zh}
                {e.ai && <AiTag className="ml-1.5 align-[1px]" />}
              </span>
              {e.example && (
                <>
                  <span className="text-[12px] text-muted">原文例句</span>
                  <p className="m-0 font-serif text-[16px] leading-relaxed">
                    <Example text={e.example} pattern={e.pattern} />
                  </p>
                </>
              )}
              <button type="button" onClick={() => drop(e)} className="flex min-h-[36px] items-center self-start text-[13px] text-muted underline hover:text-ink">
                移出表达本
              </button>
            </div>
          ))}
        </section>
      ))}
    </>
  )
}
