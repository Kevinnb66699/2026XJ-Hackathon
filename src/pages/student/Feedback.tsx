// ⑥ 反馈：太简单 / 刚好 / 太难，加上可选的「我卡在这里，因为…」，作为一条 feedback 事件提交
import { useState } from 'react'
import { btn } from '../../components/ui'
import type { Act } from '../../lib/store'

const RATINGS = ['太简单', '刚好', '太难']

export function Feedback({ act }: { act: Act }) {
  const [rating, setRating] = useState('')
  const [why, setWhy] = useState('')
  const [sent, setSent] = useState(false)

  if (sent) {
    return (
      <section className="flex flex-col gap-2 rounded-[14px] border border-line bg-surface p-5">
        <h1 className="m-0 text-[20px] font-bold">收到了，谢谢你</h1>
        <p className="m-0 text-[14px] leading-relaxed text-ink2">老师下节课会看到大家卡在哪里。</p>
      </section>
    )
  }
  return (
    <>
      <h1 className="m-0 text-[22px] font-bold">这一篇对你来说……</h1>
      <div className="grid grid-cols-3 gap-2">
        {RATINGS.map((r) => (
          <button
            key={r}
            type="button"
            aria-pressed={rating === r}
            onClick={() => setRating(r)}
            className={`min-h-[50px] rounded-[14px] text-[16px] ${rating === r ? 'border-[1.5px] border-primary bg-primary-light font-semibold text-primary' : 'border border-line-strong bg-surface'}`}
          >
            {r}
          </button>
        ))}
      </div>
      <label htmlFor="why" className="text-[14px] font-semibold">
        我卡在这里，因为…（可以不填）
      </label>
      <textarea id="why" rows={3} value={why} onChange={(e) => setWhy(e.target.value)} className="w-full resize-none rounded-xl border border-line-strong bg-surface p-3 text-[15px]" />
      <button
        type="button"
        className={btn.primary}
        disabled={!rating}
        onClick={() => {
          act({ type: 'feedback', value: why.trim() ? `${rating}｜${why.trim().slice(0, 300)}` : rating })
          setSent(true)
        }}
      >
        提交反馈
      </button>
    </>
  )
}
