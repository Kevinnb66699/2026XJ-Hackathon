// 老师账号的前端（src/lib/auth.ts）：问后端现在是谁、登录、注册、退出用假 fetch 测；登录后去哪（next）只认站内的 #/ 地址
import { afterEach, describe, expect, it, vi } from 'vitest'
import { loginHref, safeNext } from '../src/lib/auth'

const wang = { id: 't-abc123def456', username: 'wang', name: '王老师' }
const reply = (status: number, body: unknown) => ({ ok: status >= 200 && status < 300, status, json: async () => body })
// 每个测试拿一份新的模块：「现在是谁」缓存在模块里
const fresh = async () => {
  vi.resetModules()
  return import('../src/lib/auth')
}

describe('getMe：现在登录的老师，缓存在模块里', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('GET /api/auth/me；第二次用缓存，refresh 才重新问', async () => {
    const fetchMock = vi.fn().mockResolvedValue(reply(200, { teacher: wang }))
    vi.stubGlobal('fetch', fetchMock)
    const auth = await fresh()
    expect(await auth.getMe()).toEqual(wang)
    expect(fetchMock.mock.calls[0][0]).toBe('/api/auth/me')
    expect(fetchMock.mock.calls[0][1]).toBeUndefined() // 默认同源带 cookie，不设 credentials
    expect(await auth.getMe()).toEqual(wang)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    fetchMock.mockResolvedValue(reply(200, { teacher: null }))
    expect(await auth.getMe(true)).toBeNull()
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('同时问两次只发一个请求', async () => {
    const fetchMock = vi.fn().mockResolvedValue(reply(200, { teacher: wang }))
    vi.stubGlobal('fetch', fetchMock)
    const auth = await fresh()
    expect(await Promise.all([auth.getMe(), auth.getMe()])).toEqual([wang, wang])
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('连不上、服务器出错、返回的格式不对：这次当没登录，不缓存，下次再问', async () => {
    const fetchMock = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(reply(500, {})).mockResolvedValueOnce(reply(200, { teacher: { id: 1 } })).mockResolvedValue(reply(200, { teacher: wang }))
    vi.stubGlobal('fetch', fetchMock)
    const auth = await fresh()
    expect(await auth.getMe()).toBeNull()
    expect(await auth.getMe()).toBeNull()
    expect(await auth.getMe()).toBeNull() // 格式不对的当没登录（这个会缓存，要 refresh）
    expect(await auth.getMe(true)).toEqual(wang)
    expect(fetchMock).toHaveBeenCalledTimes(4)
  })
})

describe('login / register / logout', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('登录成功：POST JSON，返回老师，之后 getMe 直接用，不再请求', async () => {
    const fetchMock = vi.fn().mockResolvedValue(reply(200, { teacher: wang }))
    vi.stubGlobal('fetch', fetchMock)
    const auth = await fresh()
    expect(await auth.login('wang', 'secret-123')).toEqual(wang)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('/api/auth/login')
    expect(init.method).toBe('POST')
    expect(init.headers).toEqual({ 'Content-Type': 'application/json' }) // 后端只收 JSON，别的格式回 415
    expect(JSON.parse(init.body)).toEqual({ username: 'wang', password: 'secret-123' })
    expect(init.credentials).toBeUndefined()
    expect(await auth.getMe()).toEqual(wang)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('登录失败（401）：抛出后端的中文提示，带状态码；连不上服务器给自己的提示', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(reply(401, { error: '用户名或密码不对' })))
    const auth = await fresh()
    const err = await auth.login('wang', 'wrong-pass').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(auth.AuthError)
    expect(err).toMatchObject({ message: '用户名或密码不对', status: 401, fields: {} })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(reply(429, { error: '试错太多次了，请 15 分钟后再试' })))
    await expect(auth.login('wang', 'x')).rejects.toThrow('试错太多次了，请 15 分钟后再试')
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')))
    await expect(auth.login('wang', 'x')).rejects.toThrow('连不上服务器，请检查网络')
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 502, json: async () => Promise.reject(new Error('not json')) }))
    await expect(auth.login('wang', 'x')).rejects.toThrow('请求失败（502）')
  })

  it('注册 400：带 fields（按输入框标红），不是字符串的提示丢掉', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(reply(400, { error: '有几处要改', fields: { username: '用户名只能用字母、数字和 _ . -', password: '密码至少 8 个字符', name: 3 } })))
    const auth = await fresh()
    const err = await auth.register({ invite: 'invite-code-1', username: 'a b', password: 'short' }).catch((e: unknown) => e)
    expect(err).toMatchObject({ message: '有几处要改', status: 400, fields: { username: '用户名只能用字母、数字和 _ . -', password: '密码至少 8 个字符' } })
    expect((err as InstanceType<typeof auth.AuthError>).fields).not.toHaveProperty('name')
  })

  it('注册 409：用户名被占用带 fields；邀请码已用过的没有 fields', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(reply(409, { error: '这个用户名已经有人用了', fields: { username: '换一个用户名' } })))
    const auth = await fresh()
    await expect(auth.register({ invite: 'invite-code-1', username: 'wang', password: 'secret-123' })).rejects.toMatchObject({ status: 409, message: '这个用户名已经有人用了', fields: { username: '换一个用户名' } })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(reply(409, { error: '这个邀请码已经注册过账号了' })))
    await expect(auth.register({ invite: 'invite-code-1', username: 'li', password: 'secret-123' })).rejects.toMatchObject({ status: 409, message: '这个邀请码已经注册过账号了', fields: {} })
  })

  it('注册成功：POST /api/auth/register，称呼没填就不发；之后就是登录状态', async () => {
    const fetchMock = vi.fn().mockResolvedValue(reply(201, { teacher: { ...wang, name: 'wang' } }))
    vi.stubGlobal('fetch', fetchMock)
    const auth = await fresh()
    expect(await auth.register({ invite: 'invite-code-1', username: 'wang', password: 'secret-123', name: undefined })).toEqual({ ...wang, name: 'wang' })
    expect(fetchMock.mock.calls[0][0]).toBe('/api/auth/register')
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ invite: 'invite-code-1', username: 'wang', password: 'secret-123' })
    expect(await auth.getMe()).toEqual({ ...wang, name: 'wang' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('退出：POST JSON 到 /api/auth/logout，之后 getMe 是 null，不再请求；登录前发出、退出后才回来的 me 不覆盖；正在生成的任务记录清掉', async () => {
    let answer: (v: unknown) => void = () => undefined
    const fetchMock = vi.fn((url: string, _init?: RequestInit) => (url === '/api/auth/me' ? new Promise((ok) => (answer = ok)) : Promise.resolve(reply(200, { ok: true }))))
    vi.stubGlobal('fetch', fetchMock)
    const removeItem = vi.fn()
    vi.stubGlobal('localStorage', { removeItem })
    const auth = await fresh()
    const slow = auth.getMe() // 还没回来
    await auth.logout()
    expect(removeItem).toHaveBeenCalledWith('zhishi:upload-pending')
    expect(fetchMock.mock.calls[1][0]).toBe('/api/auth/logout')
    expect(fetchMock.mock.calls[1][1]).toMatchObject({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
    answer(reply(200, { teacher: wang })) // 退出之前的状态，作废
    expect(await slow).toBeNull()
    expect(await auth.getMe()).toBeNull()
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('退出失败：抛出提示，登录状态不变', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(reply(200, { teacher: wang })).mockRejectedValue(new Error('offline'))
    vi.stubGlobal('fetch', fetchMock)
    const auth = await fresh()
    await auth.getMe()
    const removeItem = vi.fn()
    vi.stubGlobal('localStorage', { removeItem })
    await expect(auth.logout()).rejects.toThrow('连不上服务器，请检查网络')
    expect(await auth.getMe()).toEqual(wang)
    expect(removeItem).not.toHaveBeenCalled()
  })
})

describe('登录后去哪（next）：只认站内的 #/ 地址', () => {
  it('#/ 开头的原样用（含 ?h= 参数）', () => {
    expect(safeNext('#/teacher?h=up-mg5k2x7a')).toBe('#/teacher?h=up-mg5k2x7a')
    expect(safeNext('#/upload')).toBe('#/upload')
    expect(safeNext('#/')).toBe('#/')
  })

  it('外站、协议、相对路径、空的：一律回上传页', () => {
    for (const x of ['https://evil.example/#/upload', '//evil.example', 'javascript:alert(1)', '/#/teacher', 'teacher', '#teacher', '', ' #/upload', null, undefined]) expect(safeNext(x)).toBe('#/upload')
  })

  it('loginHref 把 next 编码进登录页的地址，读回来不变', () => {
    const next = '#/teacher?h=up-mg5k2x7a&x=1'
    const href = loginHref(next)
    expect(href.startsWith('#/login?next=')).toBe(true)
    expect(new URLSearchParams(href.split('?')[1]).get('next')).toBe(next) // 和 router.ts 的 getParams 一样，只取第一个 ? 后面
  })
})
