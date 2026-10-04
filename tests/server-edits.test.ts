// 老师改 AI 起草的题目和梯子（POST /api/handouts/:id/edits）：只有上传的老师登录后能改、只限上传的讲义、和校验器一致的规则（梯子第 1 步是原句原话、
// 选项 2–4 个不重复、答案序号、没有语法术语）、按字段给中文提示、一处不合格就都不写、来源记成老师改过、和讲解保存共用一条队
// 请求用 node:http 发（同 server-notes.test.ts）；后端模块引了 undici，这个文件也用子进程跑（见 vite.config.ts）
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { BREAKDOWN_LABELS as SERVER_LABELS, createApp } from '../server/index.mjs'
import { BREAKDOWN_LABELS, Handout } from '../shared/schema'
import { GRAMMAR_TERMS } from '../shared/terms'
import { validateHandout } from '../pipeline/validate'
import { miniHandout } from './fixtures/mini-handout'

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zhishi-edits-'))
const ID = 'up-edits1'
const file = path.join(dataDir, 'handouts', `${ID}.json`)
// 用迷你讲义当上传的讲义：结构完整，改完还能整份过校验器。meta 的 owner 在注册老师之后写（见 beforeAll）
const original = { ...miniHandout, id: ID }
fs.mkdirSync(path.dirname(file), { recursive: true })
const stored = () => JSON.parse(fs.readFileSync(file, 'utf8'))
const TEACHER = { by: 'human', reviewedBy: 'teacher' }

let app: { server: Server; port: number }
let OWNER = '' // 上传这篇的老师登录后的 cookie
let OTHER = '' // 另一位老师
// 默认带上传这篇的老师的 cookie；cookie 传 '' 就是没登录
function call(url: string, b?: unknown, method = 'POST', cookie = OWNER) {
  return new Promise<{ status: number; body: any; headers: http.IncomingHttpHeaders }>((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: app.port, path: url, method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) } }, (res) => {
      let text = ''
      res.setEncoding('utf8')
      res.on('data', (c) => (text += c))
      res.on('end', () => resolve({ status: res.statusCode!, body: JSON.parse(text), headers: res.headers }))
    })
    req.on('error', reject)
    req.end(b === undefined ? undefined : JSON.stringify(b))
  })
}
const edits = (b: Record<string, unknown>, id = ID) => call(`/api/handouts/${id}/edits`, b)
// 注册一位老师，返回 cookie 和老师 id
async function register(invite: string, username: string) {
  const r = await new Promise<{ cookie: string; id: string }>((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: app.port, path: '/api/auth/register', method: 'POST', headers: { 'content-type': 'application/json' } }, (res) => {
      let text = ''
      res.setEncoding('utf8')
      res.on('data', (c) => (text += c))
      res.on('end', () => resolve({ cookie: String(res.headers['set-cookie']?.[0]).split(';')[0], id: JSON.parse(text).teacher?.id }))
    })
    req.on('error', reject)
    req.end(JSON.stringify({ invite, username, password: 'password-for-tests' }))
  })
  expect(r.id).toMatch(/^t-/)
  return r
}
const s01q = (q: Record<string, unknown> = {}) => ({ sentences: { S01: { question: { prompt: 'Who else is thinking about it?', options: ['Some parents', 'Some pupils', 'Nobody else'], answer: 0, ...q } } } })
const s03ladder = (l: Record<string, unknown> = {}) => ({
  sentences: {
    S03: {
      ladder: {
        subject: 'a blanket ban',
        predicate: 'may prove',
        l2: 'Yet a blanket ban may prove counterproductive, pending clearer evidence.',
        plain: 'Until we know more, banning phones for everyone may backfire.',
        glosses: [
          { term: 'pending', zh: '在……之前' },
          { term: 'counterproductive', zh: '适得其反的' },
        ],
        ...l,
      },
    },
  },
})

beforeAll(async () => {
  app = await new Promise((resolve) => {
    const server = createApp({ dataDir, uploadInvites: ['invite-edits-0001', 'invite-edits-0002'], log: () => {} }).listen(0, '127.0.0.1', () => resolve({ server, port: (server.address() as AddressInfo).port }))
  })
  const owner = await register('invite-edits-0001', 'edits.owner')
  OWNER = owner.cookie
  OTHER = (await register('invite-edits-0002', 'edits.other')).cookie
  fs.writeFileSync(path.join(dataDir, 'handouts', `${ID}.meta.json`), JSON.stringify({ id: ID, owner: owner.id }))
})
afterAll(() => {
  app.server.close()
})
beforeEach(() => fs.writeFileSync(file, JSON.stringify(original)))

describe('老师改题目和梯子', () => {
  it('没登录 401；别的老师 403；不是上传的讲义、讲义不存在 404；都不写讲义', async () => {
    const before = fs.readFileSync(file, 'utf8')
    expect(await call(`/api/handouts/${ID}/edits`, s01q(), 'POST', '')).toMatchObject({ status: 401, body: { error: '请先登录' } })
    const wrong = await call(`/api/handouts/${ID}/edits`, s01q(), 'POST', OTHER)
    expect(wrong).toMatchObject({ status: 403, body: { error: '只有上传这篇文章的老师能改题目和梯子' } })
    for (const id of ['mini-phones', 'social-media', 'up-missing', '..%2Fsecret']) expect((await edits(s01q(), id)).status, id).toBe(404)
    expect(fs.readFileSync(file, 'utf8')).toBe(before)
  })

  it('改成功：去掉首尾空白、整块换掉、题目 id 不变、来源记成老师改过，别的不动；整份讲义还能过校验器；学生重新打开就拿到新的', async () => {
    const r = await edits({
      sentences: {
        S01: { question: { prompt: '  Who else is thinking about it? ', options: [' Some parents', 'Some pupils ', 'Nobody else'], answer: 0 } },
        ...s03ladder({ subject: ' a blanket ban ' }).sentences,
      },
      paragraphs: { 2: { gist: { prompt: 'What does the writer suggest?', options: ['Ban all phones', 'Teach wise use'], answer: 1 } } },
    })
    expect(r.status).toBe(200)
    expect(r.body.ok).toBe(true)
    const h = stored()
    expect(r.body.handout).toEqual(h)
    const [S01, S02, S03, S04, S05] = h.sentences
    expect(S01.question).toEqual({ id: 'S01-q', prompt: 'Who else is thinking about it?', options: ['Some parents', 'Some pupils', 'Nobody else'], answer: 0, provenance: TEACHER })
    expect(S03.ladder).toEqual({
      l1: { subject: 'a blanket ban', predicate: 'may prove' },
      l2: 'Yet a blanket ban may prove counterproductive, pending clearer evidence.',
      l3: { plain: 'Until we know more, banning phones for everyone may backfire.', glosses: [{ term: 'pending', zh: '在……之前' }, { term: 'counterproductive', zh: '适得其反的' }] },
      provenance: TEACHER,
    })
    expect(h.paragraphs[1].gist).toEqual({ id: 'P2-gist', prompt: 'What does the writer suggest?', options: ['Ban all phones', 'Teach wise use'], answer: 1, provenance: TEACHER })
    // 没改的块原样
    expect(S01.ladder).toEqual(original.sentences[0].ladder)
    expect(S01.teacherNote).toBe(original.sentences[0].teacherNote)
    expect(S03.question).toEqual(original.sentences[2].question)
    for (const [i, x] of [[1, S02], [3, S04], [4, S05]] as const) expect(x).toEqual(JSON.parse(JSON.stringify(original.sentences[i])))
    expect(h.paragraphs[0]).toEqual(JSON.parse(JSON.stringify(original.paragraphs[0])))
    expect(h.words).toEqual(JSON.parse(JSON.stringify(original.words)))
    expect(validateHandout(h).filter((i) => i.level === 'error')).toEqual([])
    expect(Handout.parse(h).sentences[0].question?.provenance).toEqual(TEACHER)
    const g = await call(`/api/handouts/${ID}`, undefined, 'GET') // 还没发布：上传的老师登录后预览
    expect(g.headers['cache-control']).toBe('no-cache')
    expect(g.body.sentences[0].question.prompt).toBe('Who else is thinking about it?')
  })

  it('梯子第 1 步必须是原句原话；第 2、3 步不能空；难词只能改中文意思', async () => {
    const r = await edits(s03ladder({ subject: 'the blanket ban', predicate: 'may  prove', plain: ' ', glosses: [{ term: 'pending', zh: '' }, { term: 'counterproductive', zh: '适得其反的' }] }))
    expect(r.status).toBe(400)
    expect(r.body.error).toBe('有 4 处要改，见标红的地方')
    expect(r.body.fields).toEqual({
      'S03.ladder.subject': '梯子第 1 步的「谁」必须是原句里的原话',
      'S03.ladder.predicate': '梯子第 1 步的「做了什么」必须是原句里的原话',
      'S03.ladder.plain': '梯子第 3 步不能是空的',
      'S03.ladder.glosses.0': '「pending」的中文意思不能是空的',
    })
    const term = await edits(s03ladder({ glosses: [{ term: 'pend', zh: '等' }, { term: 'counterproductive', zh: '适得其反的' }] }))
    expect(term.body.fields).toEqual({ 'S03.ladder.glosses': '难词的格式不对，请刷新页面后再改' })
    expect((await edits(s03ladder({ glosses: [] }))).status).toBe(400)
    expect(stored()).toEqual(JSON.parse(JSON.stringify(original)))
  })

  it('讲义里难词写法带首尾空格（前端发来的已去空白）也能存，存的还是原来的写法', async () => {
    const spaced = JSON.parse(JSON.stringify(original))
    const s03 = spaced.sentences.find((x: { id: string }) => x.id === 'S03')
    s03.ladder.l3.glosses[0].term = 'pending '
    fs.writeFileSync(file, JSON.stringify(spaced))
    const r = await edits(s03ladder())
    expect(r.status).toBe(200)
    expect(stored().sentences.find((x: { id: string }) => x.id === 'S03').ladder.l3.glosses[0]).toEqual({ term: 'pending ', zh: '在……之前' })
  })

  it('句子 id 和对象自带的属性同名（constructor、__proto__）也按字段报错，不悄悄放过', async () => {
    const r = await call(`/api/handouts/${ID}/edits`, JSON.parse(`{"sentences":{"constructor":{"question":{}},"__proto__":{"question":{}},"S01":${JSON.stringify(s01q().sentences.S01)}}}`))
    expect(r.status).toBe(400)
    expect(r.body.fields).toEqual({ constructor: '没有这一句，请刷新页面后再改', ['__proto__']: '没有这一句，请刷新页面后再改' })
    expect(stored()).toEqual(JSON.parse(JSON.stringify(original)))
  })

  it('选项 2 到 4 个、不能空、不能重复，答案序号要在范围内', async () => {
    const f = async (q: Record<string, unknown>) => (await edits(s01q(q))).body.fields
    expect(await f({ options: ['Only one'] })).toEqual({ 'S01.question.options': '选项要有 2 到 4 个' })
    expect(await f({ options: ['a', 'b'], answer: 2 })).toEqual({ 'S01.question.answer': '请选出正确答案' })
    expect(await f({ options: ['a', 'b', 'c', 'd', 'e'] })).toEqual({ 'S01.question.options': '选项要有 2 到 4 个' })
    expect(await f({ options: ['Some parents', ' Some parents ', ''] })).toEqual({
      'S01.question.options.1': '第 2 个选项和第 1 个一样',
      'S01.question.options.2': '第 3 个选项不能是空的',
    })
    for (const answer of [3, -1, 1.5, '0', null]) expect(await f({ answer }), String(answer)).toEqual({ 'S01.question.answer': '请选出正确答案' })
    expect(await f({ prompt: '' })).toEqual({ 'S01.question.prompt': '题目不能是空的' })
    expect(await f({ options: 'Some parents' })).toEqual({ 'S01.question.options': '选项的格式不对，请刷新页面后再改' })
    expect(await f({ options: ['x'.repeat(201), 'b'] })).toEqual({ 'S01.question.options.0': '每个选项不超过 200 个字符' })
    // 4 个选项可以
    expect((await edits(s01q({ options: ['a', 'b', 'c', 'd'], answer: 3 }))).status).toBe(200)
  })

  it('学生看得到的题目、选项、梯子里不能有语法术语（每个术语都拦）；老师讲解不受此限', async () => {
    for (const t of GRAMMAR_TERMS) {
      const r = await edits(s01q({ options: ['Some parents', `${t}是什么`, 'Nobody else'] }))
      expect(r.body.fields, t).toEqual({ 'S01.question.options.1': `选项里不能有语法术语：${t}` })
    }
    const r = await edits({
      ...s03ladder({ l2: '先找主语', glosses: [{ term: 'pending', zh: '状语' }, { term: 'counterproductive', zh: '适得其反的' }] }),
      paragraphs: { 1: { gist: { prompt: '这一段的同位语从句说了什么？', options: ['a', 'b'], answer: 0 } } },
    })
    expect(r.body.fields).toEqual({
      'S03.ladder.l2': '梯子第 2 步里不能有语法术语：主语',
      'S03.ladder.glosses.0': '「pending」的中文意思里不能有语法术语：状语',
      'P1.gist.prompt': '题目里不能有语法术语：同位语',
    })
    expect(stored()).toEqual(JSON.parse(JSON.stringify(original)))
    const note = await call(`/api/handouts/${ID}/notes`, { notes: { S02: '先找主语 The proposal。' } })
    expect(note.status).toBe(200)
  })

  it('一处不合格就一处都不写；不存在的句子、段落、没有题或梯子的句子也按字段报错；什么都没改 400', async () => {
    const r = await edits({ sentences: { ...s01q().sentences, S03: { question: { prompt: 'Q', options: ['a', 'a'], answer: 0 } } } })
    expect(r.body.fields).toEqual({ 'S03.question.options.1': '第 2 个选项和第 1 个一样' })
    expect(stored()).toEqual(JSON.parse(JSON.stringify(original)))
    const missing = await edits({ sentences: { S99: { question: {} }, S05: { question: { prompt: 'Q', options: ['a', 'b'], answer: 0 }, ladder: {} } }, paragraphs: { 9: { gist: {} } } })
    expect(missing.body.fields).toEqual({
      S99: '没有这一句，请刷新页面后再改',
      'S05.question': '这一句没有题',
      'S05.ladder': '这一句没有梯子',
      P9: '没有这一段，请刷新页面后再改',
    })
    expect(await edits({})).toMatchObject({ status: 400, body: { error: '没有要保存的改动' } })
    expect(await edits({ sentences: [] })).toMatchObject({ status: 400, body: { error: '改动的格式不对，请刷新页面后再改' } })
  })

  it('讲解和题目、梯子同时保存：排同一条队，谁都不丢', async () => {
    const jobs: Promise<{ status: number }>[] = []
    for (let i = 0; i < 6; i++) {
      jobs.push(call(`/api/handouts/${ID}/notes`, { notes: { [`S0${(i % 5) + 1}`]: `讲解 ${i}` } }))
      jobs.push(edits(s01q({ prompt: `Who else? ${i}` })))
      jobs.push(edits({ paragraphs: { 2: { gist: { prompt: `Gist ${i}`, options: ['a', 'b', 'c'], answer: i % 3 } } } }))
    }
    expect((await Promise.all(jobs)).map((r) => r.status)).toEqual(jobs.map(() => 200))
    // 请求是并发发出的，到达顺序不定：S01 的讲解是第 0 或第 5 条，其他句子各只写过一次，必须都在；题目和段意题是某一次的改动
    const h = stored()
    expect(h.sentences.map((x: { teacherNote?: string }) => x.teacherNote).slice(1)).toEqual(['讲解 1', '讲解 2', '讲解 3', '讲解 4'])
    expect(['讲解 0', '讲解 5']).toContain(h.sentences[0].teacherNote)
    expect(h.sentences[0].question).toMatchObject({ id: 'S01-q', prompt: expect.stringMatching(/^Who else\? \d$/), provenance: TEACHER })
    expect(h.paragraphs[1].gist).toMatchObject({ id: 'P2-gist', prompt: expect.stringMatching(/^Gist \d$/), provenance: TEACHER })
    expect(fs.readdirSync(path.dirname(file)).filter((f) => f.endsWith('.tmp'))).toEqual([])
  })
})

// 梯子新第 2、3 步（拆开 + 译文）：上传的文章 article-v4 起有 breakdown，老师也能改
describe('老师改拆开和译文', () => {
  const AI = { by: 'llm', model: 'fake-model', promptVersion: 'article-v4' }
  const withBreakdown = () => {
    const h = JSON.parse(JSON.stringify(original))
    h.sentences[2].breakdown = { parts: [{ label: '谁', text: 'a blanket ban' }, { label: '做了什么', text: 'may prove counterproductive', hint: '可能适得其反' }], zh: '但在有更清楚的证据之前，全面禁令可能适得其反。', provenance: AI }
    fs.writeFileSync(file, JSON.stringify(h))
    return h
  }
  const s03bd = (b: Record<string, unknown> = {}) => ({
    sentences: {
      S03: {
        breakdown: {
          parts: [
            { label: '谁', text: ' a blanket ban ', hint: '' },
            { label: '做了什么', text: 'may prove counterproductive', hint: ' 可能会适得其反 ' },
            { label: '什么时候·在哪里', text: 'pending clearer evidence', hint: '在有更清楚的证据之前' },
          ],
          zh: ' 不过，在有更清楚的证据之前，一刀切的禁令可能适得其反。 ',
          ...b,
        },
      },
    },
  })

  it('后端的 7 个标签和 shared/schema.ts 一致', () => {
    expect(SERVER_LABELS).toEqual([...BREAKDOWN_LABELS])
  })

  it('改成功：去掉首尾空白、空提示不存、可以增删块、来源记成老师改过，梯子不动；整份讲义还能过校验器', async () => {
    const before = withBreakdown()
    const r = await edits(s03bd())
    expect(r.status).toBe(200)
    const S03 = stored().sentences[2]
    expect(S03.breakdown).toEqual({
      parts: [
        { label: '谁', text: 'a blanket ban' },
        { label: '做了什么', text: 'may prove counterproductive', hint: '可能会适得其反' },
        { label: '什么时候·在哪里', text: 'pending clearer evidence', hint: '在有更清楚的证据之前' },
      ],
      zh: '不过，在有更清楚的证据之前，一刀切的禁令可能适得其反。',
      provenance: TEACHER,
    })
    expect(S03.ladder).toEqual(before.sentences[2].ladder)
    expect(validateHandout(stored()).filter((i) => i.level === 'error')).toEqual([])
    // 删到只剩 1 块也可以
    expect((await edits(s03bd({ parts: [{ label: '谁', text: 'a blanket ban' }] }))).status).toBe(200)
    expect(stored().sentences[2].breakdown.parts).toEqual([{ label: '谁', text: 'a blanket ban' }])
  })

  it('每一块必须是原句原话、标签只能用那 7 个、提示和译文没有术语、译文不空、1 到 8 块；一处不合格就都不写', async () => {
    const before = withBreakdown()
    const r = await edits(
      s03bd({
        parts: [
          { label: '主干', text: 'the blanket ban', hint: '这是主语' },
          { label: '做了什么', text: ' ', hint: 'x'.repeat(81) },
          { label: '谁', text: 'may prove', hint: '这里是状语' },
        ],
        zh: '',
      }),
    )
    expect(r.status).toBe(400)
    expect(r.body.fields).toEqual({
      'S03.breakdown.zh': '第 3 步的译文不能是空的',
      'S03.breakdown.parts.0.label': '第 1 块请从列表里选一个标签',
      'S03.breakdown.parts.0.text': '第 1 块必须是原句里的原话',
      'S03.breakdown.parts.0.hint': '第 1 块的提示里不能有语法术语：主语',
      'S03.breakdown.parts.1.text': '第 2 块不能是空的',
      'S03.breakdown.parts.1.hint': '第 2 块的提示不超过 80 个字',
      'S03.breakdown.parts.2.hint': '第 3 块的提示里不能有语法术语：状语',
    })
    const f = async (b: Record<string, unknown>) => (await edits(s03bd(b))).body.fields
    expect(await f({ zh: '先找谓语' })).toEqual({ 'S03.breakdown.zh': '第 3 步的译文里不能有语法术语：谓语' })
    expect(await f({ zh: '长'.repeat(401) })).toEqual({ 'S03.breakdown.zh': '第 3 步的译文不超过 400 个字' })
    expect(await f({ parts: [] })).toEqual({ 'S03.breakdown.parts': '第 2 步要拆成 1 到 8 块' })
    expect(await f({ parts: Array(9).fill({ label: '谁', text: 'ban' }) })).toEqual({ 'S03.breakdown.parts': '第 2 步要拆成 1 到 8 块' })
    for (const parts of ['a blanket ban', [{ label: '谁' }], [{ label: '谁', text: 'ban', hint: 3 }], [null]]) {
      expect(await f({ parts }), JSON.stringify(parts)).toEqual({ 'S03.breakdown.parts': '拆开的格式不对，请刷新页面后再改' })
    }
    expect((await edits({ sentences: { S03: { breakdown: 'x' } } })).body.fields).toEqual({ 'S03.breakdown': '拆开的格式不对，请刷新页面后再改' })
    expect(stored()).toEqual(before)
  })

  it('没有拆开的句子（旧的上传）不能改拆开', async () => {
    const r = await edits(s03bd())
    expect(r.body.fields).toEqual({ 'S03.breakdown': '这一句没有拆开和译文' })
    expect(stored()).toEqual(JSON.parse(JSON.stringify(original)))
  })
})
