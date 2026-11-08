// 学习记录和完整导出的前端（阶段 5）：拉 /api/student/records 用假 fetch 测，服务器的推算（lib/notebook 的 buildRecords）过一遍前端的解析；
// 「下载我的数据」在浏览器里合进本机的问卷答案和写作草稿（lib/store 的 localData、lib/student-auth 的 withLocal），用内存里的 localStorage 测。
// 没有 DOM 测试环境，页面、首页入口、账号页的条件和文案直接查源码
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { LearningEvent } from '../shared/schema'
import { hasGrammarTerm } from '../shared/terms'
import { buildRecords } from '../src/lib/notebook'
import { localData } from '../src/lib/store'
import { safeNext, withLocal } from '../src/lib/student-auth'
import { bjDate, resumeHref, summaryHref } from '../src/pages/student/Records'
import { miniHandout as h } from './fixtures/mini-handout'

const sid = 'u-0123456789abcdef'
const reply = (status: number, body: unknown) => ({ ok: status >= 200 && status < 300, status, json: async () => body })
const memoryStorage = (init: Record<string, string> = {}) => {
  const m = new Map(Object.entries(init))
  return {
    get length() {
      return m.size
    },
    key: (i: number) => [...m.keys()][i] ?? null,
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
  }
}
const fresh = async () => {
  vi.resetModules()
  return import('../src/lib/student-auth')
}
const read = (f: string) => readFileSync(fileURLToPath(new URL(`../src/${f}`, import.meta.url)), 'utf8')
const code = (f: string) => read(f).replace(/\/\/.*$/gm, '').replace(/\{\/\*[\s\S]*?\*\/\}/g, '') // 去掉注释

const rec = { handoutId: 'up-a', title: 'Phones', lastTs: 5, rating: '刚好', status: 'todo', firstPending: 'S02' }

describe('getRecords：GET /api/student/records', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('原样拿到；格式不对的条目跳过；可选的字段格式不对就当没有；多出来的字段不要', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      reply(200, {
        records: [rec, { ...rec, handoutId: '' }, { ...rec, status: 'half' }, { ...rec, lastTs: '5' }, { ...rec, handoutId: 'up-b', rating: 3, firstPending: '', answered: 2 }, null],
      }),
    )
    vi.stubGlobal('fetch', fetchMock)
    const auth = await fresh()
    const list = await auth.getRecords()
    expect(fetchMock.mock.calls[0][0]).toBe('/api/student/records')
    expect(list).toEqual([rec, { handoutId: 'up-b', title: 'Phones', lastTs: 5, status: 'todo' }])
    expect(list[1]).not.toHaveProperty('answered')
  })

  it('不是数组当空的；没登录 401 抛出，带后端的提示', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(reply(200, { records: {} })))
    const auth = await fresh()
    expect(await auth.getRecords()).toEqual([])
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(reply(401, { error: '请先登录' })))
    await expect(auth.getRecords()).rejects.toMatchObject({ status: 401, message: '请先登录' })
  })

  it('服务器推算的结果（buildRecords，序列化成 JSON）过一遍前端的解析，一条不丢、一个字段不变', async () => {
    const ev = (e: Omit<LearningEvent, 'sid' | 'ts' | 'handoutId'>, ts: number): LearningEvent => ({ sid, ts, handoutId: h.id, ...e })
    const list = buildRecords([h], [ev({ type: 'answer_question', sentenceId: 'S01', correct: true }, 1), ev({ type: 'feedback', value: '太难' }, 2)])
    expect(list).toEqual([{ handoutId: h.id, title: h.title, lastTs: 2, rating: '太难', status: 'todo', firstPending: 'S02' }])
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(reply(200, JSON.parse(JSON.stringify({ records: list })))))
    const auth = await fresh()
    expect(await auth.getRecords()).toEqual(list)
  })
})

describe('学习记录页的日期和链接', () => {
  it('日期按北京时间，不看设备的时区', () => {
    expect(bjDate(Date.UTC(2026, 10, 7, 15, 59, 59))).toBe('2026 年 11 月 7 日') // 北京 23:59:59
    expect(bjDate(Date.UTC(2026, 10, 7, 16, 0, 0))).toBe('2026 年 11 月 8 日') // 北京第二天 0 点
    expect(bjDate(Date.UTC(2026, 11, 31, 16, 30))).toBe('2027 年 1 月 1 日')
  })

  it('「看小结」整页打开这一篇的小结（step=summary），「接着读」带 jump；都编码；会话过期时登录页的 next 也认', () => {
    const r = { ...rec, status: 'todo' as const }
    expect(summaryHref(r)).toBe('/?h=up-a&step=summary#/student')
    expect(resumeHref(r, 'S02')).toBe('/?h=up-a&jump=S02#/student')
    expect(resumeHref({ ...r, handoutId: 'up-a&c=x' }, 'S 1#')).toBe('/?h=up-a%26c%3Dx&jump=S%201%23#/student')
    for (const x of [summaryHref(r), resumeHref(r, 'S02')]) expect(safeNext(x)).toBe(x)
    // Student.tsx 认这两个参数（fromLink），文章之间一律整页跳转
    const student = read('pages/student/Student.tsx')
    expect(student).toContain("const STEP_IDS = ['skim', 'words', 'close', 'writing', 'summary']")
    expect(student).toContain("const jump = p.get('jump')")
  })

  it('读文章页顶上：账号模式（团队选的、自己贴的文章）写「这篇：标题」，不叫「本周外刊」；班级学号、示例照旧', () => {
    const student = read('pages/student/Student.tsx')
    expect(student).toContain("const note = `${me ? '这篇' : '本周外刊'}：${h.title}`")
    expect(student).toContain('note={note} />')
    expect(student).toContain('<span className="text-[13px] text-muted sm:hidden">{note}</span>')
    expect(student.match(/本周外刊：\$\{h\.title\}|本周外刊：\{h\.title\}/g)).toHaveLength(1) // 只剩要扫班级二维码的那一页
  })
})

describe('下载我的数据：在浏览器里合进本机的问卷答案和写作草稿', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })
  const survey = { grade: '高二', curriculum: 'IB', stuckOn: 'words' }

  it('localData：只拿这个账号的；作答状态里有问卷的才算；空的草稿、被改坏的、格式不对的问卷不放；按讲义 id 排', () => {
    vi.stubGlobal(
      'localStorage',
      memoryStorage({
        [`zhishi:state:up-b:${sid}`]: JSON.stringify({ sid, survey, answers: {} }),
        [`zhishi:state:up-a:${sid}`]: JSON.stringify({ sid, survey: { ...survey, grade: '高一' } }),
        [`zhishi:state:up-c:${sid}`]: JSON.stringify({ sid, answers: {} }), // 跳过了问卷
        [`zhishi:state:up-d:${sid}`]: '{bad',
        [`zhishi:state:up-e:${sid}`]: JSON.stringify({ survey: { grade: 1 } }),
        [`zhishi:writing:up-b:${sid}`]: 'I toyed with the idea.',
        [`zhishi:writing:up-a:${sid}`]: '   ',
        'zhishi:state:up-a:u-ffffffffffffffff': JSON.stringify({ survey }), // 别的账号
        'zhishi:writing:up-a:s-other': 'not mine',
        [`zhishi:step:up-a:${sid}`]: '3',
        [`zhishi:queue:v2:${sid}`]: '[]',
      }),
    )
    const d = localData(sid)
    expect(d.surveys).toEqual([{ handoutId: 'up-a', survey: { ...survey, grade: '高一' } }, { handoutId: 'up-b', survey }])
    expect(d.writingDrafts).toEqual([{ handoutId: 'up-b', text: 'I toyed with the idea.' }])
    expect(d.note).toContain('只存在这台设备上')
    expect(d.note).toContain('服务器上没有')
  })

  it('localData：存储用不了时是空的，不报错', () => {
    vi.stubGlobal('localStorage', {
      get length() {
        throw new Error('blocked')
      },
    })
    expect(localData(sid)).toMatchObject({ surveys: [], writingDrafts: [] })
  })

  it('withLocal：合进去的放在原始记录 events 前面，别的字段原样；服务器给的不是 JSON 对象就原样存', () => {
    const local = { note: 'n', surveys: [], writingDrafts: [{ handoutId: 'up-a', text: 'x' }] }
    const server = { note: '其中标了 AI 生成的内容由 AI 生成，可能有错', aiFields: { 'words[].zh': 'y' }, username: 'reader01', words: [], events: [{ ts: 1 }] }
    const out = JSON.parse(withLocal(JSON.stringify(server), local))
    expect(Object.keys(out)).toEqual(['note', 'aiFields', 'username', 'words', 'local', 'events'])
    expect(out).toEqual({ ...server, local })
    for (const text of ['not json', '[1]', 'null', '"x"']) expect(withLocal(text, local)).toBe(text)
  })

  it('账号页：下载时把服务器的文件和本机的合起来再存，不另外发请求；说明里如实写', () => {
    const page = read('pages/StudentLogin.tsx')
    const my = page.slice(page.indexOf('function MyPage('), page.indexOf('function DeleteAccount('))
    expect(my).toContain('const { blob, filename } = await fetchExport()')
    expect(my).toContain("URL.createObjectURL(new Blob([withLocal(await blob.text(), localData(me.sid))], { type: 'application/json' }))")
    expect(my).toContain('一个 JSON 文件：用户名、注册时间、设置、问卷答案、我的文章、学习记录、单词本、表达本，还有账号上原样的每一条记录。')
    expect(my).toContain('这台设备上的写作草稿（还有以前每篇开头填的问卷），下载时在浏览器里直接加进文件，不发给服务器。')
    expect(my).toContain('标了 AI 生成的中文由 AI 生成，可能有错。')
    // 合并只在浏览器里：lib/store、lib/student-auth 的这两个函数都不发请求
    const store = read('lib/store.ts')
    const fn = store.slice(store.indexOf('export function localData('))
    expect(fn.slice(0, fn.indexOf('\n}\n'))).not.toMatch(/fetch|sendEvent/)
    const lib = read('lib/student-auth.ts')
    const merge = lib.slice(lib.indexOf('export function withLocal('))
    expect(merge.slice(0, merge.indexOf('\n}\n'))).not.toMatch(/fetch|request/)
  })
})

describe('页面：学习记录、首页入口', () => {
  const page = code('pages/student/Records.tsx')

  it('路由：#/records 是学习记录；router 的注释写上', () => {
    expect(read('App.tsx')).toContain("path === '/records' ? <RecordsPage />")
    expect(read('lib/router.ts')).toContain('#/records（学习记录，这三页都要登录学生账号）')
  })

  it('要登录：没登录给登录入口，登录后回到这一页（和单词本同一个外壳）；先把排着的作答发完再拉；401 刷新登录状态', () => {
    expect(page).toContain('<NotebookPage label="学习记录" here="#/records">')
    expect(page).toMatch(/const sent = await drain\(sid\)\s+if \(!alive\) return\s+setUnsent\(!sent\)\s+if \(!sent\) void getStudent\(true\)\s+await getRecords\(\)/)
    expect(page).toContain('if (e.status === 401) void getStudent(true)')
    expect(page).toContain('<NotebookStatus data={data} error={error} unsent={unsent} />')
    expect(page).not.toMatch(/lib\/auth['"]|components\/Account/)
  })

  it('每行：标题、最近一次读的日期、选过才显示的难度、不带数字的状态；「看小结」都有，「接着读」只在还有没答的句子时有', () => {
    expect(page).toContain('{r.title}')
    expect(page).toContain('最近一次读：{bjDate(r.lastTs)}')
    expect(page).toContain('{r.rating && <span className="text-[13px] text-muted">你选的难度：{r.rating}</span>}')
    expect(page).toContain("{ todo: '还有没答的句子', done: '都答过了' }")
    expect(page).toMatch(/<a href=\{summaryHref\(r\)\} [^>]*>\s+看小结\s+<\/a>/)
    expect(page).toMatch(/\{r\.status === 'todo' && r\.firstPending && \(\s+<a href=\{resumeHref\(r, r\.firstPending\)\} [^>]*>\s+接着读\s+<\/a>/)
    expect(page).toContain('学习记录还是空的。读团队选的文章和自己贴的文章时答了题、点了词，那一篇就会列在这里。')
  })

  it('不出现记住了、掌握、进步、分数、正确率、排名、等级；不用「梯子」；没有语法术语、感叹号；手机上标题能折行', () => {
    for (const x of ['记住了', '掌握', '进步', '分数', '正确率', '排名', '等级', '级别', '梯子', '讲义', '老师', '班级']) expect(page, x).not.toContain(x)
    expect(page).not.toMatch(/cefr/i)
    expect(hasGrammarTerm(read('pages/student/Records.tsx'))).toBeUndefined()
    expect(page).not.toMatch(/！|[一-鿿]!/)
    expect(page).toContain('[overflow-wrap:anywhere]')
    expect(page).not.toMatch(/\bw-\[\d{3,}px\]|min-w-\[\d{3,}px\]/)
  })

  it('首页：登录后「团队选的文章」旁边有「学习记录」，在「单词本」旁边', () => {
    const home = code('pages/Home.tsx')
    const shelf = home.slice(home.indexOf('function Shelf('), home.indexOf('export default function Home('))
    expect(shelf).toMatch(/<a href="#\/records" [^>]*>\s+<Icon name="list" size=\{15\} \/>\s+学习记录\s+<\/a>\s+<a href="#\/notebook" /)
    expect(home.match(/href="#\/records"/g)).toHaveLength(1)
    expect(read('components/ui.tsx')).toContain('  list: <path')
  })
})
