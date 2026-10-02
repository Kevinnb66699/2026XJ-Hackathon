// ① 问卷：3 题，20 秒内做完。只决定先给哪种提示，不打等级。
import { useState } from 'react'
import type { Survey as SurveyT } from '../../../shared/schema'
import { btn } from '../../components/ui'

const GRADES = ['高一', '高二', '高三']
const CURRICULA = ['A-Level', 'IB', 'AP', '普通高中', '其他']
const STUCK: [SurveyT['stuckOn'], string][] = [
  ['words', '生词太多'],
  ['long_sentences', '长句读不懂'],
  ['paragraph_meaning', '段落意思抓不住'],
  ['author_view', '看不出作者的观点'],
]

const chip = (on: boolean) =>
  `min-h-[44px] rounded-full px-4 text-[15px] ${on ? 'border-[1.5px] border-primary bg-primary-light font-semibold text-primary' : 'border border-line-strong bg-surface text-ink'}`

export function Survey({ initial, onDone }: { initial?: SurveyT; onDone: (s: SurveyT) => void }) {
  const [grade, setGrade] = useState(initial?.grade ?? '')
  const [curriculum, setCurriculum] = useState(initial?.curriculum ?? '')
  const [stuckOn, setStuckOn] = useState<SurveyT['stuckOn'] | ''>(initial?.stuckOn ?? '')

  return (
    <>
      <div className="flex flex-col gap-1.5">
        <h1 className="m-0 text-[24px] font-bold">开始之前，3 个问题</h1>
        <p className="m-0 text-[14px] leading-relaxed text-ink2">大约 20 秒。之后边学边了解你，不用考试。</p>
      </div>

      <fieldset className="flex flex-col gap-2.5">
        <legend className="mb-2.5 text-[15px] font-semibold">1. 年级</legend>
        <div className="flex flex-wrap gap-2">
          {GRADES.map((g) => (
            <button key={g} type="button" aria-pressed={grade === g} className={`${chip(grade === g)} min-w-[72px]`} onClick={() => setGrade(g)}>
              {g}
            </button>
          ))}
        </div>
      </fieldset>

      <fieldset className="flex flex-col gap-2.5">
        <legend className="mb-2.5 text-[15px] font-semibold">2. 课程体系</legend>
        <div className="flex flex-wrap gap-2">
          {CURRICULA.map((c) => (
            <button key={c} type="button" aria-pressed={curriculum === c} className={chip(curriculum === c)} onClick={() => setCurriculum(c)}>
              {c}
            </button>
          ))}
        </div>
      </fieldset>

      <fieldset className="flex flex-col gap-2">
        <legend className="mb-2.5 text-[15px] font-semibold">3. 读外刊时，你通常卡在哪？</legend>
        {STUCK.map(([v, label]) => (
          <label
            key={v}
            className={`flex min-h-[48px] cursor-pointer items-center gap-2.5 rounded-xl px-3.5 text-[15px] ${stuckOn === v ? 'border-[1.5px] border-primary bg-primary-light font-semibold text-primary' : 'border border-line bg-surface'}`}
          >
            <input type="radio" name="stuck" className="h-[18px] w-[18px]" checked={stuckOn === v} onChange={() => setStuckOn(v)} />
            {label}
          </label>
        ))}
      </fieldset>

      <p className="m-0 text-[13px] leading-relaxed text-muted">这些只用来了解你，不会给你打等级。</p>
      <button type="button" className={btn.primary} disabled={!grade || !curriculum || !stuckOn} onClick={() => stuckOn && onDone({ grade, curriculum, stuckOn })}>
        开始读这篇
      </button>
    </>
  )
}
