// ② 粗读：原文一字不改，每个英文单词都能点（点一下 = 不认识，不查释义）。
// 先通读全文（老师 Day 1：「请快速通读全文」），读完再答每段一道引导问题。选项可以随便改，全部选好后一起提交；
// 提交后答对的锁定，答错一次，在题目下面给出这一段原文并标出主题句；再错给英文要点。错题换个答案再提交。
// 电脑上答题时左边是全文、右边是题目，方便对照；主题句直接在左边的全文里高亮。
import { useEffect, useMemo, useRef, useState } from 'react'
import type { Handout, Paragraph, Sentence } from '../../../shared/schema'
import type { StudentState } from '../../engine/types'
import { Choices, Icon, Pill, btn, card, serifText } from '../../components/ui'
import type { Act } from '../../lib/store'
import { lemmaIndex, tokenize } from '../../lib/text'

export function Skim({ h, state, act, onNext }: { h: Handout; state: StudentState; act: Act; onNext: () => void }) {
  const nums = useMemo(() => [...new Set(h.sentences.map((x) => x.paragraph))].sort((a, b) => a - b), [h])
  const paraOf = (n: number) => h.paragraphs.find((p) => p.n === n)
  const sentencesOf = (n: number) => h.sentences.filter((x) => x.paragraph === n)
  // 答过题再回到这一步，直接停在题目页
  const [phase, setPhase] = useState<'read' | 'quiz'>(() => (h.paragraphs.some((p) => state.answers[p.gist.id]) ? 'quiz' : 'read'))
  const [picked, setPicked] = useState<Record<number, number>>({}) // 现在选的（提交前可以随便改）
  const [submitted, setSubmitted] = useState<Record<number, number>>({}) // 上次提交的选项
  const [scrollTarget, setScrollTarget] = useState<{ n: number } | null>(null)
  const articleRef = useRef<HTMLElement>(null)
  // 电脑上：左边的全文滚到第 n 段（手机上全文是隐藏的，滚了也看不见）；要让开顶上那条点词提示
  const showPara = (n: number) => {
    const box = articleRef.current
    const el = document.getElementById(`para-${n}`)
    if (box && el) box.scrollTo({ top: el.offsetTop - (box.firstElementChild as HTMLElement).offsetHeight - 12, behavior: 'smooth' })
  }
  // 提交后滚到第一道错题。要等这次提交渲染完再滚：刚答对的题会收起提示，下面的卡片会往上移
  useEffect(() => {
    if (!scrollTarget) return
    document.getElementById(`gist-${scrollTarget.n}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    showPara(scrollTarget.n)
  }, [scrollTarget])

  // 词形 → lemma（讲义词表里没有的词，就用小写原词；点短语里的 toying 也算 toy with，见 lemmaIndex）
  const lemmaOf = useMemo(() => {
    const m = lemmaIndex(h.words)
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
  const anyAnswered = h.paragraphs.some((p) => state.answers[p.gist.id])
  // 还没答对的题；每道都要选一个新的答案（和上次提交的不同）才能提交
  const open = nums.map(paraOf).filter((p): p is Paragraph => !!p && !solved(p))
  const left = open.filter((p) => picked[p.n] === undefined || picked[p.n] === submitted[p.n]).length
  const submit = () => {
    for (const p of open) act({ type: 'gist_answer', paragraph: p.n, correct: picked[p.n] === p.gist.answer, firstTry: !state.answers[p.gist.id] })
    setSubmitted({ ...submitted, ...Object.fromEntries(open.map((p) => [p.n, picked[p.n]])) })
    // 有错题就滚到第一道错题，让学生看到提示
    const wrong = open.find((p) => picked[p.n] !== p.gist.answer)
    if (wrong) setScrollTarget({ n: wrong.n })
  }

  if (phase === 'read') {
    return (
      <div className="mx-auto flex w-full max-w-2xl flex-col gap-3.5">
        <div className="flex items-center gap-2.5 rounded-xl bg-primary-light px-3.5 py-3 text-[14px] text-primary-hover">
          <Icon name="click" />
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
          {anyAnswered ? '回到题目' : '读完了，去答题'}
        </button>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-3.5 lg:grid lg:grid-cols-2 lg:items-start lg:gap-6">
      <aside
        ref={articleRef}
        aria-label="原文"
        className={`${card} hidden lg:sticky lg:top-[72px] lg:block lg:max-h-[calc(100vh-88px)] lg:overflow-y-auto`}
      >
        {/* 答题时也能接着点生词：提示固定在全文顶上 */}
        <div className="sticky top-0 z-10 flex items-center gap-2 border-b border-line bg-surface px-5 py-2.5 text-[13px] text-primary-hover">
          <Icon name="click" />
          <span className="flex-1">遇到不认识的词点一下，不用查</span>
          <span className="font-semibold">已标记 {state.tappedWords.length} 个</span>
        </div>
        <div className="flex flex-col gap-5 px-5 py-4">
          {nums.map((n) => {
            const para = paraOf(n)
            const rec = para && state.answers[para.gist.id]
            const misses = rec ? rec.attempts - (rec.correct ? 1 : 0) : 0
            return (
              <div key={n} id={`para-${n}`} className="flex flex-col gap-1">
                <span className="text-[12px] text-muted">第 {n} 段</span>
                {text(n, 'font-serif text-[17px] leading-[1.75]', para && !rec?.correct && misses >= 1 ? para.topicSentenceId : undefined)}
              </div>
            )
          })}
        </div>
      </aside>

      <div className="flex flex-col gap-3.5">
        <div className="flex items-center justify-between gap-2">
          <span className="text-[13px] text-muted">{anyAnswered ? `已答对 ${solvedCount} / ${total}` : '每段一道题，都选好后一起提交'}</span>
          <button type="button" className={`${btn.small} lg:hidden`} onClick={() => switchTo('read')}>
            回看全文
          </button>
        </div>

        {nums.map((n) => {
          const para = paraOf(n)
          if (!para) return null
          const rec = state.answers[para.gist.id]
          const misses = rec ? rec.attempts - (rec.correct ? 1 : 0) : 0
          const done = !!rec?.correct
          const sel = picked[n]
          return (
            <section key={n} id={`gist-${n}`} className={`${card} flex scroll-mt-20 flex-col gap-2.5 p-4`}>
              <span className="self-start">
                <Pill>第 {n} 段</Pill>
              </span>
              <h2 className="m-0 text-[16px] font-bold">{para.gist.prompt}</h2>
              <Choices
                options={para.gist.options}
                answer={para.gist.answer}
                picked={done ? para.gist.answer : (sel ?? null)}
                pending={!done && sel !== undefined && sel !== submitted[n]}
                onPick={(i) => setPicked({ ...picked, [n]: i })}
                locked={done}
              />
              {!done && misses >= 1 && (
                <div className="flex flex-col gap-2 rounded-[10px] bg-primary-light px-3 py-2.5 text-[14px] leading-relaxed text-primary-hover">
                  <span className="flex items-start gap-2">
                    <Icon name="info" className="mt-0.5" />
                    <span className="lg:hidden">再读一下这一段里高亮的那一句，作者的意思在这里。</span>
                    <span className="hidden lg:inline">再读一下左边第 {n} 段里高亮的那一句，作者的意思在这里。</span>
                  </span>
                  <div className="rounded-lg bg-surface px-3 py-2.5 lg:hidden">{text(n, 'font-serif text-[17px] leading-[1.75] text-ink', para.topicSentenceId)}</div>
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

        {open.length === 0 ? (
          <button type="button" className={btn.primary} onClick={onNext}>
            去练我的生词
          </button>
        ) : (
          <>
            <button type="button" className={btn.primary} disabled={left > 0} onClick={submit}>
              {anyAnswered ? '改好了，再提交' : '提交答案'}
            </button>
            {left > 0 && <span className="text-center text-[13px] text-muted">{anyAnswered ? `还有 ${left} 道错题没换答案` : `还有 ${left} 题没选`}</span>}
          </>
        )}
      </div>
    </div>
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
                      <button key={j} type="button" aria-pressed={on} onClick={() => onTap(l)} className={on ? 'border-b-2 border-dashed border-amber bg-amber-light' : 'rounded-sm [@media(hover:hover)]:hover:bg-amber-light/60'}>
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
