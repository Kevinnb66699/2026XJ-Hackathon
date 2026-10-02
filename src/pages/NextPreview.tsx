// 下一届的起点（预览）：老师端按全班卡点挑出的句子，下一版讲义里默认先给梯子第 1 步。
// 只在本机演示：学生状态只在内存里，不存、不回流，老师端统计不受影响。
import { useMemo, useState } from 'react'
import { CloseReading } from '../components/SentenceCard'
import { TopBar } from '../components/ui'
import { currentHandout as h } from '../data'
import { emptyState, personalize } from '../engine'
import { getParams, go } from '../lib/router'
import { useMemoryStudent } from '../lib/store'

export default function NextPreviewPage() {
  const [ids] = useState(() => (getParams().get('ids') ?? '').split(',').filter((id) => h.sentences.some((x) => x.id === id && x.ladder)))
  const student = useMemoryStudent(h, () => ({ ...emptyState('preview-next'), ladder: Object.fromEntries(ids.map((id) => [id, 1 as const])) }))
  const view = useMemo(() => personalize(h, student.state), [student.state])
  const paragraphs = [...new Set(h.sentences.filter((x) => ids.includes(x.id)).map((x) => x.paragraph))]

  return (
    <div className="min-h-screen bg-ground">
      <TopBar title="下一版讲义 · 预览" subtitle={`本周外刊：${h.title}`} onBack={() => go('#/teacher')} />
      <main className="mx-auto flex max-w-2xl flex-col gap-3.5 px-4 pb-24 pt-4">
        <div className="flex flex-col gap-1.5 rounded-xl border border-dashed border-note-line bg-note px-4 py-3 text-[14px] leading-relaxed">
          <span className="font-semibold text-amber-dark">下一届的起点</span>
          <span>上一届很多同学卡在下面这几句。下一版讲义里，这几句的读懂梯子默认先打开第 1 步，不用先卡一次。原文和题目都不变。</span>
          <span className="text-[13px] text-ink2">这是老师端的预览，作答不记录。</span>
        </div>
        {ids.length ? (
          <CloseReading h={h} view={view} state={student.state} act={student.act} onCollect={() => undefined} paragraphs={paragraphs} only={ids} />
        ) : (
          <p className="m-0 text-[14px] text-muted">没有要预览的句子。请从老师端「下一届的起点」点「预览下一版」。</p>
        )}
      </main>
    </div>
  )
}
