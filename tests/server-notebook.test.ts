// 学生账号的单词本和表达本：GET /api/student/notebook，和 POST /api/events 里只给账号的四类事件（收、移出表达，复习、移出单词）。
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
import { MIN_AGE, NOTEBOOK_ID, createApp } from '../server/index.mjs'
import type { ServerConfig } from '../server/index.mjs'
import { miniHandout } from './fixtures/mini-handout'

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zhishi-notebook-'))
const handoutsDir = path.join(dataDir, 'handouts')
const PASSWORD = 'correct-horse-9'
const TEACHER_INVITE = 'invite-teacher-nb01'
const CODES = Array.from({ length: 30 }, (_, i) => `TESTNOTEBOOK${String(i).padStart(2, '0')}`)
let nextCode = 0
const BIRTH = `${new Date().getUTCFullYear() - MIN_AGE - 3}-01`
const file = (name: string) => path.join(dataDir, name)
const lines = (name: string) => (fs.existsSync(file(name)) ? fs.readFileSync(file(name), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [])

// 讲义：up-nba、up-nbb 上架；up-nbpub 发布到了班级（谁都能读）；up-nbdraft 老师还没发布、也没上架（学生读不到）；
// up-nbgone 上架了但讲义文件没了；up-nbbad 文件不是 JSON；up-nbodd 是 JSON 但不是讲义的格式
const handout = (id: string, title: string) => Handout.parse({ ...miniHandout, id, title })
function writeHandout(id: string, title: string, published = false) {
  fs.writeFileSync(path.join(handoutsDir, `${id}.json`), JSON.stringify(handout(id, title)))
  fs.writeFileSync(path.join(handoutsDir, `${id}.meta.json`), JSON.stringify({ id, title, owner: 't-x', published }))
}
const writeShelf = (ids: string[]) => fs.writeFileSync(file('shelf.json'), JSON.stringify({ handouts: ids.map((id) => ({ id, addedAt: '' })) }))
const SHELF = ['up-nba', 'up-nbb', 'up-nbgone', 'up-nbbad', 'up-nbodd']

type App = { server: Server; port: number }
type Res = { status: number; body: any; headers: http.IncomingHttpHeaders }
const open: App[] = []
let builds = 0 // 真正推算了几次（没命中缓存）
const counted = { parseHandout: notebook.parseHandout, buildNotebook: (...a: Parameters<typeof notebook.buildNotebook>) => (builds++, notebook.buildNotebook(...a)) }
function listen(config: Partial<ServerConfig> = {}) {
  return new Promise<App>((resolve) => {
    const server = createApp({ dataDir, uploadInvites: [TEACHER_INVITE], authPerMinute: 1000, notebook: counted, log: () => {}, ...config }).listen(0, '127.0.0.1', () => {
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
      res.on('end', () => resolve({ status: res.statusCode!, body: JSON.parse(text), headers: res.headers }))
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
