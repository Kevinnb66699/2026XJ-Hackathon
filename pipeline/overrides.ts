// 人工覆盖表：规则解析不了、或规则推不准而由人确认的地方，集中写在这里（报告里逐条列出）。

// 文章总结填空的词形修正。规则只能从原文取词形，讲义要求「注意时态和词形变化」。
// 只在规则已经唯一推出这个词时才生效，不会凭空填空。
export const summaryClozeForms: Record<number, string> = {
  // 「Teenagers can (7) i______ avoid them」：规则推出 ingenious（原文 ingenious ways），
  // 空格夹在 can 和动词 avoid 之间，要用副词
  7: 'ingeniously',
}
