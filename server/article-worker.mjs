// 上传管线在独立线程里跑：切句、校验这类 CPU 活儿不会卡住主线程（事件回流、写作检查照常响应）；
// 超时由主线程 terminate。进度、结果、错误都用 postMessage 传回去。
import { parentPort, workerData } from 'node:worker_threads'

try {
  const { buildFromArticle } = await import('../dist-server/article.mjs')
  const result = await buildFromArticle(workerData.input, {
    id: workerData.id,
    llm: workerData.llm,
    onProgress: (p) => parentPort.postMessage({ type: 'progress', p }),
  })
  parentPort.postMessage({ type: 'done', result })
} catch (err) {
  parentPort.postMessage({ type: 'error', name: err?.name || 'Error', message: String(err?.message ?? err) })
}
