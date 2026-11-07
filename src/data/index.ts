// 讲义注册表。默认是团队自写的迷你讲义（tests/fixtures/mini-handout.ts，id mini-phones）；其他 id 是老师上传的讲义，从后端拉。
// 10-04 起，购买讲义（social-media）的原文和衍生数据已从仓库移除（版权）；旧链接 ?h=social-media 回到默认讲义，不报错。
import { Handout } from '../../shared/schema'
import { miniHandout } from '../../tests/fixtures/mini-handout'
import { getParams } from '../lib/router'

export const handouts: Handout[] = [miniHandout]
const RETIRED = ['social-media'] // 已下线的内置讲义 id：链接还在外面流传（二维码、聊天记录），打开时用默认讲义

// main.tsx 先 await loadCurrentHandout() 再渲染，页面里拿到的就是定下来的讲义
export let currentHandout: Handout = handouts[0]

// 加载失败：message 是给人看的中文提示；status 是 401、404，其他失败（断网、超时、服务器出错、内容不合格）是 0。main.tsx 按 401 显示登录入口
export class HandoutError extends Error {
  status: number
  constructor(message: string, status: number) {
    super(message)
    this.status = status
  }
}

// 内置讲义直接用，不发请求；否则 GET /api/handouts/<id>（10 秒超时），校验通过才用。失败时抛出 HandoutError。
// 没发布的讲义：团队上架的，学生登录后读得到；上传它的老师登录后也读得到（两种会话 cookie 都是同源请求默认带上的）。
// 没登录时后端一律回 401（不管有没有这篇），提示先登录；登录了还读不到是 404
export async function loadCurrentHandout(): Promise<Handout> {
  const id = getParams().get('h')
  if (!id || RETIRED.includes(id)) return (currentHandout = handouts[0])
  const local = handouts.find((h) => h.id === id)
  if (local) return (currentHandout = local)
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 10000)
  let status = 0
  try {
    const res = await fetch(`/api/handouts/${encodeURIComponent(id)}`, { signal: ctrl.signal })
    status = res.status
    if (res.ok) return (currentHandout = Handout.parse(await res.json()))
  } catch {
    // 断网、超时、内容不合格：都按加载失败处理
  } finally {
    clearTimeout(timer)
  }
  if (status === 401) throw new HandoutError('这篇文章要先登录才能读', 401)
  // 404：班级二维码的链接（带 c）是老师发布的，照旧说老师；别的是团队上架的文章，不提老师
  const missing = getParams().get('c') ? '找不到这份讲义：链接不完整，或者老师还没有发布' : '找不到这篇文章：链接不完整，或者已经下架了'
  throw new HandoutError(status === 404 ? missing : '讲义加载失败，请检查网络后刷新', status === 404 ? 404 : 0)
}
