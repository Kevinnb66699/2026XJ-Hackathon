// 老师侧页面（上传、老师端、班级、使用指南，以及登录后的登录页）顶栏右边的账号：登录了显示「使用指南」（只在电脑上）、「班级」入口、称呼和「退出」，
// 退出后回到登录页；没登录显示「使用指南」和「老师登录」，登录后回到这一页。学生端和首页不放。还在问后端时什么都不显示，免得闪一下「老师登录」
import { loginHref, logout, useMe } from '../lib/auth'
import { go } from '../lib/router'
import { Short, btn } from './ui'

// 指南页自己的顶栏不再放指向自己的链接。登录后顶栏东西多，360 宽的手机放不下，只在电脑上显示（手机上从首页和各页的提示进指南）
const GuideLink = ({ wide = false }: { wide?: boolean }) =>
  window.location.hash.startsWith('#/guide') ? null : (
    <a href="#/guide" className={`${wide ? 'hidden sm:flex' : 'flex'} min-h-[36px] shrink-0 items-center text-[13px] text-primary underline`}>
      <Short full="使用指南" short="指南" />
    </a>
  )

export default function Account() {
  const { loading, teacher } = useMe()
  if (loading) return null
  if (!teacher)
    return (
      <>
        <GuideLink />
        <a href={loginHref(window.location.hash || '#/')} className={`${btn.small} inline-flex items-center`}>
          老师登录
        </a>
      </>
    )
  const out = () =>
    logout().then(
      () => go('#/login'),
      (e: Error) => window.alert(e.message),
    )
  return (
    <>
      <GuideLink wide />
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
