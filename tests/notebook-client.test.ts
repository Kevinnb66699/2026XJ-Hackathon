// 单词本、表达本的前端（阶段 4）：拉 /api/student/notebook、单词本里的动作进账号的事件队列用假 fetch 测；
// 服务器的推算（lib/notebook 的 buildNotebook）的结果过一遍前端的解析，一条都不丢。
// 没有 DOM 测试环境，两页、精读句卡的「移出」、首页入口的条件和文案直接查源码
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NOTEBOOK_ID, type LearningEvent } from '../shared/schema'
import { hasGrammarTerm } from '../shared/terms'
import { buildNotebook } from '../src/lib/notebook'
import { byArticle } from '../src/pages/student/Expressions'
import { miniHandout as h } from './fixtures/mini-handout'

const sid = 'u-0123456789abcdef'
const reply = (status: number, body: unknown) => ({ ok: status >= 200 && status < 300, status, json: async () => body })
const memoryStorage = () => {
  const m = new Map<string, string>()
  return {
    m,
    get length() {
      return m.size
    },
    key: (i: number) => [...m.keys()][i] ?? null,
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
  }
}
// 每个测试拿一份新的模块：事件队列在模块里
const fresh = async () => {
  vi.resetModules()
  return { auth: await import('../src/lib/student-auth'), events: await import('../src/lib/events') }
}
const read = (f: string) => readFileSync(fileURLToPath(new URL(`../src/${f}`, import.meta.url)), 'utf8')
const code = (f: string) => read(f).replace(/\/\/.*$/gm, '').replace(/\{\/\*[\s\S]*?\*\/\}/g, '') // 去掉注释

const word = { lemma: 'fret', pos: 'v.', zh: '苦恼', ai: false, sources: [{ handoutId: 'up-a', title: 'A' }], example: { handoutId: 'up-a', sentenceId: 'S05', text: 'Pupils fret.' }, addedTs: 5, lastReview: { ts: 9, correct: false } }
const expr = { id: 'E1', handoutId: 'up-a', title: 'A', text: 'toy with the idea', zh: '考虑', ai: true, example: 'They toy with the idea.', pattern: '\\btoy\\s+with\\b', ts: 3 }

describe('getNotebook：GET /api/student/notebook', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('原样拿到单词本和表达本；格式不对的条目跳过；可选的字段格式不对就当没有；多出来的字段不要', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      reply(200, {
        words: [word, { ...word, lemma: '' }, { ...word, lemma: 'x', ai: 'yes' }, { ...word, lemma: 'y', sources: null }, { ...word, lemma: 'z', pos: 3, example: { text: 1 }, lastReview: 'old', mastered: true }, null],
        expressions: [expr, { ...expr, id: 'E2', ts: '3' }, { ...expr, id: 'E3', example: null, pattern: undefined }],
      }),
    )
    vi.stubGlobal('fetch', fetchMock)
    const { auth } = await fresh()
    const nb = await auth.getNotebook()
    expect(fetchMock.mock.calls[0][0]).toBe('/api/student/notebook')
    expect(nb.words).toEqual([word, { lemma: 'z', zh: '苦恼', ai: false, sources: word.sources, addedTs: 5 }])
    expect(nb.words[1]).not.toHaveProperty('mastered')
    expect(nb.expressions).toEqual([expr, { id: 'E3', handoutId: 'up-a', title: 'A', text: 'toy with the idea', zh: '考虑', ai: true, ts: 3 }])
  })

  it('不是数组当空的；没登录 401 抛出，带后端的提示', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(reply(200, { words: {}, expressions: 'x' })))
    const { auth } = await fresh()
    expect(await auth.getNotebook()).toEqual({ words: [], expressions: [] })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(reply(401, { error: '请先登录' })))
    await expect(auth.getNotebook()).rejects.toMatchObject({ status: 401, message: '请先登录' })
  })

  it('服务器推算的结果（buildNotebook，序列化成 JSON）过一遍前端的解析，一条不丢、一个字段不变', async () => {
    let t = 0
    const ev = (e: Omit<LearningEvent, 'sid' | 'ts' | 'handoutId'>, handoutId = h.id): LearningEvent => ({ sid, ts: ++t, handoutId, ...e })
    const events = [
      ev({ type: 'tap_word', lemma: 'fret' }),
      ev({ type: 'word_card', lemma: 'pending', value: 'unknown' }),
      ev({ type: 'tap_word', lemma: 'toy' }), // 词表外的词，意思取自全文词义
      ev({ type: 'collect_expression', value: 'E1' }),
      ev({ type: 'collect_expression', value: 'E3' }),
      ev({ type: 'review_word', lemma: 'fret', correct: false }, NOTEBOOK_ID),
    ]
    const nb = buildNotebook([h], events)
    expect(nb.words.length).toBeGreaterThan(1)
    expect(nb.expressions.length).toBe(2)
    expect(nb.words.some((w) => w.lastReview)).toBe(true)
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(reply(200, JSON.parse(JSON.stringify(nb)))))
    const { auth } = await fresh()
    expect(await auth.getNotebook()).toEqual(nb)
  })
})

describe('notebookEvent：单词本、表达本里的动作进这个账号的事件队列', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('复习、移出单词带 handoutId notebook；移出表达带那一篇；都记在这个 sid 下、带时间；连不上时留在队列里', async () => {
    const posted: LearningEvent[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn((_url: string, init?: RequestInit) => {
        posted.push(...(JSON.parse(init!.body as string) as LearningEvent[]))
        return Promise.resolve(reply(200, { ok: true }))
      }),
    )
    vi.stubGlobal('localStorage', memoryStorage())
    const { auth, events } = await fresh()
    await auth.notebookEvent(sid, { handoutId: NOTEBOOK_ID, type: 'review_word', lemma: 'fret', correct: true })
    await auth.notebookEvent(sid, { handoutId: NOTEBOOK_ID, type: 'drop_word', lemma: 'fret' })
    await auth.notebookEvent(sid, { handoutId: 'up-a', type: 'drop_expression', value: 'E1' })
    expect(posted.map(({ ts, ...e }) => (expect(typeof ts).toBe('number'), e))).toEqual([
      { sid, handoutId: 'notebook', type: 'review_word', lemma: 'fret', correct: true },
      { sid, handoutId: 'notebook', type: 'drop_word', lemma: 'fret' },
      { sid, handoutId: 'up-a', type: 'drop_expression', value: 'E1' },
    ])
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')))
    await auth.notebookEvent(sid, { handoutId: NOTEBOOK_ID, type: 'drop_word', lemma: 'pending' })
    expect(events.pendingCount(sid)).toBe(1)
    expect(await events.drain(sid)).toBe(false)
  })
})

describe('byArticle：表达本按文章分组', () => {
  it('最近收过的那一篇在上面，组里按收的先后；不同文章里同一个表达 id 各算各的', () => {
    const list = [
      { ...expr, id: 'E1', handoutId: 'up-a', title: 'A', ts: 1 },
      { ...expr, id: 'E1', handoutId: 'up-b', title: 'B', ts: 2 },
      { ...expr, id: 'E3', handoutId: 'up-a', title: 'A', ts: 5 },
      { ...expr, id: 'E2', handoutId: 'up-a', title: 'A', ts: 4 },
    ]
    const g = byArticle(list)
    expect(g.map((x) => [x.handoutId, x.title, x.items.map((e) => e.id)])).toEqual([
      ['up-a', 'A', ['E1', 'E2', 'E3']],
      ['up-b', 'B', ['E1']],
    ])
    expect(byArticle([])).toEqual([])
  })
})

describe('页面：单词本、表达本', () => {
  const book = code('pages/student/WordBook.tsx')
  const exprs = code('pages/student/Expressions.tsx')
  const shell = code('components/NotebookPage.tsx')

  it('路由：#/notebook 是单词本，#/expressions 是表达本；router 的注释写上', () => {
    const app = read('App.tsx')
    expect(app).toContain("path === '/notebook' ? <WordBookPage />")
    expect(app).toContain("path === '/expressions' ? <ExpressionsPage />")
    expect(read('lib/router.ts')).toContain('#/notebook（单词本）、#/expressions（表达本')
  })

  it('两页都要登录：没登录给登录入口，登录后回到这一页；顶栏用学生自己的', () => {
    expect(book).toContain('<NotebookPage label="单词本" here="#/notebook">')
    expect(exprs).toContain('<NotebookPage label="表达本" here="#/expressions">')
    expect(shell).toContain('const { loading, student } = useStudentMe()')
    expect(shell).toMatch(/\) : student \? \(\s+<Fragment key=\{student\.sid\}>\{children\(student\)\}<\/Fragment>\s+\) : \(/)
    expect(shell).toContain('<a href={loginHref(here)}')
    expect(shell).toContain('<SiteHeader label={label} actions={<StudentBar />} />')
    for (const f of [book, exprs, shell]) expect(f).not.toMatch(/lib\/auth['"]|components\/Account/)
  })

  it('先把这个账号排着的动作发完再拉；动作之后发完了才再拉（没发完先用页面上改好的）；401 刷新登录状态', () => {
    expect(shell).toMatch(/const sent = await drain\(sid\)\s+setUnsent\(!sent\)\s+if \(!sent\) void getStudent\(true\)\s+if \(!sent && !always\) return\s+await getNotebook\(\)/)
    expect(shell).toContain('void refresh(true)') // 打开时发不完也拉
    expect(shell).toContain('if (e.status === 401) void getStudent(true)')
    expect(shell).toContain('void notebookEvent(sid, e)')
    expect(shell).toContain('有几条记录还没发出去，连上以后会自动发。')
  })

  it('拉的结果按先后：每次拉、每次页面上改都给 seq 加一，拉回来时 seq 变了就不用这次的结果和出错（晚回来的旧结果不盖掉刚改的）', () => {
    expect(shell).toContain('const seq = useRef(0)')
    expect(shell).toMatch(/const mine = \+\+seq\.current\s+const sent = await drain\(sid\)/)
    expect(shell.match(/if \(seq\.current !== mine\) return/g)).toHaveLength(2)
    expect(shell).toMatch(/if \(seq\.current !== mine\) return\s+setData\(n\)/)
    expect(shell).toMatch(/if \(seq\.current !== mine\) return\s+setError\(e\.message\)/)
    expect(shell).toMatch(/const update = useCallback\(\(fn: \(n: Notebook\) => Notebook\) => \{\s+seq\.current\+\+\s+setData\(\(n\) => n && fn\(n\)\)/)
  })

  it('单词本：每条有词、词性、中文、出处，能移出（drop_word，handoutId notebook）；复习一轮按 reviewOrder 取 REVIEW_SIZE 张', () => {
    expect(book).toContain('{w.lemma}')
    expect(book).toContain('{w.pos && <span')
    expect(book).toContain('{w.zh}')
    expect(book).toContain('<Sources w={w} link />')
    expect(book).toContain('href={articleHref(s.handoutId)}')
    expect(book).toContain("record({ handoutId: NOTEBOOK_ID, type: 'drop_word', lemma: w.lemma })")
    expect(book).toContain('移出单词本')
    expect(book).toContain('setDeck(reviewOrder(words).slice(0, REVIEW_SIZE))')
    expect(book).toContain("import { REVIEW_SIZE, reviewOrder } from '../../lib/notebook'")
    expect(book).toContain("import { NOTEBOOK_ID } from '../../../shared/schema'")
  })

  it('复习卡：意思先盖住，点「看意思」才显示；下面「还不认识 / 认识」发 review_word；用原文例句；复习卡上不放出处链接', () => {
    const review = book.slice(book.indexOf('function Review('))
    expect(review).toContain('const [peek, setPeek] = useState(false)')
    expect(review).toMatch(/\{peek \? \(/)
    expect(review).toContain('onClick={() => setPeek(true)}')
    expect(review).toContain('看意思')
    expect(review).toMatch(/onClick=\{\(\) => mark\(false\)\}>\s+还不认识/)
    expect(review).toMatch(/onClick=\{\(\) => mark\(true\)\}>\s+认识/)
    expect(book).toContain("record({ handoutId: NOTEBOOK_ID, type: 'review_word', lemma: w.lemma, correct })")
    expect(review).toContain('原文例句')
    expect(review).toContain('const example = w.example?.text')
    expect(review).toContain('<Sources w={w} />')
    // 这一轮最后一张点完：发完再拉
    expect(review).toContain('if (i + 1 === deck.length) onRound()')
    expect(book).toContain('onRound={() => void refresh()}')
  })

  it('表达本：按文章分组，出处可以点开；每条有表达、中文、原文例句（表达加粗），能移出（drop_expression，handoutId 是那一篇）', () => {
    expect(exprs).toContain('const groups = data ? byArticle(data.expressions) : []')
    expect(exprs).toContain('href={articleHref(g.handoutId)}')
    expect(exprs).toContain('{e.text}')
    expect(exprs).toContain('{e.zh}')
    expect(exprs).toContain('<Example text={e.example} pattern={e.pattern} />')
    expect(exprs).toContain("import { Example } from '../../components/Example'")
    expect(exprs).toContain("record({ handoutId: e.handoutId, type: 'drop_expression', value: e.id })")
    expect(exprs).toContain('移出表达本')
  })

  // 示例文章、从班级二维码进来时收的表达、点的词不记到账号上，服务器也只算上架的文章：页面上说清只算团队选的文章
  it('说明和空状态都说「读团队选的文章时」，不说「读过的每一篇」（首页第 3 条也是）', () => {
    expect(book).toContain('读团队选的文章时不认识的词都攒在这里：')
    expect(book).toContain('单词本还是空的。读团队选的文章时不认识的词，会自动加进来。')
    expect(exprs).toContain('读团队选的文章时收进表达本的表达都在这里，按文章分开，写作时用得上。')
    expect(exprs).toContain('表达本还是空的。读团队选的文章时点「收进表达本」，表达会攒在这里。')
    for (const f of [book, exprs, code('pages/Home.tsx')]) expect(f).not.toContain('读过的每一篇')
  })

  it('中文用 AiTag，只在 ai 为真时显示；「AI 生成」几个字不另写', () => {
    for (const [f, name] of [[book, 'w'], [exprs, 'e']] as const) {
      const tags = f.match(/<AiTag\b/g)?.length ?? 0
      expect(tags).toBeGreaterThan(0)
      expect(f.match(new RegExp(`\\{${name}\\.ai && <AiTag\\b`, 'g'))?.length).toBe(tags)
      expect(f).not.toContain('AI 生成')
    }
  })

  it('不出现记住了、掌握、进步、分数、正确率、排名、等级；不显示 cefr，不用先猜后看；没有语法术语、感叹号', () => {
    for (const f of ['pages/student/WordBook.tsx', 'pages/student/Expressions.tsx', 'components/NotebookPage.tsx']) {
      const c = code(f)
      for (const x of ['记住了', '掌握', '进步', '分数', '正确率', '排名', '等级', '级别']) expect(c, `${f}: ${x}`).not.toContain(x)
      expect(c, f).not.toMatch(/cefr/i)
      expect(c, f).not.toContain('WordGuess')
      expect(hasGrammarTerm(read(f)), f).toBeUndefined()
      expect(c, f).not.toMatch(/！|[一-鿿]!/)
    }
  })

  it('手机上不横向滚动：长的词、文章标题能在任意处折行', () => {
    expect(book.match(/\[overflow-wrap:anywhere\]/g)?.length).toBeGreaterThanOrEqual(2) // 列表里的词、复习卡上的词
    expect(exprs).toContain('[overflow-wrap:anywhere]') // 文章标题
    for (const f of [book, exprs, code('components/NotebookPage.tsx')]) expect(f).not.toMatch(/\bw-\[\d{3,}px\]|min-w-\[\d{3,}px\]/)
  })
})

describe('精读句卡、首页', () => {
  it('句卡：收了的表达旁边有「移出」，点了调 onDrop；不给 onDrop 就没有（评委页、下一版预览）', () => {
    const card = code('components/SentenceCard.tsx')
    expect(card).toContain('onDrop?: (expressionId: string) => void')
    expect(card).toMatch(/\{onDrop && \(\s+<button type="button" onClick=\{\(\) => onDrop\(e\.id\)\}[^>]*>\s+移出\s+<\/button>/)
    expect(card).toContain('<button key={e.id} type="button" onClick={() => onCollect(e.id)} className={row}>')
    expect(card).toContain('<SentenceCard key={sv.id} h={h} view={sv} state={state} act={act} onCollect={onCollect} onDrop={onDrop} />')
  })

  it('首页：登录后「团队选的文章」旁边有「单词本」「表达本」；「知适是怎么做的」加上第 3 条「自己复习」', () => {
    const home = code('pages/Home.tsx')
    const shelf = home.slice(home.indexOf('function Shelf('), home.indexOf('export default function Home('))
    expect(shelf.indexOf('团队选的文章')).toBeLessThan(shelf.indexOf('href="#/notebook"'))
    expect(shelf).toMatch(/<a href="#\/notebook" [^>]*>\s+<Icon name="book" size=\{15\} \/>\s+单词本\s+<\/a>/)
    expect(shelf).toMatch(/<a href="#\/expressions" [^>]*>\s+<Icon name="book" size=\{15\} \/>\s+表达本\s+<\/a>/)
    expect(home).toContain('{student && <Shelf />}') // 只在登录后
    expect(home).toContain("{ n: '3', title: '自己复习', desc: '登录后，读团队选的文章时不认识的词和收进表达本的表达都攒在一起，可以回头复习。' }")
  })
})
