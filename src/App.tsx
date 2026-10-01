import { pathOf, useHash } from './lib/router'
import Home from './pages/Home'
import JudgePage from './pages/Judge'
import TeacherPage from './pages/Teacher'
import StudentPage from './pages/student/Student'

export default function App() {
  const hash = useHash()
  const path = pathOf(hash)
  // key 用整个 hash：换了 ?p=A / ?p=B 也会重新加载预设
  if (path === '/student') return <StudentPage key={hash} />
  if (path === '/teacher') return <TeacherPage />
  if (path === '/judge') return <JudgePage />
  return <Home />
}
