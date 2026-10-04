// 10-04 起，购买讲义（social-media）的原文和衍生数据已从仓库当前版本移除（版权）。
// 依赖这些数据的脚本（extract、ingest、review、review:import、validate 指定文件时）缺文件就用中文说明原因并退出，不打堆栈。
// 只有缺的是被删的那几类文件时才说「已移除」；别的路径（比如手误打错的文件名）只说缺哪个文件。
import { existsSync } from 'fs'
import { relative } from 'path'
import { fileURLToPath } from 'url'

const REMOVED_NOTE =
  '10-04 起，购买讲义的原文和衍生数据已从仓库当前版本移除（版权），演示改用团队自写的迷你讲义（tests/fixtures/mini-handout.ts）。' +
  '要重跑这一步，请把本地备份放回原路径（这些文件不要再提交）。'
const REMOVED = /(^|\/)(data\/raw\/day\d+\.txt|data\/extract\/social-media\.extract\.json|data\/handouts\/social-media\.json|docs\/校对表[^/]*\.csv)$/

export function requireFiles(files: (string | URL)[], what: string): void {
  const missing = files.map((f) => (typeof f === 'string' ? f : relative(process.cwd(), fileURLToPath(f)))).filter((f) => !existsSync(f))
  if (!missing.length) return
  const removed = missing.some((f) => REMOVED.test(f.replace(/\\/g, '/')))
  console.error(`缺少${what}：${missing.join('、')}${removed ? `\n${REMOVED_NOTE}` : ''}`)
  process.exit(1)
}
