// 学生账号的单词本和表达本：GET /api/student/notebook，和 POST /api/events 里只给账号的四类事件（收、移出表达，复习、移出单词）；
// 学习记录 GET /api/student/records 和完整版的「下载我的数据」GET /api/student/export（阶段 5，和单词本同一份推算）。
// 推算用 src/lib/notebook.ts（注入，不依赖 dist-server/）。照 server-student-auth.test.ts 的写法，请求用 node:http 发。
// 邀请码文件平时由 scripts/student.mjs 写，这里直接写（码只存 sha256，都是测试用的假码）
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Handout } from '../shared/schema'
import * as notebook from '../src/lib/notebook'
import { EXPORT_AI_FIELDS, EXPORT_NOTE, MIN_AGE, NOTEBOOK_ID, createApp } from '../server/index.mjs'
import type { ServerConfig } from '../server/index.mjs'
import { miniHandout } from './fixtures/mini-handout'

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zhishi-notebook-'))
const handoutsDir = path.join(dataDir, 'handouts')
const PASSWORD = 'correct-horse-9'
const TEACHER_INVITE = 'invite-teacher-nb01'
const TEACHER_INVITE2 = 'invite-teacher-nb02'
const CODES = Array.from({ length: 30 }, (_, i) => `TESTNOTEBOOK${String(i).padStart(2, '0')}`)
let nextCode = 0
const BIRTH = `${new Date().getUTCFullYear() - MIN_AGE - 3}-01`
const file = (name: string) => path.join(dataDir, name)
const lines = (name: string) => (fs.existsSync(file(name)) ? fs.readFileSync(file(name), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [])

// 讲义：up-nba、up-nbb 上架；up-nbpub 发布到了班级（谁都能读）；up-nbdraft 老师还没发布、也没上架（学生读不到）；
// up-nbgone 上架了但讲义文件没了；up-nbbad 文件不是 JSON；up-nbodd 是 JSON 但不是讲义的格式；
// up-nbai 上架了，段意题是 AI 起草的（讲义词表的词义、表达的中文跟着算 AI 生成的）
const llm = { by: 'llm' as const }
const handout = (id: string, title: string) =>
  Handout.parse({ ...miniHandout, id, title, ...(id === 'up-nbai' ? { paragraphs: miniHandout.paragraphs.map((p) => ({ ...p, gist: { ...p.gist, provenance: llm } })) } : {}) })
function writeHandout(id: string, title: string, published = false) {
  fs.writeFileSync(path.join(handoutsDir, `${id}.json`), JSON.stringify(handout(id, title)))
  fs.writeFileSync(path.join(handoutsDir, `${id}.meta.json`), JSON.stringify({ id, title, owner: 't-x', published }))
}
const writeShelf = (ids: string[]) => fs.writeFileSync(file('shelf.json'), JSON.stringify({ handouts: ids.map((id) => ({ id, addedAt: '' })) }))
const SHELF = ['up-nba', 'up-nbb', 'up-nbgone', 'up-nbbad', 'up-nbodd', 'up-nbai']

type App = { server: Server; port: number }
type Res = { status: number; body: any; headers: http.IncomingHttpHeaders; text: string }
const open: App[] = []
let builds = 0 // 真正推算了几次（没命中缓存）
const counted = { parseHandout: notebook.parseHandout, buildRecords: notebook.buildRecords, buildNotebook: (...a: Parameters<typeof notebook.buildNotebook>) => (builds++, notebook.buildNotebook(...a)) }
function listen(config: Partial<ServerConfig> = {}) {
  return new Promise<App>((resolve) => {
    const server = createApp({ dataDir, uploadInvites: [TEACHER_INVITE, TEACHER_INVITE2], authPerMinute: 1000, notebook: counted, log: () => {}, ...config }).listen(0, '127.0.0.1', () => {
      const a = { server, port: (server.address() as AddressInfo).port }
      open.push(a)
      resolve(a)
    })
  })
}
function call(a: App, method: string, url: string, body?: unknown, cookie?: string) {
  return new Promise<Res>((resolve, reject) => {
    const h: Record<string, string> = { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }
    const req = http.request({ host: '127.0.0.1', port: a.port, path: url, method, headers: h }, (res) => {
      let text = ''
      res.setEncoding('utf8')
      res.on('data', (c) => (text += c))
      res.on('end', () => resolve({ status: res.statusCode!, body: JSON.parse(text), headers: res.headers, text }))
    })
    req.on('error', reject)
    req.end(body === undefined ? undefined : JSON.stringify(body))
  })
}
const cookieOf = (r: Res) => r.headers['set-cookie']![0].split(';')[0]

let app: App
type Who = { cookie: string; sid: string }
async function register(username: string): Promise<Who> {
  const r = await call(app, 'POST', '/api/student/register', { invite: CODES[nextCode++], username, password: PASSWORD, birth: BIRTH, agree: true })
  expect(r.status, JSON.stringify(r.body)).toBe(200)
  return { cookie: cookieOf(r), sid: r.body.student.sid }
}
const ev = (sid: string, handoutId: string, ts: number, o: Record<string, unknown> = {}) => ({ sid, handoutId, type: 'tap_word', ts, ...o })
const send = (who: Who, list: unknown[]) => call(app, 'POST', '/api/events', list, who.cookie)
const get = (who?: Who) => call(app, 'GET', '/api/student/notebook', undefined, who?.cookie)
const lemmas = (r: Res) => r.body.words.map((w: { lemma: string }) => w.lemma).sort()

beforeAll(async () => {
  fs.mkdirSync(handoutsDir, { recursive: true })
  fs.writeFileSync(file('student-invites.json'), JSON.stringify({ invites: CODES.map((c) => ({ hash: createHash('sha256').update(c).digest('hex'), batch: 't', createdAt: '' })) }))
  writeHandout('up-nba', 'Phones A')
  writeHandout('up-nbb', 'Phones B')
  writeHandout('up-nbpub', 'Phones Pub', true)
  writeHandout('up-nbdraft', 'Phones Draft')
  writeHandout('up-nbai', 'Phones AI')
  fs.writeFileSync(path.join(handoutsDir, 'up-nbbad.json'), '{not json')
  fs.writeFileSync(path.join(handoutsDir, 'up-nbodd.json'), JSON.stringify({ id: 'up-nbodd', title: 'Odd' }))
  writeShelf(SHELF)
  app = await listen()
})
afterAll(() => {
  for (const a of open) a.server.close()
})

describe('只给学生账号的四类事件', () => {
  it('value、lemma、correct 能落盘到 students/<sid>.jsonl；复习、移出单词只收 handoutId 是 notebook 的，别的类型不收 notebook；内置讲义的不收', async () => {
    const s = await register('nb.events')
    const keep = [
      ev(s.sid, 'up-nba', 1, { type: 'collect_expression', value: 'E1' }),
      ev(s.sid, 'up-nba', 2, { type: 'drop_expression', value: 'E1' }),
      ev(s.sid, NOTEBOOK_ID, 3, { type: 'review_word', lemma: 'pending', correct: false }),
      ev(s.sid, NOTEBOOK_ID, 4, { type: 'review_word', lemma: 'pending', correct: true }),
      ev(s.sid, NOTEBOOK_ID, 5, { type: 'drop_word', lemma: 'pending' }),
    ]
    const drop = [
      ev(s.sid, 'up-nba', 6, { type: 'review_word', lemma: 'pending', correct: true }),
      ev(s.sid, 'up-nba', 7, { type: 'drop_word', lemma: 'pending' }),
      ev(s.sid, NOTEBOOK_ID, 8, { lemma: 'pending' }),
      ev(s.sid, NOTEBOOK_ID, 9, { type: 'collect_expression', value: 'E1' }),
      ev(s.sid, 'mini-phones', 10, { type: 'collect_expression', value: 'E1' }),
    ]
    expect((await send(s, [...keep, ...drop])).body).toEqual({ ok: true, accepted: keep.length })
    expect(lines(`students/${s.sid}.jsonl`)).toEqual(keep)
    expect(fs.existsSync(file(`events-${NOTEBOOK_ID}.jsonl`))).toBe(false)
    expect(fs.existsSync(file('events-up-nba.jsonl'))).toBe(false)
  })

  it('handoutId 是 notebook 的事件没登录也 401、整批不写（前端留着，登录后再发）', async () => {
    const s = await register('nb.events.login')
    expect(await call(app, 'POST', '/api/events', [ev(s.sid, NOTEBOOK_ID, 1, { type: 'drop_word', lemma: 'pending' })])).toMatchObject({ status: 401, body: { ok: false, error: '请先登录' } })
    expect(fs.existsSync(file(`students/${s.sid}.jsonl`))).toBe(false)
  })
})

describe('GET /api/student/notebook', () => {
  it('没登录、老师的 cookie 都 401；不缓存', async () => {
    expect(await get()).toMatchObject({ status: 401, body: { error: '请先登录' } })
    const t = await call(app, 'POST', '/api/auth/register', { invite: TEACHER_INVITE, username: 'nb.teacher', password: 'teacher-pass-1' })
    expect(t.status).toBe(201)
    expect(await call(app, 'GET', '/api/student/notebook', undefined, cookieOf(t))).toMatchObject({ status: 401, body: { error: '请先登录' } })
    const s = await register('nb.empty')
    const r = await get(s)
    expect(r).toMatchObject({ status: 200, body: { words: [], expressions: [] } })
    expect(r.headers['cache-control']).toBe('no-store')
  })

  it('两篇里的词合并、写两处出处；表达本按收、移出算；只看得到自己的（请求参数里的 sid 不算）', async () => {
    const s = await register('nb.mine')
    const o = await register('nb.other')
    await send(s, [
      ev(s.sid, 'up-nba', 10, { lemma: 'pending' }),
      ev(s.sid, 'up-nbb', 20, { type: 'word_card', lemma: 'pending', value: 'unknown' }),
      ev(s.sid, 'up-nba', 30, { type: 'collect_expression', value: 'E1' }),
      ev(s.sid, 'up-nbb', 31, { type: 'collect_expression', value: 'E3' }),
      ev(s.sid, 'up-nbb', 32, { type: 'drop_expression', value: 'E3' }),
      ev(s.sid, NOTEBOOK_ID, 40, { type: 'review_word', lemma: 'pending', correct: false }),
    ])
    await send(o, [ev(o.sid, 'up-nba', 1, { lemma: 'fret' })])
    const r = await get(s)
    expect(r.body.words).toEqual([
      {
        lemma: 'pending',
        zh: '在……之前；等待……期间',
        ai: false,
        sources: [{ handoutId: 'up-nba', title: 'Phones A' }, { handoutId: 'up-nbb', title: 'Phones B' }],
        example: { handoutId: 'up-nbb', sentenceId: 'S03', text: 'Yet, pending clearer evidence, a blanket ban may prove counterproductive.' },
        addedTs: 10,
        lastReview: { ts: 40, correct: false },
      },
    ])
    expect(r.body.expressions.map((x: { id: string; handoutId: string }) => [x.id, x.handoutId])).toEqual([['E1', 'up-nba']])
    expect(lemmas(await get(o))).toEqual(['fret'])
    expect(lemmas(await call(app, 'GET', `/api/student/notebook?sid=${o.sid}`, undefined, s.cookie))).toEqual(['pending'])
  })

  it('移出单词本后不在；之后在某一篇里又点了就回来', async () => {
    const s = await register('nb.drop')
    await send(s, [ev(s.sid, 'up-nba', 1, { lemma: 'pending' }), ev(s.sid, 'up-nba', 2, { lemma: 'fret' })])
    expect(lemmas(await get(s))).toEqual(['fret', 'pending'])
    await send(s, [ev(s.sid, NOTEBOOK_ID, 3, { type: 'drop_word', lemma: 'pending' })])
    expect(lemmas(await get(s))).toEqual(['fret'])
    await send(s, [ev(s.sid, 'up-nbb', 4, { lemma: 'pending' })])
    const r = await get(s)
    expect(lemmas(r)).toEqual(['fret', 'pending'])
    expect(r.body.words.find((w: { lemma: string }) => w.lemma === 'pending')).toMatchObject({ sources: [{ handoutId: 'up-nbb', title: 'Phones B' }], addedTs: 4 })
  })

  it('讲义文件没了、不是 JSON、不是讲义的格式：跳过，不报 500；只用能读的讲义（上架的、发布了的），没发布也没上架的讲义里的词看不到', async () => {
    const s = await register('nb.skip')
    const ids = ['up-nba', 'up-nbgone', 'up-nbbad', 'up-nbodd', 'up-nbpub', 'up-nbdraft', 'up-nbnone']
    await send(s, ids.map((id, i) => ev(s.sid, id, i + 1, { type: 'collect_expression', value: 'E1' })))
    expect(lines(`students/${s.sid}.jsonl`)).toHaveLength(ids.length)
    const r = await get(s)
    expect(r.status).toBe(200)
    expect(r.body.expressions.map((x: { handoutId: string }) => x.handoutId).sort()).toEqual(['up-nba', 'up-nbpub'])
    expect(JSON.stringify(r.body)).not.toContain('Phones Draft')
  })

  it('缓存：没变就不重算；写进新事件、改写讲义文件、上架变了都重算', async () => {
    const s = await register('nb.cache')
    await send(s, [ev(s.sid, 'up-nbb', 1, { lemma: 'pending' })])
    const n0 = builds
    expect(lemmas(await get(s))).toEqual(['pending'])
    expect(lemmas(await get(s))).toEqual(['pending'])
    expect(builds).toBe(n0 + 1)

    await send(s, [ev(s.sid, 'up-nbb', 2, { lemma: 'fret' })])
    expect(lemmas(await get(s))).toEqual(['fret', 'pending'])
    expect(builds).toBe(n0 + 2)

    // 改写讲义（scripts/lexicon.mjs、老师改题都会改写）：先写临时文件再改名，修改时间往后调，免得和上一次落在同一刻
    const f = path.join(handoutsDir, 'up-nbb.json')
    const h = JSON.parse(fs.readFileSync(f, 'utf8'))
    h.words = h.words.map((w: { lemma: string; zh: string }) => (w.lemma === 'pending' ? { ...w, zh: '待定的' } : w))
    fs.writeFileSync(`${f}.tmp`, JSON.stringify(h))
    fs.renameSync(`${f}.tmp`, f)
    const later = new Date(Date.now() + 60000)
    fs.utimesSync(f, later, later)
    expect((await get(s)).body.words.find((w: { lemma: string }) => w.lemma === 'pending').zh).toBe('待定的')
    expect(builds).toBe(n0 + 3)
    expect(lemmas(await get(s))).toEqual(['fret', 'pending'])
    expect(builds).toBe(n0 + 3)

    // 下架了：这一篇的词不再列；再上架又回来（作答没删）
    writeShelf(SHELF.filter((id) => id !== 'up-nbb'))
    expect(lemmas(await get(s))).toEqual([])
    writeShelf(SHELF)
    expect(lemmas(await get(s))).toEqual(['fret', 'pending'])
    expect(builds).toBe(n0 + 5)
  })
})

const records = (who?: Who, url = '/api/student/records') => call(app, 'GET', url, undefined, who?.cookie)
const answer = (sid: string, handoutId: string, ts: number, sentenceId: string, correct = true) => ev(sid, handoutId, ts, { type: 'answer_question', sentenceId, correct })

describe('GET /api/student/records', () => {
  it('没登录、老师的 cookie 都 401；不缓存；没动过手是空的', async () => {
    expect(await records()).toMatchObject({ status: 401, body: { error: '请先登录' } })
    const t = await call(app, 'POST', '/api/auth/register', { invite: TEACHER_INVITE2, username: 'rec.teacher', password: 'teacher-pass-1' })
    expect(t.status).toBe(201)
    expect(await call(app, 'GET', '/api/student/records', undefined, cookieOf(t))).toMatchObject({ status: 401, body: { error: '请先登录' } })
    const s = await register('rec.empty')
    const r = await records(s)
    expect(r).toMatchObject({ status: 200, body: { records: [] } })
    expect(r.headers['cache-control']).toBe('no-store')
  })

  it('最近读的在前；只打开、没动手的不列；状态和第一句没答的、自己选的难度；只算能读的讲义；只看得到自己的（请求参数里的 sid 不算）', async () => {
    const s = await register('rec.mine')
    const o = await register('rec.other')
    await send(s, [
      answer(s.sid, 'up-nba', 10, 'S01'),
      ev(s.sid, 'up-nba', 11, { type: 'feedback', value: '刚好' }),
      // B 的四句都答过了，有一句答错：算「都答过了」
      ...['S01', 'S02', 'S03', 'S04'].map((id, i) => answer(s.sid, 'up-nbb', 20 + i, id, id !== 'S03')),
      ev(s.sid, 'up-nbb', 30, { type: 'page_view', value: '小结' }), // 看小结不算读
      ev(s.sid, 'up-nbpub', 40, { type: 'page_view', value: '粗读' }), // 只打开了
      ev(s.sid, 'up-nbdraft', 50, { lemma: 'pending' }), // 读不到的讲义
    ])
    await send(o, [ev(o.sid, 'up-nbpub', 60, { lemma: 'fret' })])
    expect((await records(s)).body).toEqual({
      records: [
        { handoutId: 'up-nbb', title: 'Phones B', lastTs: 23, status: 'done' },
        { handoutId: 'up-nba', title: 'Phones A', lastTs: 11, rating: '刚好', status: 'todo', firstPending: 'S02' },
      ],
    })
    expect((await records(o)).body).toEqual({ records: [{ handoutId: 'up-nbpub', title: 'Phones Pub', lastTs: 60, status: 'todo', firstPending: 'S01' }] })
    expect((await records(s, `/api/student/records?sid=${o.sid}`)).body.records.map((x: { handoutId: string }) => x.handoutId)).toEqual(['up-nbb', 'up-nba'])
    // 写进新事件后跟着变（和单词本同一份缓存）
    await send(s, [answer(s.sid, 'up-nba', 70, 'S02')])
    expect((await records(s)).body.records[0]).toEqual({ handoutId: 'up-nba', title: 'Phones A', lastTs: 70, rating: '刚好', status: 'todo', firstPending: 'S03' })
  })

  it('每一行只有标题、日期、难度、状态和第一句没答的：没有答对几句、生词几个这类计数', async () => {
    const s = await register('rec.keys')
    await send(s, [answer(s.sid, 'up-nba', 1, 'S01', false), ev(s.sid, 'up-nba', 2, { lemma: 'pending' }), ev(s.sid, 'up-nbb', 3, { type: 'word_card', lemma: 'fret', value: 'unknown' })])
    const r = await records(s)
    expect(r.body.records).toHaveLength(2)
    for (const x of r.body.records) for (const k of Object.keys(x)) expect(['handoutId', 'title', 'lastTs', 'rating', 'status', 'firstPending'], k).toContain(k)
    expect(r.text).not.toMatch(/count|total|answered|correct|words|score|level/i)
  })
})

describe('GET /api/student/export（完整版）', () => {
  it('没登录 401；开头是说明和 aiFields，然后是用户名、注册时间、设置、我的文章、学习记录、单词本、表达本、原始事件；AI 生成的中文标了 ai；只有自己的', async () => {
    expect(await call(app, 'GET', '/api/student/export')).toMatchObject({ status: 401, body: { error: '请先登录' } })
    const s = await register('exp.full')
    const o = await register('exp.other')
    const mine = [
      ev(s.sid, 'up-nba', 10, { lemma: 'pending' }),
      ev(s.sid, 'up-nbai', 20, { lemma: 'fret' }),
      ev(s.sid, 'up-nbai', 21, { type: 'collect_expression', value: 'E1' }),
      ev(s.sid, 'up-nba', 22, { type: 'collect_expression', value: 'E3' }),
      ev(s.sid, NOTEBOOK_ID, 30, { type: 'review_word', lemma: 'pending', correct: true }),
    ]
    await send(s, mine)
    await send(o, [ev(o.sid, 'up-nba', 1, { lemma: 'blanket' })])
    const r = await call(app, 'GET', '/api/student/export', undefined, s.cookie)
    expect(r.status).toBe(200)
    expect(r.headers['content-disposition']).toBe('attachment; filename="zhishi-exp.full.json"')
    expect(r.headers['cache-control']).toBe('no-store')
    expect(Object.keys(r.body)).toEqual(['note', 'aiFields', 'username', 'createdAt', 'settings', 'articles', 'records', 'words', 'expressions', 'events'])
    expect(r.body.note).toBe('其中标了 AI 生成的内容由 AI 生成，可能有错')
    expect(r.body.note).toBe(EXPORT_NOTE)
    expect(r.body.aiFields).toEqual(EXPORT_AI_FIELDS)
    expect(Object.keys(r.body.aiFields)).toEqual(['words[].zh', 'expressions[].zh', 'articles[].title', 'records[].title', 'words[].sources[].title', 'expressions[].title'])
    expect(r.body).toMatchObject({ username: 'exp.full', settings: { ai: true } })
    expect(r.body.records.map((x: { handoutId: string; status: string }) => [x.handoutId, x.status])).toEqual([['up-nba', 'todo'], ['up-nbai', 'todo']]) // A 最后一次是 22 收的表达
    // 和单词本、表达本页面同一份推算；每一条都有 ai，AI 生成的那一篇的中文是 true
    expect({ words: r.body.words, expressions: r.body.expressions }).toEqual((await get(s)).body)
    expect(r.body.words.map((w: { lemma: string; ai: boolean }) => [w.lemma, w.ai]).sort()).toEqual([['fret', true], ['pending', false]])
    expect(r.body.expressions.map((x: { id: string; ai: boolean }) => [x.id, x.ai])).toEqual([['E3', false], ['E1', true]])
    expect(r.body.events).toEqual(mine)
    expect(r.text).not.toContain(o.sid) // 别人点的 blanket 不在 words 里（上面比对过）
  })

  it('搜不到任何哈希、会话、账号 id', async () => {
    const s = await register('exp.secret')
    await send(s, [ev(s.sid, 'up-nba', 1, { lemma: 'pending' })])
    const r = await call(app, 'GET', '/api/student/export', undefined, s.cookie)
    const acc = JSON.parse(fs.readFileSync(file('students.json'), 'utf8')).students.find((x: { username: string }) => x.username === 'exp.secret')
    const token = s.cookie.split('=')[1]
    for (const secret of [acc.passwordHash, acc.inviteHash, acc.recoveryHash, acc.id, token, createHash('sha256').update(token).digest('hex')]) expect(r.text).not.toContain(secret)
    expect(r.text).not.toMatch(/[0-9a-f]{32}|scrypt|passwordHash|inviteHash|recoveryHash/)
  })
})
