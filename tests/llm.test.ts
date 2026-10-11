import { mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { chatJson, configFromEnv, extractJson, parseEnv, type LlmConfig } from '../pipeline/llm'

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
