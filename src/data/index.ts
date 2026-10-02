// 讲义注册表。默认是老师的真实讲义（data/handouts/social-media.json，入库管线产物）；
// URL 带 ?h=mini-phones 时切到团队自写的迷你讲义；其他 id 是老师上传的讲义，从后端拉。
import { Handout } from '../../shared/schema'
import socialMedia from '../../data/handouts/social-media.json'
import { miniHandout } from '../../tests/fixtures/mini-handout'
import { getParams } from '../lib/router'

export const handouts: Handout[] = [Handout.parse(socialMedia), miniHandout]

// main.tsx 先 await loadCurrentHandout() 再渲染，页面里拿到的就是定下来的讲义
export let currentHandout: Handout = handouts[0]

// 内置讲义直接用，不发请求；否则 GET /api/handouts/<id>（10 秒超时），校验通过才用。失败时抛出中文提示
export async function loadCurrentHandout(): Promise<Handout> {
  const id = getParams().get('h')
  if (!id) return (currentHandout = handouts[0])
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
  throw new Error(status === 404 ? '找不到这份讲义，请确认链接是否完整' : '讲义加载失败，请检查网络后刷新')
}
