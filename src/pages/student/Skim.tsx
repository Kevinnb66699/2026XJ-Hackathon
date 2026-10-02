// ② 粗读：原文一字不改，每个英文单词都能点（点一下 = 不认识，不查释义）。
// 先通读全文（老师 Day 1：「请快速通读全文」），读完再答每段一道引导问题：
// 答错一次，在题目下面给出这一段原文并标出主题句；再错给英文要点。
import { useMemo, useState } from 'react'
import type { Handout, Paragraph, Sentence } from '../../../shared/schema'
import type { StudentState } from '../../engine/types'
import { Choices, Icon, Pill, btn, card, serifText } from '../../components/ui'
import type { Act } from '../../lib/store'
import { tokenize } from '../../lib/text'

export function Skim({ h, state, act, onNext }: { h: Handout; state: StudentState; act: Act; onNext: () => void }) {
  const nums = useMemo(() => [...new Set(h.sentences.map((x) => x.paragraph))].sort((a, b) => a - b), [h])
  const paraOf = (n: number) => h.paragraphs.find((p) => p.n === n)
  const sentencesOf = (n: number) => h.sentences.filter((x) => x.paragraph === n)
  // 答过题再回到这一步，直接停在题目页
  const [phase, setPhase] = useState<'read' | 'quiz'>(() => (h.paragraphs.some((p) => state.answers[p.gist.id]) ? 'quiz' : 'read'))
  const [picked, setPicked] = useState<Record<number, number>>({})

  // 词形 → lemma（讲义词表里没有的词，就用小写原词）
  const lemmaOf = useMemo(() => {
    const m = new Map<string, string>()
    for (const w of h.words) for (const f of w.forms) m.set(f.toLowerCase(), w.lemma)
    return (t: string) => m.get(t.toLowerCase()) ?? t.toLowerCase()
  }, [h])
  const tapped = new Set(state.tappedWords)
  const toggle = (lemma: string) => act({ type: 'tap_word', lemma, ...(tapped.has(lemma) ? { value: 'off' } : {}) })
  const text = (n: number, className: string, highlight?: string) => (
    <ParagraphText sentences={sentencesOf(n)} className={className} highlight={highlight} tapped={tapped} lemmaOf={lemmaOf} onTap={toggle} />
  )

  const solved = (p: Paragraph | undefined) => !p || !!state.answers[p.gist.id]?.correct
  const solvedCount = nums.filter((n) => paraOf(n) && solved(paraOf(n))).length
  const total = nums.filter((n) => paraOf(n)).length
  const switchTo = (next: 'read' | 'quiz') => {
    setPhase(next)
    window.scrollTo(0, 0)
  }
  const answer = (p: Paragraph, i: number) => {
    setPicked({ ...picked, [p.n]: i })
    act({ type: 'gist_answer', paragraph: p.n, correct: i === p.gist.answer, firstTry: !state.answers[p.gist.id] })
  }

  if (phase === 'read') {
    return (
      <>
        <div className="flex items-center gap-2.5 rounded-xl bg-primary-light px-3.5 py-3 text-[14px] text-primary-hover">
          <Icon name="hand" />
          <span className="flex-1">遇到不认识的词点一下，不用查</span>
          <span className="font-semibold">已标记 {state.tappedWords.length} 个</span>
        </div>
        <span className="text-[13px] text-muted">先快速通读全文（共 {nums.length} 段），读完再答题</span>

        <article className={`${card} flex flex-col gap-5 px-4 py-[18px]`}>
          {nums.map((n) => (
            <div key={n} className="flex flex-col gap-1">
              <span className="text-[12px] text-muted">第 {n} 段</span>
              {text(n, serifText)}
            </div>
          ))}
        </article>

        <button type="button" className={btn.primary} onClick={() => switchTo('quiz')}>
          {h.paragraphs.some((p) => state.answers[p.gist.id]) ? '回到题目' : '读完了，去答题'}
        </button>
      </>
    )
  }

  return (
    <>
      <div className="flex items-center justify-between gap-2">
        <span className="text-[13px] text-muted">
          每段一道题，已答对 {solvedCount} / {total}
        </span>
        <button type="button" className={btn.small} onClick={() => switchTo('read')}>
          回看全文
        </button>
      </div>

      {nums.map((n) => {
        const para = paraOf(n)
        if (!para) return null
        const rec = state.answers[para.gist.id]
        const misses = rec ? rec.attempts - (rec.correct ? 1 : 0) : 0
        const done = !!rec?.correct
        return (
          <section key={n} className={`${card} flex flex-col gap-2.5 p-4`}>
            <span className="self-start">
              <Pill>第 {n} 段</Pill>
            </span>
            <h2 className="m-0 text-[16px] font-bold">{para.gist.prompt}</h2>
            <Choices options={para.gist.options} answer={para.gist.answer} picked={picked[n] ?? (done ? para.gist.answer : null)} onPick={(i) => answer(para, i)} locked={done} />
            {!done && misses >= 1 && (
              <div className="flex flex-col gap-2 rounded-[10px] bg-primary-light px-3 py-2.5 text-[14px] leading-relaxed text-primary-hover">
                <span className="flex items-start gap-2">
                  <Icon name="info" className="mt-0.5" />
                  再读一下这一段里高亮的那一句，作者的意思在这里。
                </span>
                <div className="rounded-lg bg-surface px-3 py-2.5">{text(n, 'font-serif text-[17px] leading-[1.75] text-ink', para.topicSentenceId)}</div>
              </div>
            )}
            {!done && misses >= 2 && (
              <div className="flex flex-col gap-1 rounded-[10px] bg-primary-light px-3 py-2.5 text-[14px] text-primary-hover">
                <span>这一段的要点：</span>
                <span className="font-serif text-[17px] leading-relaxed text-ink">{para.gistEn}</span>
              </div>
            )}
          </section>
        )
      })}

      <button type="button" className={btn.primary} disabled={solvedCount < total} onClick={onNext}>
        去练我的生词
      </button>
    </>
  )
}

// 一段原文：每个词都能点；highlight 指定的句子加底色
function ParagraphText({ sentences, className, highlight, tapped, lemmaOf, onTap }: {
  sentences: Sentence[]
  className: string
  highlight?: string
  tapped: Set<string>
  lemmaOf: (t: string) => string
  onTap: (lemma: string) => void
}) {
  return (
    <p className={`m-0 ${className}`}>
      {sentences.map((x, k) => (
        <span key={x.id}>
          {k > 0 && ' '}
          <span className={x.id === highlight ? 'rounded bg-what' : ''}>
            {/* 按空白切成「词块」，每块不换行：under-16s 这类词不会在连字符处断开 */}
            {x.text.split(/(\s+)/).map((chunk, c) =>
              /^\s*$/.test(chunk) ? (
                chunk
              ) : (
                <span key={c} className="whitespace-nowrap">
                  {tokenize(chunk).map((t, j) => {
                    if (!t.word) return <span key={j}>{t.text}</span>
                    const l = lemmaOf(t.text)
                    const on = tapped.has(l)
                    return (
                      <button key={j} type="button" aria-pressed={on} onClick={() => onTap(l)} className={on ? 'border-b-2 border-dashed border-amber bg-amber-light' : ''}>
                        {t.text}
                      </button>
                    )
                  })}
                </span>
              ),
            )}
          </span>
        </span>
      ))}
    </p>
  )
}
