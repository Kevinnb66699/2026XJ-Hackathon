// 上传管线在独立线程里跑：切句、校验这类 CPU 活儿不会卡住主线程（事件回流、写作检查照常响应）；
// 超时由主线程 terminate。进度、每次调模型的开始和用量、结果、错误都用 postMessage 传回去（用量由主线程记账：
// 线程被终止时还没报用量的那几次，主线程按开始时的估计额记）
import { parentPort, workerData } from 'node:worker_threads'

try {
  const { buildFromArticle } = await import('../dist-server/article.mjs')
  const result = await buildFromArticle(workerData.input, {
    id: workerData.id,
    llm: { ...workerData.llm, onCall: (c) => parentPort.postMessage({ type: 'call', c }), onUsage: (u) => parentPort.postMessage({ type: 'usage', u }) },
    onProgress: (p) => parentPort.postMessage({ type: 'progress', p }),
  })
  parentPort.postMessage({ type: 'done', result })
} catch (err) {
  // reason：ArticleError 的拒收原因（被内容安全拦截是 unsafe），后端按它给学生专门的提示
  parentPort.postMessage({ type: 'error', name: err?.name || 'Error', message: String(err?.message ?? err), reason: typeof err?.reason === 'string' ? err.reason : undefined })
}
