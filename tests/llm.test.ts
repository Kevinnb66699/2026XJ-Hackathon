import { mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { callKind, chatJson, configFromEnv, extractJson, parseEnv, type LlmCall, type LlmConfig, type LlmUsage } from '../pipeline/llm'

// 不联网：pipeline/llm.ts 用的 undici fetch 换成假的，记下发出去的请求
const fetchMock = vi.hoisted(() => vi.fn())
vi.mock('undici', () => ({ fetch: fetchMock }))

describe('llm 工具', () => {
  it('解析 .env', () => {
    const env = parseEnv('# 注释\nA=1\nB="two"\n tokenspace_apikey = abc \nBAD')
    expect(env).toEqual({ A: '1', B: 'two', tokenspace_apikey: 'abc' })
  })

  it('从各种格式里取出 JSON', () => {
    expect(extractJson('{"a":1}')).toEqual({ a: 1 })
    expect(extractJson('说明\n```json\n{"a":2}\n```')).toEqual({ a: 2 })
    expect(extractJson('前缀 {"a":3} 后缀')).toEqual({ a: 3 })
    expect(() => extractJson('没有')).toThrow()
  })

  it('回放模式只读缓存，缺缓存时报错且不联网', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'llm-'))
    const cfg: LlmConfig = { baseUrl: 'http://127.0.0.1:9', apiKey: '', model: 'm', cacheDir: dir, replay: true, timeoutMs: 1000 }
    const schema = z.object({ ok: z.boolean() })
    await expect(chatJson(cfg, { system: 's', user: 'u', promptVersion: 'v1' }, schema)).rejects.toThrow(/回放模式/)
  })

  it('命中缓存时返回缓存内容', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'llm-'))
    const cfg: LlmConfig = { baseUrl: 'http://127.0.0.1:9', apiKey: '', model: 'm', cacheDir: dir, replay: true, timeoutMs: 1000 }
    const schema = z.object({ ok: z.boolean() })
    const req = { system: 's', user: 'u', promptVersion: 'v1' }
    // 先算出缓存键：用一次失败调用拿到错误信息里的键
    const err = await chatJson(cfg, req, schema).catch((e: Error) => e.message)
    const key = String(err).match(/缓存：(\w+)/)?.[1]
    expect(key).toBeTruthy()
    writeFileSync(join(dir, `${key}.json`), JSON.stringify({ model: 'm', content: '{"ok":true}' }))
    const r = await chatJson(cfg, req, schema)
    expect(r).toMatchObject({ data: { ok: true }, cached: true })
  })
})

describe('发给百炼的请求（pipeline/llm.ts）', () => {
  afterEach(() => {
    fetchMock.mockReset()
  })
  const schema = z.object({ ok: z.boolean() })
  const reply = () => ({ ok: true, json: async () => ({ model: 'served', choices: [{ message: { content: '{"ok":true}' } }] }) })
  const cfg = (o: Partial<LlmConfig> = {}): LlmConfig => ({ baseUrl: 'https://ws.example/compatible-mode/v1', apiKey: 'sk-test', model: 'm', cacheDir: mkdtempSync(join(tmpdir(), 'llm-')), replay: false, timeoutMs: 1000, ...o })
  const send = async (c: LlmConfig) => {
    fetchMock.mockResolvedValueOnce(reply())
    const r = await chatJson(c, { system: '只输出 JSON', user: 'u', promptVersion: 'v1' }, schema)
    const [url, init] = fetchMock.mock.calls.at(-1)!
    return { r, url, auth: init.headers.Authorization, body: JSON.parse(init.body) }
  }

  it('默认关思考（顶层 enable_thinking:false），不带 models 备选；地址末尾多余的 / 去掉', async () => {
    const { r, url, auth, body } = await send(cfg({ baseUrl: 'https://ws.example/compatible-mode/v1//' }))
    expect(r).toMatchObject({ data: { ok: true }, model: 'served', cached: false })
    expect(url).toBe('https://ws.example/compatible-mode/v1/chat/completions')
    expect(auth).toBe('Bearer sk-test')
    expect(body).toMatchObject({ model: 'm', temperature: 0, enable_thinking: false, response_format: { type: 'json_object' } })
    expect(body).not.toHaveProperty('models')
  })

  it('thinking:false 也关；只有 thinking:true 才不带 enable_thinking', async () => {
    expect((await send(cfg({ thinking: false }))).body.enable_thinking).toBe(false)
    expect((await send(cfg({ thinking: true }))).body).not.toHaveProperty('enable_thinking')
  })

  it('没有 Key：报错说要 LLM_API_KEY，不发请求', async () => {
    await expect(chatJson(cfg({ apiKey: '' }), { system: 's', user: 'u', promptVersion: 'v1' }, schema)).rejects.toThrow('缺少 LLM_API_KEY')
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('用量：onCall / onUsage（阶段 2）', () => {
  afterEach(() => {
    fetchMock.mockReset()
  })
  const schema = z.object({ ok: z.boolean() })
  const usage = { prompt_tokens: 1234, completion_tokens: 56, prompt_tokens_details: { cached_tokens: 1000 } }
  const reply = (content = '{"ok":true}', extra: Record<string, unknown> = { usage }) => ({ ok: true, json: async () => ({ model: 'served', choices: [{ message: { content } }], ...extra }) })
  // 每次一个新的缓存目录，不会命中缓存
  const setup = (o: Partial<LlmConfig> = {}) => {
    const calls: LlmCall[] = []
    const usages: LlmUsage[] = []
    const c: LlmConfig = { baseUrl: 'https://ws.example/compatible-mode/v1', apiKey: 'sk-test', model: 'deepseek-v4-pro', cacheDir: mkdtempSync(join(tmpdir(), 'llm-')), replay: false, timeoutMs: 1000, onCall: (x) => calls.push(x), onUsage: (x) => usages.push(x), ...o }
    return { c, calls, usages }
  }
  // 「只输出 JSON」14 个字节 + 30 个 u：估计 44 / 3 向上取整 = 15 个 token
  const req = (promptVersion = 'article-v5') => ({ system: '只输出 JSON', user: 'u'.repeat(30), promptVersion })
  const sentBody = () => JSON.parse(fetchMock.mock.calls[fetchMock.mock.calls.length - 1][1].body)

  it('上游回了 usage：先报开始（估计的输入 token、这类调用的 max_tokens），再报一次实际用量；请求带同一个 max_tokens', async () => {
    const { c, calls, usages } = setup()
    fetchMock.mockResolvedValueOnce(reply())
    await chatJson(c, req(), schema)
    expect(calls).toEqual([{ id: expect.any(Number), kind: 'article', model: 'deepseek-v4-pro', input: 15, output: 8192 }])
    expect(usages).toEqual([{ ...calls[0], input: 1234, output: 56, cached: 1000, estimated: false }])
    expect(sentBody().max_tokens).toBe(8192)
  })

  it('max_tokens 按调用类型：提示词版本去掉末尾的 -vN；没列的类型按 8192', async () => {
    const cases: [string, string, number][] = [['article-v5', 'article', 8192], ['title-v2', 'title', 200], ['lexicon-v1', 'lexicon', 3000], ['repair-l1-v1', 'repair-l1', 600], ['draft-v1', 'draft', 8192], ['v1', 'v1', 8192]]
    for (const [v, kind, n] of cases) {
      const { c, calls } = setup()
      fetchMock.mockResolvedValueOnce(reply())
      await chatJson(c, req(v), schema)
      expect(callKind(v)).toBe(kind)
      expect(calls[0], v).toMatchObject({ kind, output: n })
      expect(sentBody().max_tokens, v).toBe(n)
    }
  })

  it('命中缓存不报', async () => {
    const { c, calls, usages } = setup()
    fetchMock.mockResolvedValueOnce(reply())
    await chatJson(c, req(), schema)
    expect((await chatJson(c, req(), schema)).cached).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect([calls.length, usages.length]).toEqual([1, 1])
  })

  it('格式不对重试：两次各报一次实际用量；第二次的输入带着重试提示，估计数更大', async () => {
    const { c, calls, usages } = setup()
    fetchMock.mockResolvedValueOnce(reply('{"ok":"不是布尔"}', { usage: { prompt_tokens: 10, completion_tokens: 5 } })).mockResolvedValueOnce(reply())
    expect((await chatJson(c, req(), schema)).data).toEqual({ ok: true })
    expect(usages.map((u) => [u.input, u.output, u.cached, u.estimated])).toEqual([[10, 5, 0, false], [1234, 56, 1000, false]])
    expect(calls).toHaveLength(2)
    expect(calls[1].input).toBeGreaterThan(calls[0].input)
    expect(usages.map((u) => u.id)).toEqual(calls.map((x) => x.id))
  })

  it('超时、非 200、响应不是 JSON、没给 usage：按开始时的估计数报一次，estimated 为 true', async () => {
    const abortable = (_url: string, init: { signal: AbortSignal }) =>
      new Promise((_ok, no) => init.signal.addEventListener('abort', () => no(Object.assign(new Error('This operation was aborted'), { name: 'AbortError' }))))
    const cases: [string, () => void, number][] = [
      ['超时', () => fetchMock.mockImplementationOnce(abortable), 20],
      ['非 200', () => fetchMock.mockResolvedValueOnce({ ok: false, status: 500, text: async () => 'boom' }), 1000],
      ['不是 JSON', () => fetchMock.mockResolvedValueOnce({ ok: true, json: async () => JSON.parse('<html>') }), 1000],
    ]
    for (const [name, mock, timeoutMs] of cases) {
      const { c, calls, usages } = setup({ timeoutMs })
      mock()
      await expect(chatJson(c, req(), schema), name).rejects.toThrow()
      expect(usages, name).toEqual([{ ...calls[0], cached: 0, estimated: true }])
    }
    // 没给 usage：结果照常，用量按估计
    const { c, calls, usages } = setup()
    fetchMock.mockResolvedValueOnce(reply('{"ok":true}', {}))
    expect((await chatJson(c, req(), schema)).data).toEqual({ ok: true })
    expect(usages).toEqual([{ ...calls[0], cached: 0, estimated: true }])
  })

  it('连接都没建立（连不上、域名解析失败、连接超时）：报 0（上游没收到请求）；连上以后断了照样按估计额', async () => {
    for (const code of ['ECONNREFUSED', 'ENOTFOUND', 'UND_ERR_CONNECT_TIMEOUT']) {
      const { c, calls, usages } = setup()
      fetchMock.mockRejectedValueOnce(Object.assign(new TypeError('fetch failed'), { cause: { code } }))
      await expect(chatJson(c, req(), schema)).rejects.toThrow('fetch failed')
      expect(usages, code).toEqual([{ ...calls[0], input: 0, output: 0, cached: 0, estimated: false }])
    }
    const { c, calls, usages } = setup()
    fetchMock.mockRejectedValueOnce(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } }))
    await expect(chatJson(c, req(), schema)).rejects.toThrow('fetch failed')
    expect(usages).toEqual([{ ...calls[0], cached: 0, estimated: true }])
  })

  it('没有 Key：不发请求，也不报', async () => {
    const { c, calls, usages } = setup({ apiKey: '' })
    await expect(chatJson(c, req(), schema)).rejects.toThrow('缺少 LLM_API_KEY')
    expect([calls, usages]).toEqual([[], []])
  })
})

describe('configFromEnv（离线 npm run ingest 用）', () => {
  const NAMES = ['LLM_API_KEY', 'tokenspace_apikey', 'LLM_BASE_URL', 'PIPELINE_MODEL', 'PIPELINE_THINKING', 'PIPELINE_FALLBACKS']
  const fromFile = (text: string) => {
    const saved = Object.fromEntries(NAMES.map((k) => [k, process.env[k]]))
    for (const k of NAMES) delete process.env[k]
    try {
      const file = join(mkdtempSync(join(tmpdir(), 'llm-env-')), '.env')
      writeFileSync(file, text)
      return configFromEnv({ envFile: file })
    } finally {
      for (const k of NAMES) if (saved[k] === undefined) delete process.env[k]
      else process.env[k] = saved[k]
    }
  }

  it('默认：百炼地址、deepseek-v4-pro、关思考；没有备选模型', () => {
    const c = fromFile('PIPELINE_FALLBACKS=a,b\n')
    expect(c).toMatchObject({ baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', apiKey: '', model: 'deepseek-v4-pro', thinking: false })
    expect(c).not.toHaveProperty('fallbacks')
    expect(fromFile('PIPELINE_THINKING=off\n').thinking).toBe(false)
    expect(fromFile('PIPELINE_THINKING=on\n').thinking).toBe(true)
  })

  it('Key 读 LLM_API_KEY，没设时读旧名 tokenspace_apikey', () => {
    expect(fromFile('LLM_API_KEY=k-new\ntokenspace_apikey=k-old\n').apiKey).toBe('k-new')
    expect(fromFile('tokenspace_apikey=k-old\n').apiKey).toBe('k-old')
  })
})
