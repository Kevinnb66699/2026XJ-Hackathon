import { mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { chatJson, extractJson, parseEnv, type LlmConfig } from '../pipeline/llm'

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
    const cfg: LlmConfig = { baseUrl: 'http://127.0.0.1:9', apiKey: '', model: 'm', fallbacks: [], cacheDir: dir, replay: true, timeoutMs: 1000 }
    const schema = z.object({ ok: z.boolean() })
    await expect(chatJson(cfg, { system: 's', user: 'u', promptVersion: 'v1' }, schema)).rejects.toThrow(/回放模式/)
  })

  it('命中缓存时返回缓存内容', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'llm-'))
    const cfg: LlmConfig = { baseUrl: 'http://127.0.0.1:9', apiKey: '', model: 'm', fallbacks: [], cacheDir: dir, replay: true, timeoutMs: 1000 }
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
