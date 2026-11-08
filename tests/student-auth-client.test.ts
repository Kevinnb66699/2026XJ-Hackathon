// 学生账号的前端（src/lib/student-auth.ts、src/lib/events.ts 按 sid 分开的队列、src/lib/store.ts 的 clearSid）：
// 问后端现在是谁、登录、注册、退出、注销、改设置、找回码改密码、上架列表、这一篇的作答、导出用假 fetch 测；登录后去哪（next）只认站内地址。
// 没有 DOM 测试环境，学生登录页、顶栏、首页、学生端的条件和文案直接查源码
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PROFILE_CURRICULA, PROFILE_GOALS, PROFILE_GRADES, type LearningEvent } from '../shared/schema'
import { STUDENT_INACTIVE_MONTHS } from '../server/index.mjs'
import { emptyState, personalize } from '../src/engine'
import { loginHref, safeNext } from '../src/lib/student-auth'
import { GOAL_LABEL, defaultGoal } from '../src/pages/student/Survey'
import { miniHandout } from './fixtures/mini-handout'

const ming = { username: 'reader01', sid: 'u-0123456789abcdef', ai: false, aiAvailable: true, adapt: true }
const reply = (status: number, body: unknown) => ({ ok: status >= 200 && status < 300, status, json: async () => body })
// 内存里的 localStorage（node 里没有），带 length / key，退出时要按前缀找键
const memoryStorage = (init: Record<string, string> = {}) => {
  const m = new Map<string, string>(Object.entries(init))
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
// 每个测试拿一份新的模块：「现在是谁」和事件队列都在模块里
const fresh = async () => {
  vi.resetModules()
  return { auth: await import('../src/lib/student-auth'), events: await import('../src/lib/events') }
}
const read = (f: string) => readFileSync(fileURLToPath(new URL(`../src/${f}`, import.meta.url)), 'utf8')
const code = (f: string) => read(f).replace(/\/\/.*$/gm, '').replace(/\{\/\*[\s\S]*?\*\/\}/g, '') // 去掉注释

describe('getStudent：现在登录的学生，缓存在模块里', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('GET /api/student/me；第二次用缓存，refresh 才重新问；没登录是 null', async () => {
    const fetchMock = vi.fn().mockResolvedValue(reply(200, { student: ming }))
    vi.stubGlobal('fetch', fetchMock)
    const { auth } = await fresh()
    expect(await auth.getStudent()).toEqual(ming)
    expect(fetchMock.mock.calls[0][0]).toBe('/api/student/me')
    expect(fetchMock.mock.calls[0][1]).toBeUndefined() // 同源默认带 cookie
    expect(await auth.getStudent()).toEqual(ming)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    fetchMock.mockResolvedValue(reply(200, { student: null }))
    expect(await auth.getStudent(true)).toBeNull()
  })

  it('ai、aiAvailable 不是 true 都算关着；sid 不是 u- 开头的当没登录；连不上当没登录、不缓存', async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce(reply(200, { student: { ...ming, ai: 'yes', aiAvailable: undefined } }))
    vi.stubGlobal('fetch', fetchMock)
    const { auth } = await fresh()
    expect(await auth.getStudent()).toBeNull()
    expect(await auth.getStudent()).toEqual({ ...ming, ai: false, aiAvailable: false })
    expect(auth.asStudent({ ...ming, sid: 's-0123456789abcdef' })).toBeNull() // 学号的 sid 不是账号
    expect(auth.asStudent({ ...ming, sid: 'u-123' })).toBeNull()
    expect(auth.asStudent({ ...ming, extra: 1, passwordHash: 'x' })).toEqual(ming) // 只留五个字段
  })

  it('adapt（按我以前的记录调整提示）默认开：只有后端明说 false 才算关着', () => {
    return fresh().then(({ auth }) => {
      expect(auth.asStudent({ ...ming, adapt: false })?.adapt).toBe(false)
      for (const adapt of [true, undefined, null, 'no']) expect(auth.asStudent({ ...ming, adapt })?.adapt, String(adapt)).toBe(true)
    })
  })
})

describe('登录、注册、退出、改设置、找回码改密码', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('登录：POST JSON 到 /api/student/login，之后 getStudent 直接用；没登录时回 401 卡着的作答，登录后发出去', async () => {
    let signed = false
    const fetchMock = vi.fn((url: string, _init?: RequestInit) => {
      if (url === '/api/events') return Promise.resolve(signed ? reply(200, { ok: true }) : reply(401, { error: '请先登录' }))
      signed = true
      return Promise.resolve(reply(200, { student: ming }))
    })
    vi.stubGlobal('fetch', fetchMock)
    vi.stubGlobal('localStorage', memoryStorage({ [`zhishi:queue:v2:${ming.sid}`]: JSON.stringify([{ sid: ming.sid, ts: 1, handoutId: 'up-a', type: 'tap_word', lemma: 'fret' }]) }))
    const { auth, events } = await fresh()
    expect(events.pendingCount(ming.sid)).toBe(1)
    await events.flush() // 打开页面时那一次：还没登录，回 401，留着
    expect(events.pendingCount(ming.sid)).toBe(1)
    expect(await auth.login('reader01', 'secret-123')).toEqual(ming)
    const [url, init] = fetchMock.mock.calls.find((c) => c[0] === '/api/student/login')!
    expect(url).toBe('/api/student/login')
    expect(init).toMatchObject({ method: 'POST', headers: { 'Content-Type': 'application/json' } })
    expect(JSON.parse(init!.body as string)).toEqual({ username: 'reader01', password: 'secret-123' })
    expect(await auth.getStudent()).toEqual(ming)
    expect(fetchMock.mock.calls.filter((c) => c[0] === '/api/student/me')).toHaveLength(0)
    await events.flush()
    expect(events.pendingCount(ming.sid)).toBe(0)
  })

  it('登录失败：抛出后端的中文提示和状态码；连不上服务器、不是 JSON 给自己的提示', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(reply(401, { error: '用户名或密码不对' })))
    const { auth } = await fresh()
    const err = await auth.login('reader01', 'wrong-pass').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(auth.StudentError)
    expect(err).toMatchObject({ message: '用户名或密码不对', status: 401, fields: {} })
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')))
    await expect(auth.login('reader01', 'x')).rejects.toMatchObject({ status: 0, message: '连不上服务器，请检查网络' })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 502, json: async () => Promise.reject(new Error('not json')) }))
    await expect(auth.login('reader01', 'x')).rejects.toThrow('请求失败（502）')
  })

  it('注册：发邀请码、用户名、密码、出生年月和 agree，没有称呼；拿回找回码，之后就是登录状态', async () => {
    const fetchMock = vi.fn().mockResolvedValue(reply(200, { student: ming, recoveryCode: 'ABC234' }))
    vi.stubGlobal('fetch', fetchMock)
    const { auth } = await fresh()
    const input = { invite: 'test-invite-1', username: 'reader01', password: 'secret-123', birth: '2010-03', agree: true as const }
    expect(await auth.register(input)).toEqual({ student: ming, recoveryCode: 'ABC234' })
    expect(fetchMock.mock.calls[0][0]).toBe('/api/student/register')
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual(input)
    expect(await auth.getStudent()).toEqual(ming)
  })

  it('注册被拒（年龄不够 400、码不对 403、码用过或用户名占用 409）：原样带出后端的提示和 fields，不是登录状态', async () => {
    const { auth } = await fresh()
    const input = { invite: 'test-invite-1', username: 'reader01', password: 'secret-123', birth: '2020-01', agree: true as const }
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(reply(400, { error: '知适内测暂时只对年满 12 周岁的同学开放' })))
    await expect(auth.register(input)).rejects.toMatchObject({ status: 400, message: '知适内测暂时只对年满 12 周岁的同学开放' })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(reply(409, { error: '这个用户名已经有人用了', fields: { username: '换一个用户名', x: 1 } })))
    await expect(auth.register(input)).rejects.toMatchObject({ status: 409, fields: { username: '换一个用户名' } })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(reply(200, { student: null })))
    expect(await auth.getStudent()).toBeNull()
  })

  it('退出：成功后清掉这个账号在这台设备上的作答、步骤、写作草稿和队列，别人的、别的键不动；之后 getStudent 是 null', async () => {
    const other = 'u-ffffffffffffffff'
    const ls = memoryStorage({
      [`zhishi:state:up-a:${ming.sid}`]: '{}',
      [`zhishi:step:up-a:${ming.sid}`]: '3',
      [`zhishi:writing:up-a:${ming.sid}`]: 'I think',
      [`zhishi:state:up-b:${ming.sid}`]: '{}',
      [`zhishi:state:up-a:${other}`]: '{}',
      [`zhishi:writing:mini-phones:stu-abc123`]: 'draft',
      'zhishi:sid:student': 'stu-abc123',
      'zhishi:class:c-0123456789ab': '{}',
    })
    vi.stubGlobal('localStorage', ls)
    const fetchMock = vi.fn((url: string, _init?: RequestInit) =>
      Promise.resolve(url === '/api/student/me' ? reply(200, { student: ming }) : url === '/api/events' ? reply(500, {}) : reply(200, { ok: true })),
    )
    vi.stubGlobal('fetch', fetchMock)
    const { auth, events } = await fresh()
    await auth.getStudent()
    await events.sendEvent({ sid: ming.sid, ts: 1, handoutId: 'up-a', type: 'tap_word', lemma: 'fret' }) // 发不出去，留在队列
    expect(ls.m.has(`zhishi:queue:v2:${ming.sid}`)).toBe(true)
    await auth.logout()
    expect(fetchMock.mock.calls.find((c) => c[0] === '/api/student/logout')![1]).toMatchObject({ method: 'POST', body: '{}' })
    expect([...ls.m.keys()].sort()).toEqual([`zhishi:state:up-a:${other}`, 'zhishi:class:c-0123456789ab', 'zhishi:sid:student', 'zhishi:writing:mini-phones:stu-abc123'].sort())
    expect(events.pendingCount(ming.sid)).toBe(0)
    expect(await auth.getStudent()).toBeNull()
  })

  it('退出失败（连不上）：抛出提示，本机的键和登录状态都不动', async () => {
    const ls = memoryStorage({ [`zhishi:state:up-a:${ming.sid}`]: '{}' })
    vi.stubGlobal('localStorage', ls)
    vi.stubGlobal('fetch', vi.fn((url: string) => (url === '/api/student/me' ? Promise.resolve(reply(200, { student: ming })) : Promise.reject(new Error('offline')))))
    const { auth } = await fresh()
    await auth.getStudent()
    await expect(auth.logout()).rejects.toThrow('连不上服务器，请检查网络')
    expect(ls.m.has(`zhishi:state:up-a:${ming.sid}`)).toBe(true)
    expect(await auth.getStudent()).toEqual(ming)
  })

  it('注销：POST JSON {password} 到 /api/student/delete；成功后清掉这个账号在这台设备上的作答、步骤、写作草稿和队列（不先发），别的不动；之后 getStudent 是 null；带回 incomplete', async () => {
    const other = 'u-ffffffffffffffff'
    const ls = memoryStorage({
      [`zhishi:state:up-a:${ming.sid}`]: '{}',
      [`zhishi:step:up-a:${ming.sid}`]: '3',
      [`zhishi:writing:up-a:${ming.sid}`]: 'I think',
      [`zhishi:state:up-a:${other}`]: '{}',
      'zhishi:class:c-0123456789ab': '{}',
    })
    vi.stubGlobal('localStorage', ls)
    const fetchMock = vi.fn((url: string, _init?: RequestInit) =>
      Promise.resolve(url === '/api/student/me' ? reply(200, { student: ming }) : url === '/api/events' ? reply(500, {}) : reply(200, { ok: true, incomplete: true })),
    )
    vi.stubGlobal('fetch', fetchMock)
    const { auth, events } = await fresh()
    await auth.getStudent()
    await events.sendEvent({ sid: ming.sid, ts: 1, handoutId: 'up-a', type: 'tap_word', lemma: 'fret' }) // 发不出去，留在队列
    const posts = () => fetchMock.mock.calls.filter((c) => c[0] === '/api/events').length
    const sent = posts()
    expect(await auth.deleteAccount('my-password-1')).toEqual({ incomplete: true })
    expect(fetchMock.mock.calls.find((c) => c[0] === '/api/student/delete')![1]).toMatchObject({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'my-password-1' }) })
    expect(posts()).toBe(sent) // 不先把队列发完：记录本来就要删
    expect([...ls.m.keys()].sort()).toEqual([`zhishi:state:up-a:${other}`, 'zhishi:class:c-0123456789ab'].sort())
    expect(events.pendingCount(ming.sid)).toBe(0)
    expect(await auth.getStudent()).toBeNull()
    fetchMock.mockImplementation((url: string) => Promise.resolve(url === '/api/student/me' ? reply(200, { student: ming }) : reply(200, { ok: true })))
    await auth.getStudent(true)
    expect(await auth.deleteAccount('my-password-1')).toEqual({ incomplete: false })
  })

  it('注销失败（密码不对、连不上）：抛出提示，本机的键和登录状态都不动', async () => {
    const ls = memoryStorage({ [`zhishi:state:up-a:${ming.sid}`]: '{}' })
    vi.stubGlobal('localStorage', ls)
    vi.stubGlobal('fetch', vi.fn((url: string) => Promise.resolve(url === '/api/student/me' ? reply(200, { student: ming }) : reply(401, { error: '密码不对' }))))
    const { auth } = await fresh()
    await auth.getStudent()
    await expect(auth.deleteAccount('wrong')).rejects.toMatchObject({ status: 401, message: '密码不对' })
    vi.stubGlobal('fetch', vi.fn((url: string) => (url === '/api/student/me' ? Promise.resolve(reply(200, { student: ming })) : Promise.reject(new Error('offline')))))
    await expect(auth.deleteAccount('x')).rejects.toThrow('连不上服务器，请检查网络')
    expect(ls.m.has(`zhishi:state:up-a:${ming.sid}`)).toBe(true)
    expect(await auth.getStudent()).toEqual(ming)
  })

  it('AI 写作检查开关：PUT JSON 到 /api/student/settings，回来的账号更新缓存', async () => {
    const fetchMock = vi.fn().mockResolvedValue(reply(200, { student: { ...ming, ai: true } }))
    vi.stubGlobal('fetch', fetchMock)
    const { auth } = await fresh()
    expect(await auth.saveAi(true)).toEqual({ ...ming, ai: true })
    expect(fetchMock.mock.calls[0][0]).toBe('/api/student/settings')
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ai: true }) })
    expect(await auth.getStudent()).toEqual({ ...ming, ai: true })
  })

  it('调整提示开关：PUT JSON 到 /api/student/settings，只发 adapt；回来的账号更新缓存', async () => {
    const fetchMock = vi.fn().mockResolvedValue(reply(200, { student: { ...ming, adapt: false } }))
    vi.stubGlobal('fetch', fetchMock)
    const { auth } = await fresh()
    expect(await auth.saveAdapt(false)).toEqual({ ...ming, adapt: false })
    expect(fetchMock.mock.calls[0][0]).toBe('/api/student/settings')
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ adapt: false }) })
    expect(await auth.getStudent()).toEqual({ ...ming, adapt: false })
  })

  it('找回码改密码：找回码去掉空格和「-」转大写；返回新的找回码；之后重新问登录状态（旧会话都作废了）', async () => {
    const fetchMock = vi.fn((url: string, _init?: RequestInit) => Promise.resolve(url === '/api/student/reset' ? reply(200, { recoveryCode: 'NEW234' }) : reply(200, { student: null })))
    vi.stubGlobal('fetch', fetchMock)
    const { auth } = await fresh()
    expect(await auth.resetPassword({ username: 'reader01', code: 'abc-23 4', newPassword: 'new-secret-1' })).toBe('NEW234')
    expect(JSON.parse(fetchMock.mock.calls[0][1]!.body as string)).toEqual({ username: 'reader01', code: 'ABC234', newPassword: 'new-secret-1' })
    expect(fetchMock.mock.calls[1][0]).toBe('/api/student/me')
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(reply(429, { error: '试错太多次了，请 15 分钟后再试' })))
    await expect(auth.resetPassword({ username: 'reader01', code: 'x', newPassword: 'new-secret-1' })).rejects.toMatchObject({ status: 429, message: '试错太多次了，请 15 分钟后再试' })
  })
})

// 阶段 6：问卷改成注册后做一次（看过找回码之后，可以跳过），账号页随时能改；答案记在账号的 profile 上
describe('问卷：GET / PUT /api/student/profile、注册后和账号页', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('getProfile：只留认得的项，格式不对的那一项当没答；回来的不是对象当什么都没答；没登录 401 抛出', async () => {
    const fetchMock = vi.fn().mockResolvedValue(reply(200, { profile: { goal: 'gaokao', grade: '高九', curriculum: '普通高中', level: 'B2' } }))
    vi.stubGlobal('fetch', fetchMock)
    const { auth } = await fresh()
    expect(await auth.getProfile()).toEqual({ goal: 'gaokao', curriculum: '普通高中' })
    expect(fetchMock.mock.calls[0][0]).toBe('/api/student/profile')
    for (const profile of [null, 'x', [1], undefined]) {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(reply(200, { profile })))
      expect(await auth.getProfile(), String(profile)).toEqual({})
    }
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(reply(401, { error: '请先登录' })))
    await expect(auth.getProfile()).rejects.toMatchObject({ status: 401 })
  })

  // 阶段 7：同一个接口还回开关和单词本里还在练的词，读文章时交给引擎（getLearner），页面上不显示
  it('getLearner：开关关着返回 undefined（标准版）；开着时是问卷答案加 practicing，practicing 里不是字符串的跳过；没回 adapt 的当开着；没登录 401 抛出', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(reply(200, { profile: { grade: '高一', goal: 'gaokao' }, adapt: false, practicing: ['fret'] })))
    const { auth } = await fresh()
    expect(await auth.getLearner()).toBeUndefined()
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(reply(200, { profile: { grade: '高一', level: 'B2' }, adapt: true, practicing: ['fret', 3, '', null, 'pupil'] })))
    expect(await auth.getLearner()).toEqual({ grade: '高一', practicing: ['fret', 'pupil'] })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(reply(200, { profile: {}, practicing: 'fret' })))
    expect(await auth.getLearner()).toEqual({ practicing: [] })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(reply(401, { error: '请先登录' })))
    await expect(auth.getLearner()).rejects.toMatchObject({ status: 401 })
  })

  it('开关关掉：交给引擎的是 undefined，和不传画像逐字段一样；开着时同样的答案会多出注释', async () => {
    const body = { profile: { grade: '初中', goal: 'gaokao' }, practicing: ['harm', 'proposal'] }
    const s = { ...emptyState('u-0123456789abcdef'), tappedWords: ['pupil'], wordMarks: { fret: 'known' as const } }
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(reply(200, { ...body, adapt: false })))
    const { auth } = await fresh()
    expect(personalize(miniHandout, s, await auth.getLearner())).toEqual(personalize(miniHandout, s))
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(reply(200, { ...body, adapt: true })))
    expect(personalize(miniHandout, s, await auth.getLearner())).not.toEqual(personalize(miniHandout, s))
  })

  it('saveProfile：PUT JSON，没答的不发；拿回服务器存下的', async () => {
    const fetchMock = vi.fn().mockResolvedValue(reply(200, { profile: { grade: '初中' } }))
    vi.stubGlobal('fetch', fetchMock)
    const { auth } = await fresh()
    expect(await auth.saveProfile({ grade: '初中', goal: undefined })).toEqual({ grade: '初中' })
    expect(fetchMock.mock.calls[0][0]).toBe('/api/student/profile')
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ grade: '初中' }) })
  })

  it('题目：年级（初中、高一、高二、高三、其他）、课程体系（照旧）、读英文主要为了（高考 / 出国考试 / 课内和兴趣）；不再问卡在哪', () => {
    expect([...PROFILE_GRADES]).toEqual(['初中', '高一', '高二', '高三', '其他'])
    expect([...PROFILE_CURRICULA]).toEqual(['A-Level', 'IB', 'AP', '普通高中', '其他'])
    expect(PROFILE_GOALS.map((g) => GOAL_LABEL[g])).toEqual(['高考', '出国考试', '课内和兴趣'])
    const survey = code('pages/student/Survey.tsx')
    for (const x of ['1. 年级', '2. 课程体系', '3. 读英文主要为了']) expect(survey).toContain(x)
    expect(survey).not.toMatch(/stuckOn|卡在哪/)
    expect(survey).not.toMatch(/只存在本机|不参与适配/) // 旧的说法改掉了
    // 说明如实写：记在账号上、决定要不要放「高中新词」、年级用来调整注释（阶段 7）、课程体系只用来预选目标（引擎和服务器不读）、不打等级、可以跳过
    expect(survey).toContain('大约 20 秒，可以跳过。答案记在你的账号上，用来决定词卡里要不要放「高中新词」，年级也用来调整精读的注释，课程体系只用来帮你先选好目标；不会给你打等级。在账号页随时可以改。')
    expect(survey).not.toContain('以后也会用来调整提示')
  })

  it('默认值：选「普通高中」时目标默认高考，国际课程、其他、没选默认不选；自己点过目标就不再跟着改', () => {
    expect(defaultGoal('普通高中')).toBe('gaokao')
    for (const c of ['A-Level', 'IB', 'AP', '其他', undefined] as const) expect(defaultGoal(c), String(c)).toBeUndefined()
    const survey = code('pages/student/Survey.tsx')
    expect(survey).toContain('if (!goalPicked) setGoal(defaultGoal(next))')
    expect(survey).toContain('const [goalPicked, setGoalPicked] = useState(initial?.goal !== undefined)')
    expect(survey).toMatch(/const pickGoal = \(g: Goal\) => \{\s+setGoal\(goal === g \? undefined : g\)\s+setGoalPicked\(true\)/)
  })

  it('注册后：看过找回码（「我记下来了」）再做一次问卷；保存或跳过以后去 next；保存没成功留在这一页', () => {
    const page = code('pages/StudentLogin.tsx')
    expect(page).toContain("if (shown.after === 'register') return setAsking(true)")
    expect(page).toContain("<FirstSurvey onLeave={() => goNext(safeNext(getParams().get('next')))} />")
    const first = page.slice(page.indexOf('function FirstSurvey('), page.indexOf('function ProfileSection('))
    expect(first).toMatch(/await saveProfile\(p\)\s+onLeave\(\)/)
    expect(first).toContain('<Survey busy={busy} doneLabel="保存，去读文章" skipLabel="跳过" onDone={(p) => void done(p)} onSkip={onLeave} />')
  })

  it('账号页：能看、能改问卷答案，说明同问卷；没答的显示「还没填」', () => {
    const page = code('pages/StudentLogin.tsx')
    const my = page.slice(page.indexOf('function MyPage('), page.indexOf('function DeleteAccount('))
    expect(my).toContain('<ProfileSection disabled={busy} />')
    const sec = page.slice(page.indexOf('function ProfileSection('), page.indexOf('function MyPage('))
    expect(sec).toContain('getProfile().then(')
    expect(sec).toContain('setProfile(await saveProfile(p))')
    expect(sec).toContain('<Survey initial={profile} busy={busy} doneLabel="保存" skipLabel="不改了"')
    expect(sec).toContain("'还没填。'")
    expect(sec).toContain('答案记在账号上，用来决定词卡里要不要放「高中新词」，年级也用来调整精读的注释，课程体系只用来帮你先选好目标；不会给你打等级。关掉上面的开关就不用。')
    // 注销写明问卷答案一起删
    expect(page).toContain('用户名、密码、设置、问卷答案，还有你在每一篇里的作答、单词本和表达本')
  })
})

describe('上架列表、这一篇的作答、下载我的数据', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('fetchShelf：GET /api/student/shelf，格式不对的跳过；没登录 401 抛出', async () => {
    const fetchMock = vi.fn().mockResolvedValue(reply(200, { handouts: [{ id: 'up-abc', title: 'Phones in class' }, { id: '../x', title: 'bad' }, { id: 'up-b' }, null] }))
    vi.stubGlobal('fetch', fetchMock)
    const { auth } = await fresh()
    expect(await auth.fetchShelf()).toEqual([{ id: 'up-abc', title: 'Phones in class' }])
    expect(fetchMock.mock.calls[0][0]).toBe('/api/student/shelf')
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(reply(401, { error: '请先登录' })))
    await expect(auth.fetchShelf()).rejects.toMatchObject({ status: 401 })
  })

  it('fetchMyEvents：参数编码，格式不对的事件跳过', async () => {
    const good: LearningEvent = { sid: ming.sid, ts: 1, handoutId: 'up-abc', type: 'tap_word', lemma: 'fret' }
    const fetchMock = vi.fn().mockResolvedValue(reply(200, { events: [good, { nope: 1 }] }))
    vi.stubGlobal('fetch', fetchMock)
    const { auth } = await fresh()
    expect(await auth.fetchMyEvents('up-abc')).toEqual([good])
    expect(fetchMock.mock.calls[0][0]).toBe('/api/student/events?h=up-abc')
  })

  it('fetchExport：拿到文件内容，文件名只认安全的字符；失败带出后端的提示（每小时限次数）', async () => {
    const blob = { size: 2 }
    const res = (cd: string | null) => ({ ok: true, status: 200, headers: { get: () => cd }, blob: async () => blob })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(res('attachment; filename="zhishi-reader01.json"')))
    const { auth } = await fresh()
    expect(await auth.fetchExport()).toEqual({ blob, filename: 'zhishi-reader01.json' })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(res('attachment; filename="../../etc/x"')))
    expect((await auth.fetchExport()).filename).toBe('zhishi-my-data.json')
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(res(null)))
    expect((await auth.fetchExport()).filename).toBe('zhishi-my-data.json')
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(reply(429, { error: '导出太频繁了，请过一会儿再试' })))
    await expect(auth.fetchExport()).rejects.toMatchObject({ status: 429, message: '导出太频繁了，请过一会儿再试' })
  })
})

describe('事件队列按 sid 分开', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })
  const ev = (sid: string, ts: number): LearningEvent => ({ sid, ts, handoutId: 'up-abc', type: 'tap_word', lemma: 'fret' })

  it('一批只发一个 sid；账号的事件回 401 只卡住这个账号，别的 sid 照常发，401 的不再自动重发', async () => {
    const acct = 'u-0123456789abcdef'
    const fetchMock = vi.fn((_url: string, init?: RequestInit) => {
      const batch = JSON.parse(init!.body as string) as LearningEvent[]
      return Promise.resolve(batch[0].sid === acct ? reply(401, { error: '请先登录' }) : reply(200, { ok: true }))
    })
    vi.stubGlobal('fetch', fetchMock)
    vi.stubGlobal('localStorage', memoryStorage())
    const { events } = await fresh()
    await events.sendEvent(ev(acct, 1))
    await events.sendEvent(ev('s-0123456789abcdef', 2))
    await events.sendEvent(ev(acct, 3))
    for (const [, init] of fetchMock.mock.calls) expect(new Set((JSON.parse(init!.body as string) as LearningEvent[]).map((e) => e.sid)).size).toBe(1)
    expect(events.pendingCount(acct)).toBe(2)
    expect(events.pendingCount('s-0123456789abcdef')).toBe(0)
    const calls = fetchMock.mock.calls.length
    await events.flush()
    expect(fetchMock.mock.calls.length).toBe(calls) // 卡着的不自动重发
    // 登录后 drain：发完返回 true
    fetchMock.mockImplementation(() => Promise.resolve(reply(200, { ok: true })))
    expect(await events.drain(acct)).toBe(true)
    expect(events.pendingCount()).toBe(0)
  })

  it('drain：连不上返回 false，事件留着；forget 丢掉这个 sid 的队列', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')))
    const ls = memoryStorage()
    vi.stubGlobal('localStorage', ls)
    const { events } = await fresh()
    await events.sendEvent(ev('u-0123456789abcdef', 1))
    expect(await events.drain('u-0123456789abcdef')).toBe(false)
    expect(events.pendingCount('u-0123456789abcdef')).toBe(1)
    expect(await events.drain('u-ffffffffffffffff')).toBe(true) // 本来就没有
    events.forget('u-0123456789abcdef')
    expect(events.pendingCount()).toBe(0)
    expect(ls.m.size).toBe(0)
  })

  it('旧版本整台设备一条的队列：打开时按 sid 拆开存，旧的键删掉', async () => {
    const ls = memoryStorage({ 'zhishi:queue:v1': JSON.stringify([ev('s-0123456789abcdef', 1), ev('diag-abc', 2), ev('s-0123456789abcdef', 3)]) })
    vi.stubGlobal('localStorage', ls)
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')))
    const { events } = await fresh()
    expect(events.pendingCount('s-0123456789abcdef')).toBe(2)
    expect(events.pendingCount('diag-abc')).toBe(1)
    expect(ls.m.has('zhishi:queue:v1')).toBe(false)
    expect(JSON.parse(ls.m.get('zhishi:queue:v2:s-0123456789abcdef')!)).toHaveLength(2)
  })
})

describe('登录后去哪（next）：只认站内的 #/ 地址和 /?h=<讲义 id>…#/', () => {
  it('#/ 开头的、整页打开一篇的原样用', () => {
    for (const x of ['#/', '#/student', '#/me?mode=register', '/?h=up-mg5k2x7a#/student', '/?h=up-mg5k2x7a&jump=S03#/student', '/?h=mini-phones#/student?step=summary']) expect(safeNext(x)).toBe(x)
  })

  it('外站、协议、// 开头、/?h= 后面不是讲义 id、空的：一律回首页', () => {
    for (const x of [
      'https://evil.example/#/',
      'http://evil.example',
      '//evil.example/#/',
      '/\\evil.example/#/',
      'javascript:alert(1)',
      '/?h=#/student',
      '/?h=../x#/student',
      '/?h=UP X#/student',
      '/?h=up-a',
      '/?h=up-a//evil#/',
      '/#/student',
      '/student',
      'student',
      ' #/',
      '',
      null,
      undefined,
    ])
      expect(safeNext(x)).toBe('#/')
  })

  it('loginHref 把 next 编码进 #/me 的地址，读回来不变', () => {
    const next = '/?h=up-mg5k2x7a#/student'
    const href = loginHref(next)
    expect(href.startsWith('#/me?next=')).toBe(true)
    expect(new URLSearchParams(href.split('?')[1]).get('next')).toBe(next)
  })
})

describe('页面：学生登录、账号页、顶栏', () => {
  const page = read('pages/StudentLogin.tsx')
  const bar = read('components/StudentBar.tsx')
  const lib = read('lib/student-auth.ts')

  it('学生这一侧不引用老师的 lib/auth 和 components/Account', () => {
    for (const f of ['pages/StudentLogin.tsx', 'components/StudentBar.tsx', 'lib/student-auth.ts', 'pages/Home.tsx', 'pages/student/Student.tsx'].map(code)) {
      expect(f).not.toMatch(/lib\/auth['"]|components\/Account|from '\.\/auth'|from '\.\/Account'/)
    }
  })

  it('路由：#/me 是学生登录页；router 的注释写上', () => {
    expect(read('App.tsx')).toContain("path === '/me' ? <StudentLoginPage />")
    expect(read('lib/router.ts')).toContain('#/me（学生登录')
  })

  it('注册页：邀请码、用户名（提示不要用真实姓名或手机号）、密码两次、出生年月两个下拉框、必勾隐私说明；没有称呼，也没有 AI 的勾选', () => {
    const c = code('pages/StudentLogin.tsx')
    expect(c).toContain("m === 'login' ? '登录' : '用邀请码注册'")
    expect(c).toContain('label="邀请码"')
    expect(c).toContain("hint={reg ? '不要用真实姓名或手机号' : undefined}")
    expect(c).toContain('label="再输一次密码"')
    expect(c).toContain('两次输入的密码不一样')
    expect(c).toContain('出生年月')
    expect(c.match(/<select required/g)).toHaveLength(2)
    expect(c).toContain('birth, agree: true')
    expect(c).toMatch(/<input type="checkbox" required checked=\{agree\}/)
    expect(c).toMatch(/我读过\s+<a href="#\/privacy" target="_blank"[^>]*>\s+隐私说明\s+<\/a>\s+，同意按账号保存学习记录/)
    expect(c).not.toContain('称呼')
    expect(c).not.toContain('服务协议')
    // AI 只在账号页的开关里出现，注册表单里没有
    const signIn = c.slice(c.indexOf('function SignIn('), c.indexOf('function ResetForm('))
    expect(signIn).not.toContain('AI')
    for (const k of ['invite', 'username', 'password', 'password2']) expect(c).toContain(`error={fields.${k}}`)
  })

  it('年龄由后端判断：前端不先拦（不比较年份），年份下拉框里年龄不够的也列出来；不存出生年月', () => {
    const c = code('pages/StudentLogin.tsx')
    expect(c).not.toMatch(/MIN_AGE|THIS_YEAR - 1[0-9]\b|周岁/)
    expect(c).toContain('const YEARS = Array.from({ length: 56 }, (_, i) => String(THIS_YEAR - 5 - i))')
    expect(c).toContain('只用来确认年龄，不保存')
    expect(page).not.toMatch(/writeLS|localStorage/)
  })

  it('注册成功显示一次找回码；登录、注册成功后按 safeNext 去 next', () => {
    expect(page).toContain('找回码只显示这一次')
    expect(page).toContain('我记下来了')
    // 标题里有用户名（最长 32 个字母数字，中间没处可断）：要能在任意处折行，窄手机上不撑出横向滚动
    expect(page).toMatch(/<h1 className="[^"]*\[overflow-wrap:anywhere\][^"]*">\{shown\.after === 'register' \? `注册好了：\$\{shown\.username\}`/)
    expect(page.match(/goNext\(safeNext\(getParams\(\)\.get\('next'\)\)\)/g)).toHaveLength(2)
    expect(lib).toContain('if (next.startsWith(\'/\')) window.location.assign(next)') // /?h= 的整页打开
  })

  it('账号页：用户名、AI 写作检查开关（服务器开放了才有，默认开）、用找回码改密码、下载我的数据、退出写明清掉写作草稿', () => {
    const my = page.slice(page.indexOf('function MyPage('))
    expect(my).toContain('用户名：{me.username}')
    expect(my).toContain('{me.aiAvailable && (')
    expect(my).toContain('role="switch"')
    expect(my).toContain('aria-checked={me.ai}')
    expect(my).toContain('await saveAi(!me.ai)')
    // 阶段 7：「按我以前的记录调整提示（关掉就用标准版）」开关，不管服务器开没开放 AI 都有；在问卷上面（问卷那里说「关掉上面的开关就不用」）
    const adapt = my.slice(my.indexOf('按我以前的记录调整提示<'), my.indexOf('<ProfileSection disabled={busy} />'))
    expect(adapt).toContain('按我以前的记录调整提示<span className="font-normal text-ink2">（关掉就用标准版）</span>')
    expect(adapt).toContain('aria-checked={me.adapt}')
    expect(adapt).toContain('aria-label="按我以前的记录调整提示"')
    expect(adapt).toContain('await saveAdapt(!me.adapt)')
    expect(adapt).toContain('开着的时候，读文章会根据你填的问卷和单词本里的词调整注释和词卡：单词本里的词在新文章里出现，会加注释、放进词卡。不会给你打等级。关掉以后，只按你在这一篇里点过、标过的词调整。')
    expect(my.indexOf('aria-label="按我以前的记录调整提示"')).toBeGreaterThan(my.indexOf('{me.aiAvailable && ('))
    expect(my).toContain('用找回码改密码')
    expect(my).toContain('下载我的数据')
    expect(my).toContain('fetchExport()')
    expect(my).toContain('退出会清掉这台设备上的写作草稿')
    // 和隐私说明对得上：表达本的收进、移出记在账号上（collect_expression、drop_expression），问卷答案在账号记录上；写作草稿不记到账号上，退出就没有了
    expect(my).toContain('作答、表达本和问卷答案记在账号上，再登录还在；写作草稿只存在这台设备上')
    expect(my).not.toMatch(/问卷和写作草稿只存在|问卷、表达本和写作草稿只存在/)
    expect(my).toContain('还有账号上原样的每一条记录') // 下载的有账号上的全部事件，包括单词本里的复习、移出（完整版见 records-client.test.ts）
    // 退出前先把队列发完，发不完先问
    expect(my).toMatch(/if \(!\(await drain\(me\.sid\)\) && !window\.confirm\([^)]*\)\) return\s+await logout\(\)/)
  })

  it('注销账号：账号页最下面，先点开；写明删掉什么、本机清掉什么、备份里最多还留 30 天（deploy/backup.sh 的 BACKUP_DAYS）、码不能再用；再输一次密码；成功先说已经注销再回首页，没删完的说服务器会再删', () => {
    const c = code('pages/StudentLogin.tsx')
    const my = c.slice(c.indexOf('function MyPage('), c.indexOf('function DeleteAccount('))
    const box = c.slice(c.indexOf('function DeleteAccount('))
    expect(my).toContain('<DeleteAccount disabled={busy} />')
    expect(box).toContain('onClick={() => setOpen(true)}')
    expect(box).toContain('账号和账号上的学习记录马上从服务器上删掉，不能恢复')
    expect(box).toContain('还有你在每一篇里的作答、单词本和表达本') // 都在 students/<sid>.jsonl 里，删账号时一起删
    expect(box).toContain('这台设备上这个账号的作答、读到哪一步、问卷、表达本和写作草稿也一起清掉')
    const days = readFileSync(fileURLToPath(new URL('../deploy/backup.sh', import.meta.url)), 'utf8').match(/BACKUP_DAYS=\$\{BACKUP_DAYS:-(\d+)\}/)![1]
    expect(box).toContain(`服务器的备份里最多还会留 ${days} 天，到期自动删掉`)
    expect(box).toContain('用过的邀请码不能再注册')
    expect(box).toContain('label="再输一次密码"')
    expect(box).toMatch(/<input required type="password" value=\{password\}.*autoComplete="current-password"/)
    expect(box).toContain('await deleteAccount(password)')
    // 删完了也说一句「已经注销」，没删完的再说服务器会再删；然后回首页
    expect(box).toMatch(/window\.alert\(incomplete \? '账号已经注销。[^']*服务器会自动再删[^']*' : '账号已经注销，[^']*'\)\s+goNext\('#\/'\)/)
    expect(box).toContain('不注销了')
    expect(box).not.toContain('drain(') // 不先发队列
  })

  it(`登录页写明账号 ${STUDENT_INACTIVE_MONTHS} 个月没用会自动删除（和 server 的 STUDENT_INACTIVE_MONTHS 一致）`, () => {
    const c = code('pages/StudentLogin.tsx')
    const signIn = c.slice(c.indexOf('function SignIn('), c.indexOf('function ResetForm('))
    expect(signIn).toContain(`账号连续 ${STUDENT_INACTIVE_MONTHS} 个月没用会自动删除，删之前没法通知你。`)
  })

  it('找回码改密码：登录页和账号页都能进，说明旧登录都会失效', () => {
    expect(page).toContain('忘了密码？用找回码改密码')
    expect(page).toContain("onReset={() => setMode('reset')}")
    expect(page).toContain('所有设备上的登录都会退出')
    expect(page).toContain('<ResetForm username={student?.username ?? \'\'}')
  })

  it('顶栏：登录了显示用户名去 #/me，没登录显示「登录」并带回这一页；还在问后端时不显示', () => {
    expect(bar).toContain('if (loading) return null')
    expect(bar).toContain("loginHref(window.location.hash || '#/')")
    expect(bar).toContain('href="#/me"')
    expect(bar).toContain('{student.username}')
  })

  it('页面文案：不用感叹号', () => {
    for (const f of ['pages/StudentLogin.tsx', 'components/StudentBar.tsx', 'lib/student-auth.ts']) expect(code(f)).not.toMatch(/！|[\u4e00-\u9fff]!/)
  })
})
