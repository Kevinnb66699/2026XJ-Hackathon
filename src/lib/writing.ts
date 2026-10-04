// 写作检查：规则先查「有没有用上」（engine.expressionUsed），再请服务器代理的大模型判断「用得对不对」，顺带指出可能写错的地方。
// 只说用得对 / 再看看原文，并引用原文例句；写错的地方只引学生原话、说是哪一类；绝不显示改写后的句子。
import type { Handout } from '../../shared/schema'
import { deviceId } from './store'

export type Verdict = 'correct' | 'incorrect' | 'unsure'
export interface CheckResult {
  id: string
  verdict: Verdict
  reason: string
}
// AI 指出的可能写错的地方（服务器已校验：quote 是学生原话里的片段，hint 不含改法）
export interface GrammarIssue {
  quote: string
  type: string
  hint: string
}
export interface CheckOutput {
  results: CheckResult[]
  grammar: GrammarIssue[] | null // null：这一项没查成
}

const VERDICTS: Verdict[] = ['correct', 'incorrect', 'unsure']

export const exampleOf = (h: Handout, expressionId: string) => {
  const e = h.expressions.find((x) => x.id === expressionId)
  return e ? h.sentences.find((x) => x.id === e.sentenceId)?.text ?? '' : ''
}

// 理由里出现 3 个词以上的英文片段，又不在 allowed（学生原话、表达、原文例句）里，就当成改写，换成通用说法
import { hasGrammarTerm } from '../../shared/terms'

export function safeReason(reason: string, verdict: Verdict, allowed: string[]): string {
  const pool = allowed.join('\n').toLowerCase()
  const spans = reason.match(/[A-Za-z][A-Za-z' ,-]*[A-Za-z]/g) ?? []
  const rewrite = spans.some((sp) => sp.trim().split(/\s+/).length >= 3 && !pool.includes(sp.trim().toLowerCase()))
  if (!rewrite && !hasGrammarTerm(reason)) return reason
  return verdict === 'correct' ? '意思和搭配都对，和原文例句的用法一致。' : '对照原文例句再想想。'
}

// 返回 null 表示 AI 检查暂时不可用（网络失败、超时、服务器回落、超过次数上限）。
// sid：学生的匿名编号，后端只用来限次数（模型费用有上限），不存。
// 演示画像（#/student?seed=demo&p=A|B）的编号固定（demo-A / demo-B），所有访客都一样，改按设备限次，免得共用一个份额
export async function checkWriting(h: Handout, text: string, ids: string[], sid: string): Promise<CheckOutput | null> {
  const exprs = h.expressions.filter((e) => ids.includes(e.id))
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 12000)
  try {
    const res = await fetch('/api/writing-check', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        handoutId: h.id,
        sid: sid.startsWith('demo-') ? deviceId() : sid,
        text,
        expressions: exprs.map((e) => ({ id: e.id, text: e.text, zh: e.zh, example: exampleOf(h, e.id) })),
      }),
      signal: ctrl.signal,
    })
    if (!res.ok) return null
    const data = (await res.json()) as { fallback?: boolean; results?: unknown; grammar?: unknown }
    if (data.fallback || !Array.isArray(data.results)) return null
    const out: CheckResult[] = []
    for (const r of data.results as Record<string, unknown>[]) {
      if (!r || typeof r.id !== 'string' || !ids.includes(r.id)) continue
      const verdict = VERDICTS.includes(r.verdict as Verdict) ? (r.verdict as Verdict) : 'unsure'
      // 允许引用：学生原话、表达本身（原形，如 toy with the idea）、原文例句
      const allowed = [text, exprs.find((e) => e.id === r.id)?.text ?? '', exampleOf(h, r.id)]
      const reason = typeof r.reason === 'string' ? safeReason(r.reason, verdict, allowed) : ''
      out.push({ id: r.id, verdict, reason })
    }
    // 引用不在学生原话里的再挡一遍
    const grammar = Array.isArray(data.grammar)
      ? (data.grammar as GrammarIssue[]).filter((g) => g && typeof g.quote === 'string' && g.quote && text.includes(g.quote) && typeof g.type === 'string' && typeof g.hint === 'string').slice(0, 3)
      : null
    return { results: out, grammar }
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}
