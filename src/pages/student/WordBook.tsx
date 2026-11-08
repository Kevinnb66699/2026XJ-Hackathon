// #/notebook 单词本（要登录）：读过的每一篇里不认识的词（粗读点过、标了不认识、第一次猜错，减去标了认识的），同一个词合并成一条、写上出自哪几篇。
// 服务器从这个账号的事件推算（GET /api/student/notebook），本机不另存。每条显示词、词性、中文（AI 生成的带标签）、出自哪篇，可以「移出单词本」（drop_word；
// 之后在哪一篇里又不认识这个词，服务器会重新加进来）。
// 复习一轮最多 10 张（REVIEW_SIZE），顺序见 lib/notebook 的 reviewOrder；卡片照词汇那一步：意思先盖住，点了才显示，下面「还不认识 / 认识」（review_word），用原文例句帮着回想。
// 只说发生了什么：不数认识了几个，不显示难度等级。
// 账号上的目标是高考、账号页的开关「按我以前的记录调整提示」开着时（GET /api/student/profile，同读文章时的 getLearner），高中新词（syllabusNew）在列表和复习卡上贴「高中新词」标签，
// 页面上说一句范围；开关关着、拉不到答案就不贴（账号页说的「关掉上面的开关就不用」）
import { Fragment, useEffect, useState } from 'react'
import { NOTEBOOK_ID } from '../../../shared/schema'
import { NotebookPage, NotebookStatus, articleHref, useNotebook } from '../../components/NotebookPage'
import { RichText } from '../../components/SentenceCard'
import { AiTag, NEW_WORD_NOTE, NewWordTag, btn, card } from '../../components/ui'
import { REVIEW_SIZE, reviewOrder } from '../../lib/notebook'
import { getLearner, type NotebookWord } from '../../lib/student-auth'
import { markWords, segment } from '../../lib/text'

export default function WordBookPage() {
  return (
    <NotebookPage label="单词本" here="#/notebook">
      {(me) => <WordBook sid={me.sid} />}
    </NotebookPage>
  )
}

function WordBook({ sid }: { sid: string }) {
  const { data, error, unsent, record, refresh, update } = useNotebook(sid)
  const [deck, setDeck] = useState<NotebookWord[] | null>(null) // 正在复习的这一轮：开始时定下，复习的过程中不变
  const [round, setRound] = useState(0)
  const [notice, setNotice] = useState('')
  const [gaokao, setGaokao] = useState(false) // 目标是高考、开关开着：高中新词贴标签
  useEffect(() => {
    let alive = true
    getLearner().then(
      (p) => alive && setGaokao(p?.goal === 'gaokao'),
      () => undefined, // 拉不到就不贴；没登录的提示由单词本那次请求给
    )
    return () => {
      alive = false
    }
  }, [])

  const start = (words: NotebookWord[]) => {
    setDeck(reviewOrder(words).slice(0, REVIEW_SIZE))
    setRound(round + 1)
    setNotice('')
  }
  const review = (w: NotebookWord, correct: boolean) => {
    record({ handoutId: NOTEBOOK_ID, type: 'review_word', lemma: w.lemma, correct })
    // 页面上先记下这次的结果：再复习一轮时顺序就对，不用等服务器
    const lastReview = { ts: Date.now(), correct }
    update((n) => ({ ...n, words: n.words.map((x) => (x.lemma === w.lemma ? { ...x, lastReview } : x)) }))
  }
  const drop = (w: NotebookWord) => {
    record({ handoutId: NOTEBOOK_ID, type: 'drop_word', lemma: w.lemma })
    update((n) => ({ ...n, words: n.words.filter((x) => x.lemma !== w.lemma) }))
    setNotice(`移出了 ${w.lemma}。以后读文章时又不认识它，会重新加进来。`)
    void refresh()
  }

  if (data && deck)
    return (
      <Review
        key={round}
        deck={deck}
        gaokao={gaokao}
        onMark={review}
        onRound={() => void refresh()}
        onAgain={() => start(data.words)}
        onEnd={() => {
          setDeck(null)
          void refresh()
        }}
      />
    )

  const words = data?.words ?? [] // 服务器排好了：最近加进来的在上面
  return (
    <>
      <h1 className="m-0 text-[22px] font-bold">单词本</h1>
      <p className="m-0 text-[15px] leading-relaxed text-ink2">读团队选的文章和自己贴的文章时不认识的词都攒在这里：粗读时点过的、标了「不认识」的、第一次猜错的。同一个词在几篇里都有，只记一条。</p>
      <NotebookStatus data={data} error={error} unsent={unsent} />
      {gaokao && words.some((w) => w.syllabusNew) && <p className="m-0 text-[13px] leading-relaxed text-muted">{NEW_WORD_NOTE}</p>}
      {notice && (
        <p role="status" className="m-0 text-[14px] text-ink2">
          {notice}
        </p>
      )}
      {data && !words.length && (
        <section className={`${card} flex flex-col items-start gap-3 p-4`}>
          <p className="m-0 text-[15px] leading-relaxed">单词本还是空的。读团队选的文章和自己贴的文章时不认识的词，会自动加进来。</p>
          <a href="#/" className={`${btn.secondary} inline-flex items-center no-underline`}>
            去选一篇文章
          </a>
        </section>
      )}
      {words.length > 0 && (
        <>
          <section className={`${card} flex flex-col items-start gap-2 p-4`}>
            <button type="button" className={btn.primary} onClick={() => start(words)}>
              复习一轮
            </button>
            <span className="text-[13px] leading-relaxed text-muted">一轮最多 {REVIEW_SIZE} 张：上次点了「还不认识」的先出，然后是还没复习过的。</span>
          </section>
          <ul className={`${card} m-0 flex list-none flex-col px-4 py-1`}>
            {words.map((w) => (
              <li key={w.lemma} className="flex flex-col gap-1 border-b border-line-soft py-3 last:border-b-0">
                <div className="flex items-start justify-between gap-3">
                  <span className="min-w-0 pt-1.5 font-serif text-[18px] font-semibold leading-snug [overflow-wrap:anywhere]">
                    {w.lemma}
                    {w.pos && <span className="ml-1.5 font-sans text-[13px] font-normal text-muted">{w.pos}</span>}
                    {gaokao && w.syllabusNew && (
                      <span className="ml-2 align-[2px] font-sans">
                        <NewWordTag />
                      </span>
                    )}
                  </span>
                  <button type="button" onClick={() => drop(w)} className="flex min-h-[36px] shrink-0 items-center text-[13px] text-muted underline hover:text-ink">
                    移出单词本
                  </button>
                </div>
                <span className="text-[15px] text-ink2">
                  {w.zh}
                  {w.ai && <AiTag className="ml-1.5 align-[1px]" />}
                </span>
                <Sources w={w} link />
              </li>
            ))}
          </ul>
        </>
      )}
    </>
  )
}

// 出自哪几篇。列表里可以点开那一篇；复习卡上不放链接，免得点了就离开这一轮
function Sources({ w, link = false }: { w: NotebookWord; link?: boolean }) {
  if (!w.sources.length) return null
  return (
    <span className="text-[13px] leading-relaxed text-muted">
      出自：
      {w.sources.map((s, k) => (
        <Fragment key={s.handoutId}>
          {k > 0 && '、'}
          {link ? (
            <a href={articleHref(s.handoutId)} className="text-primary underline">
              {s.title}
            </a>
          ) : (
            s.title
          )}
        </Fragment>
      ))}
    </span>
  )
}

// 一轮复习。onMark：点了「还不认识 / 认识」；onRound：这一轮最后一张点完了（发完再拉）；onAgain：再来一轮；onEnd：回到单词本。gaokao：高中新词贴标签
function Review({ deck, gaokao, onMark, onRound, onAgain, onEnd }: {
  deck: NotebookWord[]
  gaokao: boolean
  onMark: (w: NotebookWord, correct: boolean) => void
  onRound: () => void
  onAgain: () => void
  onEnd: () => void
}) {
  const [i, setI] = useState(0)
  const [peek, setPeek] = useState(false)
  const w = deck[i]

  if (!w)
    return (
      <section className="flex flex-col gap-3 rounded-[18px] border border-line bg-surface px-[18px] py-5">
        <h1 className="m-0 text-[20px] font-bold">这一轮看完了</h1>
        <p className="m-0 text-[14px] leading-relaxed text-ink2">点了「还不认识」的词，下一轮会先出。</p>
        <button type="button" className={btn.primary} onClick={onAgain}>
          再复习一轮
        </button>
        <button type="button" className={btn.secondary} onClick={onEnd}>
          回到单词本
        </button>
      </section>
    )

  const mark = (correct: boolean) => {
    onMark(w, correct)
    setI(i + 1)
    setPeek(false)
    if (i + 1 === deck.length) onRound()
  }
  const example = w.example?.text

  return (
    <>
      <div className="flex flex-col gap-1.5">
        <div className="flex justify-between text-[13px] text-ink2">
          <span>复习单词本</span>
          <span>
            {i + 1} / {deck.length}
          </span>
        </div>
        <div className="h-1.5 rounded-full bg-line">
          <div className="h-1.5 rounded-full bg-primary" style={{ width: `${((i + 1) / deck.length) * 100}%` }} />
        </div>
      </div>

      <section key={w.lemma} className="flex flex-col gap-4 rounded-[18px] border border-line bg-surface px-[18px] py-5">
        {gaokao && w.syllabusNew && (
          <span className="self-start">
            <NewWordTag />
          </span>
        )}
        {/* 手机上字小一点：counterproductive 这类长词在 360 宽里放得下一行，更长的才折行 */}
        <h1 className="m-0 font-serif text-[28px] font-semibold [overflow-wrap:anywhere] sm:text-[34px]">
          {w.lemma}
          {w.pos && (
            <>
              {' '}
              <span className="ml-1 font-sans text-[15px] font-normal text-muted">{w.pos}</span>
            </>
          )}
        </h1>
        {/* 原文例句照原文显示，词原样出现时加粗 */}
        {example && (
          <div className="flex flex-col gap-1">
            <span className="text-[12px] text-muted">原文例句</span>
            <p className="m-0 font-serif text-[18px] leading-[1.7] text-[#2B312E]">
              <RichText segs={segment(example, markWords(example, [{ lemma: w.lemma, forms: [w.lemma] }], 'bold'))} />
            </p>
          </div>
        )}
        {peek ? (
          <div className="flex flex-col gap-1 rounded-xl bg-ground px-3.5 py-3">
            <span className="text-[15px] font-semibold">
              {w.zh}
              {w.ai && <AiTag className="ml-2 align-[2px]" />}
            </span>
          </div>
        ) : (
          <button type="button" className={btn.secondary} onClick={() => setPeek(true)}>
            看意思
          </button>
        )}
        <Sources w={w} />
        {gaokao && w.syllabusNew && <span className="text-[12px] leading-relaxed text-muted">{NEW_WORD_NOTE}</span>}
      </section>

      <div className="grid grid-cols-2 gap-2.5">
        <button type="button" className={btn.secondary} onClick={() => mark(false)}>
          还不认识
        </button>
        <button type="button" className={btn.primary} onClick={() => mark(true)}>
          认识
        </button>
      </div>
      <button type="button" className={`${btn.small} self-start`} onClick={onEnd}>
        先不复习了
      </button>
    </>
  )
}
