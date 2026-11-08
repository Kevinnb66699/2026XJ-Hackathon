// 原文例句里把这个表达加粗（写作页、表达本共用）：用和「用上了没有」同一条规则（pattern）去找，找不到、没有规则就原样显示。
// 规则里 sth、doing 这类空位（{0,4}）是贪婪的，判断用没用上没关系，加粗会把后面好几个词也带上：显示时改成尽量少
export function Example({ text, pattern }: { text: string; pattern?: string }) {
  let m: RegExpExecArray | null = null
  try {
    if (pattern) m = new RegExp(pattern.replace(/\{0,(\d+)\}(?!\?)/g, '{0,$1}?'), 'i').exec(text)
  } catch {
    // 规则写坏了（和 expressionUsed 一样当找不到）
  }
  if (!m) return <>{text}</>
  return (
    <>
      {text.slice(0, m.index)}
      <strong>{m[0]}</strong>
      {text.slice(m.index + m[0].length)}
    </>
  )
}
