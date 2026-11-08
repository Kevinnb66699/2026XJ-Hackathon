// 学生贴文章的前端（阶段 3）：lib/student-auth 的开没开放、提交、查进度、我的文章用假 fetch 测；页面上给学生看的话（拒收原因、限额、全站停了、任务丢了、进度）直接测。
// 没有 DOM 测试环境，页面、首页的「我的文章」、路由的条件和文案直接查源码
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { hasGrammarTerm } from '../shared/terms'
import { articleHref } from '../src/components/NotebookPage'
import { UPLOAD_PENDING_KEY, studentUploadKey } from '../src/lib/store'
import { StudentError, getLibrary, getUploadJob, getUploadStatus, submitUpload, uploadRefusal } from '../src/lib/student-auth'
import { CONFIRMS, KINDS, LOST, REASONS, bjMonthDay, charCount, pausedText, progressOf, refusalText } from '../src/pages/student/StudentUpload'

const reply = (status: number, body: unknown) => ({ ok: status >= 200 && status < 300, status, json: async () => body })
const read = (f: string) => readFileSync(fileURLToPath(new URL(`../src/${f}`, import.meta.url)), 'utf8')
const code = (f: string) => read(f).replace(/\/\/.*$/gm, '').replace(/\{\/\*[\s\S]*?\*\/\}/g, '') // 去掉注释
// 后端拒绝时的错误：照 lib/student-auth 的 request 抛出来的样子
const refused = async (status: number, body: Record<string, unknown>) => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(reply(status, body)))
  return submitUpload('x'.repeat(300), true).catch((e: StudentError) => e)
}

describe('getUploadStatus：GET /api/upload-status', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('开没开放、这周用了几篇、每周几篇；全站停了带恢复时间（ISO 或毫秒都认），不收钱数', async () => {
    const fetchMock = vi.fn().mockResolvedValue(reply(200, { enabled: true, open: false, weekUsed: 2, weekLimit: 2, resetsAt: '2026-11-08T16:00:00.000Z', paused: { resumesAt: '2026-11-07T16:00:00.000Z' }, spent: 3 }))
    vi.stubGlobal('fetch', fetchMock)
    expect(await getUploadStatus()).toEqual({ enabled: true, weekUsed: 2, weekLimit: 2, pausedUntil: Date.parse('2026-11-07T16:00:00.000Z') })
    expect(fetchMock.mock.calls[0][0]).toBe('/api/upload-status')
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(reply(200, { enabled: true, weekUsed: 0, weekLimit: 2, paused: { resumesAt: 1794153600000 } })))
    expect((await getUploadStatus()).pausedUntil).toBe(1794153600000)
  })

  it('格式不对的当没开放、0 篇；没停就没有 pausedUntil；没登录 401 抛出', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(reply(200, { enabled: 'yes', weekUsed: -1, weekLimit: '2', paused: { resumesAt: 'soon' } })))
    expect(await getUploadStatus()).toEqual({ enabled: false, weekUsed: 0, weekLimit: 0 })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(reply(401, { error: '请先登录' })))
    const err = await getUploadStatus().catch((e: StudentError) => e)
    expect(err).toBeInstanceOf(StudentError)
    expect(err).toMatchObject({ status: 401, message: '请先登录' })
  })
})

describe('submitUpload：POST /api/student/uploads', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('学生自己的接口（不是老师的 /api/uploads），只发原文和三项勾没勾全（照页面传的，不写死），没有标题、必练词这些；学生选了才带 similar', async () => {
    const fetchMock = vi.fn().mockResolvedValue(reply(202, { jobId: 'up-job1' }))
    vi.stubGlobal('fetch', fetchMock)
    const text = 'Some article.\n\nSecond paragraph.'
    expect(await submitUpload(text, true)).toEqual({ jobId: 'up-job1' })
    const [path, init] = fetchMock.mock.calls[0]
    expect(path).toBe('/api/student/uploads')
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body)).toEqual({ text, confirm: true })
    await submitUpload(text, true, 'ignore')
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({ text, confirm: true, similar: 'ignore' })
    await submitUpload(text, true, 'use')
    expect(JSON.parse(fetchMock.mock.calls[2][1].body)).toEqual({ text, confirm: true, similar: 'use' })
    await submitUpload(text, false, 'use')
    expect(JSON.parse(fetchMock.mock.calls[3][1].body)).toEqual({ text, confirm: false, similar: 'use' })
  })

  it('三种回答：已经有现成的讲义、开始生成或接上正在生成的任务、只差标点或大小写的那一份；别的回答抛出', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(reply(200, { handoutId: 'up-a1', reused: true })))
    expect(await submitUpload('t', true)).toEqual({ handoutId: 'up-a1', reused: true })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(reply(202, { jobId: 'up-j2', joined: true })))
    expect(await submitUpload('t', true)).toEqual({ jobId: 'up-j2' })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(reply(200, { similar: { handoutId: 'up-b2', title: 'Phones at School' } })))
    expect(await submitUpload('t', true)).toEqual({ similar: { handoutId: 'up-b2', title: 'Phones at School' } })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(reply(200, { similar: { handoutId: 'up-b2' } })))
    expect(await submitUpload('t', true)).toEqual({ similar: { handoutId: 'up-b2', title: '' } })
    for (const bad of [{}, { handoutId: '../x' }, { jobId: 'UP JOB' }, { similar: { title: 'x' } }]) {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(reply(200, bad)))
      await expect(submitUpload('t', true)).rejects.toThrow('服务器的回应不对')
    }
  })

  it('被拒：kind、reason、resumesAt、lost 都从后端的 JSON 里读出来；不是请求的错误什么都没有', async () => {
    const week = await refused(429, { error: '这周的次数用完了', kind: 'week', resetsAt: '2026-11-08T16:00:00.000Z' })
    expect(uploadRefusal(week)).toEqual({ kind: 'week', lost: false })
    const spend = await refused(429, { error: '全站停了', kind: 'spend', resumesAt: '2026-11-07T16:00:00.000Z' })
    expect(uploadRefusal(spend)).toEqual({ kind: 'spend', resumesAt: Date.parse('2026-11-07T16:00:00.000Z'), lost: false })
    const exam = await refused(400, { error: '像试卷', reason: 'exam' })
    expect(uploadRefusal(exam)).toEqual({ reason: 'exam', lost: false })
    expect(uploadRefusal(new Error('x'))).toEqual({ lost: false })
    expect(uploadRefusal(new StudentError('x', 404, {}, { lost: 'yes' }))).toEqual({ lost: false })
  })
})

describe('getUploadJob：GET /api/uploads/:jobId', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('正在生成：中文进度照收；管线的进度对象也收下；格式不对当没有进度', async () => {
    const fetchMock = vi.fn().mockResolvedValue(reply(200, { status: 'running', progress: 'AI 在写第 2 / 5 段的提示和题目' }))
    vi.stubGlobal('fetch', fetchMock)
    expect(await getUploadJob('up-j1')).toEqual({ status: 'running', progress: 'AI 在写第 2 / 5 段的提示和题目' })
    expect(fetchMock.mock.calls[0][0]).toBe('/api/uploads/up-j1')
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(reply(200, { status: 'running', progress: { stage: 'draft', done: 1, total: 4 } })))
    expect(await getUploadJob('up-j1')).toEqual({ status: 'running', progress: { stage: 'draft', done: 1, total: 4 } })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(reply(200, { status: 'running', progress: 3 })))
    expect(await getUploadJob('up-j1')).toEqual({ status: 'running', progress: undefined })
  })

  it('做好了给讲义 id；失败给中文提示和原因（内容安全拦截是 unsafe）；做好了却没有讲义 id 当失败', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(reply(200, { status: 'done', handoutId: 'up-h9', title: 'x', report: {} })))
    expect(await getUploadJob('up-j1')).toEqual({ status: 'done', handoutId: 'up-h9' })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(reply(200, { status: 'failed', error: '这篇文章里有不适合在这里读的内容，换一篇吧', reason: 'unsafe' })))
    expect(await getUploadJob('up-j1')).toEqual({ status: 'failed', error: '这篇文章里有不适合在这里读的内容，换一篇吧', reason: 'unsafe' })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(reply(200, { status: 'done' })))
    expect(await getUploadJob('up-j1')).toEqual({ status: 'failed', error: '' })
  })

  it('任务丢了（服务器重启过）404 带 lost：抛出，页面说重新提交；不是这个账号的任务 404 照后端的提示', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(reply(404, { error: '找不到这个生成任务', lost: true })))
    const lost = await getUploadJob('up-j1').catch((e: StudentError) => e)
    expect(lost).toMatchObject({ status: 404 })
    expect(uploadRefusal(lost).lost).toBe(true)
    expect(refusalText(lost)).toBe('重新提交一次，已经生成好的会直接复用')
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(reply(404, { error: '找不到这个生成任务，请重新提交' })))
    expect(refusalText(await getUploadJob('up-j1').catch((e: StudentError) => e))).toBe('找不到这个生成任务，请重新提交')
  })
})

describe('getLibrary：GET /api/student/library', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('新加的在前（加入时间是 ISO 或毫秒都认）；id 不对的跳过；没有标题给空字符串；只留 id 和标题', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      reply(200, {
        handouts: [
          { id: 'up-old', title: 'Old', addedAt: '2026-11-01T00:00:00.000Z' },
          { id: 'up-new', title: 'New', addedAt: Date.parse('2026-11-07T00:00:00.000Z') },
          { id: 'up-mid', addedAt: '2026-11-03T00:00:00.000Z' },
          { id: '../etc', title: 'Bad' },
          null,
        ],
      }),
    )
    vi.stubGlobal('fetch', fetchMock)
    expect(await getLibrary()).toEqual([
      { id: 'up-new', title: 'New' },
      { id: 'up-mid', title: '' },
      { id: 'up-old', title: 'Old' },
    ])
    expect(fetchMock.mock.calls[0][0]).toBe('/api/student/library')
  })

  it('不是数组当空的；没登录 401 抛出', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(reply(200, { handouts: {} })))
    expect(await getLibrary()).toEqual([])
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(reply(401, { error: '请先登录' })))
    await expect(getLibrary()).rejects.toMatchObject({ status: 401 })
  })
})

describe('贴文章页给学生看的话', () => {
  it('拒收按 reason 给中文原因；限额按 kind；认不出的照后端的提示', async () => {
    expect(REASONS.not_english).toContain('不像英文')
    expect(REASONS.exam).toContain('只贴文章正文')
    expect(REASONS.personal_info).toContain('手机号、身份证号或邮箱')
    expect(REASONS.repeated).toContain('同一句重复')
    expect(REASONS.unsafe).toBe('这篇文章里有不适合在这里读的内容，换一篇吧')
    for (const reason of Object.keys(REASONS)) expect(refusalText(await refused(400, { error: '后端的说法', reason }))).toBe(REASONS[reason])
    expect(refusalText(await refused(400, { error: '后端的说法', reason: 'other' }))).toBe('后端的说法')
    // 后端的 length 还包括段数、句数这些（字符数没超也会是它），照后端的说法
    expect(REASONS.length).toBeUndefined()
    expect(refusalText(await refused(400, { error: '段落太多：最多 12 段（现在 13 段）', reason: 'length' }))).toBe('段落太多：最多 12 段（现在 13 段）')
    expect(refusalText(await refused(429, { error: '这周用完了', kind: 'week' }))).toBe(KINDS.week)
    expect(KINDS.week).toContain('下周一恢复')
    expect(refusalText(await refused(429, { error: 'x', kind: 'busy' }))).toContain('正在生成')
    expect(refusalText(await refused(429, { error: 'x', kind: 'fails' }))).toContain('明天再试')
    expect(refusalText(await refused(429, { error: 'x', kind: 'spend', resumesAt: '2026-11-07T16:00:00.000Z' }))).toContain('免费名额恢复')
    expect(refusalText(await refused(429, { error: 'x', kind: 'crowded' }))).toBe('现在同时在生成的文章有点多，过几分钟再试') // 只是正在生成的占着，没有恢复日期
    expect(refusalText(await refused(403, { error: '贴文章还没开放' }))).toBe('贴文章还没开放')
    expect(refusalText(new StudentError('', 500))).toBe('这篇没有生成成功，可以再提交一次')
  })

  it('全站停了：照计划的说法，恢复日期按北京时间写「X 月 X 日」', () => {
    expect(bjMonthDay(Date.parse('2026-11-07T16:00:00.000Z'))).toBe('11 月 8 日') // 北京时间 11-08 0 点
    expect(bjMonthDay(Date.parse('2026-11-30T15:59:00.000Z'))).toBe('11 月 30 日')
    expect(pausedText(Date.parse('2026-11-30T16:00:00.000Z'))).toBe('这几天的免费生成名额用完了，12 月 1 日恢复。已经生成过的文章照常能读；贴进来的文章如果已经有现成讲义，也能直接读。')
    expect(LOST).toBe('重新提交一次，已经生成好的会直接复用')
  })

  it('进度：中文进度照用；管线的进度对象写成中文，叫「提示」不叫「梯子」；只有对象带百分比', () => {
    expect(progressOf()).toEqual({ text: '准备中' })
    expect(progressOf('逐条对照原文检查')).toEqual({ text: '逐条对照原文检查' })
    expect(progressOf({ stage: 'draft', done: 1, total: 4 })).toEqual({ text: 'AI 在写第 2 / 4 段的提示和题目', pct: 28 })
    expect(progressOf({ stage: 'draft', done: 4, total: 4 }).text).toBe('AI 在写第 4 / 4 段的提示和题目')
    for (const stage of ['split', 'draft', 'repair', 'validate', 'done']) {
      const p = progressOf({ stage, done: 0, total: 3 })
      expect(p.text).not.toContain('梯子')
      expect(p.pct).toBeGreaterThan(0)
    }
  })

  it('字数和后端一样数：去掉首尾空白', () => {
    expect(charCount('  abc \n\n')).toBe(3)
    expect(charCount('a\n\nb')).toBe(4)
  })

  it('三项确认', () => {
    expect(CONFIRMS).toEqual(['这篇不是还没公开的考试题或学校内部资料', '这篇不含自己或别人的个人信息', '我有权使用这篇文章'])
  })

  it('正在生成的任务按账号分开记在本机，和老师上传页的键不一样', () => {
    expect(studentUploadKey('u-0123456789abcdef')).toBe('zhishi:student-upload:u-0123456789abcdef')
    expect(studentUploadKey('u-0123456789abcdef')).not.toBe(studentUploadKey('u-fedcba9876543210'))
    expect(studentUploadKey('u-0123456789abcdef')).not.toBe(UPLOAD_PENDING_KEY)
  })
})

describe('页面：#/new 贴一篇文章', () => {
  const page = code('pages/student/StudentUpload.tsx')

  it('不引用老师的上传页、lib/auth 和顶栏账号；没有发班、二维码、改题目、讲解、必练词、「梯子」「老师」', () => {
    expect(page).not.toMatch(/from '\.\.\/Upload'|pages\/Upload|lib\/auth'|components\/Account/)
    for (const x of ['发给班级', '二维码', '改题目', '写讲解', '必练词', '梯子', '老师', '班级', '教学重点']) expect(page, x).not.toContain(x)
    // 「标题」只出现在 AI 说明那一句里（标题由 AI 起），没有填标题的地方
    expect(page.replace('这篇的标题、题目、词义和提示由 AI 生成', '')).not.toContain('标题')
  })

  it('不说进步、分数、掌握、记住了、正确率、排名、等级；没有语法术语、感叹号', () => {
    for (const x of ['进步', '分数', '掌握', '记住了', '正确率', '排名', '等级', '级别']) expect(page, x).not.toContain(x)
    expect(page).not.toMatch(/cefr/i)
    expect(hasGrammarTerm(read('pages/student/StudentUpload.tsx'))).toBeUndefined()
    expect(page).not.toMatch(/！|[一-鿿]!/)
  })

  it('要登录：没登录给登录入口，登录后回到 #/new；每个账号一份（key 是 sid）', () => {
    expect(page).toContain("loginHref('#/new')")
    expect(page).toContain('<Compose key={student.sid} me={student} />')
    expect(page).toContain('const key = studentUploadKey(me.sid)')
  })

  it('上方写这周还能生成几篇、下周一恢复；全站停了换成停了的说法；没开放时不给表单', () => {
    expect(page).toContain('这周还能生成 {Math.max(0, status.weekLimit - status.weekUsed)} 篇，下周一恢复')
    expect(page).toContain('{pausedText(pausedUntil)}')
    expect(page).toContain('const closed = status?.enabled === false')
    expect(page).toContain('贴文章还没开放')
  })

  it('贴原文：段落之间空一行，实时显示字数，200–8000 字符；三项都是必勾', () => {
    expect(page).toContain('段落之间空一行')
    expect(page).toContain('现在 {n} 个字符，要在 {MIN_CHARS} 到 {MAX_CHARS} 之间')
    expect(page).toContain('if (n < MIN_CHARS || n > MAX_CHARS) return setError(')
    expect(page).toMatch(/\{CONFIRMS\.map\(\(c, i\) => \(\s+<label key=\{c\}[^>]*>\s+<input\s+type="checkbox"\s+required/)
  })

  it('等 AI：每 1.5 秒查一次；任务记在本机，关掉再回来接着查；做完、失败、丢了才清掉', () => {
    expect(page).toContain('let wait = 1500')
    expect(page).toContain('timer = window.setTimeout(tick, wait)')
    expect(page).toContain('const [jobId, setJobId] = useState(() => savedJob(key))')
    expect(page).toContain('writeLS(key, r.jobId)')
    expect(page.match(/writeLS\(key, null\)/g)).toHaveLength(1) // 只在 finish 里清
    expect(page).toContain('关掉这一页也不会中断，回来会接着显示进度。')
  })

  it('做好了「开始读」整页打开 /?h=<id>#/student；已经有现成讲义的直接读；只差标点或大小写的让学生选', () => {
    expect(articleHref('up-abc')).toBe('/?h=up-abc#/student')
    expect(page).toMatch(/<a href=\{articleHref\(result\.handoutId\)\}[^>]*>\s+开始读\s+<\/a>/)
    expect(page).toContain('这篇已经有现成的讲义')
    expect(page).toMatch(/onClick=\{\(\) => void send\('use'\)\}[^>]*>\s+直接读那一份\s+</)
    expect(page).toMatch(/onClick=\{\(\) => void send\('ignore'\)\}[^>]*>\s+按我贴的生成\s+</)
    expect(page).toContain("else if (choice === 'use') window.location.assign(articleHref(r.handoutId))")
  })

  it('三项确认不能绕过：选「直接读」「按我贴的生成」时三项没勾全，两个按钮按不了；提交时 confirm 照勾选框的实际情况发', () => {
    expect(page).toContain('const confirmed = checks.every(Boolean)')
    expect(page.match(/disabled=\{busy \|\| !confirmed\} onClick=\{\(\) => void send\('(?:use|ignore)'\)\}/g)).toHaveLength(2)
    expect(page).toContain("{confirmed ? '直接读那一份不占这周的次数。' : '先勾上上面三项。'}")
    expect(page).toContain('submitUpload(text, checks.every(Boolean), choice)')
    expect(page).not.toMatch(/submitUpload\([^)]*\btrue\b/)
  })

  it('手机上不横向滚动：没有写死的宽度，长标题能折行', () => {
    expect(page).not.toMatch(/\bw-\[\d{3,}px\]|min-w-\[\d{3,}px\]/)
    expect(page).toContain('[overflow-wrap:anywhere]')
  })
})

describe('路由、首页的「我的文章」、读不到时的提示', () => {
  it('#/new 是学生贴文章页；老师的 #/upload 照旧；router 的注释写上', () => {
    const app = read('App.tsx')
    expect(app).toContain("path === '/new' ? <StudentUploadPage />")
    expect(app).toContain("path === '/upload' ? <UploadPage />")
    expect(read('lib/router.ts')).toContain('#/new（学生贴一篇文章生成讲义，要登录学生账号')
  })

  it('首页：登录后有「我的文章」，整页打开；开放了才放「贴一篇文章」入口；没开放、也没贴过的整块不显示', () => {
    const home = code('pages/Home.tsx')
    const mine = home.slice(home.indexOf('function Mine('), home.indexOf('export default function Home('))
    expect(home).toContain('{student && <Mine />}')
    expect(mine).toContain('getLibrary().then(setItems')
    expect(mine).toContain('(s) => setEnabled(s.enabled)')
    expect(mine).toContain('if (!enabled && !items?.length) return null')
    expect(mine).toMatch(/\{enabled && \(\s+<a href="#\/new" [^>]*>\s+贴一篇文章\s+<\/a>/)
    expect(home.match(/href="#\/new"/g)).toHaveLength(1)
    expect(mine).toContain('href={`/?h=${encodeURIComponent(x.id)}#/student`}')
    expect(mine).toContain('if (e.status === 401) void getStudent(true)')
    expect(mine).toContain('我的文章')
  })

  it('读不到的文章：说一句别人贴的只有贴过的人能读（后端不说有没有这篇）', () => {
    expect(read('data/index.ts')).toContain("'找不到这篇文章：链接不完整，或者已经下架了。同学自己贴的文章，只有贴过这一篇的人能读'")
  })
})
