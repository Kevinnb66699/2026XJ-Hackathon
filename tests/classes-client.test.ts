// 班级和学号的前端（src/lib/classes.ts、store.ts 的 restoreState）：名单解析、学号称呼、学生在本机记住的学号、请求班级接口用假 fetch 测；
// 没有 DOM 测试环境，学生端选学号、班级页、上传页选班发布、老师端按班看的条件和文案直接查源码
import { readFileSync, readdirSync, statSync } from 'fs'
import { join } from 'path'
import { fileURLToPath } from 'url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { LearningEvent } from '../shared/schema'
import { emptyState } from '../src/engine'
import { classSummary } from '../src/lib/classSummary'
import { ApiError, asBinding, bindingKey, cleanCode, formatRoster, myProgress, parseRoster, readBinding, saveBinding, seatName, send } from '../src/lib/classes'
import { replay } from '../src/lib/replay'
import { STEPS, restoreState, stepIndex } from '../src/lib/store'
import { miniHandout as h } from './fixtures/mini-handout'

// 内存里的 localStorage（node 里没有）
const memoryStorage = () => {
  const m = new Map<string, string>()
  return {
    m,
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
  }
}

describe('parseRoster：老师粘贴的名单', () => {
  it('「学号 分隔符 姓名」：Tab、逗号、中文逗号、顿号、空格（一个或多个、混着用）都算分隔符；按学号排好', () => {
    const { seats, errors } = parseRoster('3\t王五\n1,张三\n2，李四\n4、赵六\n5   钱七\n6 ,、 孙八\n7　周九')
    expect(errors).toEqual([])
    expect(seats).toEqual([
      { n: 1, name: '张三' },
      { n: 2, name: '李四' },
      { n: 3, name: '王五' },
      { n: 4, name: '赵六' },
      { n: 5, name: '钱七' },
      { n: 6, name: '孙八' },
      { n: 7, name: '周九' },
    ])
  })

  it('每行去掉首尾空白，空行、只有空白的行跳过；Windows 换行也认；学号前面的 0 去掉', () => {
    expect(parseRoster('\n  07 张三  \r\n\r\n   \n\t08\t李四\t\n').seats).toEqual([
      { n: 7, name: '张三' },
      { n: 8, name: '李四' },
    ])
    expect(parseRoster('')).toEqual({ seats: [], errors: [] })
  })

  it('只有姓名的行按顺序编号，接着上面最大的学号；只有数字的行是没有姓名的学号', () => {
    expect(parseRoster('张三\n李四\n10 王五\n赵六\n3\n钱七').seats).toEqual([
      { n: 1, name: '张三' },
      { n: 2, name: '李四' },
      { n: 3, name: '' },
      { n: 10, name: '王五' },
      { n: 11, name: '赵六' },
      { n: 12, name: '钱七' },
    ])
  })

  it('全角数字、全角空格也认；姓名中间的空白合成一个空格', () => {
    expect(parseRoster('０７　张三\n8 欧阳  小\t明').seats).toEqual([
      { n: 7, name: '张三' },
      { n: 8, name: '欧阳 小 明' },
    ])
  })

  it('学号重复：说是第几行、和第几行重复', () => {
    const r = parseRoster('1 张三\n2 李四\n\n1 王五')
    expect(r.errors).toEqual(['第 4 行：学号 1 重复了（第 1 行也是 1 号）'])
    expect(r.seats.map((s) => s.name)).toEqual(['张三', '李四'])
    // 自动编号撞上后面写明的学号
    expect(parseRoster('张三\n1 李四').errors).toEqual(['第 2 行：学号 1 重复了（第 1 行也是 1 号）'])
  })

  it('学号超出 1–99（含自动编号编到 100）', () => {
    expect(parseRoster('0 张三\n100 李四\n99 王五').errors).toEqual(['第 1 行：学号要在 1–99 之间', '第 2 行：学号要在 1–99 之间'])
    expect(parseRoster('99 张三\n李四').errors).toEqual(['第 2 行：学号要在 1–99 之间'])
  })

  it('超过 80 人：从第 81 个人那一行起提示一次，只留前 80 人', () => {
    const r = parseRoster(Array.from({ length: 85 }, (_, i) => `同学${i + 1}`).join('\n'))
    expect(r.seats).toHaveLength(80)
    expect(r.errors).toEqual(['第 81 行：一个班最多 80 人，从这一行起多出来了'])
    expect(parseRoster(Array.from({ length: 80 }, (_, i) => String(i + 1)).join('\n')).errors).toEqual([])
  })

  it('姓名超过 20 个字（按字数算，和后端一样）', () => {
    expect(parseRoster(`1 ${'张'.repeat(20)}\n2 ${'李'.repeat(21)}`).errors).toEqual(['第 2 行：姓名最多 20 个字'])
    expect(parseRoster(`${'𠮷'.repeat(20)}`).errors).toEqual([]) // 扩展区的字也算一个字
  })

  it('数字后面直接跟姓名（没有分隔符）：提示要隔开，不悄悄当成姓名', () => {
    expect(parseRoster('3张三').errors).toEqual(['第 1 行：学号和姓名之间要用空格、逗号、顿号或 Tab 隔开'])
  })

  it('formatRoster：写回文本框，再读回来不变', () => {
    const seats = [
      { n: 1, name: '张三' },
      { n: 5, name: '' },
      { n: 12, name: '欧阳 小明' },
    ]
    expect(formatRoster(seats)).toBe('1 张三\n5\n12 欧阳 小明')
    expect(parseRoster(formatRoster(seats))).toEqual({ seats, errors: [] })
  })
})

describe('学号称呼', () => {
  it('老师端「07 张三」，没有姓名「07 号」', () => {
    expect(seatName(7, '张三')).toBe('07 张三')
    expect(seatName(7, '')).toBe('07 号')
    expect(seatName(12)).toBe('12 号')
  })

  it('找回码：去掉空白和「-」、转大写', () => {
    expect(cleanCode(' ab3-k7 m\t')).toBe('AB3K7M')
  })
})

describe('学生在本机记住的学号（zhishi:class:<班级 id>）', () => {
  const ok = { seat: 7, sid: 's-0123456789abcdef', token: 'a'.repeat(64), ai: true }
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('存了读得回来；只存学号、sid、token、AI 开关（找回码不存）；存 null 就忘掉', () => {
    const ls = memoryStorage()
    vi.stubGlobal('localStorage', ls)
    saveBinding('c-0123456789ab', { ...ok, recoveryCode: 'ABCDEF' } as typeof ok)
    expect(bindingKey('c-0123456789ab')).toBe('zhishi:class:c-0123456789ab')
    expect(JSON.parse(ls.m.get('zhishi:class:c-0123456789ab')!)).toEqual(ok)
    expect(readBinding('c-0123456789ab')).toEqual(ok)
    expect(readBinding('c-other0000000')).toBeNull() // 别的班没有
    saveBinding('c-0123456789ab', null)
    expect(ls.m.has('zhishi:class:c-0123456789ab')).toBe(false)
    expect(readBinding('c-0123456789ab')).toBeNull()
  })

  it('AI 开关：关着的存了读得回来；旧版本存的没有 ai（或不是布尔）先按开着算', () => {
    const ls = memoryStorage()
    vi.stubGlobal('localStorage', ls)
    saveBinding('c-x', { ...ok, ai: false })
    expect(JSON.parse(ls.m.get('zhishi:class:c-x')!)).toEqual({ ...ok, ai: false })
    expect(readBinding('c-x')).toEqual({ ...ok, ai: false })
    const { ai: _ai, ...old } = ok
    ls.m.set('zhishi:class:c-x', JSON.stringify(old))
    expect(readBinding('c-x')).toEqual({ ...ok, ai: true })
    expect(asBinding({ ...old, ai: 'false' })).toEqual({ ...ok, ai: true })
  })

  it('格式坏了当没有', () => {
    const ls = memoryStorage()
    vi.stubGlobal('localStorage', ls)
    const bad = ['not json', 'null', '7', '[]', JSON.stringify({ seat: 7, sid: 's-0123456789abcdef' })]
    for (const v of bad) {
      ls.m.set('zhishi:class:c-x', v)
      expect(readBinding('c-x')).toBeNull()
    }
    for (const x of [
      { ...ok, seat: 0 },
      { ...ok, seat: 100 },
      { ...ok, seat: 1.5 },
      { ...ok, seat: '7' },
      { ...ok, sid: 'stu-abc123' },
      { ...ok, sid: 's-0123456789ABCDEF' },
      { ...ok, token: 'a'.repeat(63) },
      { ...ok, token: 'g'.repeat(64) },
    ])
      expect(asBinding(x)).toBeNull()
    expect(asBinding({ ...ok, extra: 1 })).toEqual(ok)
  })

  it('本机存不了（隐私模式、被禁用）：读到 null，写不报错', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('denied')
      },
      setItem: () => {
        throw new Error('denied')
      },
      removeItem: () => {
        throw new Error('denied')
      },
    })
    expect(readBinding('c-x')).toBeNull()
    expect(() => saveBinding('c-x', ok)).not.toThrow()
  })
})

describe('restoreState：找回后用服务器上的事件重建这份讲义的状态', () => {
  const sid = 's-0123456789abcdef'
  let t = 0
  const ev = (who: string, e: Omit<LearningEvent, 'sid' | 'ts' | 'handoutId'>): LearningEvent => ({ sid: who, ts: ++t, handoutId: h.id, ...e })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('只用这个 sid 的事件，和老师端重放的一样；存进本机（讲义 + sid）；问卷、表达本恢复不了', () => {
    const ls = memoryStorage()
    vi.stubGlobal('localStorage', ls)
    const events = [
      ev(sid, { type: 'answer_question', sentenceId: 'S01', correct: false, firstTry: true }),
      ev(sid, { type: 'open_ladder', sentenceId: 'S01', level: 2 }),
      ev(sid, { type: 'tap_word', lemma: 'fret' }),
      ev('s-ffffffffffffffff', { type: 'tap_word', lemma: 'pending' }), // 别人的不算
    ]
    const s = restoreState(h, sid, events)
    expect(s).toEqual({ ...replay(h, events.slice(0, 3))[0], survey: undefined, collectedExpressions: [] })
    expect(s.ladder).toEqual({ S01: 2 })
    expect(s.tappedWords).toEqual(['fret'])
    expect(JSON.parse(ls.m.get(`zhishi:state:${h.id}:${sid}`)!)).toMatchObject({ sid, ladder: { S01: 2 }, tappedWords: ['fret'] })
  })

  it('没有事件：空状态；这台手机上本来就有的问卷和表达本留着', () => {
    const ls = memoryStorage()
    vi.stubGlobal('localStorage', ls)
    const survey = { level: 'mid', goal: 'exam' }
    ls.m.set(`zhishi:state:${h.id}:${sid}`, JSON.stringify({ ...emptyState(sid), survey, collectedExpressions: ['E1'], tappedWords: ['old'] }))
    expect(restoreState(h, sid, [])).toEqual({ ...emptyState(sid), survey, collectedExpressions: ['E1'] })
  })

  // 阶段 4：账号的收进、移出表达本有事件，换设备时表达本以服务器为准；学号的照旧只在本机（服务器丢掉这两类事件）
  it('账号（account）：表达本用重放出来的，不并进本机的；问卷照旧留着本机的', () => {
    const ls = memoryStorage()
    vi.stubGlobal('localStorage', ls)
    const acct = 'u-0123456789abcdef'
    const survey = { level: 'mid', goal: 'exam' }
    const [e1, e2] = h.expressions.map((x) => x.id)
    ls.m.set(`zhishi:state:${h.id}:${acct}`, JSON.stringify({ ...emptyState(acct), survey, collectedExpressions: [e2] })) // 别的设备上已经移出了
    const events = [
      ev(acct, { type: 'collect_expression', value: e1 }),
      ev(acct, { type: 'collect_expression', value: e2 }),
      ev(acct, { type: 'drop_expression', value: e2 }),
    ]
    expect(restoreState(h, acct, events, true)).toEqual({ ...emptyState(acct), survey, collectedExpressions: [e1] })
    expect(JSON.parse(ls.m.get(`zhishi:state:${h.id}:${acct}`)!).collectedExpressions).toEqual([e1])
    expect(restoreState(h, acct, [], true).collectedExpressions).toEqual([])
    // 不传 account（学号找回）：本机的表达本留着
    ls.m.set(`zhishi:state:${h.id}:${sid}`, JSON.stringify({ ...emptyState(sid), collectedExpressions: [e2] }))
    expect(restoreState(h, sid, []).collectedExpressions).toEqual([e2])
  })
})

// 11-07 起问卷不再是每篇的第一步（所有模式：账号、班级学号、匿名、示例）。本机的 stepKey 以前存数字下标，去掉问卷后同一个数字会落到后一步，
// 所以改成按名字存；旧的数字按旧的步骤（问卷、粗读、词汇、精读、写作、小结）换成名字，问卷换成粗读
describe('步骤：问卷拿掉了，按名字存，旧的数字迁移', () => {
  it('旧的数字下标落在同一步：原来的 3 是精读，迁移后还是精读；问卷（0）落到粗读', () => {
    const OLD = ['问卷', '粗读', '词汇', '精读', '写作', '小结']
    expect(['0', '1', '2', '3', '4', '5'].map((n) => STEPS[stepIndex(n)!])).toEqual(['粗读', '粗读', '词汇', '精读', '写作', '小结'])
    for (let n = 1; n < OLD.length; n++) expect(STEPS[stepIndex(String(n))!]).toBe(OLD[n])
    expect(stepIndex('3')).toBe(STEPS.indexOf('精读'))
  })

  it('新存的名字原样认；page_view 里旧的「问卷」也落到粗读；认不出的（没存、空、超出旧步骤、乱写的）是 null', () => {
    STEPS.forEach((name, i) => expect(stepIndex(name)).toBe(i))
    expect(stepIndex('问卷')).toBe(0)
    for (const v of [null, undefined, '', '6', '-1', '1.5', 'close', '精读 ']) expect(stepIndex(v), String(v)).toBeNull()
  })

  it('学生端不再有问卷这一步：不引 Survey，步骤条用 lib/store 的 STEPS；班级学号、匿名、示例都走这一套', () => {
    const student = readFileSync(fileURLToPath(new URL('../src/pages/student/Student.tsx', import.meta.url)), 'utf8')
    expect(student).not.toMatch(/import \{ Survey \}|<Survey\b|'survey'/)
    expect(student).toContain("import { STEPS, collectExpression, presetFromUrl, readLS, restoreState, stepIndex, stepKey, useStudent, writeLS } from '../../lib/store'")
    expect(student).toContain('<StepBar steps={STEPS} current={step} onPick={goStep} note={note} />')
    expect(student).not.toMatch(/const STEPS\b/) // 只有一套步骤
    expect(student).toContain("act({ type: 'page_view', value: STEPS[step] })")
  })
})

describe('send / myProgress：请求班级、进班接口', () => {
  const reply = (status: number, body: unknown) => ({ ok: status >= 200 && status < 300, status, json: async () => body })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('GET 不带 init（同源默认带 cookie）；POST 是 JSON', async () => {
    const fetchMock = vi.fn().mockResolvedValue(reply(200, { ok: true }))
    vi.stubGlobal('fetch', fetchMock)
    await send('/api/classes')
    expect(fetchMock.mock.calls[0]).toEqual(['/api/classes', undefined])
    await send('/api/join/c-0123456789ab', { h: 'up-x', seat: 7 })
    expect(fetchMock.mock.calls[1][1]).toEqual({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ h: 'up-x', seat: 7 }) })
  })

  it('出错：后端的中文提示原样带出来，带状态码和 fields；连不上服务器、不是 JSON 给自己的提示', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(reply(409, { error: '这个学号已经有人选了。如果是你换了手机，点「用找回码找回」', taken: true })))
    const e = await send('/api/join/c-x', { h: 'up-x', seat: 7 }).catch((x: unknown) => x)
    expect(e).toBeInstanceOf(ApiError)
    expect(e).toMatchObject({ status: 409, message: '这个学号已经有人选了。如果是你换了手机，点「用找回码找回」', fields: {} })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(reply(400, { error: '有 1 处要改，见标红的地方', fields: { roster: '学号 3 重复了', x: 1 } })))
    await expect(send('/api/classes', {})).rejects.toMatchObject({ status: 400, fields: { roster: '学号 3 重复了' } })
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')))
    await expect(send('/api/classes')).rejects.toMatchObject({ status: 0, message: '连不上服务器，请检查网络' })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 502, json: async () => Promise.reject(new Error('not json')) }))
    await expect(send('/api/classes')).rejects.toMatchObject({ status: 502, message: '请求失败（502）' })
  })

  it('myProgress：带 X-Student-Token，参数编码；格式不对的事件跳过；带回 AI 开关（没给按开着）；401 抛出', async () => {
    const good: LearningEvent = { sid: 's-0123456789abcdef', ts: 1, handoutId: 'up-abc', type: 'tap_word', lemma: 'fret' }
    const fetchMock = vi.fn().mockResolvedValue(reply(200, { events: [good, { nope: 1 }], ai: true }))
    vi.stubGlobal('fetch', fetchMock)
    expect(await myProgress('up-abc', 'c-0123456789ab', 'f'.repeat(64))).toEqual({ events: [good], ai: true })
    expect(fetchMock.mock.calls[0]).toEqual(['/api/my-progress?h=up-abc&c=c-0123456789ab', { headers: { 'X-Student-Token': 'f'.repeat(64) } }])
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(reply(200, { events: [], ai: false })))
    expect(await myProgress('up-abc', 'c-0123456789ab', 'f'.repeat(64))).toEqual({ events: [], ai: false })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(reply(200, { events: [good] })))
    expect(await myProgress('up-abc', 'c-0123456789ab', 'f'.repeat(64))).toEqual({ events: [good], ai: true })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(reply(401, { error: '找不到你的学号记录，请重新扫码' })))
    await expect(myProgress('up-abc', 'c-0123456789ab', 'f'.repeat(64))).rejects.toMatchObject({ status: 401, message: '找不到你的学号记录，请重新扫码' })
  })
})

describe('教学建议的汇总里没有学生编号（学号、姓名本来就不进汇总）', () => {
  it('classSummary 的结果里找不到 sid', () => {
    const sids = ['s-0123456789abcdef', 's-fedcba9876543210']
    let t = 0
    const events: LearningEvent[] = sids.flatMap((sid) => [
      { sid, ts: ++t, handoutId: h.id, type: 'answer_question', sentenceId: 'S01', correct: false, firstTry: true },
      { sid, ts: ++t, handoutId: h.id, type: 'open_ladder', sentenceId: 'S01', level: 3 },
    ])
    const text = JSON.stringify(classSummary(h, replay(h, events), events))
    expect(text).toContain('"students":2')
    for (const sid of sids) expect(text).not.toContain(sid)
  })
})

// 没有 DOM 测试环境，页面条件和文案直接查源码
describe('页面：班级和学号', () => {
  const read = (f: string) => readFileSync(fileURLToPath(new URL(`../src/${f}`, import.meta.url)), 'utf8')
  const student = read('pages/student/Student.tsx')
  const join_ = read('pages/student/JoinClass.tsx')
  const classes = read('pages/Classes.tsx')
  const upload = read('pages/Upload.tsx')
  const teacher = read('pages/Teacher.tsx')
  const store = read('lib/store.ts')

  it('学生端「重置演示」按钮删掉了；演示画像重新打开链接就是重新开始（连上次的写作草稿也清掉）', () => {
    expect(student).not.toMatch(/重置演示|reset\(|epoch/)
    expect(student).not.toContain('清空你在这份讲义里的全部作答')
    expect(student).toContain('重新打开链接就是重新开始') // 演示画像照旧能用
    expect(student).toContain('if (preset) writeLS(writingKey(h.id, state.sid), null)') // 演示画像的 sid 固定，草稿会留到下一次
  })

  it('学生端：上传的讲义要从班级二维码进来；没有班级参数时说明并可以「只是看看」；本机记着学号就直接进；内置讲义、演示画像照旧匿名', () => {
    expect(student).toContain("const gated = h.id.startsWith('up-') && !preset")
    expect(student).toContain("getParams().get('c')")
    expect(student).toContain('readBinding(classId)')
    expect(student).toContain('这份讲义要从老师发给你们班的二维码进入，作答才能记到你的学号上。')
    expect(student).toContain('只是看看（不记学号）')
    expect(student).toContain('if (!gated || look) return <Learn preset={preset} preview={preview} />')
    expect(student).toContain('if (seat) return <Learn key={seat.sid} seat={seat} />')
    expect(student).toContain("useStudent(h, 'student', preset, seat?.sid ?? me?.sid, !!seat || !!me)") // 只有选了学号、登录了账号的才上传
    expect(student).toContain('{pad(seat.seat)} 号') // 顶栏显示「07 号」
    // 老师清空了学号：后端 401，忘掉本机的学号，回到选学号页
    expect(student).toMatch(/if \(e\.status !== 401\) return\s+saveBinding\(classId, null\)/)
    // 班级删了、讲义不再发给这个班：后端 404，回到选学号页（提示重新扫码），本机的学号先留着
    expect(student).toMatch(/if \(e\.status === 404\) return setSeat\(null\)\s+if \(e\.status !== 401\) return/)
  })

  it('useStudent 能用学号的 sid，本机状态照旧按「讲义 + sid」存，学号的 sid 不顶替匿名 sid', () => {
    expect(store).toContain('loadState(h.id, sid || readLS(sidKey(role)) || newSid(role))')
    expect(store).toContain('if (!preset && !sid) writeLS(sidKey(role), state.sid)')
  })

  it('选学号页：只有学号和「已有人」，隐私说明、确认、找回码页、找回入口；后端的提示原样显示', () => {
    expect(join_).toContain('选好学号后，你的作答会记在这个学号上，只有你的老师能看到。')
    expect(join_).toContain('你是 ${pad(n)} 号？选好就不能自己改，选错了请找老师。')
    expect(join_).toContain('换了手机？用找回码找回')
    expect(join_).toContain('请截图或抄下来，换手机时要用')
    expect(join_).toContain('我记下来了')
    expect(join_).toContain('disabled={busy || s.taken}') // 已有人的点不了
    expect(join_).toContain('type Info = { className: string; seats: { n: number; taken: boolean }[] }') // 没有姓名
    expect(join_.replace(/\/\/.*$/gm, '')).not.toContain('姓名') // 注释以外（页面上）不出现姓名
    expect(join_).toContain('cleanCode(form.code)')
    expect(join_).toContain('restoreState(h, b.sid, events)') // 找回后用 replay 重建状态
    // 选学号、找回的响应带 AI 开关，存进本机（没给按开着）
    expect(join_.match(/const b = \{ seat: r\.seat, sid: r\.sid, token: r\.token, ai: r\.ai !== false \}/g)).toHaveLength(2)
    expect(join_).toContain('setError((e as Error).message)') // 409、404、429 等后端提示原样显示
    // 提示条在学号格子上面，出错时滚过去：手机上点的是下面几排学号，提示条不能在屏幕外
    expect(join_.indexOf('ref={errorRef} role="alert"')).toBeGreaterThan(-1)
    expect(join_.indexOf('ref={errorRef} role="alert"')).toBeLessThan(join_.indexOf('grid-cols-5'))
    expect(join_).toContain("if (error) errorRef.current?.scrollIntoView({ block: 'center' })")
  })

  it('不写「不收姓名」（老师的名单里有姓名）', () => {
    const root = fileURLToPath(new URL('../src', import.meta.url))
    const files = (dir: string): string[] => readdirSync(dir).flatMap((f) => (statSync(join(dir, f)).isDirectory() ? files(join(dir, f)) : [join(dir, f)]))
    for (const f of files(root)) expect(readFileSync(f, 'utf8')).not.toContain('不收姓名')
  })

  it('路由和顶栏：#/classes 是班级页；登录后老师侧页面多一个「班级」', () => {
    expect(read('App.tsx')).toContain("path === '/classes' ? <ClassesPage />")
    expect(read('lib/router.ts')).toContain('#/classes')
    expect(read('components/Account.tsx')).toContain('href="#/classes"')
    expect(classes).toContain('<Account />')
  })

  it('班级页：要登录；导入名单前预览、写明姓名存在哪；重置找回码、清空学号、改名单、改班名、删除都先确认', () => {
    expect(classes).toContain('if (teacher) return <Classes key={teacher.id} />')
    expect(classes).toContain("loginHref('#/classes')")
    expect(classes).toContain('姓名保存在服务器上你的账号下，只有你登录后能看到；学生端只显示学号。删除班级会一起删掉名单。')
    expect(classes).toContain('parseRoster(text)')
    expect(classes).toContain('预览：共 {seats.length} 人')
    expect(classes).toContain('formatRoster(c.seats)') // 改名单时预填
    expect(classes).toContain('删掉的学号会连学生的进班记录一起删')
    for (const x of ['新找回码', '清空学号', '改名单', '改班名', '删除班级']) expect(classes).toContain(x)
    expect(classes.match(/window\.confirm\(/g)).toHaveLength(4) // 重置找回码、清空学号、删掉已进班的学号、删班
    // 清空学号、删掉已进班的学号、删班都会删学习记录：确认框写明，成功后说删了几条
    expect(classes).toContain('的学号？会同时删除这个学号在所有讲义里的学习记录，学生要重新选学号。删除后不能恢复。')
    expect(classes).toContain('」？会删除这个班的名单、进班记录和全部学习记录。删除后不能恢复。')
    expect(classes).toContain('这些学号在所有讲义里的学习记录也会一起删除')
    expect(classes).not.toContain('之前的作答不再算在这个学号名下') // 旧说法：作答留着，只是不算在学号名下
    expect(classes).toContain('删除了 ${r.deletedEvents ?? 0} 条学习记录')
    expect(classes.match(/deletedMsg\('/g)).toHaveLength(2) // 清空、改名单（删班的开头带班名）
    expect(classes).toContain("setRowMsg({ [s.n]: deletedMsg('已清空学号，', r) })")
    expect(classes).toContain("setDone(deletedMsg('名单已保存，删掉的学号一共', r))")
    expect(classes).toContain('send<Deleted>(`${base}/delete`, {}).then((r) => onDeleted(deletedMsg(`已删除「${c.name}」，一起`, r))')
    // 后端没删完（incomplete）：换成琥珀色提示，写明服务器会自动再删，不当作删完了
    expect(classes).toContain('type Deleted = { deletedEvents?: number; incomplete?: boolean }')
    expect(classes).toMatch(/r\.incomplete\s+\? \{ text: `\$\{head\}删除了 \$\{r\.deletedEvents \?\? 0\} 条学习记录；还有一部分这次没删成功，服务器会自动再删。`, tone: 'warn' \}/)
    expect(classes).toContain('if (gone.length || r.deletedEvents || r.incomplete)')
    expect(classes).toContain('joined: false, ai: x.ai') // 清空学号不动 AI 开关
    expect(classes).toContain("'/api/classes', { name: name.trim(), roster: seats, confirm: checks }")
    expect(classes).toContain('`${base}/seats/${s.n}/reset-code`')
    expect(classes).toContain('`${base}/seats/${s.n}/clear`')
    expect(classes).toContain('`${base}/delete`')
  })

  it('班级页：按学号开关 AI 写作检查，还没进班的也能关；改完马上保存，失败提示并切回原状态', () => {
    expect(classes).toContain('家长回执第 2 项（AI 写作检查）选了不同意的学号，在这里关掉。')
    expect(classes).toContain('ai: boolean')
    expect(classes).toContain('role="switch"')
    expect(classes).toContain('aria-checked={s.ai}')
    expect(classes).toContain("AI 写作检查：{s.ai ? '开' : '关'}")
    expect(classes).toContain("send(`${base}/seats/${s.n}/ai`, { enabled: !s.ai })")
    expect(classes).toMatch(/set\(!s\.ai\)\s+void run\(async \(\) => \{\s+await send\(`\$\{base\}\/seats\/\$\{s\.n\}\/ai`, \{ enabled: !s\.ai \}\)\.catch\(\(e: unknown\) => \{\s+set\(s\.ai\)\s+throw e\s+\}\)\s+\}, s\.n\)/)
    // 开关不在「已进班」才有的按钮组里
    const row = classes.slice(classes.indexOf('{s.joined && ('))
    expect(row.indexOf('role="switch"')).toBeGreaterThan(row.indexOf('清空学号'))
    expect(row.slice(0, row.indexOf('role="switch"'))).toMatch(/<\/span>\s+\)\}\s+\{\/\*/)
  })

  it('班级页：学号那一行上的操作（新找回码、清空学号、AI 开关），结果和出错提示显示在那一行（名单长，名单上方的提示看不到）', () => {
    expect(classes).toContain('const run = async (fn: () => Promise<void>, n?: number) => {')
    expect(classes).toMatch(/if \(n === undefined\) setError\(problem\(err\)\)\s+else setRowMsg\(\{ \[n\]: \{ text: problem\(err\), tone: 'error' \} \}\)/)
    expect(classes.match(/\}, s\.n\)/g)).toHaveLength(3) // 新找回码、清空学号、AI 开关
    // 提示在这个学号的 <li> 里，新找回码后面
    const li = classes.slice(classes.indexOf('<li key={s.n}'), classes.indexOf('</li>', classes.indexOf('<li key={s.n}')))
    expect(li.indexOf('<Note msg={rowMsg[s.n]} row />')).toBeGreaterThan(li.indexOf('{codes[s.n] && ('))
    expect(classes).toContain("role={msg.tone === 'ok' ? undefined : 'alert'}")
  })

  it('没选学号不上传：学习事件、page_view 只更新本机；页面报错照常发', () => {
    expect(store).toContain('upload = false')
    expect(store).toContain('if (upload) void sendEvent(full)')
    expect(store).not.toContain('if (!preset) void sendEvent')
    expect(store.match(/sendEvent\(/g)).toHaveLength(1)
    expect(student).not.toContain('sendEvent')
    // Learn 只在选了学号时拿到 seat：内置讲义、「只是看看」、老师预览、演示画像都走 <Learn preset={preset} preview={preview} />
    expect(student).toContain('if (!gated || look) return <Learn preset={preset} preview={preview} />')
    expect(student).toContain('local={!seat && !me}')
    // 老师在电脑上预览也对；示例文章（首页谁都能进）不提老师
    expect(read('pages/student/Summary.tsx')).toContain(`{local && <span className="pt-1 text-[13px] text-muted">{onRestart ? '这次的作答只存在这台设备上。' : '这次的作答只存在本机，不会发给老师。'}</span>}`)
    expect(read('pages/Judge.tsx')).toContain("useStudent(h, 'judge')") // 评委页不传 upload，不回流
    expect(read('main.tsx')).toContain("sendEvent({ sid: diagSid(), ts: Date.now(), handoutId: currentHandout.id, type: 'client_error', value })")
  })

  // 阶段 4：收进、移出表达本只在账号模式发事件；班级学号（按家长同意书收的）和没登录照旧只改本机，句卡上也照旧没有「移出」
  it('表达本：账号模式发 collect_expression、drop_expression；班级学号和没登录只用 patch 改本机，不发，也没有「移出」', () => {
    expect(student).toContain("const collect = (id: string) => (me ? act({ type: 'collect_expression', value: id }) : patch(collectExpression(id)))")
    expect(student).toContain("const drop = (id: string) => act({ type: 'drop_expression', value: id })")
    expect(student.match(/'collect_expression'/g)).toHaveLength(1)
    expect(student.match(/'drop_expression'/g)).toHaveLength(1)
    expect(student).toContain('<CloseReading h={h} view={view} state={state} act={act} onCollect={collect} onDrop={me ? drop : undefined} />')
    expect(student.match(/onDrop=/g)).toHaveLength(1)
    // 学号模式下 Learn 只拿到 seat，没有 me：收进走 patch，没有「移出」
    expect(student).toContain('if (seat) return <Learn key={seat.sid} seat={seat} />')
    for (const x of ['collect_expression', 'drop_expression', 'review_word', 'drop_word']) {
      expect(join_).not.toContain(x)
      expect(store).not.toContain(`'${x}'`)
    }
    // 只在本机改的：只有收进
    expect(store).toContain('export const collectExpression = (id: string) => (s: StudentState): StudentState =>')
    expect(store).not.toContain('dropExpression')
    // 精读页顶栏的表达本弹层：只有账号模式有「全部表达」，整页打开 #/expressions（不带上 ?h=）
    expect(student).toMatch(/\{me && \(\s+<a href="\/#\/expressions"[^>]*>\s+全部表达\s+<\/a>\s+\)\}/)
  })

  it('学生端：后台确认（my-progress）回来时更新本机的 AI 开关', () => {
    expect(student).toMatch(/\(\{ ai \}\) => \{\s+if \(ai === saved\.ai\) return\s+saveBinding\(classId, \{ \.\.\.saved, ai \}\)\s+setSeat\(\(s\) => \(s\?\.sid === saved\.sid \? \{ \.\.\.s, ai \} : s\)\)/)
    expect(student).toContain('noAi={noAiNote(seat, me, example)}')
  })

  // 11-07 起有学生账号：gated 的讲义分三层，链接带 c 走学号（登录了也一样），否则用账号，都没有就是说明页
  it('学生端三层：链接带 c 就走学号（就算登录了账号）；没有 c 才看账号；账号也没有就是说明页（可以登录、只是看看）', () => {
    const gate = student.slice(student.indexOf('export default function StudentPage'), student.indexOf('function ByLogin('))
    expect(gate).toMatch(/if \(seat\) return <Learn key=\{seat\.sid\} seat=\{seat\} \/>\s+if \(!classId\) return <ByLogin onLook=\{\(\) => setLook\(true\)\} \/>\s+return <JoinClass /)
    expect(gate).not.toContain('useStudentMe') // 有班级参数时不看账号
    const byLogin = student.slice(student.indexOf('function ByLogin('), student.indexOf('async function sync('))
    expect(byLogin).toContain('const { loading, student } = useStudentMe()')
    expect(byLogin).toContain('if (student) return <Synced key={student.sid} me={student} />')
    expect(byLogin).toContain('有知适账号的同学，登录后作答记在账号上。')
    expect(byLogin).toContain('loginHref(`${window.location.pathname}${window.location.search}${window.location.hash}`)') // 登录后回到这一篇
    expect(byLogin).toContain('onClick={onLook}')
    // 顶栏：学号显示「07 号」，账号显示用户名（学生自己的顶栏组件）
    expect(student).toContain('{me && <StudentBar />}')
  })

  it('账号模式打开一篇：先把队列发完再拉 /api/student/events 重建状态；发不完、连不上就用本机缓存并说明；401 刷新登录状态', () => {
    const sync = student.slice(student.indexOf('async function sync('), student.indexOf('function Synced('))
    expect(sync).toMatch(/if \(!\(await drain\(sid\)\)\) return false\s+const events = await fetchMyEvents\(h\.id\)/)
    expect(sync).toContain('if (e.status === 401) void getStudent(true)')
    expect(sync).toContain('restoreState(h, sid, events, true)') // 账号：表达本以服务器为准
    expect(join_).not.toContain('restoreState(h, b.sid, events, true)') // 学号找回：本机的表达本留着
    // 换了设备（本机没记着步骤）：用最后一次 page_view 的步骤（旧事件记的「问卷」落到粗读，见 stepIndex），按名字存
    expect(sync).toContain('const n = stepIndex(last?.value)')
    expect(sync).toContain('if (readLS(stepKey(h.id, sid)) === null && n !== null) writeLS(stepKey(h.id, sid), STEPS[n])')
    // 画像（问卷答案和单词本里的词，阶段 7）等 sync 把排着的作答发完再拉（服务器从事件现算单词本，并行拉会漏掉还没发出去的「不认识」），
    // 拉不到、开关关着都不传（不挡住读文章）；交给 Learn，进词汇那一步时按画像定下词卡
    expect(student).toContain('void sync(me.sid).then(async (ok) => [ok, await getLearner().catch(() => undefined)] as const).then(([ok, p]) => {')
    expect(student).not.toContain('Promise.all([sync(me.sid), getLearner()')
    expect(student).toContain('return <Learn me={me} offline={!synced} profile={profile} />')
    expect(student).toContain('{step === 1 && <Words h={h} state={state} act={act} profile={profile} onNext={() => goStep(2)} />}')
    expect(student).toContain('const view = useMemo(() => personalize(h, state, profile), [state, profile])')
    // 学号、只是看看、示例、演示画像都不传画像：和以前一样
    expect(student).toContain("if (!gated || look) return <Learn preset={preset} preview={preview} />")
    expect(student).toContain('if (seat) return <Learn key={seat.sid} seat={seat} />')
    expect(student).toContain('正在同步你的作答……')
    expect(student).toContain('{offline && <span className="text-[12px] text-muted">这次没连上服务器，先用这台设备上的记录；新的作答连上以后会记到账号上。</span>}')
  })

  it('学生端读链接里的 step、jump：jump 是这一篇的句子 id 就到精读并滚过去，否则看 step；都没有用本机记的步骤', () => {
    expect(student).toContain("const STEP_IDS = ['skim', 'words', 'close', 'writing', 'summary']")
    expect(STEPS).toEqual(['粗读', '词汇', '精读', '写作', '小结']) // 和 STEP_IDS 一一对应
    expect(student).toContain('const CLOSE = 2')
    expect(student).toContain("if (jump && h.sentences.some((x) => x.id === jump)) return { step: CLOSE, jump }")
    expect(student).toContain("const n = STEP_IDS.indexOf(p.get('step') ?? '')")
    expect(student).toContain('const initialStep = () => (preset ? CLOSE : link.step ?? stepIndex(readLS(stepKey(h.id, state.sid))) ?? 0)')
    expect(student).toContain('writeLS(stepKey(h.id, state.sid), STEPS[step])') // 按名字存
    expect(student).toContain('const [jump, setJump] = useState<string | null>(link.jump ?? null)')
  })

  it('示例文章（内置讲义）的小结页：从头再读一遍，先确认，清掉这一篇的作答和写作草稿，回到第一步；账号学生的小结换成账号的说法', () => {
    expect(student).toContain("const example = !preset && !h.id.startsWith('up-')")
    expect(student).toContain('onRestart={example ? restart : undefined}')
    const at = student.indexOf('const restart = () => {')
    const restart = student.slice(at, student.indexOf('\n  return (', at))
    expect(restart).toMatch(/if \(!window\.confirm\([^)]*\)\) return\s+writeLS\(writingKey\(h\.id, state\.sid\), null\)\s+patch\(\(s\) => emptyState\(s\.sid\)\)\s+goStep\(0\)/)
    const summary = read('pages/student/Summary.tsx')
    expect(summary).toMatch(/\{onRestart && r\.started && \(\s+<button [^>]*onClick=\{onRestart\}>\s+从头再读一遍\s+<\/button>/)
    expect(summary).toContain('{account && <span className="pt-1 text-[13px] text-muted">这一篇的作答记在你的账号上，换一台设备登录也能接着读。</span>}')
    expect(student).toContain('account={!!me}')
  })

  it('上传页：发布先选班（没有班时链到班级页），每个班一张二维码、学生链接、这个班的老师端；列表显示发布到哪些班，可以改', () => {
    expect(upload).toContain('先去建一个班')
    expect(upload).toContain('href={`${window.location.origin}/#/classes`} target="_blank"') // 新标签页建班：写完整地址，不触发「确定离开吗」
    expect(upload).toContain('{ classes: picked }')
    expect(upload).toContain('disabled={busy || !picker.picked.some((c) => className(c))}') // 至少勾一个
    expect(upload).toContain("linkOf(id, 'student', c)")
    expect(upload).toContain("linkOf(published.id, 'teacher', x.id)")
    expect(upload).toContain('改发布的班级')
    expect(upload).toContain('发布到：')
    expect(upload).toContain('pick(x.id, x.classes ?? [], true)') // 已发布的预先勾上
    // 班级还没读到或读取失败时「二维码」点不了（班级名对不上会误报「还没有发布到班级」），列表上方显示读取失败和重试
    expect(upload).toContain('disabled={!classes} onClick={() => void showQr(x.id, x.classes ?? [])}')
    expect(upload).toContain('{classesError && !picker && (')
    // 「还没有发布到班级」里的「改发布的班级」预先勾上这份讲义现在发布的班，不从空白开始
    expect(upload).not.toContain('pick(published.id, [], true)')
    expect(upload).toContain('pick(published.id, mine?.find((x) => x.id === published.id)?.classes ?? [], true)')
    // 刚生成的讲义：发布了没有看「我上传过的」，不只看当前显示的二维码；发布过的是「改发布的班级」，预先勾上
    expect(upload).toContain('const doneClasses = doneMine?.published ? doneMine.classes ?? [] :')
    expect(upload).toContain('pick(done.handoutId, doneClasses ?? [], !!doneClasses)')
    expect(upload).toContain("{doneClasses ? '改发布的班级' : '发给班级'}")
  })

  // 10-16 老师端极简：三步走、页内建班、只有一个班默认勾上、投屏二维码、预览直接「只是看看」
  it('上传页三步：页内建班用班级页同一个表单（出错不刷新登录状态，建好提醒去关 AI 写作检查），一个班时默认勾上', () => {
    const classes = read('pages/Classes.tsx')
    expect(classes).toContain('export function NewClass({ onCreated, onCancel, onProblem = problem, compact = false }')
    expect(classes).toContain('setError(onProblem(err))')
    expect(upload).toContain("import { NewClass } from './Classes'")
    expect(upload).toContain('onProblem={classProblem}')
    expect(upload).toContain("((e as ApiError).status === 401 ? `${EXPIRED}") // 401 不调 getMe(true)
    // 第 2、3 步同一个位置：AI 做完换到第 3 步、生成失败退回第 1 步时，填了一半的名单都不丢
    expect(upload).toContain('{flow && (step > 1 || !!newClass) && (noClasses || newClass) && (')
    expect(upload).toContain('/#/classes?id=${encodeURIComponent(newClass.id)}')
    expect(upload).toContain('AI 写作检查：关')
    expect(upload).toContain('if (only) setPicker((p) => (p && !p.again && !p.touched && !p.picked.length ? { ...p, picked: [only] } : p))')
    expect(upload).toContain('touched: true') // 老师自己动过勾，就不再替他勾
    // 同一篇的选班框开着就留着原来的勾，点完滚过去；生成完成时不抢老师正在用的选班框
    expect(upload).toContain('setPicker((p) => (p?.id === id && p.again === again ? p : { id, picked: current, again }))')
    expect(upload).not.toContain('pickingId !== doneId')
    expect(upload).toContain('setPicker((p) => p ?? { id: r.handoutId, picked: [], again: false })')
    // 列表读到过一次以后再读失败，不切成上传框；回到列表时没保存的建班表单先问一句
    expect(upload).toContain('(!!mineError && !mine)')
    expect(upload).toContain("window.confirm('新建班级还没保存，确定不要了吗？')")
    // 「⋯ → 老师端」在新标签页开：本页打开时只改哈希，会绕过未保存讲解、改题的拦截
    expect(upload).toContain(`<a href={linkOf(x.id, 'teacher')} target="_blank" rel="noreferrer"`)
  })

  it('投屏二维码：学生扫码后要做的事，没在名单上的点「只是看看」、记下找回码', () => {
    expect(upload).toContain('function QrScreen(')
    for (const x of ['扫码，勾选说明，点自己的学号', '记下屏幕上的找回码', '不在名单上的同学，点「只是看看」']) expect(upload).toContain(x)
    expect(upload).toContain("e.key === 'Escape' && onClose()")
  })

  it('老师预览 look=1：链接里有班级时不认（预览链接被转给学生也不会全班匿名做），预览时一直写着不进老师端', () => {
    expect(student).toContain("getParams().get('look') === '1' && !classId")
    expect(student).toContain('预览：作答只存在本机，不进老师端。学生请扫班级二维码进入。')
  })

  // 11-07 起只做学生端：首页不再有老师入口卡片、示例班级和老师指南链接，只在页脚留一个小字「老师登录」；老师的路由都还在
  it('首页：没有老师入口卡片、示例班级、老师指南；页脚小字「老师登录」去 #/upload；写明小范围内测', () => {
    const home = read('pages/Home.tsx')
    for (const x of ['我是老师', '#/teacher', '#/guide', '#/classes', '扫老师发给']) expect(home).not.toContain(x)
    expect(home.match(/href="#\/upload"/g)).toHaveLength(1)
    expect(home).toMatch(/<a href="#\/upload" [^>]*>\s+老师登录\s+<\/a>/)
    expect(home).toContain('知适正在小范围内测，只能用邀请码注册。')
    expect(home).not.toContain('暂不开放注册') // 1a 起有邀请码注册，和下面「在那里注册」不能打架
  })

  it('首页：没登录有「登录」和示例文章入口；登录后列出团队选的文章，整页打开 /?h=<id>#/student；示例链接不带地址里的 ?h=', () => {
    const home = read('pages/Home.tsx')
    expect(home).toContain('<SiteHeader actions={<StudentBar />} />')
    expect(home).toContain('{!loading && !student && (')
    expect(home).toMatch(/<a href="#\/me" [^>]*>\s+登录\s+<\/a>/)
    expect(home).toContain("const EXAMPLE = '/#/student'")
    expect(home).toMatch(/<a href=\{EXAMPLE\} [^>]*>\s+先读一篇示例文章\s+<\/a>/)
    expect(home).toContain('{student && <Shelf />}')
    expect(home).toContain('团队选的文章')
    expect(home).toContain('fetchShelf().then(setItems')
    expect(home).toContain('href={`/?h=${encodeURIComponent(x.id)}#/student`}')
    expect(home).toContain('if (e.status === 401) void getStudent(true)') // 会话过期：顶栏换回「登录」
  })

  it('首页不讲老师讲义和全班：没有「讲义」「全班」「老师」这类说法（页脚的「老师登录」除外）', () => {
    const home = read('pages/Home.tsx')
      .replace(/\/\/.*$/gm, '')
      .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
      .replace('老师登录', '')
    for (const x of ['讲义', '全班', '老师', '班级']) expect(home).not.toContain(x)
  })

  it('老师的路由都还在（老师端不再开发，但已有的老师和班级二维码照常能用）', () => {
    const app = read('App.tsx')
    for (const p of ["'/upload'", "'/teacher'", "'/classes'", "'/login'", "'/guide'"]) expect(app).toContain(p)
  })

  it('老师端：按班看（c 参数优先），事件带 classId，按名单叫「07 张三」，显示还没进班的；没发布到班时提示去发布；教学建议照旧只发汇总', () => {
    expect(teacher).toContain("getParams().get('c')")
    expect(teacher).toContain('&classId=${encodeURIComponent(classId)}')
    expect(teacher).toContain('`/api/classes/${encodeURIComponent(classId)}`')
    expect(teacher).toContain('seatName(s.n, s.name)')
    expect(teacher).toContain('还没进班：{waiting.length} 人')
    // 自动刷新：名单变了也更新（学生刚选好学号、还没动手时没有学习事件）
    expect(teacher).toContain('JSON.stringify(next.seats) === JSON.stringify(prev.seats)) return')
    expect(teacher).toContain('这份讲义还没有发布到班级')
    expect(teacher).toContain("fetchAdvice({ handoutId: h.id, mode: data.mode === 'live' ? 'live' : 'demo', device: deviceId(), summary })")
    expect(teacher).toContain('同学 ${String(i + 1).padStart(2, \'0\')}') // 示例班级照旧「同学 07」
  })
})
