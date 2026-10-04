// 讲义加载：内置讲义不发请求；其他 id 从后端拉，校验通过才用；拉不到给中文提示
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

  it('404、内容不合格、断网都拒绝，给中文提示', async () => {
    at('?h=up-missing')
    vi.stubGlobal('fetch', reply(404, { error: 'not found' }))
    await expect(data.loadCurrentHandout()).rejects.toThrow('找不到这份讲义')
    vi.stubGlobal('fetch', reply(200, { ...uploaded, sentences: [] }))
    await expect(data.loadCurrentHandout()).rejects.toThrow('讲义加载失败')
    vi.stubGlobal('fetch', reply(500, {}))
    await expect(data.loadCurrentHandout()).rejects.toThrow('讲义加载失败')
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')))
    await expect(data.loadCurrentHandout()).rejects.toThrow('讲义加载失败')
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
