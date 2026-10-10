// 讲义入库用的大模型客户端：OpenAI 兼容接口（组委会 TokenDance），只输出 JSON。
// 每次响应按请求内容缓存到 pipeline/cache/，--replay 时只读缓存、不联网，保证可复现。
import { createHash } from 'crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { fetch } from 'undici'
import type { ZodType } from 'zod'

export interface LlmConfig {
  baseUrl: string
  apiKey: string
  model: string
  fallbacks: string[]
  cacheDir: string
  replay: boolean
  timeoutMs: number
  thinking?: boolean // false 时关闭模型思考（快很多）；不设则用模型默认
}

// 极简 .env 解析：KEY=VALUE，支持引号和 # 注释
export function parseEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq <= 0) continue
    const key = line.slice(0, eq).trim()
    let value = line.slice(eq + 1).trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    out[key] = value
  }
  return out
}

export function configFromEnv(opts: { replay?: boolean; envFile?: string } = {}): LlmConfig {
  const envFile = opts.envFile ?? process.env.ENV_FILE ?? '.env'
  const fileEnv = existsSync(envFile) ? parseEnv(readFileSync(envFile, 'utf8')) : {}
  const get = (k: string) => process.env[k] ?? fileEnv[k]
  return {
    baseUrl: get('LLM_BASE_URL') ?? 'https://tokendance.space/gateway/v1',
    apiKey: get('tokenspace_apikey') ?? '',
    model: get('PIPELINE_MODEL') ?? 'deepseek-v4-pro',
    fallbacks: (get('PIPELINE_FALLBACKS') ?? 'qwen3.7-max,glm-5.2').split(',').map((s) => s.trim()).filter(Boolean),
    cacheDir: get('PIPELINE_CACHE') ?? 'pipeline/cache',
    replay: opts.replay ?? false,
    timeoutMs: Number(get('PIPELINE_TIMEOUT_MS') ?? 300000),
    thinking: get('PIPELINE_THINKING') === 'off' ? false : undefined,
  }
}

// 从模型输出里取出 JSON：优先整体解析，其次取 ```json 代码块或第一个 {...}
export function extractJson(content: string): unknown {
  const trimmed = content.trim()
  try {
    return JSON.parse(trimmed)
  } catch {
    // 继续尝试
  }
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (fenced) return JSON.parse(fenced[1])
  const start = trimmed.indexOf('{')
  const end = trimmed.lastIndexOf('}')
  if (start >= 0 && end > start) return JSON.parse(trimmed.slice(start, end + 1))
  throw new Error('模型输出里没有 JSON')
}

export interface ChatRequest {
  system: string
  user: string
  promptVersion: string // 改提示词时递增，缓存随之失效
}

export interface ChatResult<T> {
  data: T
  model: string
  cached: boolean
  cacheKey: string
}

function cacheKey(cfg: LlmConfig, req: ChatRequest): string {
  return createHash('sha256')
    .update(JSON.stringify([cfg.model, cfg.fallbacks, req.promptVersion, req.system, req.user]))
    .digest('hex')
    .slice(0, 24)
}

async function callOnce(cfg: LlmConfig, req: ChatRequest, extra?: string): Promise<{ content: string; model: string }> {
  if (!cfg.apiKey) throw new Error('缺少 tokenspace_apikey（写在 .env 里）')
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), cfg.timeoutMs)
  try {
    const res = await fetch(`${cfg.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` },
      body: JSON.stringify({
        model: cfg.model,
        models: cfg.fallbacks, // TokenDance 的模型降级：主模型失败时按顺序尝试
        temperature: 0,
        ...(cfg.thinking === false ? { enable_thinking: false } : {}),
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: req.system },
          { role: 'user', content: extra ? `${req.user}\n\n${extra}` : req.user },
        ],
      }),
      signal: controller.signal,
    })
    if (!res.ok) throw new Error(`模型接口返回 ${res.status}: ${(await res.text()).slice(0, 300)}`)
    const body = (await res.json()) as { model?: string; choices?: { message?: { content?: string } }[] }
    const content = body.choices?.[0]?.message?.content
    if (!content) throw new Error('模型没有返回内容')
    return { content, model: body.model ?? cfg.model }
  } finally {
    clearTimeout(timer)
  }
}

// 调用模型并用 zod 校验输出；校验失败时把错误反馈给模型重试一次
export async function chatJson<T>(cfg: LlmConfig, req: ChatRequest, schema: ZodType<T>): Promise<ChatResult<T>> {
  const key = cacheKey(cfg, req)
  const file = join(cfg.cacheDir, `${key}.json`)
  if (existsSync(file)) {
    const cached = JSON.parse(readFileSync(file, 'utf8')) as { model: string; content: string }
    return { data: schema.parse(extractJson(cached.content)), model: cached.model, cached: true, cacheKey: key }
  }
  if (cfg.replay) throw new Error(`回放模式下缺少缓存：${key}（提示词版本 ${req.promptVersion}）`)

  let attempt = await callOnce(cfg, req)
  let parsed = schema.safeParse(safeExtract(attempt.content))
  if (!parsed.success) {
    const hint = `上一次的输出不符合要求：${parsed.error.issues.slice(0, 5).map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}。请只输出符合要求的 JSON。`
    attempt = await callOnce(cfg, req, hint)
    parsed = schema.safeParse(safeExtract(attempt.content))
    if (!parsed.success) throw new Error(`模型输出两次都不符合 schema：${parsed.error.message.slice(0, 500)}`)
  }
  // 后端上传管线的缓存在 DATA_DIR/llm-cache（有老师上传的原文）：新建的目录只给本用户（700），文件只给本用户读写（600）
  mkdirSync(cfg.cacheDir, { recursive: true, mode: 0o700 })
  writeFileSync(file, JSON.stringify({ model: attempt.model, promptVersion: req.promptVersion, content: attempt.content }, null, 1), { mode: 0o600 })
  return { data: parsed.data, model: attempt.model, cached: false, cacheKey: key }
}

function safeExtract(content: string): unknown {
  try {
    return extractJson(content)
  } catch {
    return undefined
  }
}
