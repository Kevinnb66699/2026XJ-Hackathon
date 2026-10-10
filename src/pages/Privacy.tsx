// 隐私说明（#/privacy）：正文是 src/content/privacy.md（现在是试点前简要版，正式版发布时整篇替换这个文件），用 lib/markdown 显示。
// #/privacy?s=minors 打开时滚到 id 是 minors 的标题（「不满 14 周岁的学生」那一节，页脚和选座号页都链到这里）；不带 s 回到顶部
import { useEffect } from 'react'
import { SiteHeader, card } from '../components/ui'
import text from '../content/privacy.md?raw'
import { renderMarkdown } from '../lib/markdown'
import { getParams } from '../lib/router'

const body = renderMarkdown(text)

export default function PrivacyPage() {
  // App 换页时会回到顶部，那是在这里的 effect 之后跑的（子组件的 effect 先跑）：等它跑完再滚到要看的那一节
  useEffect(() => {
    const s = getParams().get('s')
    const t = setTimeout(() => (s ? document.getElementById(s)?.scrollIntoView() : window.scrollTo(0, 0)))
    return () => clearTimeout(t)
  }, [])

  return (
    <div className="min-h-screen bg-ground">
      <SiteHeader label="隐私说明" />
      <main className="mx-auto max-w-2xl px-4 pb-16 pt-5">
        <article className={`${card} flex flex-col gap-3 p-5 text-[15px] leading-relaxed text-ink sm:p-7`}>{body}</article>
      </main>
    </div>
  )
}
