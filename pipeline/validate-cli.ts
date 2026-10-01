// 校验器命令行入口（vite-node 会去掉脚本路径，所以单独成文件）
import { main } from './validate'

main(process.argv.slice(2)).catch((e) => {
  console.error(e)
  process.exit(1)
})
