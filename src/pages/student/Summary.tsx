// ⑥ 小结（10-16 起，原来的「反馈」）：最上面是难度评价，点一下就交（一条 feedback 事件，只有这个评分，不收学生自己写的话）；
// 下面用本机的学生状态算出这一篇是怎么读的（见 lib/report）：几句第一次就答对、没开提示、几段第一次就选对、生词，还没答对的句子给一个「接着读」。
// 不新增收集、不发给服务器；不说进步、分数（团队口径：一篇文章证明不了进步）。还没答对的句子用中性色，不用表示「错」的珊瑚色
import { useMemo, useState } from 'react'
import type { Handout } from '../../../shared/schema'
import type { StudentState } from '../../engine/types'
import { Icon, btn, card } from '../../components/ui'
import { handoutReport } from '../../lib/report'
import type { Act } from '../../lib/store'

const RATINGS = ['太简单', '刚好', '太难']
const WORDS_SHOWN = 10 // 生词先列 10 个，多的点「全部」

// 句子开头几个词，太长的截掉
const head = (t: string) => (t.split(' ').length <= 7 ? t : `${t.split(' ').slice(0, 6).join(' ').replace(/[,;:]$/, '')}…`)

// local：没选学号（内置讲义、只是看看、老师预览、演示画像），作答只在本机
export function Summary({ h, state, act, local, onRead, onStart }: {
  h: Handout
  state: StudentState
  act: Act
  local: boolean
  onRead: (sentenceId: string) => void
  onStart: () => void
}) {
  const [rating, setRating] = useState('')
  const [allWords, setAllWords] = useState(false)
  const r = useMemo(() => handoutReport(h, state), [h, state])
  const rate = (x: string) => {
    if (x === rating) return
    act({ type: 'feedback', value: x })
    setRating(x)
  }
  const stats = [
    ...(r.close.total ? [['精读', r.close.answered ? `${r.close.own} / ${r.close.answered}` : '', r.close.answered ? '句第一次就答对、没开提示' : '还没答题']] : []),
    ['粗读', r.gist.answered ? `${r.gist.first} / ${r.gist.answered}` : '', r.gist.answered ? '段第一次就选对' : '还没答题'],
    ['生词', String(r.words.length), '个'],
  ]
  const words = allWords ? r.words : r.words.slice(0, WORDS_SHOWN)

  return (
    <>
      <h1 className="m-0 text-[22px] font-bold">这一篇的小结</h1>

      <section className={`${card} flex flex-col gap-3 p-4`}>
        <span className="text-[15px] font-semibold">这一篇对你来说……</span>
        <div className="grid grid-cols-3 gap-2">
          {RATINGS.map((x) => (
            <button
              key={x}
              type="button"
              aria-pressed={rating === x}
              onClick={() => rate(x)}
              className={`min-h-[46px] rounded-xl text-[15px] ${rating === x ? 'border-[1.5px] border-primary bg-primary-light font-semibold text-primary' : 'border border-line-strong bg-surface'}`}
            >
              {x}
            </button>
          ))}
        </div>
        {rating && <span className="text-[13px] text-ink2">收到了，谢谢你。</span>}
      </section>

      {!r.started ? (
        <section className={`${card} flex flex-col items-start gap-3 p-4`}>
          <p className="m-0 text-[15px] leading-relaxed">这一篇你还没开始读。</p>
          <button type="button" className={btn.secondary} onClick={onStart}>
            从粗读开始
          </button>
        </section>
      ) : (
        <>
          <section className={`${card} grid divide-y divide-line-soft px-4`}>
            {stats.map(([name, n, what]) => (
              <div key={name} className="flex items-baseline gap-3 py-3 text-[15px]">
                <span className="w-9 shrink-0 text-[13px] text-muted">{name}</span>
                {n && <span className="text-[20px] font-bold">{n}</span>}
                <span className="text-ink2">{what}</span>
              </div>
            ))}
          </section>

          {r.pending.length > 0 && (
            <section className={`${card} flex flex-col gap-2.5 p-4`}>
              <span className="text-[15px] font-semibold">还没答对、还没答的句子</span>
              {r.pending.slice(0, 5).map((p) => (
                <div key={p.id} className="flex items-baseline gap-2 text-[14px]">
                  <span className="shrink-0 text-[13px] text-muted">第 {p.paragraph} 段</span>
                  <span className="min-w-0 flex-1 truncate font-serif text-[15px]">{head(p.text)}</span>
                  <span className="shrink-0 text-[13px] text-ink2">{p.status === 'wrong' ? '还没答对' : '还没答'}</span>
                </div>
              ))}
              {r.pending.length > 5 && <span className="text-[13px] text-muted">还有 {r.pending.length - 5} 句</span>}
              <button type="button" className={`${btn.secondary} mt-1`} onClick={() => onRead(r.pending[0].id)}>
                接着读
              </button>
            </section>
          )}

          {r.words.length > 0 && (
            <section className={`${card} flex flex-col gap-2.5 p-4`}>
              <span className="text-[15px] font-semibold">这一篇的生词</span>
              <div className="flex flex-wrap gap-2">
                {words.map((w) => (
                  <span key={w.lemma} className="rounded-full border border-line px-3 py-1 text-[14px]">
                    <span className="font-serif text-[15px]">{w.lemma}</span> <span className="text-ink2">{w.zh}</span>
                  </span>
                ))}
              </div>
              {r.words.length > WORDS_SHOWN && (
                <button type="button" className={`${btn.small} self-start`} onClick={() => setAllWords(!allWords)}>
                  {allWords ? '收起' : `全部 ${r.words.length} 个`}
                </button>
              )}
            </section>
          )}
        </>
      )}

      <div className="flex flex-col gap-1 pt-1 text-[13px] text-muted">
        <span className="flex items-center gap-2 text-ink2">
          <Icon name="cheese" className="text-amber" />
          慢慢嚼，味道才出来。
        </span>
        {local && <span>这次的作答只存在本机，不会发给老师。</span>}
      </div>
    </>
  )
}
