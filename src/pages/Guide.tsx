// 老师使用指南（#/guide）：正文是 src/content/guide.md，截图在 public/guide-img/，用 lib/markdown 显示（和隐私说明页一样）。
// #/guide?s=publish 打开时滚到 id 是 publish 的那一节（老师侧页面上的「下一步」提示链到对应的节）；不带 s 回到顶部。
// 同样内容的 PDF（public/zhishi-teacher-guide.pdf）由这一页打印生成（tools/guide_pdf.py），见 docs/上传设计.md「四、老师使用指南」
import { useEffect } from 'react'
import Account from '../components/Account'
import { SiteHeader, card } from '../components/ui'
import text from '../content/guide.md?raw'
import { renderMarkdown } from '../lib/markdown'
import { getParams } from '../lib/router'

const body = renderMarkdown(text)

export default function GuidePage() {
  useEffect(() => {
    const s = getParams().get('s')
    const t = setTimeout(() => (s ? document.getElementById(s)?.scrollIntoView() : window.scrollTo(0, 0)))
    return () => clearTimeout(t)
  }, [])

  return (
    <div className="min-h-screen bg-ground">
      <SiteHeader label="使用指南" actions={<Account />} />
      <main className="mx-auto max-w-3xl px-4 pb-16 pt-5">
        <article className={`${card} flex flex-col gap-3 p-5 text-[15px] leading-relaxed text-ink sm:p-7`}>{body}</article>
      </main>
    </div>
  )
}
