// 老师侧页面（上传、老师端、班级、登录）顶栏右边的账号：登录了显示「班级」入口、称呼和「退出」，退出后回到登录页；没登录显示「老师登录」，登录后回到这一页。
// 学生端和首页不放。还在问后端时什么都不显示，免得闪一下「老师登录」
import { loginHref, logout, useMe } from '../lib/auth'
import { go } from '../lib/router'
import { btn } from './ui'

export default function Account() {
  const { loading, teacher } = useMe()
  if (loading) return null
  if (!teacher)
    return (
      <a href={loginHref(window.location.hash || '#/')} className={`${btn.small} inline-flex items-center`}>
        老师登录
      </a>
    )
  const out = () =>
    logout().then(
      () => go('#/login'),
      (e: Error) => window.alert(e.message),
    )
  return (
    <>
      <a href="#/classes" className="flex min-h-[36px] shrink-0 items-center text-[13px] text-primary underline">
        班级
      </a>
      {/* 手机上顶栏放不下长称呼：截断，完整的用户名放在悬停提示里 */}
      <span title={teacher.username} className="max-w-[5em] truncate text-[13px] text-ink2 sm:max-w-[10em]">
        {teacher.name}
      </span>
      {/* data-leave：上传页有没保存的讲解、题目改动时，和站内链接一样先问（问的人在捕获阶段 preventDefault，这里就不退出） */}
      <button
        type="button"
        data-leave
        onClick={(e) => {
          if (!e.defaultPrevented) void out()
        }}
        className="min-h-[36px] text-[13px] text-muted underline hover:text-ink"
      >
        退出
      </button>
    </>
  )
}
