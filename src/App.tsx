import { useEffect, useRef } from 'react'
import { pathOf, useHash } from './lib/router'
import Home from './pages/Home'
import JudgePage from './pages/Judge'
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
  // key 用整个 hash：换了 ?p=A / ?p=B 也会重新加载预设
  if (path === '/student') return <StudentPage key={hash} />
  if (path === '/teacher') return <TeacherPage />
  if (path === '/judge') return <JudgePage />
  if (path === '/upload') return <UploadPage />
  if (path === '/next') return <NextPreviewPage key={hash} />
  return <Home />
}
