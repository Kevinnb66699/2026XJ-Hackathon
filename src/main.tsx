import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import { btn } from './components/ui'
import { currentHandout, loadCurrentHandout } from './data'
import { sendEvent } from './lib/events'
import { readLS, sidKey, writeLS } from './lib/store'
import './index.css'

const root = ReactDOM.createRoot(document.getElementById('root')!)

// 前端报错回流（诊断用）：每次打开页面最多 3 条，只发截短到 200 字的错误信息，不带堆栈，链接去掉参数；上报本身出错也不影响页面
let errorsSent = 0
// 报错记在哪台设备名下：评委页用评委编号，其他页用学生编号；都没有就给这台设备一个只用于诊断的编号，不同设备的报错不会并成一台
function diagSid(): string {
  const own = window.location.hash.startsWith('#/judge') ? readLS(sidKey('judge')) : readLS(sidKey('student'))
  const id = own || readLS('zhishi:diag-id') || `diag-${Math.random().toString(36).slice(2, 8)}`
  if (!own) writeLS('zhishi:diag-id', id)
  return id
}
function reportError(reason: unknown) {
  try {
    if (errorsSent >= 3) return
    errorsSent++
    const value = (reason instanceof Error ? reason.message : String(reason)).replace(/(https?:\/\/[^\s?#]*)[?#]\S*/g, '$1').slice(0, 200)
    sendEvent({ sid: diagSid(), ts: Date.now(), handoutId: currentHandout.id, type: 'client_error', value }).catch(() => undefined)
  } catch {
    // 上报失败就算了
  }
}

// 先定下讲义（老师上传的要从后端拉）再渲染；拉不到就显示错误页
loadCurrentHandout().then(
  () => {
    window.addEventListener('error', (e) => reportError(e.message))
    window.addEventListener('unhandledrejection', (e) => reportError(e.reason))
    root.render(
      <React.StrictMode>
        <App />
      </React.StrictMode>,
    )
  },
  (e: Error) =>
    root.render(
      <main className="flex min-h-screen flex-col items-center justify-center gap-5 bg-ground px-4 text-center">
        <p className="m-0 text-[16px] leading-relaxed text-ink">{e.message}</p>
        <a href={window.location.pathname} className={`${btn.secondary} inline-flex items-center no-underline`}>
          回首页
        </a>
      </main>,
    ),
)
