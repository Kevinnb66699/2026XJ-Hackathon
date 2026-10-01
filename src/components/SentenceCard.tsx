// 精读：一句一卡。原文用 SentenceView.text 原样渲染；适配的只是支架（注释、梯子、讲解、题目）。
import { Fragment, useMemo, useState, type ReactNode } from 'react'
import type { Handout } from '../../shared/schema'
import type { PersonalView, SentenceView, StudentState } from '../engine/types'
import type { Act } from '../lib/store'
import { findAll, ladderHighlights, markWords, segment, type Seg } from '../lib/text'
import { Choices, Icon, Pill, btn, serifText } from './ui'
import { WordMeaning } from './WordMeaning'

const STEPS = ['找到：谁 → 做了什么', '换成正常语序', '用简单英文说一遍']

// 把切好的原文片段渲染出来：高亮（谁 / 做了什么）包在外层，注释词、可跳过词、加粗在里层
export function RichText({ segs, active, onGloss }: { segs: Seg[]; active?: string | null; onGloss?: (lemma: string) => void }) {
  const out: ReactNode[] = []
  for (let i = 0; i < segs.length; ) {
    const hl = segs[i].hl
    const group: ReactNode[] = []
    for (; i < segs.length && segs[i].hl === hl; i++) {
      const s = segs[i]
      const m = s.mark
      if (m?.kind === 'gloss' && onGloss) {
        group.push(
          <button key={i} type="button" onClick={() => onGloss(m.lemma)} aria-expanded={active === m.lemma} className={`border-b-2 border-dotted border-amber ${active === m.lemma ? 'bg-amber-light' : ''}`}>
            {s.text}
          </button>,
        )
      } else if (m?.kind === 'skip') {
        group.push(
          <span key={i} title="可跳过" className="text-dim">
            {s.text}
          </span>,
        )
      } else if (m?.kind === 'bold') {
        group.push(<strong key={i}>{s.text}</strong>)
      } else {
        group.push(<Fragment key={i}>{s.text}</Fragment>)
      }
    }
    out.push(
      hl ? (
        <span key={`h${i}`} className={`rounded px-0.5 ${hl === 'who' ? 'bg-who' : 'bg-what'}`}>
          {group}
        </span>
      ) : (
        <Fragment key={`h${i}`}>{group}</Fragment>
      ),
    )
  }
  return <>{out}</>
}

interface CardProps {
  h: Handout
  view: SentenceView
  state: StudentState
  act: Act
  onCollect: (expressionId: string) => void
}

export function SentenceCard({ h, view, state, act, onCollect }: CardProps) {
  const ladder = h.sentences.find((s) => s.id === view.id)?.ladder
  const q = view.question
  const ans = q ? state.answers[q.id] : undefined
  const level = state.ladder[view.id] ?? 0
  const [open, setOpen] = useState(level > 0 && !ans?.correct) // 梯子是否展开
  const [quiz, setQuiz] = useState(false) // 关梯子前在原句上答题：这时隐藏梯子内容
  const [picked, setPicked] = useState<number | null>(null)
  const [gloss, setGloss] = useState<string | null>(null)
  const [noteOpen, setNoteOpen] = useState<boolean | null>(null)
  const [draft, setDraft] = useState('')

  const tryFirst = view.ladderMode === 'tryFirst' && !!q && !ans
  const drafted = !view.checkIn || !!state.checkInDrafted[view.id]
  const showLadder = !!ladder && open && !quiz
  const showQ = !!q && (tryFirst || quiz || (!open && !ans?.correct))
  const wrong = !!q && picked !== null && picked !== q.answer

  const segs = useMemo(() => {
    const marks = markWords(view.text, view.glosses, 'gloss')
    const skip = view.skippableWords.map((l) => h.words.find((w) => w.lemma === l) ?? { lemma: l, forms: [l] })
    markWords(view.text, skip, 'skip', marks)
    const hls = showLadder && ladder && level >= 1 ? ladderHighlights(view.text, ladder.l1.subject, ladder.l1.predicate) : []
    return segment(view.text, marks, hls)
  }, [h, view, showLadder, ladder, level])
  const glossWord = gloss ? h.words.find((w) => w.lemma === gloss) : undefined

  const openTo = (n: number) => {
    if (!ladder || n > view.maxLadderLevel) return
    if (n > level) act({ type: 'open_ladder', sentenceId: view.id, level: n })
    setOpen(true)
    setQuiz(false)
    setPicked(null)
  }

  const answer = (i: number) => {
    if (!q) return
    const correct = i === q.answer
    act({ type: 'answer_question', sentenceId: view.id, correct, firstTry: !ans })
    setPicked(i)
    if (correct) {
      setOpen(false)
      setQuiz(false)
    } else if (tryFirst && ladder) openTo(1) // 先自己试答错：立刻给梯子第 1 步
  }

  const finish = () => {
    if (q) {
      setQuiz(true)
      setPicked(null)
    } else setOpen(false)
  }

  // 老师的讲解也是支架：打卡句交初稿前不给（只给梯子第 1 步）；屏幕上有题时先藏起来，免得直接看到答案
  const note = view.teacherNote
  const noteLock = view.checkIn && !drafted ? '交初稿后可以看' : showQ ? '先答题，再看' : ''
  const noteVisible = noteOpen ?? !view.teacherNoteCollapsed
  const isUnknown = (l: string) => (state.wordMarks[l] ? state.wordMarks[l] === 'unknown' : state.tappedWords.includes(l))
  const personal = note ? h.words.find((w) => isUnknown(w.lemma) && w.forms.some((f) => findAll(note, f).length > 0)) : undefined
  // 「给你」便签：老师讲解里点名这个词的那一句（优先带「如果」的那句）。它只说这个词难、不说意思，
  // 所以打卡句交初稿前也可以显示；完整讲解仍按上面的规则锁定或收起。
  const ifQuote = personal && note
    ? (() => {
        const parts = note.split(/(?<=[。；])/).map((x) => x.trim()).filter(Boolean)
        const has = (x: string) => personal.forms.some((f) => findAll(x, f).length > 0)
        return (parts.find((x) => has(x) && x.includes('如果')) ?? parts.find(has))?.replace(/[。；]$/, '')
      })()
    : undefined
  const exprs = h.expressions.filter((e) => e.sentenceId === view.id)
  const focus = open || tryFirst

  return (
    <section className={`flex flex-col gap-3 rounded-[14px] bg-surface p-4 ${focus ? 'border-[1.5px] border-blue' : 'border border-line'}`}>
      {(view.checkIn || level > 0) && (
        <div className="flex flex-wrap gap-2">
          {view.checkIn && <Pill tone="amber">打卡句</Pill>}
          {level > 0 && <Pill tone="blue">梯子 · 第 {level} 步</Pill>}
        </div>
      )}

      <p className={`m-0 ${serifText}`}>
        <RichText segs={segs} active={gloss} onGloss={(l) => setGloss(gloss === l ? null : l)} />
      </p>
      {view.skippableWords.length > 0 && <span className="text-[13px] text-muted">灰色的词可跳过，不影响读懂大意</span>}
      {personal && ifQuote && (
        <div className="flex gap-2.5 rounded-xl border border-dashed border-note-line bg-note p-3">
          <Icon name="pin" className="mt-0.5 shrink-0 text-amber" />
          <div className="flex flex-col gap-1.5 text-[14px] leading-relaxed">
            <span className="font-semibold text-amber-dark">给你</span>
            <span>
              你把 {personal.lemma} 标成了「不认识」。老师讲义里写的「{ifQuote}」，说的就是你。
            </span>
          </div>
        </div>
      )}
      {glossWord && <WordMeaning key={glossWord.lemma} word={glossWord} state={state} act={act} />}

      {ans?.correct && !open && (
        <div className="flex items-center gap-2 text-[13px] text-green">
          <Icon name="check" size={16} />
          <span>读懂了</span>
        </div>
      )}

      {showQ && q && (
        <div className="flex flex-col gap-2 rounded-xl bg-blue-light p-3">
          <span className="text-[14px] text-blue-hover">
            {tryFirst ? '上次你自己读懂了类似的句子，这次先试一下' : quiz ? '先不看提示，在原句上答一题' : '读懂了吗？答一题看看'}
          </span>
          <span className="text-[15px] font-semibold">{q.prompt}</span>
          <Choices options={q.options} answer={q.answer} picked={picked} onPick={answer} />
          {wrong && (
            <div className="flex flex-wrap items-center gap-2 text-[13px] text-red-dark">
              <span className="flex-1">还不对，再读一遍原句。</span>
              {quiz && (
                <button type="button" className={btn.small} onClick={() => setQuiz(false)}>
                  再看提示
                </button>
              )}
            </div>
          )}
        </div>
      )}

      {showLadder && ladder && (
        <div className="flex flex-col gap-2">
          <span className="text-[14px] font-semibold">读懂梯子</span>
          {STEPS.map((title, i) => {
            const n = i + 1
            const opened = level >= n
            return (
              <div key={n} className={`flex flex-col gap-2 rounded-[10px] px-3 py-2.5 text-[14px] ${opened ? 'bg-blue-light' : 'bg-ground text-ink2'}`}>
                <div className="flex items-center gap-2.5">
                  <span className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[13px] ${opened ? 'bg-blue text-white' : 'border-[1.5px] border-dim'}`}>{n}</span>
                  <span className="flex-1">{title}</span>
                  {opened ? <span className="text-[13px] text-blue">已打开</span> : n > view.maxLadderLevel ? <Icon name="lock" size={16} /> : null}
                </div>
                {opened && n === 1 && (
                  <div className="flex flex-col gap-1 text-[14px] text-ink">
                    <span className="flex items-center gap-1.5">
                      <span className="h-3 w-3 shrink-0 rounded-sm bg-[#F2C98A]" />谁：<span className="font-serif">{ladder.l1.subject}</span>
                    </span>
                    <span className="flex items-center gap-1.5">
                      <span className="h-3 w-3 shrink-0 rounded-sm bg-[#A9C4E8]" />做了什么：<span className="font-serif">{ladder.l1.predicate}</span>
                    </span>
                  </div>
                )}
                {opened && n === 2 && <p className="m-0 font-serif text-[18px] leading-relaxed text-ink">{ladder.l2}</p>}
                {opened && n === 3 && (
                  <div className="flex flex-col gap-1.5 text-ink">
                    <p className="m-0 font-serif text-[18px] leading-relaxed">{ladder.l3.plain}</p>
                    {ladder.l3.glosses.map((g) => (
                      <span key={g.term} className="text-[14px]">
                        <span className="font-serif">{g.term}</span>：{g.zh}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            )
          })}
          {view.maxLadderLevel < 3 && <span className="text-[13px] text-muted">打卡句：先写初稿，再打开第 2、3 步</span>}
          <div className="flex gap-2">
            {level < view.maxLadderLevel && (
              <button type="button" className={`${btn.secondary} flex-1`} onClick={() => openTo(level + 1)}>
                我卡住了
              </button>
            )}
            <button type="button" className={`${btn.primary} flex-1`} onClick={finish}>
              我读懂了
            </button>
          </div>
        </div>
      )}

      {ladder && !open && !tryFirst && (
        <button type="button" className={`${btn.secondary} flex items-center justify-center gap-2`} onClick={() => openTo(Math.max(level, 1))}>
          <Icon name="hand" />
          {level > 0 ? '再看提示' : '我卡住了'}
        </button>
      )}

      {view.checkIn && !drafted && (
        <div className="flex flex-col gap-2">
          <label htmlFor={`draft-${view.id}`} className="text-[14px] font-semibold">
            你的翻译初稿
          </label>
          <textarea
            id={`draft-${view.id}`}
            rows={3}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="先写初稿，再看更多提示"
            className="w-full resize-none rounded-[10px] border border-line-strong bg-surface px-3 py-2.5 text-[15px]"
          />
          <button type="button" disabled={!draft.trim()} className={btn.primary} onClick={() => act({ type: 'writing_submit', sentenceId: view.id, value: draft.trim().slice(0, 500) })}>
            交初稿
          </button>
        </div>
      )}
      {view.checkIn && drafted && (
        <span className="flex items-center gap-1.5 text-[13px] text-green">
          <Icon name="check" size={16} />
          初稿已交，提示都可以打开了
        </span>
      )}

      {exprs.map((e) => {
        const got = state.collectedExpressions.includes(e.id)
        return (
          <button
            key={e.id}
            type="button"
            onClick={() => !got && onCollect(e.id)}
            className="flex min-h-[44px] items-center justify-between gap-2 rounded-xl border border-line bg-surface px-3.5 text-left"
          >
            <span className="font-serif text-[16px]">{e.text}</span>
            <span className={`flex shrink-0 items-center gap-1 text-[13px] ${got ? 'text-green' : 'text-blue'}`}>
              {got && <Icon name="check" size={14} />}
              {got ? '已收进表达本' : '收进表达本'}
            </span>
          </button>
        )
      })}

      {note &&
        (noteLock ? (
          <div className="rounded-xl border border-line px-3.5 py-3 text-[14px] text-ink2">老师的讲解：{noteLock}</div>
        ) : (
          <div className="flex flex-col gap-2 rounded-xl border border-line px-3.5 py-3">
            <div className="flex items-center gap-2">
              {view.teacherNoteCollapsed ? (
                <>
                  <Icon name="check" size={16} className="text-green" />
                  <span className="flex-1 text-[13px] text-green">
                    {view.collapseReason}
                    {noteVisible ? '' : '，老师的讲解已收起'}
                  </span>
                </>
              ) : (
                <span className="flex-1 text-[14px] text-ink2">老师的讲解</span>
              )}
              <button type="button" className={btn.small} onClick={() => setNoteOpen(!noteVisible)}>
                {noteVisible ? '收起' : '展开'}
              </button>
            </div>
            {noteVisible && <p className="m-0 text-[14px] leading-relaxed">{note}</p>}
          </div>
        ))}
    </section>
  )
}

// 精读页：按段落列出每句的卡片（paragraphs 可只显示其中几段，only 可只显示其中几句）
export function CloseReading({ h, view, state, act, onCollect, paragraphs, only }: {
  h: Handout
  view: PersonalView
  state: StudentState
  act: Act
  onCollect: (expressionId: string) => void
  paragraphs?: number[]
  only?: string[]
}) {
  const nums = [...new Set(view.sentences.map((s) => s.paragraph))].filter((n) => !paragraphs || paragraphs.includes(n))
  return (
    <>
      {nums.map((n) => (
        <section key={n} className="flex flex-col gap-3.5">
          <div className="flex items-baseline justify-between gap-2">
            <h2 className="m-0 text-[18px] font-bold">第 {n} 段</h2>
            <span className="text-[13px] text-muted">卡住了就点「我卡住了」</span>
          </div>
          {view.sentences
            .filter((s) => s.paragraph === n && (!only || only.includes(s.id)))
            .map((sv) => (
              <SentenceCard key={sv.id} h={h} view={sv} state={state} act={act} onCollect={onCollect} />
            ))}
        </section>
      ))}
    </>
  )
}
