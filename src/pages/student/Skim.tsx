// ② 粗读：原文一字不改，每个英文单词都能点（点一下 = 不认识，不查释义）。每段一道引导问题：
// 答错一次标出主题句，再错给英文要点。
import { useMemo, useState } from 'react'
import type { Handout } from '../../../shared/schema'
import type { StudentState } from '../../engine/types'
import { Choices, Icon, btn, card, serifText } from '../../components/ui'
import type { Act } from '../../lib/store'
import { tokenize } from '../../lib/text'

export function Skim({ h, state, act, onNext }: { h: Handout; state: StudentState; act: Act; onNext: () => void }) {
  const nums = useMemo(() => [...new Set(h.sentences.map((x) => x.paragraph))].sort((a, b) => a - b), [h])
  const [pi, setPi] = useState(0)
  const [picked, setPicked] = useState<number | null>(null)
  const n = nums[pi]
  const para = h.paragraphs.find((p) => p.n === n)
  const sentences = h.sentences.filter((x) => x.paragraph === n)

  // 词形 → lemma（讲义词表里没有的词，就用小写原词）
  const lemmaOf = useMemo(() => {
    const m = new Map<string, string>()
    for (const w of h.words) for (const f of w.forms) m.set(f.toLowerCase(), w.lemma)
    return (t: string) => m.get(t.toLowerCase()) ?? t.toLowerCase()
  }, [h])
  const tapped = new Set(state.tappedWords)
  const toggle = (lemma: string) => act({ type: 'tap_word', lemma, ...(tapped.has(lemma) ? { value: 'off' } : {}) })

  const rec = para ? state.answers[para.gist.id] : undefined
  const misses = rec ? rec.attempts - (rec.correct ? 1 : 0) : 0
  const done = !para || !!rec?.correct
  const last = pi === nums.length - 1

  const answer = (i: number) => {
    if (!para) return
    setPicked(i)
    act({ type: 'gist_answer', paragraph: para.n, correct: i === para.gist.answer, firstTry: !rec })
  }
  const next = () => {
    setPicked(null)
    if (last) onNext()
    else {
      setPi(pi + 1)
      window.scrollTo(0, 0)
    }
  }

  return (
    <>
      <div className="flex items-center gap-2.5 rounded-xl bg-primary-light px-3.5 py-3 text-[14px] text-primary-hover">
        <Icon name="hand" />
        <span className="flex-1">遇到不认识的词点一下，不用查</span>
        <span className="font-semibold">已标记 {state.tappedWords.length} 个</span>
      </div>
      <span className="text-[13px] text-muted">
        第 {pi + 1} / {nums.length} 段
      </span>

      <article className={`${card} px-4 py-[18px]`}>
        <p className={`m-0 ${serifText}`}>
          {sentences.map((x, k) => (
            <span key={x.id}>
              {k > 0 && ' '}
              <span className={misses >= 1 && x.id === para?.topicSentenceId ? 'rounded bg-what' : ''}>
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
                          <button key={j} type="button" aria-pressed={on} onClick={() => toggle(l)} className={on ? 'border-b-2 border-dashed border-amber bg-amber-light' : ''}>
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
      </article>

      {para && (
        <section className={`${card} flex flex-col gap-2.5 p-4`}>
          <h2 className="m-0 text-[16px] font-bold">{para.gist.prompt}</h2>
          <Choices options={para.gist.options} answer={para.gist.answer} picked={picked ?? (done ? para.gist.answer : null)} onPick={answer} locked={done} />
          {!done && misses === 1 && (
            <div className="flex items-start gap-2 rounded-[10px] bg-primary-light px-3 py-2.5 text-[14px] leading-relaxed text-primary-hover">
              <Icon name="info" className="mt-0.5" />
              <span>再读一下上面高亮的那一句，作者的意思在这里。</span>
            </div>
          )}
          {!done && misses >= 2 && (
            <div className="flex flex-col gap-1 rounded-[10px] bg-primary-light px-3 py-2.5 text-[14px] text-primary-hover">
              <span>这一段的要点：</span>
              <span className="font-serif text-[17px] leading-relaxed text-ink">{para.gistEn}</span>
            </div>
          )}
        </section>
      )}

      <button type="button" className={btn.primary} disabled={!done} onClick={next}>
        {last ? '去练我的生词' : '下一段'}
      </button>
    </>
  )
}
