// 讲义加载：内置讲义不发请求；其他 id 从后端拉，校验通过才用；拉不到给中文提示。本机有这篇的编辑口令就放在请求头里带上
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as data from '../src/data'
import { editKeyOf } from '../src/lib/store'
import { miniHandout } from './fixtures/mini-handout'

const at = (search: string, hash = '') => vi.stubGlobal('window', { location: { search, hash } })
const reply = (status: number, body: unknown) => vi.fn().mockResolvedValue({ ok: status >= 200 && status < 300, status, json: async () => body })
const uploaded = { ...miniHandout, id: 'up-mg5k2x7a', title: 'Uploaded' }
// 假的 localStorage：只读这几项（Node 16 没有 localStorage，不假就是「本机什么都没存」）
const storage = (items: Record<string, string>) => vi.stubGlobal('localStorage', { getItem: (k: string) => items[k] ?? null, setItem: vi.fn(), removeItem: vi.fn() })
const mine = (...rows: unknown[]) => ({ 'zhishi:uploads': JSON.stringify(rows) })

describe('editKeyOf：本机存的编辑口令', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('从上传过的讲义和正在生成的任务里找', () => {
    storage({
      ...mine({ id: 'up-a', title: 'A', createdAt: 1, published: false, key: 'key-a' }, { id: 'up-old', title: '旧的', createdAt: 1, published: true }),
      'zhishi:upload-pending': JSON.stringify({ jobId: 'up-c', title: 'C', key: 'key-c' }),
    })
    expect(editKeyOf('up-a')).toBe('key-a')
    expect(editKeyOf('up-c')).toBe('key-c')
    expect(editKeyOf('up-old')).toBeUndefined() // 有这条记录，但没有口令
    expect(editKeyOf('up-x')).toBeUndefined()
    expect(editKeyOf('mini-phones')).toBeUndefined()
  })

  it('存的格式不对、口令不是字符串或是空的，都当没有；一项坏了不影响另一项', () => {
    storage({ 'zhishi:uploads': '{not json', 'zhishi:upload-pending': JSON.stringify({ jobId: 'up-c', title: 'C', key: 'key-c' }) })
    expect(editKeyOf('up-c')).toBe('key-c')
    storage({ 'zhishi:uploads': JSON.stringify({ id: 'up-a', key: 'key-a' }), 'zhishi:upload-pending': '[1,2]' }) // 上传记录不是数组
    expect(editKeyOf('up-a')).toBeUndefined()
    storage({ ...mine(null, 3, { id: 'up-a', key: 42 }, { id: 'up-b', key: '' }), 'zhishi:upload-pending': 'null' })
    expect(editKeyOf('up-a')).toBeUndefined()
    expect(editKeyOf('up-b')).toBeUndefined()
  })

  it('读不了本地存储（隐私模式、没有 localStorage）当没有，不报错', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('SecurityError')
      },
    })
    expect(editKeyOf('up-a')).toBeUndefined()
    vi.unstubAllGlobals()
    expect(editKeyOf('up-a')).toBeUndefined()
  })
})

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
    expect(fetchMock.mock.calls[0][1].headers).toBeUndefined() // 本机没有口令：不带请求头
    expect(data.currentHandout.id).toBe('up-mg5k2x7a')
  })

  it('本机有这篇的编辑口令就放在请求头 X-Edit-Key 里（老师发布前试做学生端），不进链接', async () => {
    const fetchMock = reply(200, uploaded)
    vi.stubGlobal('fetch', fetchMock)
    storage(mine({ id: 'up-other', title: 'O', createdAt: 1, published: false, key: 'key-other' }, { id: 'up-mg5k2x7a', title: 'Uploaded', createdAt: 1, published: false, key: 'key-1' }))
    at('?h=up-mg5k2x7a', '#/student')
    expect((await data.loadCurrentHandout()).id).toBe('up-mg5k2x7a')
    expect(fetchMock.mock.calls[0][0]).toBe('/api/handouts/up-mg5k2x7a')
    expect(fetchMock.mock.calls[0][1].headers).toEqual({ 'X-Edit-Key': 'key-1' })
    // 别的讲义的口令不带
    fetchMock.mockClear()
    at('?h=up-third', '#/student')
    await data.loadCurrentHandout().catch(() => undefined)
    expect(fetchMock.mock.calls[0][1].headers).toBeUndefined()
  })

  it('404、内容不合格、断网都拒绝，给中文提示', async () => {
    at('?h=up-missing')
    vi.stubGlobal('fetch', reply(404, { error: 'not found' }))
    await expect(data.loadCurrentHandout()).rejects.toThrow('找不到这份讲义：链接不完整，或者老师还没有发布')
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
