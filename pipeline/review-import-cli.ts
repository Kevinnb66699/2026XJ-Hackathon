// 校对表导入的命令行入口（vite-node 会去掉脚本路径，所以单独成文件）
import { main } from './review-import'

main(process.argv.slice(2)).catch((e) => {
  console.error(e instanceof Error ? e.message : e)
  process.exit(1)
})
