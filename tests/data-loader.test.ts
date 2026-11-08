// 讲义加载：内置讲义不发请求；其他 id 从后端拉，校验通过才用；拉不到给中文提示（401 要登录、404 找不到分开说）。没发布的讲义靠登录的 cookie（同源请求默认带上），不带别的请求头
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as data from '../src/data'
import { miniHandout } from './fixtures/mini-handout'

const at = (search: string, hash = '') => vi.stubGlobal('window', { location: { search, hash } })
const reply = (status: number, body: unknown) => vi.fn().mockResolvedValue({ ok: status >= 200 && status < 300, status, json: async () => body })
const uploaded = { ...miniHandout, id: 'up-mg5k2x7a', title: 'Uploaded' }

describe('loadCurrentHandout', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('内置讲义（不带 h、?h=、#/…?h=）不发请求；默认是迷你讲义', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    at('')
    expect((await data.loadCurrentHandout()).id).toBe('mini-phones')
    at('?h=mini-phones')
    expect((await data.loadCurrentHandout()).id).toBe('mini-phones')
    expect(data.currentHandout.id).toBe('mini-phones')
    at('', '#/student?h=mini-phones')
    expect((await data.loadCurrentHandout()).id).toBe('mini-phones')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('已下线的购买讲义（?h=social-media 的旧链接）回到默认讲义，不发请求、不报错', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    for (const [search, hash] of [['?h=social-media', '#/judge'], ['', '#/student?h=social-media']]) {
      at(search, hash)
      expect((await data.loadCurrentHandout()).id).toBe('mini-phones')
      expect(data.currentHandout.id).toBe('mini-phones')
    }
    expect(data.handouts.map((x) => x.id)).toEqual(['mini-phones'])
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('其他 id 请求 /api/handouts/<id>，校验后成为 currentHandout', async () => {
    const fetchMock = reply(200, uploaded)
    vi.stubGlobal('fetch', fetchMock)
    at('?h=up-mg5k2x7a', '#/student')
    expect((await data.loadCurrentHandout()).title).toBe('Uploaded')
    expect(fetchMock.mock.calls[0][0]).toBe('/api/handouts/up-mg5k2x7a')
    expect(data.currentHandout.id).toBe('up-mg5k2x7a')
  })

  it('不带 X-Edit-Key 之类的请求头，也不改 cookie 的默认行为：作者登录后，会话 cookie 跟着同源请求带上（发布前试做学生端）', async () => {
    const fetchMock = reply(200, uploaded)
    vi.stubGlobal('fetch', fetchMock)
    // 旧版本留在本机的上传记录（带口令）不再读
    vi.stubGlobal('localStorage', { getItem: () => JSON.stringify([{ id: 'up-mg5k2x7a', key: 'key-1' }]), setItem: vi.fn(), removeItem: vi.fn() })
    at('?h=up-mg5k2x7a', '#/student')
    expect((await data.loadCurrentHandout()).id).toBe('up-mg5k2x7a')
    const init = fetchMock.mock.calls[0][1]
    expect(init.headers).toBeUndefined()
    expect(init.credentials).toBeUndefined() // 默认 same-origin，不能是 omit
    expect(Object.keys(init)).toEqual(['signal'])
  })

  it('404、内容不合格、断网都拒绝，给中文提示；404 只有班级二维码的链接（带 c）才说老师', async () => {
    at('?h=up-missing')
    vi.stubGlobal('fetch', reply(404, { error: 'not found' }))
    await expect(data.loadCurrentHandout()).rejects.toThrow('找不到这篇文章：链接不完整，或者已经下架了。同学自己贴的文章，只有贴过这一篇的人能读')
    at('?h=up-missing&c=c-0123456789ab', '#/student')
    await expect(data.loadCurrentHandout()).rejects.toThrow('找不到这份讲义：链接不完整，或者老师还没有发布')
    at('?h=up-missing')
    vi.stubGlobal('fetch', reply(200, { ...uploaded, sentences: [] }))
    await expect(data.loadCurrentHandout()).rejects.toThrow('讲义加载失败')
    vi.stubGlobal('fetch', reply(500, {}))
    await expect(data.loadCurrentHandout()).rejects.toThrow('讲义加载失败')
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')))
    await expect(data.loadCurrentHandout()).rejects.toThrow('讲义加载失败')
  })

  it('401（没登录，后端不说这篇存不存在）和 404 分开提示，带状态码；其他失败状态码是 0', async () => {
    at('?h=up-shelf1', '#/student')
    vi.stubGlobal('fetch', reply(401, { error: '请先登录' }))
    const e401 = await data.loadCurrentHandout().catch((e: unknown) => e)
    expect(e401).toBeInstanceOf(data.HandoutError)
    expect(e401).toMatchObject({ status: 401, message: '这篇文章要先登录才能读' })
    vi.stubGlobal('fetch', reply(404, { error: '没有这份讲义' }))
    const e404 = await data.loadCurrentHandout().catch((e: unknown) => e)
    expect(e404).toMatchObject({ status: 404 })
    expect((e404 as Error).message).not.toBe((e401 as Error).message)
    vi.stubGlobal('fetch', reply(500, {}))
    await expect(data.loadCurrentHandout()).rejects.toMatchObject({ status: 0 })
  })

  it('错误页：401 显示「登录」，去 #/me，next 带完整地址（?h=、哈希），登录页的链接不带 ?h=；去掉了「我的讲义」，401 时留小字「老师登录」', () => {
    const main = readFileSync(fileURLToPath(new URL('../src/main.tsx', import.meta.url)), 'utf8')
    expect(main).toContain('const here = `/${window.location.search}${window.location.hash}`')
    expect(main).toMatch(/\{e\.status === 401 && \(\s+<a href=\{`\/\$\{loginHref\(here\)\}`\}[^>]*>\s+登录\s+<\/a>/)
    expect(main).toMatch(/\{e\.status === 401 && \(\s+<a href="\/#\/upload" [^>]*>\s+老师登录\s+<\/a>/)
    expect(main.match(/#\/upload/g)).toHaveLength(1)
    expect(main).toContain("import { loginHref } from './lib/student-auth'")
    expect(main).not.toContain('我的讲义')
    expect(main).toContain("window.addEventListener('hashchange', () => window.location.reload())") // 讲义 id 在哈希里的旧链接也能去登录页
  })

  it('错误页的链接写死根路径，不拼 location.pathname：地址是 //外站/?h=… 时不会拼出去外站的 //外站/#/me', () => {
    const main = readFileSync(fileURLToPath(new URL('../src/main.tsx', import.meta.url)), 'utf8')
    expect(main).not.toContain('location.pathname')
    expect(main).toMatch(/<a href="\/" [^>]*>\s+回首页\s+<\/a>/)
    // 拼法本身：pathname 是 //evil.example/ 时，旧拼法会解析到外站
    expect(new URL('//evil.example/#/me', 'https://zhishi.test//evil.example/?h=up-a').host).toBe('evil.example')
    expect(new URL('/#/me', 'https://zhishi.test//evil.example/?h=up-a').host).toBe('zhishi.test')
  })

  it('10 秒没有回应就放弃', async () => {
    vi.useFakeTimers()
    at('?h=up-slow')
    vi.stubGlobal(
      'fetch',
      vi.fn((_url: string, init: { signal: AbortSignal }) => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(new Error('aborted'))))),
    )
    const p = expect(data.loadCurrentHandout()).rejects.toThrow('讲义加载失败')
    await vi.advanceTimersByTimeAsync(10000)
    await p
  })
})
