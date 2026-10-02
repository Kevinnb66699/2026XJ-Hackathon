// 精读：一句一卡。原文用 SentenceView.text 原样渲染；适配的只是支架（注释、梯子、讲解、题目）。
import { Fragment, useMemo, useState } from 'react'
import type { Handout, Word } from '../../shared/schema'
import { unknownWords } from '../engine'
import type { PersonalView, SentenceView, StudentState } from '../engine/types'
import type { Act } from '../lib/store'
import { annotate, findAll, markWords, noteQuote, sameWording, segment, type Seg } from '../lib/text'
import { Choices, Icon, Pill, btn, serifText } from './ui'
import { WordMeaning } from './WordMeaning'

// 梯子三步：有拆句（breakdown）的用新的第 2、3 步；没有的（如上传的讲义）还用正常语序和简单英文
const STEPS = ['谁 → 做了什么', '换成正常语序', '简单英文']
const BREAKDOWN_STEPS = ['谁 → 做了什么', '拆开', '译文']
// 原句上批注的底色：谁 / 做了什么沿用原来的高亮色，其他标签各一种浅色，补充说明用浅灰
const TONE: Record<string, string> = { 谁: 'bg-who', 做了什么: 'bg-what', '对谁·对什么': 'bg-select-light', '什么时候·在哪里': 'bg-[#ECE4F7]', 为什么: 'bg-red-light', 怎么样: 'bg-green-light' } // 其余（补充说明）用 bg-line
const TAIL = /^[,.;:!?)\]’”'"…]+/ // 紧跟在批注块后面的标点
const lineLabel = 'mr-1.5 rounded bg-primary-light px-1.5 py-0.5 text-[12px] font-semibold text-primary'

// 把切好的原文片段渲染出来：注释词、可跳过词、加粗
export function RichText({ segs, active, onGloss }: { segs: Seg[]; active?: string | null; onGloss?: (lemma: string) => void }) {
  return (
    <>
      {segs.map((s, i) => {
        const m = s.mark
        if (m?.kind === 'gloss' && onGloss)
          return (
            <button key={i} type="button" onClick={() => onGloss(m.lemma)} aria-expanded={active === m.lemma} className={`border-b-2 border-dotted border-amber ${active === m.lemma ? 'bg-amber-light' : ''}`}>
              {s.text}
            </button>
          )
        if (m?.kind === 'skip')
          return (
            <span key={i} title="可跳过" className="text-dim">
              {s.text}
            </span>
          )
        if (m?.kind === 'bold') return <strong key={i}>{s.text}</strong>
        return <Fragment key={i}>{s.text}</Fragment>
      })}
    </>
  )
}

// 「给你」便签写的词：这一句原文里有、学生又不认识的词，老师讲解里有一句点名它（见 noteQuote，没有就不显示）。评委页的对比提示也用它
export function personalWord(h: Handout, view: SentenceView, state: StudentState): Word | undefined {
  const note = view.teacherNote
  const unknown = unknownWords(h, state)
  return note ? h.words.find((w) => unknown.has(w.lemma) && w.forms.some((f) => findAll(view.text, f).length > 0) && noteQuote(note, w.forms)) : undefined
}

// 「先自己试」：同类句子以前自己读懂过，这句还没答
export const tryFirstOf = (view: SentenceView, state: StudentState) => view.ladderMode === 'tryFirst' && !!view.question && !state.answers[view.question.id]

// 表达的中文：开过梯子、答对了原句题、收进了表达本，或这句本来没有题也没有梯子，才显示
export const exprZhShown = (view: SentenceView, state: StudentState, expressionId: string) =>
  (state.ladder[view.id] ?? 0) >= 1 || !!(view.question && state.answers[view.question.id]?.correct) || state.collectedExpressions.includes(expressionId) || (!view.question && !view.hasLadder)

// 老师常常几句一起讲（「第一句话……第二句话……」），入库时这段讲解挂在它讲到的每一句下面，单看一张卡会对不上。
// 这段讲解讲到哪几句：老师按同一段精讲引文（原文精读学习）里的顺序叫第一句、第二句；讲解里点到的、讲解一字不差的都算。n 是老师的叫法
const CN = '一二三四五六七八九'
export function noteGroup(h: Handout, id: string): { id: string; text: string; n: string; here: boolean }[] {
  const x = h.sentences.find((s) => s.id === id)
  if (!x?.teacherNote) return []
  const src = x.sources.find((s) => s.section === '原文精读学习')
  const block = src ? h.sentences.filter((s) => s.sources.some((t) => t.day === src.day && t.section === src.section && t.quote === src.quote)) : [x]
  const named = (x.teacherNote.match(/第[一二三四五六七八九]句/g) ?? []).map((m) => block[CN.indexOf(m[1])])
  return block.flatMap((s, i) => (s.teacherNote === x.teacherNote || named.includes(s) ? [{ id: s.id, text: s.text, n: CN[i], here: s === x }] : []))
}

// 讲解上面的一行：讲了几句、哪一句是这张卡；只讲这一句、又没用「第几句」叫它时不说
export function noteCover(h: Handout, id: string): string {
  const g = noteGroup(h, id)
  const head = (t: string) => (t.split(' ').length <= 5 ? t : `${t.split(' ').slice(0, 4).join(' ').replace(/[,;:]$/, '')}…`)
  if (g.length > 1) return `这段讲解一起讲了 ${g.length} 句：${g.map((r) => `第${r.n}句「${head(r.text)}」${r.here ? '（就是这一句）' : ''}`).join('，')}`
  const called = g.length ? `第${g[0].n}句` : ''
  return called && h.sentences.find((s) => s.id === id)?.teacherNote?.includes(called) ? `讲解里的「${called}」就是这一句` : ''
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
  const bd = view.breakdown
  const q = view.question
  const ans = q ? state.answers[q.id] : undefined
  const level = state.ladder[view.id] ?? 0
  const [open, setOpen] = useState(level > 0 && !ans?.correct) // 梯子是否展开
  const [quiz, setQuiz] = useState(false) // 关梯子前在原句上答题：这时隐藏梯子内容
  const [picked, setPicked] = useState<number | null>(null)
  const [gloss, setGloss] = useState<string | null>(null)
  const [noteOpen, setNoteOpen] = useState<boolean | null>(null)
  const [wrongOpened, setWrongOpened] = useState(false) // 这次梯子是原句题答错后自动打开的

  const tryFirst = tryFirstOf(view, state)
  const showLadder = !!ladder && open && !quiz
  const showQ = !!q && (tryFirst || quiz || (!open && !ans?.correct))
  const wrong = !!q && picked !== null && picked !== q.answer

  const marks = useMemo(() => {
    const marks = markWords(view.text, view.glosses, 'gloss')
    const skip = view.skippableWords.map((l) => h.words.find((w) => w.lemma === l) ?? { lemma: l, forms: [l] })
    return markWords(view.text, skip, 'skip', marks)
  }, [h, view])
  // 梯子打开时直接在原句上批注：第 1 步标出谁 / 做了什么，有拆句的从第 2 步起标出拆开的每一块
  const chunks = useMemo(() => {
    const parts: { label: string; text: string; hint?: string }[] =
      !showLadder || !ladder || level < 1 ? [] : bd && level >= 2 ? bd.parts : [{ label: '谁', text: ladder.l1.subject }, { label: '做了什么', text: ladder.l1.predicate }]
    return annotate(view.text, parts)
  }, [view, showLadder, ladder, bd, level])
  const rich = (a: number, b: number) => <RichText segs={segment(view.text, marks, a, b)} active={gloss} onGloss={(l) => setGloss(gloss === l ? null : l)} />
  const glossWord = gloss ? h.words.find((w) => w.lemma === gloss) : undefined

  const openTo = (n: number) => {
    if (!ladder || n > view.maxLadderLevel) return
    if (n > level) act({ type: 'open_ladder', sentenceId: view.id, level: n })
    setOpen(true)
    setQuiz(false)
    setPicked(null)
    setWrongOpened(false)
  }

  const answer = (i: number) => {
    if (!q) return
    const correct = i === q.answer
    act({ type: 'answer_question', sentenceId: view.id, correct, firstTry: !ans })
    setPicked(i)
    if (correct) {
      setOpen(false)
      setQuiz(false)
    } else if (ladder && !open) {
      // 答错就给梯子第 1 步：不然 3 个选项换着点总能蒙对，走不到梯子
      openTo(1)
      setWrongOpened(true)
    }
  }

  const finish = () => {
    setWrongOpened(false)
    if (q) {
      setQuiz(true)
      setPicked(null)
    } else setOpen(false)
  }

  // 老师的讲解也是支架：还没答题、或屏幕上有题时整块不显示，免得直接看到答案
  const note = view.teacherNote
  const noteHidden = showQ || (!!q && !ans)
  const noteVisible = noteOpen ?? !view.teacherNoteCollapsed
  const cover = noteCover(h, view.id)
  // 「给你」便签：引老师讲解里点名这个词的那一句（见 personalWord）。
  // 它只说这个词难、不说意思，所以答题前也可以显示；完整讲解仍按上面的规则隐藏或收起。
  const personal = personalWord(h, view, state)
  const ifQuote = personal && note ? noteQuote(note, personal.forms) : undefined
  // 便签照实说为什么当你不认识，按这个顺序判断：先猜后看第一次猜错（之后可能又点了「认识」，不能说成「标成了不认识」）
  // → 卡片标了「不认识」→ 粗读点过 → 其他（把编出来的词点成「认识」后，所有「认识」都不算数）
  const why = !personal
    ? ''
    : personal.guess && state.answers[personal.guess.id]?.firstTryCorrect === false
      ? `${personal.lemma} 的意思你第一次猜错了`
      : state.wordMarks[personal.lemma] === 'unknown'
        ? `你把 ${personal.lemma} 标成了「不认识」`
        : state.tappedWords.includes(personal.lemma)
          ? `你在粗读时点了 ${personal.lemma}`
          : `你把编出来的词也点成了「认识」，所以 ${personal.lemma} 先当你不认识`
  // 旧的梯子第 2 步和原句一字不差时，不再把原句抄一遍，直接说不用调
  const sameAsText = !!ladder && sameWording(ladder.l2, view.text)
  const exprs = h.expressions.filter((e) => e.sentenceId === view.id)
  const focus = open || tryFirst

  return (
    <section data-sentence={view.id} className={`flex scroll-mt-20 flex-col gap-3 rounded-[14px] bg-surface p-4 ${focus ? 'border-[1.5px] border-primary' : 'border border-line'}`}>
      {(view.checkIn || level > 0) && (
        <div className="flex flex-wrap gap-2">
          {view.checkIn && <Pill tone="amber">打卡句</Pill>}
          {level > 0 && <Pill tone="primary">梯子 · 第 {level} 步</Pill>}
        </div>
      )}

      <p className={`m-0 ${serifText}`}>
        {chunks.map((c, i) => {
          // 批注块：上面标签、中间原话、下面提示；紧跟在块后面的标点并进块里，免得单独折到下一行
          if (!c.part) return <Fragment key={i}>{rich(c.start + (chunks[i - 1]?.part ? (TAIL.exec(c.text)?.[0].length ?? 0) : 0), c.end)}</Fragment>
          const next = chunks[i + 1]
          const tail = next && !next.part ? (TAIL.exec(next.text)?.[0].length ?? 0) : 0
          const tone = TONE[c.part.label] ?? 'bg-line'
          const chip = `whitespace-nowrap rounded px-1 font-sans text-[11px] font-semibold leading-4 text-ink2 ${tone}`
          return (
            <span key={i} className="relative inline-flex flex-col pb-1 pt-[18px]">
              <span className={`absolute left-0 top-0 ${chip}`}>{c.part.label}</span>
              <span>
                <span className={`rounded px-0.5 ${tone}`}>{rich(c.start, c.end)}</span>
                {rich(c.end, c.end + tail)}
              </span>
              {c.part.hint && <span className="w-0 min-w-full pr-2 font-sans text-[12px] leading-snug text-muted">{c.part.hint}</span>}
              {/* 只用来撑宽：标签比原话宽时不压到旁边的标签；提示最多撑开 6 个字宽，再长就在原话下面折行（pr-2 让相邻两块的提示分得开） */}
              <span aria-hidden className={`invisible h-0 overflow-hidden ${chip}`}>
                {c.part.label}
              </span>
              {c.part.hint && (
                <span aria-hidden className="invisible h-0 max-w-[6em] overflow-hidden whitespace-nowrap pr-2 font-sans text-[12px]">
                  {c.part.hint}
                </span>
              )}
            </span>
          )
        })}
      </p>
      {view.skippableWords.length > 0 && <span className="text-[13px] text-muted">灰色的词可跳过，不影响读懂大意</span>}
      {glossWord && <WordMeaning word={glossWord} head />}
      {showLadder && ladder && level >= 2 && !bd && (
        <p className="m-0 text-[14px] leading-relaxed">
          <span className={lineLabel}>换成正常语序</span>
          {sameAsText ? '这句本来就是正常语序，不用调，直接看第 3 步' : <span className="font-serif text-[17px]">{ladder.l2}</span>}
        </p>
      )}
      {showLadder && ladder && level >= 3 && (
        <div className="flex flex-col gap-1 leading-relaxed">
          <p className="m-0 text-[15px]">
            <span className={lineLabel}>{bd ? '译文' : '简单英文'}</span>
            {bd ? bd.zh : <span className="font-serif text-[17px]">{ladder.l3.plain}</span>}
          </p>
          {ladder.l3.glosses.length > 0 && (
            <p className="m-0 text-[14px] text-ink2">
              {ladder.l3.glosses.map((g, k) => (
                <Fragment key={g.term}>
                  {k > 0 && '\u00a0· '}
                  <span className="font-serif">{g.term}</span>：{g.zh}
                </Fragment>
              ))}
            </p>
          )}
        </div>
      )}
      {personal && ifQuote && (
        <div className="flex gap-2.5 rounded-xl border border-dashed border-note-line bg-note p-3">
          <Icon name="pin" className="mt-0.5 shrink-0 text-amber" />
          <div className="flex flex-col gap-1.5 text-[14px] leading-relaxed">
            <span className="font-semibold text-amber-dark">给你</span>
            <span>
              {why}。老师讲义里写的「{ifQuote}」，刚好戳中了你。
            </span>
          </div>
        </div>
      )}

      {ans?.correct && !open && (
        <div className="flex items-center gap-2 text-[13px] text-green">
          <Icon name="check" size={16} />
          <span>读懂了</span>
        </div>
      )}

      {showQ && q && (
        <div className="flex flex-col gap-2 rounded-xl bg-primary-light p-3">
          <span className="text-[14px] text-primary-hover">
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
          {wrongOpened && <span className="text-[13px] text-red-dark">这题没答对，先看梯子第 1 步，读懂了再答</span>}
          {/* 梯子的内容都批注在上面的原句里，这里只留一行告诉学生走到第几步 */}
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px]">
            <span className="text-[14px] font-semibold">读懂梯子</span>
            {(bd ? BREAKDOWN_STEPS : STEPS).map((title, i) => {
              const n = i + 1
              const opened = level >= n
              return (
                <span key={n} className={`flex items-center gap-1 ${opened ? 'font-semibold text-primary' : 'text-muted'}`}>
                  <span className={`flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-full text-[11px] ${opened ? 'bg-primary text-white' : 'border border-dim'}`}>{n}</span>
                  {title}
                  {!opened && n > view.maxLadderLevel && <Icon name="lock" size={12} />}
                </span>
              )
            })}
          </div>
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
          <Icon name="raise" />
          {level > 0 ? '再看提示' : '我卡住了'}
        </button>
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
            <span className="flex flex-col">
              <span className="font-serif text-[16px]">{e.text}</span>
              {exprZhShown(view, state, e.id) && <span className="text-[13px] text-muted">{e.zh}</span>}
            </span>
            <span className={`flex shrink-0 items-center gap-1 text-[13px] ${got ? 'text-green' : 'text-primary'}`}>
              {got && <Icon name="check" size={14} />}
              {got ? '已收进表达本' : '收进表达本'}
            </span>
          </button>
        )
      })}

      {note && !noteHidden && (
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
          {noteVisible && cover && <span className="text-[13px] text-muted">{cover}</span>}
          {noteVisible && <p className="m-0 text-[14px] leading-relaxed">{note}</p>}
        </div>
      )}
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
