// 人工修订：队友校对后的修改记在 pipeline/human-edits.json，每次入库都自动套用（在模型起草之后、校验之前），
// 来源标为 human。重新入库不会丢掉人工修改；改坏了照样会被校验器拦下。
import { existsSync, readFileSync } from 'fs'
import { z } from 'zod'
import type { Handout, Provenance } from '../shared/schema'
import { patternFor } from './text-utils'

export const HumanEdit = z.object({
  target: z.enum(['sentence', 'paragraph', 'word', 'expression', 'handout']),
  id: z.string(), // 句子 S24 / 段落 2 / 词 lemma / 表达 E09 / 讲义 id（handout 只能改 structure）
  field: z.string(), // 点号路径，如 ladder.l1、question、zh、guess、gist、gistEn、structure；remove 表示删掉这一条
  value: z.unknown(),
  by: z.string(), // 谁改的
  note: z.string().optional(),
})
export type HumanEdit = z.infer<typeof HumanEdit>
export const HumanEdits = z.object({ edits: z.array(HumanEdit) })

const setPath = (obj: Record<string, unknown>, path: string, value: unknown) => {
  const keys = path.split('.')
  let cur: Record<string, unknown> = obj
  for (const k of keys.slice(0, -1)) {
    if (typeof cur[k] !== 'object' || cur[k] === null) cur[k] = {}
    cur = cur[k] as Record<string, unknown>
  }
  cur[keys[keys.length - 1]] = value
}

// 套用修改，返回每条修改的结果说明（写进入库报告）。prov：不是人工改的（如 ai-edits.json），按它记来源
export function applyHumanEdits(h: Handout, edits: HumanEdit[], prov?: Provenance): string[] {
  const log: string[] = []
  for (const e of edits) {
    const human: Provenance = prov ?? { by: 'human', reviewedBy: e.by }
    const label = `${e.target} ${e.id} ${e.field}`
    if (e.field === 'remove') {
      const before = JSON.stringify(h)
      if (e.target === 'word') h.words = h.words.filter((w) => w.lemma !== e.id)
      if (e.target === 'expression') {
        h.expressions = h.expressions.filter((x) => x.id !== e.id)
        h.writing.requiredExpressionIds = h.writing.requiredExpressionIds.filter((x) => x !== e.id)
      }
      if (e.target === 'sentence') {
        // 句子原文不能删，只能删掉它的模型产出（梯子和原句题）
        const s = h.sentences.find((x) => x.id === e.id)
        if (s) {
          s.ladder = undefined
          s.breakdown = undefined
          s.question = undefined
        }
      }
      log.push(`${JSON.stringify(h) === before ? '未找到' : '已删除'}：${label}（${e.by}）`)
      continue
    }
    const obj: Record<string, unknown> | undefined =
      e.target === 'handout'
        ? (e.id === h.id ? (h as unknown as Record<string, unknown>) : undefined)
        : e.target === 'sentence'
        ? (h.sentences.find((x) => x.id === e.id) as unknown as Record<string, unknown>)
        : e.target === 'paragraph'
          ? (h.paragraphs.find((x) => String(x.n) === e.id) as unknown as Record<string, unknown>)
          : e.target === 'word'
            ? (h.words.find((x) => x.lemma === e.id) as unknown as Record<string, unknown>)
            : (h.expressions.find((x) => x.id === e.id) as unknown as Record<string, unknown>)
    if (!obj) {
      log.push(`未找到：${label}（${e.by}）`)
      continue
    }
    // 句子的 text 是原文，不能改；表达的 text 是我们整理的写法，可以改（改了要重新生成匹配规则）。讲义本身只能改 structure
    const top = e.field.split('.')[0]
    if ((e.field === 'text' && e.target !== 'expression') || e.field === 'id' || (e.target === 'handout' && top !== 'structure')) {
      log.push(`拒绝：${label}，原文和编号不能改（${e.by}）`)
      continue
    }
    setPath(obj, e.field, e.value)
    if (e.target === 'expression' && e.field === 'text') obj.pattern = patternFor(String(e.value))
    // 被改动的那一块记上「人工」来源；整块新写的题（如 guess）、拆句（breakdown）、文章结构（structure）原来没有来源，也补上
    const block = obj[top]
    if (block && typeof block === 'object' && ('provenance' in (block as object) || 'prompt' in (block as object) || top === 'breakdown' || top === 'structure')) (block as { provenance: Provenance }).provenance = human
    if (e.target === 'paragraph') (obj as { provenance: Provenance }).provenance = human
    log.push(`已修改：${label}（${e.by}${e.note ? `：${e.note}` : ''}）`)
  }
  return log
}

export function loadHumanEdits(file = 'pipeline/human-edits.json'): HumanEdit[] {
  if (!existsSync(file)) return []
  return HumanEdits.parse(JSON.parse(readFileSync(file, 'utf8'))).edits
}
