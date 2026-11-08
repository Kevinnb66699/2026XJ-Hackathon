// 问卷：3 题（年级、课程体系、读英文主要为了什么），20 秒内做完。11-07 起不再是每篇的第一步，改成学生账号注册后做一次（看过找回码之后，可以跳过），
// 账号页随时可以改（都在 StudentLogin.tsx）。答案记在账号上（PUT /api/student/profile），只存答了的几项：
// 目标是高考时词卡多一类「高中新词」，年级定精读默认给哪些词加注释（阶段 7，账号页的开关关着时都不用）。不给学生打等级。
// 每个选项点一下选上，再点一下取消。选「普通高中」时目标默认高考，国际课程默认不选；自己点过目标以后就不再跟着课程体系改
import { useState } from 'react'
import { PROFILE_CURRICULA, PROFILE_GRADES, PROFILE_GOALS, type Profile } from '../../../shared/schema'
import { btn } from '../../components/ui'

type Goal = NonNullable<Profile['goal']>
export const GOAL_LABEL: Record<Goal, string> = { gaokao: '高考', abroad: '出国考试', interest: '课内和兴趣' }

// 选了课程体系以后，目标默认选什么：普通高中默认高考；国际课程和「其他」默认不选
export const defaultGoal = (curriculum?: Profile['curriculum']): Goal | undefined => (curriculum === '普通高中' ? 'gaokao' : undefined)

const chip = (on: boolean) =>
  `min-h-[44px] rounded-full px-4 text-[15px] ${on ? 'border-[1.5px] border-primary bg-primary-light font-semibold text-primary' : 'border border-line-strong bg-surface text-ink'}`

// doneLabel、skipLabel：注册后是「保存，去读文章」「跳过」，账号页是「保存」「不改了」
export function Survey({ initial, busy, doneLabel, skipLabel, onDone, onSkip }: {
  initial?: Profile
  busy?: boolean
  doneLabel: string
  skipLabel: string
  onDone: (p: Profile) => void
  onSkip: () => void
}) {
  const [grade, setGrade] = useState(initial?.grade)
  const [curriculum, setCurriculum] = useState(initial?.curriculum)
  const [goal, setGoal] = useState(initial?.goal)
  const [goalPicked, setGoalPicked] = useState(initial?.goal !== undefined) // 自己点过目标（或以前答过）

  const pickCurriculum = (c: Profile['curriculum']) => {
    const next = curriculum === c ? undefined : c
    setCurriculum(next)
    if (!goalPicked) setGoal(defaultGoal(next))
  }
  const pickGoal = (g: Goal) => {
    setGoal(goal === g ? undefined : g)
    setGoalPicked(true)
  }
  const answers: Profile = { ...(grade ? { grade } : {}), ...(curriculum ? { curriculum } : {}), ...(goal ? { goal } : {}) }

  return (
    <div className="flex flex-col gap-5">
      <p className="m-0 text-[14px] leading-relaxed text-ink2">
        大约 20 秒，可以跳过。答案记在你的账号上，用来决定词卡里要不要放「高中新词」，年级也用来调整精读的注释，课程体系只用来帮你先选好目标；不会给你打等级。在账号页随时可以改。
      </p>

      <fieldset className="flex flex-col gap-2.5">
        <legend className="mb-2.5 text-[15px] font-semibold">1. 年级</legend>
        <div className="flex flex-wrap gap-2">
          {PROFILE_GRADES.map((g) => (
            <button key={g} type="button" aria-pressed={grade === g} className={`${chip(grade === g)} min-w-[72px]`} onClick={() => setGrade(grade === g ? undefined : g)}>
              {g}
            </button>
          ))}
        </div>
      </fieldset>

      <fieldset className="flex flex-col gap-2.5">
        <legend className="mb-2.5 text-[15px] font-semibold">2. 课程体系</legend>
        <div className="flex flex-wrap gap-2">
          {PROFILE_CURRICULA.map((c) => (
            <button key={c} type="button" aria-pressed={curriculum === c} className={chip(curriculum === c)} onClick={() => pickCurriculum(c)}>
              {c}
            </button>
          ))}
        </div>
      </fieldset>

      <fieldset className="flex flex-col gap-2.5">
        <legend className="mb-2.5 text-[15px] font-semibold">3. 读英文主要为了</legend>
        <div className="flex flex-wrap gap-2">
          {PROFILE_GOALS.map((g) => (
            <button key={g} type="button" aria-pressed={goal === g} className={chip(goal === g)} onClick={() => pickGoal(g)}>
              {GOAL_LABEL[g]}
            </button>
          ))}
        </div>
      </fieldset>

      <div className="flex flex-wrap gap-3">
        <button type="button" className={btn.primary} disabled={busy} onClick={() => onDone(answers)}>
          {busy ? '正在保存……' : doneLabel}
        </button>
        <button type="button" className={btn.secondary} disabled={busy} onClick={onSkip}>
          {skipLabel}
        </button>
      </div>
    </div>
  )
}
