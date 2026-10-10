// 自写的小 Markdown 渲染器（隐私说明页 #/privacy 用，正文在 src/content/privacy.md）：纯函数，输出 React 元素，不拼 HTML、不用 dangerouslySetInnerHTML，
// 文里写的 HTML 原样当文字显示。只认这几种写法，别的都当普通文字：
// # / ## / ### 标题（末尾写 {#id} 给标题加 id，如「## 不满 14 周岁的学生 {#minors}」，#/privacy?s=minors 滚到这里）、段落（空行隔开）、
// - 列表、1. 列表、**粗体**、[文字](链接)（只认 https:// 和 #/ 开头的链接，别的整段原样当文字）、
// 管道表格（每行首尾都写 |，第二行是 |---|---|）。段落里的换行照 Markdown 当一个空格，中文段落请写成一行
import { createElement as el, type ReactElement, type ReactNode } from 'react'

const HEADING = /^(#{1,3})\s+(.+?)(?:\s*\{#([A-Za-z0-9_-]+)\})?\s*$/
const UL = /^-\s+(.*)$/
const OL = /^(\d+)\.\s+(.*)$/
const ROW = /^\s*\|.*\|\s*$/
const SEP = /^\s*\|(\s*:?-+:?\s*\|)+\s*$/
const INLINE = /\*\*(.+?)\*\*|\[([^\]\n]+)\]\(([^()\s]+)\)/g
const SAFE_HREF = /^(https:\/\/|#\/)/

const HEADING_CLASS = ['m-0 text-[22px] font-bold leading-snug', 'm-0 mt-3 text-[18px] font-bold', 'm-0 mt-1 text-[16px] font-semibold']
const LINK_CLASS = 'text-primary underline'

// 粗体、链接；不认的链接（javascript:、mailto: 等）整段原样当文字
function inline(text: string): ReactNode[] {
  const out: ReactNode[] = []
  let last = 0
  for (const m of text.matchAll(INLINE)) {
    const i = m.index ?? 0
    if (i > last) out.push(text.slice(last, i))
    if (m[1] !== undefined) out.push(el('strong', { className: 'font-semibold' }, ...inline(m[1])))
    else if (SAFE_HREF.test(m[3])) out.push(el('a', m[3].startsWith('#') ? { href: m[3], className: LINK_CLASS } : { href: m[3], target: '_blank', rel: 'noopener noreferrer', className: LINK_CLASS }, m[2]))
    else out.push(m[0])
    last = i + m[0].length
  }
  if (last < text.length) out.push(text.slice(last))
  return out
}

const cells = (line: string) => line.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim())
const isTable = (lines: string[], i: number) => ROW.test(lines[i]) && i + 1 < lines.length && SEP.test(lines[i + 1])
const isStart = (lines: string[], i: number) => HEADING.test(lines[i]) || UL.test(lines[i]) || OL.test(lines[i]) || isTable(lines, i)

export function renderMarkdown(md: string): ReactElement[] {
  const lines = md.split(/\r?\n/)
  const blocks: ReactElement[] = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    const key = blocks.length
    if (!line.trim()) {
      i++
      continue
    }
    const hm = HEADING.exec(line)
    if (hm) {
      const level = hm[1].length
      blocks.push(el(`h${level}`, { key, id: hm[3], className: `${HEADING_CLASS[level - 1]} scroll-mt-20` }, ...inline(hm[2])))
      i++
    } else if (isTable(lines, i)) {
      const head = cells(lines[i])
      const rows: string[][] = []
      i += 2
      while (i < lines.length && ROW.test(lines[i])) rows.push(cells(lines[i++]))
      // 外面套一层可以横着滚：手机上表格太宽时只滚表格，不撑宽整页
      blocks.push(
        el('div', { key, className: 'overflow-x-auto' },
          el('table', { className: 'w-full border-collapse text-[14px]' },
            el('thead', null, el('tr', null, ...head.map((c) => el('th', { className: 'border border-line bg-ground px-3 py-1.5 text-left font-semibold' }, ...inline(c))))),
            el('tbody', null, ...rows.map((r) => el('tr', null, ...head.map((_, j) => el('td', { className: 'border border-line px-3 py-1.5 align-top' }, ...inline(r[j] ?? '')))))),
          ),
        ),
      )
    } else if (UL.test(line) || OL.test(line)) {
      const ordered = OL.test(line)
      const re = ordered ? OL : UL
      const items: string[] = []
      const start = ordered ? Number(OL.exec(line)?.[1]) : 1
      while (i < lines.length) {
        const m = re.exec(lines[i])
        if (!m) break
        items.push(m[ordered ? 2 : 1])
        i++
      }
      const props = { key, start: ordered && start !== 1 ? start : undefined, className: `m-0 flex flex-col gap-1 pl-6 ${ordered ? 'list-decimal' : 'list-disc'}` }
      blocks.push(el(ordered ? 'ol' : 'ul', props, ...items.map((t) => el('li', null, ...inline(t)))))
    } else {
      // 段落：到空行或下一个标题、列表、表格为止
      const para: string[] = []
      while (i < lines.length && lines[i].trim() && (!para.length || !isStart(lines, i))) para.push(lines[i++].trim())
      blocks.push(el('p', { key, className: 'm-0' }, ...inline(para.join('\n'))))
    }
  }
  return blocks
}
