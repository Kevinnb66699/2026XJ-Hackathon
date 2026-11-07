// 学生侧顶栏右边（首页、用账号读的文章）：登录了显示用户名，点进账号页（#/me）；没登录显示「登录」，登录后回到这一页。
// 还在问后端时什么都不显示，免得闪一下「登录」。和老师顶栏（components/Account）分开：不引用老师的 lib/auth
import { loginHref, useStudentMe } from '../lib/student-auth'
import { btn } from './ui'

export default function StudentBar() {
  const { loading, student } = useStudentMe()
  if (loading) return null
  if (!student)
    return (
      <a href={loginHref(window.location.hash || '#/')} className={`${btn.small} inline-flex items-center`}>
        登录
      </a>
    )
  // 手机上顶栏放不下长用户名：截断，完整的放在悬停提示里
  return (
    <a href="#/me" title={student.username} className="block max-w-[7em] truncate py-2 text-[13px] leading-5 text-ink2 underline sm:max-w-[12em]">
      {student.username}
    </a>
  )
}
