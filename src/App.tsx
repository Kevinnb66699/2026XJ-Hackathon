import { useEffect, useRef } from 'react'
import BeianFooter from './components/BeianFooter'
import { pathOf, useHash } from './lib/router'
import Home from './pages/Home'
import LoginPage from './pages/Login'
import NextPreviewPage from './pages/NextPreview'
import TeacherPage from './pages/Teacher'
import UploadPage from './pages/Upload'
import StudentPage from './pages/student/Student'

export default function App() {
  const hash = useHash()
  const path = pathOf(hash)
  // 换了页面回到顶部；同一页面里只换参数（如 ?p=A / ?p=B）不动
  const pathRef = useRef(path)
  useEffect(() => {
    if (pathRef.current === path) return
    pathRef.current = path
    window.scrollTo(0, 0)
  }, [path])
  // 比赛结束（10-04）后评委模式下线：评委卡上的二维码（#/judge）和流传的旧链接都回到首页，地址栏换成 #/
  useEffect(() => {
    if (path === '/judge') history.replaceState(null, '', `${location.pathname}${location.search}#/`)
  }, [path])
  // key 用整个 hash：换了 ?p=A / ?p=B 也会重新加载预设
  const page =
    path === '/student' ? <StudentPage key={hash} />
    : path === '/teacher' ? <TeacherPage />
    : path === '/upload' ? <UploadPage />
    : path === '/login' ? <LoginPage />
    : path === '/next' ? <NextPreviewPage key={hash} />
    : <Home />
  return (
    <>
      {page}
      <BeianFooter />
    </>
  )
}
