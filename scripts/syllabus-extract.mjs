// 课标词表抽取：从《普通高中英语课程标准（2017年版2020年修订）》PDF 用 pdftotext -layout 抽出的文本里，
// 整理出附录 2 词汇表，写成 shared/syllabus-words.ts（shared/syllabus.ts 用它查档位）。只读输入，原文文本不进仓库。
// 用法：
//   pdftotext -layout 课标.pdf kb.txt
//   node scripts/syllabus-extract.mjs kb.txt                 写到 shared/syllabus-words.ts
//   node scripts/syllabus-extract.mjs kb.txt out.ts          写到别处（先看看再换）
// 全文或只截附录 2 那几页都行：有「说明」就从说明后面开始，到「主要国家名称及相关信息」表之前为止（国家表不收）。
// 条数、字母标题、写法不对就报错退出，不写文件
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const EXPECTED = [1500, 500, 1000] // 附录 2 说明第 1 条

// 原表疑似印错、整理时改了的。改之前先在这里写清楚依据，数据文件头会列出来
const FIXES = {
  million: {
    band: 1,
    why: [
      '原表印的是 million**（选择性必修），这样数下来是 1500 / 499 / 1001，和说明的 500 / 1000 差 1 条。',
      '2020 版全文里 million 除了词表只在教学案例和例文里出现，看不出该属于哪一档；',
      '调研时转存的 2025 年日常修订版（2017年版2025年修订）词表里是 million*，而 2020 版的 ** 词在那份词表里只有它一个变成 *',
      '（其余的还是 **、变成不带 *，或者不在表里）。所以按印错一个 * 处理，改成 *（必修），改完正好 1500 / 500 / 1000。',
      '这是推断，待人工对照 2020 版原 PDF 第 152 页（附录 2）确认。',
    ],
  },
}

const [input, outArg] = process.argv.slice(2)
if (!input) {
  console.error('用法：node scripts/syllabus-extract.mjs <pdftotext 抽出的文本> [输出文件]')
  process.exit(1)
}
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const out = outArg ?? path.join(root, 'shared', 'syllabus-words.ts')

const fail = (msg) => {
  console.error(msg)
  process.exit(1)
}

// 1. 截出词表那几页
let lines = fs.readFileSync(input, 'utf8').replace(/\f/g, '').split(/\r?\n/) // pdftotext 在换页处插 \f，会被当成缩进
const start = lines.findIndex((l) => l.includes('主要国家名称及相关信息等词单独列出'))
if (start >= 0) lines = lines.slice(start + 1)
const end = lines.findIndex((l) => l.includes('主要国家名称及相关信息（供教学参考）'))
if (end >= 0) lines = lines.slice(0, end)

// 2. 按页码行分页，去掉页眉页脚和空行
const pages = [[]]
for (const l of lines) {
  const t = l.trim()
  if (/^\d+$/.test(t)) pages.push([])
  else if (t && !t.includes('普通高中英语课程标准') && !t.includes('│ 附录 │')) pages[pages.length - 1].push(l.replace(/\s+$/, ''))
}

// 3. 双栏：每页先左栏后右栏。两栏之间至少两个空格；行首有空格的是只有右栏的行。
// 左栏写长了会和右栏只隔一个空格、被当成一条，所以检查左栏有没有伸到右栏的起点
const cells = []
for (const page of pages) {
  const left = []
  const right = []
  let rightStart = Infinity
  for (const l of page) {
    const indent = l.length - l.trimStart().length
    const parts = l.trim().split(/\s{2,}/)
    if (parts.length > 2) fail(`一行里分出了 ${parts.length} 栏：${l}`)
    if (indent > 0) {
      if (parts.length > 1) fail(`行首有空格又分出两栏：${l}`)
      right.push(parts[0])
      rightStart = Math.min(rightStart, indent)
    } else {
      left.push(parts[0])
      if (parts[1]) {
        right.push(parts[1])
        rightStart = Math.min(rightStart, l.indexOf(parts[1], parts[0].length))
      }
    }
  }
  for (const l of page) if (!/^\s/.test(l) && l.trim().split(/\s{2,}/).length === 1 && l.length >= rightStart) fail(`左栏伸到了右栏，可能两条连在一起：${l}`)
  cells.push(...left, ...right)
}

// 4. 去掉字母标题（A、B……按顺序出现的单个大写字母；I 标题后面紧跟的 I 是词），拼回折行的条目（括号没合上就接下一格）
const raw = []
let letter = 65
for (let i = 0; i < cells.length; i++) {
  let c = cells[i]
  if (c === String.fromCharCode(letter)) {
    letter++
    continue
  }
  while (c.includes('(') && !c.includes(')') && i + 1 < cells.length) c += ' ' + cells[++i]
  raw.push(c)
}
if (letter !== 91) fail(`字母标题只找到 ${String.fromCharCode(letter - 1)}，排版和预想的不一样`)

// 5. 每条拆成几种写法和档位。末尾的 * 个数是档位（directory ** 这种中间隔了空格的也算）；
// 括号里是美式拼写、全称或简称、复数、变形（pl. 去掉），toward(s) 拆成两种，「/」两边各算一种。弯引号改直引号
const entries = raw.map((text) => {
  const band = text.match(/\s*(\**)$/)[1].length
  if (band > 2) fail(`星号太多：${text}`)
  let body = text.replace(/\s*\**$/, '').replace(/’/g, "'")
  let forms
  const paren = body.match(/^(.+?)\s*\((.+)\)$/)
  const suffix = body.match(/^([a-z]+)\(([a-z]+)\)$/)
  if (suffix) forms = [suffix[1], suffix[1] + suffix[2]]
  else if (paren) forms = [...paren[1].split(/\s*\/\s*/), ...paren[2].replace(/^pl\.\s*/, '').split(/\s*,\s*/)]
  else forms = body.split(/\s*\/\s*/)
  for (const f of forms) if (!/^[A-Za-zé]+(?:[-.' ][A-Za-z]+)*\.?$/.test(f)) fail(`写法里有没想到的字符：${f}（${text}）`)
  return { text, forms, band }
})

// 6. 按 FIXES 改档位
const fixed = []
for (const [head, fix] of Object.entries(FIXES)) {
  const e = entries.find((x) => x.forms[0] === head)
  if (!e) fail(`FIXES 里的 ${head} 不在词表里`)
  fixed.push(`${head}：${'*'.repeat(e.band) || '不带 *'} → ${'*'.repeat(fix.band) || '不带 *'}`)
  e.band = fix.band
}

// 7. 核对：总数、各档条数、写法不重复（区分大小写：China 和 china* 是两个词）
const counts = [0, 1, 2].map((b) => entries.filter((e) => e.band === b).length)
if (counts.join() !== EXPECTED.join()) fail(`各档条数 ${counts.join(' / ')}，说明写的是 ${EXPECTED.join(' / ')}`)
const seen = new Map()
for (const e of entries)
  for (const f of e.forms) {
    if (seen.has(f)) fail(`${f} 出现了两次：${seen.get(f)}、${e.text}`)
    seen.set(f, e.text)
  }

// 8. 写文件：主写法是多词的条目（according to 这类）单独放一组；一行一个首字母，太长就折行
const isPhrase = (e) => e.forms[0].includes(' ')
const words = entries.filter((e) => !isPhrase(e))
const phrases = entries.filter(isPhrase)
const literal = (e) => `'${e.forms.join('/').replace(/'/g, "\\'")}${'*'.repeat(e.band)}'` // o'clock
const block = (list) => {
  const rows = []
  let row = ''
  let initial = ''
  for (const e of list) {
    const s = literal(e)
    const first = e.forms[0][0].toLowerCase()
    if (row && (first !== initial || row.length + s.length > 110)) {
      rows.push(`  ${row.trimEnd()}`)
      row = ''
    }
    initial = first
    row += `${s}, `
  }
  if (row) rows.push(`  ${row.trimEnd()}`)
  return rows.join('\n')
}
const phraseNote = phrases.map((e) => e.text).join('、')
const multiForm = entries.filter((e) => e.forms.length > 1).length
const header = `// 课标词表数据：据《普通高中英语课程标准（2017年版2020年修订）》附录 2 整理，非官方文本。
// 由 scripts/syllabus-extract.mjs 生成，不要手改：要改先改脚本（档位改动写进 FIXES），再重新生成。查档位用 shared/syllabus.ts。
//
// 抽取方式：课标 PDF 用 pdftotext -layout 转成文本，脚本按页码行分页、去掉页眉页脚，双栏每页先左栏后右栏，
// 去掉 A–Z 字母标题，拼回折行的条目（kilo (kilogramme, kilogram) 跨了两行），末尾 * 的个数定档位。
// 末尾的「主要国家名称及相关信息（供教学参考）」表不收；词表正文里本来就有的 China、Japan、Monday 这类照收。
//
// 改过什么：
// - 括号里的写法都收成同一条的另一种写法，档位相同：美式拼写（analyse (analyze)）、全称或简称（exam (examination)、
//   television (TV)）、复数（child (pl. children)，pl. 去掉）、变形（be (am, are, is)、have (has)）、a (an)；
//   toward(s) 拆成 toward、towards；「/」两边（bride / bridegroom）各算一种写法。${multiForm} 条有不止一种写法。
// - 大小写照原表：专有名词和缩写（China、March、US、AD、PE）大写，其余小写。China 和 china*、March 和 march* 是两个词、档位不同。
// - o’clock 的弯引号改成直引号；café 照原表，查的时候 cafe 也算。
// - 档位：${fixed.join('；') || '没有改'}。
${Object.values(FIXES)
  .flatMap((f) => f.why)
  .map((s) => `//   ${s}`)
  .join('\n')}
// - 主写法是多词的 ${phrases.length} 条单独放在 SYLLABUS_PHRASES（${phraseNote}）。
//   多词写法（according to、PE (physical education) 里的 physical education）不当单词查；tofu 这种单词写法照样查。
//
// 各档条数：义务教育 ${counts[0]}、必修 ${counts[1]}、选择性必修 ${counts[2]}，共 ${entries.length}（含 SYLLABUS_PHRASES 的 ${phrases.length} 条）。
//
// 格式：一项是表里的一个词条，几种写法用「/」隔开，第一个是表里的主写法；末尾不带 * 是义务教育阶段，
// 一个 * 是必修，两个 * 是选择性必修。顺序照原表。
`
const ts = `${header}
export const SYLLABUS_WORDS: readonly string[] = [
${block(words)}
]

export const SYLLABUS_PHRASES: readonly string[] = [
${block(phrases)}
]
`
fs.writeFileSync(out, ts)
console.log(`写好了 ${path.relative(process.cwd(), out)}`)
console.log(`各档条数：${counts.join(' / ')}，共 ${entries.length}；多词条目 ${phrases.length} 条；改了档位：${fixed.join('；') || '无'}`)
