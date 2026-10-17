// ⑤ 写作（10-16 起选做：推广时学生说写作有压力）：10-17 起上面先列出这篇要学的表达（老师要求的在前，再是表达本里的），
// 每个带中文和原文例句（学生说不如看例句），只看不写也行；想写的用这些表达写 2-3 句，不想写可以直接去小结。
// 先用规则逐个显示「用上了 / 还没用上」，再请 AI 判断用得对不对、指出最多 3 处可能写错的地方；
// AI 只说对不对、引用原文例句，写错的地方只引你写的几个词、说是哪一类，不替你改写。这一栏的标题和说明也不用术语（见 shared/terms.ts）。
// 写的句子存在本机（按讲义和学生），切到别的步骤再回来还在；检查结果不存。
// 原文不进服务器的记录：提交只记一条不带原文的 writing_submit 事件（老师端只数写作人数）；检查时原文转给 AI，后端不落盘。
// 没选学号、老师关了这个学号的 AI 时（noAi 是给学生看的说明）不请 AI，原文不发出去，只显示「用上了 / 还没用上」。
// 会发给 AI 时，先查写的内容里有没有手机号、身份证号、邮箱（privateInfo）：有就不发、不记 writing_submit，提醒删掉再检查。
// 讲义有 structure 时，写之前给「可以借的写法」：怎么写 + 原文里的例句（原话）。
import { useRef, useState } from 'react'
import type { Handout } from '../../../shared/schema'
import { expressionUsed } from '../../engine'
import { Pill, btn, card } from '../../components/ui'
import { readLS, writeLS, type Act } from '../../lib/store'
import { checkWriting, exampleOf, privateInfo, type CheckOutput } from '../../lib/writing'

type Ai = 'loading' | 'off' | CheckOutput

export const writingKey = (hid: string, sid: string) => `zhishi:writing:${hid}:${sid}`

export function Writing({ h, sid, ids, noAi, act, onNext }: { h: Handout; sid: string; ids: string[]; noAi: string | null; act: Act; onNext: () => void }) {
  const exprs = ids.flatMap((id) => h.expressions.filter((e) => e.id === id))
  const required = new Set(h.writing.requiredExpressionIds)
  const [text, setText] = useState(() => readLS(writingKey(h.id, sid)) ?? '')
  const [used, setUsed] = useState<Record<string, boolean> | null>(null)
  const [ai, setAi] = useState<Ai>('loading')
  const [leak, setLeak] = useState<string[]>([]) // 这次没发出去：写的内容里像有私人信息
  const run = useRef(0)

  const submit = async () => {
    const t = text.trim()
    // 会发给 AI 才查；发现了就到此为止（不动 run，上一次还没回来的 AI 结果照常显示）
    const found = noAi ? [] : privateInfo(t)
    setLeak(found)
    if (found.length) return
    const n = ++run.current
    setUsed(Object.fromEntries(exprs.map((e) => [e.id, expressionUsed(t, e.pattern)])))
    act({ type: 'writing_submit' })
    // 不请 AI：ai 也改掉，免得之后 AI 改成开着（后台确认回来）时一直显示「AI 正在看」，那时显示「暂时不可用」
    if (noAi) return setAi('off')
    setAi('loading')
    const res = await checkWriting(h, t, exprs.map((e) => e.id), sid)
    if (n === run.current) setAi(res ?? 'off')
  }

  const shown = [...exprs].sort((a, b) => Number(required.has(b.id)) - Number(required.has(a.id))) // 老师要求的排前面，其余照原来的先后

  return (
    <>
      {exprs.length > 0 && (
        <section className={`${card} flex flex-col gap-3 px-4 py-3.5`}>
          <h2 className="m-0 text-[16px] font-bold">这篇要学的表达</h2>
          {shown.map((e) => (
            <div key={e.id} className="flex flex-col gap-1 border-t border-line-soft pt-3">
              <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                <span className="font-serif text-[17px] font-semibold">{e.text}</span>
                <span className="text-[14px] text-ink2">{e.zh}</span>
                {/* 不是老师要求的，就是表达本里收的 */}
                <Pill tone={required.has(e.id) ? 'primary' : 'gray'}>{required.has(e.id) ? '老师要求' : '你收的'}</Pill>
              </div>
              <span className="text-[12px] text-muted">原文例句</span>
              <p className="m-0 font-serif text-[16px] leading-relaxed">
                <Example text={exampleOf(h, e.id)} pattern={e.pattern} />
              </p>
            </div>
          ))}
        </section>
      )}

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

      <section className={`${card} flex flex-col gap-1.5 px-4 py-3.5 text-[15px] leading-relaxed`}>
        <span className="self-start">
          <Pill>选做</Pill>
        </span>
        {h.writing.prompt}
        <span className="text-[13px] text-ink2">想写就用上面的表达写 2–3 句，写完点「检查一下」；不想写，看完例句就可以去小结。</span>
      </section>

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
      {leak.length > 0 && (
        <p role="alert" className="m-0 rounded-xl bg-amber-soft px-4 py-3 text-[14px] leading-relaxed text-amber-dark">
          你写的内容里好像有{leak.join(' / ')}，请删掉再检查。
        </p>
      )}

      {used && (
        <section className={`${card} flex flex-col px-4 py-1.5`}>
          {exprs.map((e) => {
            const r = !noAi && typeof ai === 'object' ? ai.results.find((x) => x.id === e.id) : undefined
            const ok = r?.verdict === 'correct'
            return (
              <div key={e.id} className="flex flex-col gap-1 border-b border-line-soft py-3 last:border-b-0">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-serif text-[16px]">{e.text}</span>
                  {!used[e.id] ? (
                    <span className="shrink-0 text-[13px] text-muted">还没用上</span>
                  ) : (
                    <span className={`shrink-0 text-[13px] font-semibold ${r && !ok ? 'text-amber-dark' : 'text-green-dark'}`}>
                      用上了{r ? (ok ? ' · 用得对' : ' · 再看看用法') : ''}
                    </span>
                  )}
                </div>
                {used[e.id] && r && (
                  <span className="text-[13px] leading-relaxed text-ink2">
                    {r.reason}
                    {!ok && <span className="mt-1 block font-serif text-[15px] text-ink">原文例句：{exampleOf(h, e.id)}</span>}
                  </span>
                )}
              </div>
            )
          })}
        </section>
      )}
      {used && !noAi && ai === 'loading' && <p className="m-0 text-[13px] text-muted">AI 正在看你用得对不对、有没有写错……</p>}
      {used && !noAi && ai === 'off' && <p className="m-0 text-[13px] text-muted">AI 检查暂时不可用，上面只显示有没有用上。</p>}
      {used && !noAi && ai !== 'loading' && (
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
                  <span className="ml-2 text-[13px] font-semibold text-amber-dark">{g.type}</span>
                </span>
                {g.hint && <span className="text-[13px] leading-relaxed text-ink2">{g.hint}</span>}
              </div>
            ))
          )}
        </section>
      )}
      <p className="m-0 text-[12px] text-muted">{noAi ?? 'AI 只告诉你用得对不对、哪里可能写错了，不替你改写。'}</p>

      <button type="button" className={btn.secondary} onClick={onNext}>
        {used ? '写完了，去小结' : '这次不写，去小结'}
      </button>
    </>
  )
}

// 原文例句里把这个表达加粗：用和「用上了没有」同一条规则（pattern）去找，找不到就原样显示。
// 规则里 sth、doing 这类空位（{0,4}）是贪婪的，判断用没用上没关系，加粗会把后面好几个词也带上：显示时改成尽量少
function Example({ text, pattern }: { text: string; pattern: string }) {
  let m: RegExpExecArray | null = null
  try {
    m = new RegExp(pattern.replace(/\{0,(\d+)\}(?!\?)/g, '{0,$1}?'), 'i').exec(text)
  } catch {
    // 规则写坏了（和 expressionUsed 一样当找不到）
  }
  if (!m) return <>{text}</>
  return (
    <>
      {text.slice(0, m.index)}
      <strong>{m[0]}</strong>
      {text.slice(m.index + m[0].length)}
    </>
  )
}
