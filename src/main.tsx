import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import { btn } from './components/ui'
import { loadCurrentHandout } from './data'
import './index.css'

const root = ReactDOM.createRoot(document.getElementById('root')!)

// 先定下讲义（老师上传的要从后端拉）再渲染；拉不到就显示错误页
loadCurrentHandout().then(
  () =>
    root.render(
      <React.StrictMode>
        <App />
      </React.StrictMode>,
    ),
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
