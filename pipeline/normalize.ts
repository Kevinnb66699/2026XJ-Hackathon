// pdftotext -layout 文本的清洗工具。抽取器和校验器共用，保证两边对「原文」的理解一致。
// 只做三件事：空白归一、去页脚、合并断行。不改任何字词。

// 中文字符及中文标点（含省略号 …）。两端对齐排版会在它们之间插空格，归一时去掉。
const CJK = '\\u2026\\u3000-\\u303f\\u3400-\\u9fff\\uff00-\\uffef'
const CJK_GAP = new RegExp(`([${CJK}]) (?=[${CJK}])`, 'g')
// 中文标点（全角）两侧不需要空格；合并断行时补的空格会留在「。」和下一行的英文之间
const PUNCT = '\\u3000-\\u303f\\uff00-\\uffef'
const PUNCT_GAP = new RegExp(` (?=[${PUNCT}])|(?<=[${PUNCT}]) `, 'g')
export const HAS_CJK = new RegExp(`[${CJK}]`)

// 页脚：单独成行的「—1—」
const FOOTER = /^\s*—\d+—\s*$/

// 私用区字符：PDF 里 Wingdings 项目符号（精读块开头的 U+F06C），是排版符号不是文字
const PUA = /[-]/g

// 空白归一：去掉项目符号；连续空白压成一个空格；去掉中文字符之间、中文标点两侧的空格
export function normalizeSpace(s: string): string {
  return s.replace(PUA, ' ').replace(/\s+/g, ' ').trim().replace(CJK_GAP, '$1').replace(PUNCT_GAP, '')
}

// 去页脚：拆成行，删掉页码行和换页符（pdftotext 把 \f 放在新页第一行开头，会被误当成缩进）
export function stripFooters(text: string): string[] {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/\f/g, '')
    .split('\n')
    .filter((l) => !FOOTER.test(l))
}

// 合并断行：多行接成一段（行之间补一个空格，再做空白归一）
export function joinLines(lines: string[]): string {
  return normalizeSpace(lines.join(' '))
}

// 整天讲义的归一化全文，用于校验「出处 quote 是讲义原文子串」
export function normalizeText(raw: string): string {
  return joinLines(stripFooters(raw))
}
