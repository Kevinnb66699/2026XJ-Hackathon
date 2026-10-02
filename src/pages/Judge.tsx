// 评委模式：先做 3 道快题，再把「评委的这一份」和预设同学 B 并排显示。
// 快题的选法是为了让大多数成年人至少错一道，「你的这一份」才会和原文不同：
//   ① 打卡句里的熟词僻义（真实讲义里是 pending）先猜后看 → 答错就记成猜错、标成不认识，精读里出现「给你」便签和注释；
//   ② 跨天复现的 appositive_that 标签句的原句题（S16）→ 答对就收起老师讲解，后面同类句子「先自己试」；
//   ③ inversion 标签句的原句题（S04）。不够的话用讲义前面的原句题补齐。
// 评委的作答会回流到老师端；同学 B 只在内存里，可以点，但不存、不回流。
// 快题的选项提交前可以随便改（点错能改），三题选完点「看你的这一份」才一起记录。
import { useMemo, useState } from 'react'
import type { Handout, Sentence, Word } from '../../shared/schema'
import { CloseReading, personalWord, tryFirstOf } from '../components/SentenceCard'
import { Choices, Icon, Pill, btn, card, serifText } from '../components/ui'
import { currentHandout as h } from '../data'
import { PRESET_NAME, presetState } from '../data/presets'
import { personalize } from '../engine'
import { collectExpression, useMemoryStudent, useStudent } from '../lib/store'

interface QuizItem {
  key: string
  sentence: Sentence
  prompt: string
  options: string[]
  answer: number
  word?: Word
}

function pickQuiz(hd: Handout): QuizItem[] {
  const sentenceOf = (id: string) => hd.sentences.find((x) => x.id === id)
  const items: QuizItem[] = []
  const withQ = hd.sentences.filter((x) => x.question)
  const appos = withQ.filter((x) => x.tag === 'appositive_that')
  // 熟词僻义优先取 appositive_that 题所在段落的打卡句（真实讲义：第 4 段 S17 的 pending），评委的这一份集中在一段里
  const focusPara = appos[appos.length - 1]?.paragraph
  const inPara = (w: Word, para?: number) => w.sentenceIds.some((id) => sentenceOf(id)?.checkIn && (para === undefined || sentenceOf(id)?.paragraph === para))
  const traps = hd.words.filter((w) => w.familiarTrap && w.guess)
  const trap = traps.find((w) => inPara(w, focusPara)) ?? traps.find((w) => inPara(w)) ?? traps[0]
  const trapSentence = trap && sentenceOf(trap.sentenceIds[0])
  if (trap?.guess && trapSentence) items.push({ key: `w:${trap.lemma}`, sentence: trapSentence, prompt: trap.guess.prompt, options: trap.guess.options, answer: trap.guess.answer, word: trap })
  const wanted = [appos[appos.length - 1], withQ.find((x) => x.tag === 'inversion'), ...withQ]
  for (const x of wanted) {
    if (items.length >= 3) break
    if (x && !items.some((it) => it.sentence.id === x.id && !it.word)) items.push({ key: `s:${x.id}`, sentence: x, prompt: x.question!.prompt, options: x.question!.options, answer: x.question!.answer })
  }
  return items
}

export default function JudgePage() {
  const judge = useStudent(h, 'judge')
  const b = useMemoryStudent(h, () => presetState(h, 'B'))
  const quiz = useMemo(() => pickQuiz(h), [])
  const answered = (it: QuizItem) => (it.word ? !!judge.state.wordMarks[it.word.lemma] : !!judge.state.answers[it.sentence.question!.id])
  const correctOf = (it: QuizItem) => (it.word ? judge.state.wordMarks[it.word.lemma] === 'known' : !!judge.state.answers[it.sentence.question!.id]?.firstTryCorrect)
  const done = quiz.every(answered)
  const [seen, setSeen] = useState(done)
  const [picked, setPicked] = useState<Record<string, number>>({}) // 现在选的，提交前可以改
  const left = quiz.filter((it) => !answered(it) && picked[it.key] === undefined).length
  const view = useMemo(() => personalize(h, judge.state), [judge.state])
  const bView = useMemo(() => personalize(h, b.state), [b.state])

  // 展位只看一段：第一道快题（熟词僻义）所在的段落，真实讲义里是第 4 段（S16、S17）
  const paragraphs = quiz.length ? [quiz[0].sentence.paragraph] : undefined
  // 只并排显示这一段里出过快题的句子（真实讲义：S16、S17），30 秒内看得完
  const only = paragraphs ? [...new Set(quiz.filter((it) => it.sentence.paragraph === paragraphs[0]).map((it) => it.sentence.id))].sort() : undefined

  // 手机上两份的差别在一屏半以下，结果下面先用一行说清楚：和卡片用同一份数据算，最多两条。
  // 卡片上不显示句子编号，用题号指句子
  const name = (id: string) => `第\u00a0${quiz.findIndex((it) => it.sentence.id === id) + 1}\u00a0题那句` // 不换行空格：手机上「第 2 题」不被拆开
  const shown = view.sentences.filter((x) => only?.includes(x.id))
  const bOf = (id: string) => bView.sentences.find((x) => x.id === id)!
  const lv = (ladder: Record<string, number>, id: string) => ladder[id] ?? 0
  const diff = [
    ...shown.filter((x) => personalWord(h, x, judge.state) && !personalWord(h, bOf(x.id), b.state)).map((x) => `${name(x.id)}多了一张写给你的便签`),
    ...shown.flatMap((x) =>
      // 卡片上要真的显示「讲解已收起」：有老师讲解
      x.teacherNote && x.teacherNoteCollapsed && !bOf(x.id).teacherNoteCollapsed
        ? [`${name(x.id)}你第一次就读懂，讲解已收起`]
        : lv(judge.state.ladder, x.id) > lv(b.state.ladder, x.id)
          ? [`${name(x.id)}给你打开了梯子第 ${lv(judge.state.ladder, x.id)} 步`]
          : [],
    ),
    ...shown.filter((x) => tryFirstOf(bOf(x.id), b.state) && !tryFirstOf(x, judge.state)).map((x) => `B 的${name(x.id)}要先自己试`),
  ].slice(0, 2)

  const record = (it: QuizItem, i: number) => {
    if (answered(it)) return
    const correct = i === it.answer
    if (it.word) {
      // 先记先猜后看的作答（答错 = 第一次猜错，便签和老师端都说「猜错了」），再记卡片标记（答错 = 不认识）；
      // 精读里会出现「给你」便签和注释
      judge.act({ type: 'answer_question', lemma: it.word.lemma, correct, firstTry: true })
      judge.act({ type: 'word_card', lemma: it.word.lemma, value: correct ? 'known' : 'unknown' })
      return
    }
    const x = it.sentence
    judge.act({ type: 'answer_question', sentenceId: x.id, correct, firstTry: true })
    if (!correct && x.ladder) judge.act({ type: 'open_ladder', sentenceId: x.id, level: 1 }) // 答错：你的这一份里直接打开第 1 步
  }
  const submit = () => {
    for (const it of quiz) if (picked[it.key] !== undefined) record(it, picked[it.key])
    setSeen(true)
    window.scrollTo(0, 0)
  }
  const resetAll = () => {
    judge.reset()
    b.reset()
    setPicked({})
    setSeen(false)
  }

  return (
    <div className="min-h-screen bg-ground">
      <header className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-line bg-surface px-4 py-3.5 sm:px-8">
        <a href="#/" className="inline-flex items-center gap-2 text-[20px] font-bold tracking-wider text-ink">
          <img src="/logo.png" alt="" width={28} height={28} className="h-7 w-7 object-contain" />
          知适 · 评委模式
        </a>
        <span className="order-last w-full text-[15px] text-ink2 sm:order-none sm:w-auto sm:flex-1">同一份讲义，原文一字不改，每个人拿到的梯子不同</span>
        {/* 评委做完想回首页看别的入口：顶栏里放一个明显的按钮（标题虽然也能点，但看不出来）。手机上和「重置演示」排在第一行，标题在第二行 */}
        <a href="#/" className={`${btn.secondary} order-first inline-flex items-center gap-1.5 font-semibold text-primary no-underline sm:order-none sm:ml-auto`}>
          <Icon name="back" size={16} />
          返回首页
        </a>
        <button type="button" className={`${btn.secondary} order-first ml-auto sm:order-none sm:ml-0`} onClick={resetAll}>
          重置演示
        </button>
      </header>

      {!seen ? (
        <main className="mx-auto flex max-w-2xl flex-col gap-4 px-4 py-6">
          <div className="flex flex-col gap-1.5">
            <h1 className="m-0 text-[22px] font-bold">先做 3 道快题</h1>
            <p className="m-0 text-[14px] text-ink2">每题读一句原文，选出它的意思，提交前可以改。三题选完，马上看到「你的这一份」。</p>
          </div>
          {quiz.map((it, k) => (
            <section key={it.key} className={`${card} flex flex-col gap-3 p-4`}>
              <span className="text-[13px] text-muted">
                第 {k + 1} / {quiz.length} 题
              </span>
              <p className={`m-0 ${serifText}`}>{it.sentence.text}</p>
              <span className="text-[15px] font-semibold">{it.prompt}</span>
              <Choices
                options={it.options}
                answer={it.answer}
                picked={picked[it.key] ?? null}
                pending={!answered(it)}
                onPick={(i) => setPicked((p) => ({ ...p, [it.key]: i }))}
                locked={answered(it)}
              />
            </section>
          ))}
          <button type="button" className={btn.primary} disabled={left > 0} onClick={submit}>
            看你的这一份
          </button>
          {left > 0 && <span className="text-center text-[13px] text-muted">还有 {left} 题没选</span>}
        </main>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2 border-b border-line bg-surface px-4 py-3 text-[14px] sm:px-8">
            <span className="font-semibold">你刚才的 3 道题：</span>
            {quiz.map((it, k) => {
              const ok = correctOf(it)
              // 题目是英文长句，放进胶囊会折成好几行；这里只写题号（词义题带上这个词）
              return (
                <Pill key={it.key} tone={ok ? 'green' : 'red'}>
                  第 {k + 1} 题{it.word ? ` · “${it.word.lemma}”` : ''} · {ok ? '答对' : '没答对'}
                </Pill>
              )
            })}
            {diff.length > 0 && <p className="m-0 w-full font-semibold text-primary">和同学 B 比：{diff.join('；')}</p>}
          </div>
          <main key={`${judge.state.sid}:${judge.epoch}`} className="mx-auto grid max-w-7xl gap-5 px-4 py-5 sm:px-8 lg:grid-cols-2">
            {/* 手机上两份上下排，同学 B 的那份在一屏多以下，顶上给个提示 */}
            <button type="button" className={`${btn.secondary} lg:hidden`} onClick={() => document.getElementById('judge-b')?.scrollIntoView({ behavior: 'smooth', block: 'start' })}>
              往下看同学 B 的这一份 ↓
            </button>
            <div className="flex flex-col gap-3.5 rounded-2xl border-[1.5px] border-primary p-4">
              <h2 className="m-0 text-[18px] font-bold text-primary">评委的这一份</h2>
              <CloseReading h={h} view={view} state={judge.state} act={judge.act} onCollect={(id) => judge.patch(collectExpression(id))} paragraphs={paragraphs} only={only} />
            </div>
            <div id="judge-b" className="flex flex-col gap-3.5 rounded-2xl border border-line p-4">
              <h2 className="m-0 text-[18px] font-bold">{PRESET_NAME.B}的这一份</h2>
              <CloseReading h={h} view={bView} state={b.state} act={b.act} onCollect={(id) => b.patch(collectExpression(id))} paragraphs={paragraphs} only={only} />
            </div>
          </main>
          <footer className="mx-auto flex max-w-7xl flex-wrap items-center gap-4 px-4 pb-8 text-[14px] sm:px-8">
            <span className="font-semibold">原文一字不改 · 终点相同 · 梯子不同</span>
            <span className="flex-1" />
            <a href="#/teacher" className="flex items-center gap-1.5 text-green">
              <span className="h-2 w-2 rounded-full bg-green" />
              你的作答会计入老师端热力图
            </a>
          </footer>
        </>
      )}
    </div>
  )
}
