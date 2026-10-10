// 自写 hash 路由：#/ 入口、#/student、#/teacher、#/judge、#/upload、#/login（老师登录、注册）、#/classes（老师的班级和名单）、#/next（下一版讲义预览）、#/privacy（隐私说明，?s=minors 滚到「不满 14 周岁的学生」那一节）。参数可以写在 ?… 或 #/…?… 里。
import { useEffect, useState } from 'react'

export function useHash(): string {
  const [hash, setHash] = useState(window.location.hash)
  useEffect(() => {
    const on = () => setHash(window.location.hash)
    window.addEventListener('hashchange', on)
    return () => window.removeEventListener('hashchange', on)
  }, [])
  return hash
}

export const pathOf = (hash: string) => hash.replace(/^#/, '').split('?')[0] || '/'

export function getParams(): URLSearchParams {
  const p = new URLSearchParams(window.location.search)
  const q = window.location.hash.split('?')[1]
  if (q) new URLSearchParams(q).forEach((v, k) => p.set(k, v))
  return p
}

export const go = (hash: string) => {
  window.location.hash = hash
}
