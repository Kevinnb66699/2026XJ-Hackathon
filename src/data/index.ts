// 讲义注册表。默认是团队自写的迷你讲义（tests/fixtures/mini-handout.ts，id mini-phones）；其他 id 是老师上传的讲义，从后端拉。
// 10-04 起，购买讲义（social-media）的原文和衍生数据已从仓库移除（版权）；旧链接 ?h=social-media 回到默认讲义，不报错。
import { Handout } from '../../shared/schema'
import { miniHandout } from '../../tests/fixtures/mini-handout'
import { getParams } from '../lib/router'
import { editKeyOf } from '../lib/store'

export const handouts: Handout[] = [miniHandout]
const RETIRED = ['social-media'] // 已下线的内置讲义 id：链接还在外面流传（二维码、聊天记录），打开时用默认讲义

// main.tsx 先 await loadCurrentHandout() 再渲染，页面里拿到的就是定下来的讲义
export let currentHandout: Handout = handouts[0]

// 内置讲义直接用，不发请求；否则 GET /api/handouts/<id>（10 秒超时），校验通过才用。失败时抛出中文提示。
// 没发布的讲义只有带对编辑口令（请求头 X-Edit-Key）才读得到：本机有这篇的口令就带上，老师发布前在新标签页里试做学生端也能打开
export async function loadCurrentHandout(): Promise<Handout> {
  const id = getParams().get('h')
  if (!id || RETIRED.includes(id)) return (currentHandout = handouts[0])
  const local = handouts.find((h) => h.id === id)
  if (local) return (currentHandout = local)
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 10000)
  let status = 0
  try {
    const key = editKeyOf(id)
    const res = await fetch(`/api/handouts/${encodeURIComponent(id)}`, { headers: key ? { 'X-Edit-Key': key } : undefined, signal: ctrl.signal })
    status = res.status
    if (res.ok) return (currentHandout = Handout.parse(await res.json()))
  } catch {
    // 断网、超时、内容不合格：都按加载失败处理
  } finally {
    clearTimeout(timer)
  }
  throw new Error(status === 404 ? '找不到这份讲义：链接不完整，或者老师还没有发布' : '讲义加载失败，请检查网络后刷新')
}
