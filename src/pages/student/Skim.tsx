// ② 粗读：原文一字不改，每个英文单词都能点（点一下 = 不认识，不查释义）。
// 先通读全文（老师 Day 1：「请快速通读全文」），读完再答每段一道引导问题。选项可以随便改，全部选好后一起提交，每道题只交一次。
// 答对的标绿；答错的直接标出正确答案（10-17 起，学生说粗读题不给答案、要一遍遍换着选），选错的那一项标红，
// 下面给这一段原文、标出主题句，再给英文要点当解释。答错只记一次「第一次没答对」；老师端只数第一次答对 / 答错，不再数「还没答对」。
// 电脑上答题时左边是全文、右边是题目，方便对照；主题句直接在左边的全文里高亮。
// 全部答完后给「这篇文章是怎么写的」（答错的题也算答完；每段的作用，有 structure 的讲义才有；概括会透露段意，所以答完才给）。
import { useEffect, useMemo, useRef, useState } from 'react'
import type { ArticleStructure, Handout, Paragraph, Sentence } from '../../../shared/schema'
import { lookupWord } from '../../engine'
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
  const [submitted, setSubmitted] = useState<Record<number, number>>({}) // 提交的选项：答错的那一项标红（这次打开页面时交的才知道）
  const [scrollTarget, setScrollTarget] = useState<{ n: number } | null>(null)
  const articleRef = useRef<HTMLElement>(null)
  // 电脑上：左边的全文滚到第 n 段（手机上全文是隐藏的，滚了也看不见）；要让开顶上那条点词提示
  const showPara = (n: number) => {
    const box = articleRef.current
    const el = document.getElementById(`para-${n}`)
    if (box && el) box.scrollTo({ top: el.offsetTop - (box.firstElementChild as HTMLElement).offsetHeight - 12, behavior: 'smooth' })
  }
  // 提交后滚到第一道错题，让学生看到答案和解释。要等这次提交渲染完再滚
  useEffect(() => {
    if (!scrollTarget) return
    document.getElementById(`gist-${scrollTarget.n}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    showPara(scrollTarget.n)
  }, [scrollTarget])

  // 词形 → lemma：先认讲义词表（排在后面，同一写法以它为准；点短语里的 toying 也算 toy with，见 lemmaIndex），再认全文词义；都没有的就用小写原词
  const lemmaOf = useMemo(() => {
    const m = lemmaIndex([...(h.lexicon?.words ?? []), ...h.words])
    return (t: string) => m.get(t.toLowerCase()) ?? t.toLowerCase()
  }, [h])
  // 点过的词按原形算（以前词表外的词记的是小写原词，如 phones，换成 phone），高亮和「已标记」都看它
  const tapped = new Set(state.tappedWords.map((l) => lookupWord(h, l)?.lemma ?? l))
  const toggle = (lemma: string) => act({ type: 'tap_word', lemma, ...(tapped.has(lemma) ? { value: 'off' } : {}) })
  const text = (n: number, className: string, highlight?: string) => (
    <ParagraphText sentences={sentencesOf(n)} className={className} highlight={highlight} tapped={tapped} lemmaOf={lemmaOf} onTap={toggle} />
  )

  const answered = (p: Paragraph | undefined) => !p || !!state.answers[p.gist.id]
  const answeredCount = nums.filter((n) => paraOf(n) && answered(paraOf(n))).length
  const total = nums.filter((n) => paraOf(n)).length
  const switchTo = (next: 'read' | 'quiz') => {
    setPhase(next)
    window.scrollTo(0, 0)
  }
  const anyAnswered = h.paragraphs.some((p) => state.answers[p.gist.id])
  // 还没答过的题（以前答错、还没答对的也算答过：照样给答案和解释）；都选好才能提交
  const open = nums.map(paraOf).filter((p): p is Paragraph => !!p && !answered(p))
  const left = open.filter((p) => picked[p.n] === undefined).length
  const submit = () => {
    for (const p of open) act({ type: 'gist_answer', paragraph: p.n, correct: picked[p.n] === p.gist.answer, firstTry: true })
    setSubmitted({ ...submitted, ...Object.fromEntries(open.map((p) => [p.n, picked[p.n]])) })
    // 有错题就滚到第一道错题，让学生看到答案和解释
    const wrong = open.find((p) => picked[p.n] !== p.gist.answer)
    if (wrong) setScrollTarget({ n: wrong.n })
  }

  if (phase === 'read') {
    return (
      <div className="mx-auto flex w-full max-w-2xl flex-col gap-3.5">
        <div className="flex items-center gap-2.5 rounded-xl bg-primary-light px-3.5 py-3 text-[14px] text-primary-hover">
          <Icon name="click" />
          <span className="flex-1">遇到不认识的词点一下，不用查</span>
          <span className="font-semibold">已标记 {tapped.size} 个</span>
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
          <span className="font-semibold">已标记 {tapped.size} 个</span>
        </div>
        <div className="flex flex-col gap-5 px-5 py-4">
          {nums.map((n) => {
            const para = paraOf(n)
            const rec = para && state.answers[para.gist.id]
            return (
              <div key={n} id={`para-${n}`} className="flex flex-col gap-1">
                <span className="text-[12px] text-muted">第 {n} 段</span>
                {text(n, 'font-serif text-[17px] leading-[1.75]', para && rec && !rec.correct ? para.topicSentenceId : undefined)}
              </div>
            )
          })}
        </div>
      </aside>

      <div className="flex flex-col gap-3.5">
        <div className="flex items-center justify-between gap-2">
          <span className="text-[13px] text-muted">{anyAnswered ? `已答 ${answeredCount} / ${total}` : '每段一道题，都选好后一起提交'}</span>
          <button type="button" className={`${btn.small} lg:hidden`} onClick={() => switchTo('read')}>
            回看全文
          </button>
        </div>

        {nums.map((n) => {
          const para = paraOf(n)
          if (!para) return null
          const rec = state.answers[para.gist.id]
          const missed = !!rec && !rec.correct // 答错了：标出正确答案，给主题句和要点
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
                picked={rec ? para.gist.answer : (sel ?? null)}
                missed={missed ? submitted[n] : undefined}
                pending={!rec && sel !== undefined}
                onPick={(i) => setPicked({ ...picked, [n]: i })}
                locked={!!rec}
              />
              {missed && (
                <div className="flex flex-col gap-2 rounded-[10px] bg-primary-light px-3 py-2.5 text-[14px] leading-relaxed text-primary-hover">
                  <span className="flex items-start gap-2">
                    <Icon name="info" className="mt-0.5" />
                    <span>
                      这题没答对，正确答案是标绿的那一项。
                      <span className="lg:hidden">这一段里高亮的那一句，就是作者的意思：</span>
                      <span className="hidden lg:inline">左边第 {n} 段里高亮的那一句，就是作者的意思。</span>
                    </span>
                  </span>
                  <div className="rounded-lg bg-surface px-3 py-2.5 lg:hidden">{text(n, 'font-serif text-[17px] leading-[1.75] text-ink', para.topicSentenceId)}</div>
                  <span>这一段的要点：</span>
                  <span className="font-serif text-[17px] leading-relaxed text-ink">{para.gistEn}</span>
                </div>
              )}
            </section>
          )
        })}

        {open.length === 0 ? (
          <>
            {h.structure && <StructureMap s={h.structure} />}
            <button type="button" className={btn.primary} onClick={onNext}>
              去练我的生词
            </button>
          </>
        ) : (
          <>
            <button type="button" className={btn.primary} disabled={left > 0} onClick={submit}>
              提交答案
            </button>
            {left > 0 && <span className="text-center text-[13px] text-muted">还有 {left} 题没选</span>}
          </>
        )}
      </div>
    </div>
  )
}

// 这篇文章是怎么写的：上面一行是整篇的骨架（相邻作用相同的段合成一步），下面按段竖着排，每段的作用和一句概括
function StructureMap({ s }: { s: ArticleStructure }) {
  const skeleton = s.paragraphs.map((p) => p.role).filter((r, i, all) => r !== all[i - 1])
  return (
    <section className={`${card} flex flex-col gap-3 p-4`}>
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="m-0 text-[16px] font-bold">这篇文章是怎么写的</h2>
        <Pill>AI 起草，供参考</Pill>
      </div>
      <p className="m-0 text-[15px] font-semibold text-primary">{skeleton.join(' → ')}</p>
      <ol className="m-0 flex list-none flex-col p-0">
        {s.paragraphs.map((p, i) => (
          <li key={p.n} className="flex gap-3">
            <span aria-hidden="true" className="flex w-2.5 shrink-0 flex-col items-center">
              <span className="mt-[7px] h-2.5 w-2.5 rounded-full bg-primary" />
              {i < s.paragraphs.length - 1 && <span className="w-px flex-1 bg-line-strong" />}
            </span>
            <span className="flex flex-col gap-0.5 pb-3">
              <span className="text-[14px]">
                <span className="font-semibold">第 {p.n} 段</span>
                <span className="ml-2 font-semibold text-primary">{p.role}</span>
              </span>
              <span className="text-[14px] leading-relaxed text-ink2">{p.summary}</span>
            </span>
          </li>
        ))}
      </ol>
      {s.moves.length > 0 && <span className="text-[13px] text-muted">到「写作」那一步，还有原文里可以借的写法。</span>}
    </section>
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
