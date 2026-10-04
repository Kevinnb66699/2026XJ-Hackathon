// ⑤ 写作：用表达本里的表达和老师要求的表达写 2-3 句。
// 先用规则逐个显示「用上了 / 还没用上」，再请 AI 判断用得对不对、指出最多 3 处可能写错的地方；
// AI 只说对不对、引用原文例句，写错的地方只引你写的几个词、说是哪一类，不替你改写。这一栏的标题和说明也不用术语（见 shared/terms.ts）。
// 写的句子存在本机（按讲义和学生），切到别的步骤再回来还在；检查结果不存。
// 原文不进服务器的记录：提交只记一条不带原文的 writing_submit 事件（老师端只数写作人数）；检查时原文转给 AI，后端不落盘。
// 讲义有 structure 时，写之前给「可以借的写法」：怎么写 + 原文里的例句（原话）。
import { useRef, useState } from 'react'
import type { Handout } from '../../../shared/schema'
import { expressionUsed } from '../../engine'
import { Pill, btn, card } from '../../components/ui'
import { readLS, writeLS, type Act } from '../../lib/store'
import { checkWriting, exampleOf, type CheckOutput } from '../../lib/writing'

type Ai = 'loading' | 'off' | CheckOutput

export const writingKey = (hid: string, sid: string) => `zhishi:writing:${hid}:${sid}`

export function Writing({ h, sid, ids, act, onNext }: { h: Handout; sid: string; ids: string[]; act: Act; onNext: () => void }) {
  const exprs = ids.flatMap((id) => h.expressions.filter((e) => e.id === id))
  const required = new Set(h.writing.requiredExpressionIds)
  const [text, setText] = useState(() => readLS(writingKey(h.id, sid)) ?? '')
  const [used, setUsed] = useState<Record<string, boolean> | null>(null)
  const [ai, setAi] = useState<Ai>('loading')
  const run = useRef(0)

  const submit = async () => {
    const t = text.trim()
    const n = ++run.current
    setUsed(Object.fromEntries(exprs.map((e) => [e.id, expressionUsed(t, e.pattern)])))
    setAi('loading')
    act({ type: 'writing_submit' })
    const res = await checkWriting(h, t, exprs.map((e) => e.id), sid)
    if (n === run.current) setAi(res ?? 'off')
  }

  const chips = (list: typeof exprs, strong: boolean) => (
    <div className="flex flex-wrap gap-2">
      {list.map((e) => (
        <span key={e.id} className={`rounded-full px-3 py-1.5 font-serif text-[15px] ${strong ? 'bg-primary-light text-primary' : 'border border-line bg-surface'}`}>
          {e.text}
        </span>
      ))}
    </div>
  )
  const mine = exprs.filter((e) => !required.has(e.id)) // 不是老师要求的，就是表达本里收的

  return (
    <>
      <section className={`${card} px-4 py-3.5 text-[15px] leading-relaxed`}>{h.writing.prompt}</section>

      <div className="flex flex-col gap-2">
        <span className="text-[13px] text-ink2">老师要求</span>
        {chips(
          exprs.filter((e) => required.has(e.id)),
          true,
        )}
        {mine.length > 0 && (
          <>
            <span className="text-[13px] text-ink2">你的表达本</span>
            {chips(mine, false)}
          </>
        )}
      </div>

      {!!h.structure?.moves.length && (
        <section className={`${card} flex flex-col gap-3 px-4 py-3.5`}>
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="m-0 text-[15px] font-bold">可以借的写法</h2>
            <Pill>AI 起草，供参考</Pill>
          </div>
          {h.structure.moves.map((m) => (
            <div key={m.name} className="flex flex-col gap-1 border-t border-line-soft pt-3">
              <span className="text-[15px] font-semibold">{m.name}</span>
              <span className="text-[14px] leading-relaxed text-ink2">{m.how}</span>
              {m.examples.map((x) => (
                <span key={x.sentenceId} className="font-serif text-[15px] leading-relaxed">
                  “{x.quote}”
                  <span className="ml-1.5 whitespace-nowrap font-sans text-[12px] text-muted">原文第 {h.sentences.find((s) => s.id === x.sentenceId)?.paragraph} 段</span>
                </span>
              ))}
            </div>
          ))}
        </section>
      )}

      <label htmlFor="essay" className="text-[14px] font-semibold">
        你的句子
      </label>
      <textarea
        id="essay"
        rows={5}
        maxLength={1200}
        value={text}
        onChange={(e) => {
          setText(e.target.value)
          writeLS(writingKey(h.id, sid), e.target.value)
        }}
        className="w-full resize-none rounded-xl border border-line-strong bg-surface p-3 font-serif text-[18px] leading-relaxed"
      />
      <button type="button" className={btn.primary} disabled={!text.trim()} onClick={submit}>
        {used ? '改好了，再检查一次' : '检查一下'}
      </button>

      {used && (
        <section className={`${card} flex flex-col px-4 py-1.5`}>
          {exprs.map((e) => {
            const r = typeof ai === 'object' ? ai.results.find((x) => x.id === e.id) : undefined
            const ok = r?.verdict === 'correct'
            return (
              <div key={e.id} className="flex flex-col gap-1 border-b border-line-soft py-3 last:border-b-0">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-serif text-[16px]">{e.text}</span>
                  {!used[e.id] ? (
                    <span className="shrink-0 text-[13px] text-muted">还没用上</span>
                  ) : (
                    <span className={`shrink-0 text-[13px] font-semibold ${r && !ok ? 'text-amber' : 'text-green'}`}>
                      用上了{r ? (ok ? ' · 用得对' : ' · 再看看原文') : ''}
                    </span>
                  )}
                </div>
                {used[e.id] && r && (
                  <span className="text-[13px] leading-relaxed text-ink2">
                    {r.reason}
                    {!ok && <span className="mt-1 block font-serif text-[15px] text-ink">原文：{exampleOf(h, e.id)}</span>}
                  </span>
                )}
              </div>
            )
          })}
        </section>
      )}
      {used && ai === 'loading' && <p className="m-0 text-[13px] text-muted">AI 正在看你用得对不对、有没有写错……</p>}
      {used && ai === 'off' && <p className="m-0 text-[13px] text-muted">AI 检查暂时不可用，上面只显示有没有用上。</p>}
      {used && ai !== 'loading' && (
        <section className={`${card} flex flex-col gap-2 px-4 py-3`}>
          <span className="text-[13px] text-ink2">可能写错的地方（AI 检查，可能漏判或误判）</span>
          {ai === 'off' || !ai.grammar ? (
            <span className="text-[13px] text-muted">这一项这次没查成</span>
          ) : !ai.grammar.length ? (
            <span className="text-[13px] text-muted">AI 没发现明显写错的地方（不保证全对）</span>
          ) : (
            ai.grammar.map((g, i) => (
              <div key={i} className="flex flex-col gap-0.5">
                <span>
                  <span className="font-serif text-[16px]">“{g.quote}”</span>
                  <span className="ml-2 text-[13px] font-semibold text-amber">{g.type}</span>
                </span>
                {g.hint && <span className="text-[13px] leading-relaxed text-ink2">{g.hint}</span>}
              </div>
            ))
          )}
        </section>
      )}
      <p className="m-0 text-[12px] text-muted">AI 只告诉你用得对不对、哪里可能写错了，不替你改写。</p>

      {used && (
        <button type="button" className={btn.secondary} onClick={onNext}>
          写完了，去反馈
        </button>
      )}
    </>
  )
}
