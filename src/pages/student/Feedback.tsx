// ⑥ 反馈：太简单 / 刚好 / 太难，作为一条 feedback 事件提交。事件里只有这个评分，不收学生自己写的话（学生写的文字不进服务器的记录）
import { useState } from 'react'
import { btn } from '../../components/ui'
import type { Act } from '../../lib/store'

const RATINGS = ['太简单', '刚好', '太难']

// local：没选座号（内置讲义、只是看看、老师预览、演示画像），作答只在本机，感谢语不说「老师会看到」
export function Feedback({ act, local }: { act: Act; local: boolean }) {
  const [rating, setRating] = useState('')
  const [sent, setSent] = useState(false)

  if (sent) {
    return (
      <section className="flex flex-col gap-2 rounded-[14px] border border-line bg-surface p-5">
        <h1 className="m-0 text-[20px] font-bold">收到了，谢谢你</h1>
        <p className="m-0 text-[14px] leading-relaxed text-ink2">{local ? '这次的作答只存在本机，不会发给老师。' : '老师下节课会看到大家卡在哪里。'}</p>
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
      <button
        type="button"
        className={btn.primary}
        disabled={!rating}
        onClick={() => {
          act({ type: 'feedback', value: rating })
          setSent(true)
        }}
      >
        提交反馈
      </button>
    </>
  )
}
