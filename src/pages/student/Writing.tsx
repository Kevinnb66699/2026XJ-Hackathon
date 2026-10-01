// ⑤ 写作：用表达本里的表达和老师要求的表达写 2-3 句。
// 先用规则逐个显示「用上了 / 还没用上」，再请 AI 判断用得对不对；AI 只说对不对、引用原文例句，不替你改写。
import { useRef, useState } from 'react'
import type { Handout } from '../../../shared/schema'
import { expressionUsed } from '../../engine'
import { btn, card } from '../../components/ui'
import type { Act } from '../../lib/store'
import { checkWriting, exampleOf, type CheckResult } from '../../lib/writing'

type Ai = 'loading' | 'off' | CheckResult[]

export function Writing({ h, ids, act, onNext }: { h: Handout; ids: string[]; act: Act; onNext: () => void }) {
  const exprs = ids.flatMap((id) => h.expressions.filter((e) => e.id === id))
  const required = new Set(h.writing.requiredExpressionIds)
  const [text, setText] = useState('')
  const [used, setUsed] = useState<Record<string, boolean> | null>(null)
  const [ai, setAi] = useState<Ai>('loading')
  const run = useRef(0)

  const submit = async () => {
    const t = text.trim()
    const n = ++run.current
    setUsed(Object.fromEntries(exprs.map((e) => [e.id, expressionUsed(t, e.pattern)])))
    setAi('loading')
    act({ type: 'writing_submit', value: t.slice(0, 1000) })
    const res = await checkWriting(h, t, exprs.map((e) => e.id))
    if (n === run.current) setAi(res ?? 'off')
  }

  const chips = (list: typeof exprs, strong: boolean) => (
    <div className="flex flex-wrap gap-2">
      {list.map((e) => (
        <span key={e.id} className={`rounded-full px-3 py-1.5 font-serif text-[15px] ${strong ? 'bg-blue-light text-blue' : 'border border-line bg-surface'}`}>
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

      <label htmlFor="essay" className="text-[14px] font-semibold">
        你的句子
      </label>
      <textarea
        id="essay"
        rows={5}
        value={text}
        onChange={(e) => setText(e.target.value)}
        className="w-full resize-none rounded-xl border border-line-strong bg-surface p-3 font-serif text-[18px] leading-relaxed"
      />
      <button type="button" className={btn.primary} disabled={!text.trim()} onClick={submit}>
        {used ? '改好了，再检查一次' : '检查一下'}
      </button>

      {used && (
        <section className={`${card} flex flex-col px-4 py-1.5`}>
          {exprs.map((e) => {
            const r = Array.isArray(ai) ? ai.find((x) => x.id === e.id) : undefined
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
      {used && ai === 'loading' && <p className="m-0 text-[13px] text-muted">AI 正在看你用得对不对……</p>}
      {used && ai === 'off' && <p className="m-0 text-[13px] text-muted">AI 检查暂时不可用，上面只显示有没有用上。</p>}
      <p className="m-0 text-[12px] text-muted">AI 只告诉你用得对不对，不替你改写。</p>

      {used && (
        <button type="button" className={btn.secondary} onClick={onNext}>
          写完了，去反馈
        </button>
      )}
    </>
  )
}
