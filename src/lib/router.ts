// 自写 hash 路由：#/ 入口、#/student、#/teacher、#/judge、#/upload。参数可以写在 ?… 或 #/…?… 里。
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
