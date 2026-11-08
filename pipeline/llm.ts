// 讲义入库用的大模型客户端：OpenAI 兼容接口（阿里云百炼），只输出 JSON。
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
  cacheDir: string
  replay: boolean
  timeoutMs: number
  thinking?: boolean // true 时让模型思考（请求里不带 enable_thinking:false）；不设或 false 都关闭思考（快很多）
  // 记用量：每次真正发请求前报 onCall（估计额用的 token 数），结束时报一次 onUsage；命中缓存的不报。
  // 上传管线在 worker 里跑，这两个由 server/article-worker.mjs 填上、postMessage 回主线程记账；离线 npm run ingest 不设
  onCall?: (c: LlmCall) => void
  onUsage?: (u: LlmUsage) => void
}

// 一次调用开始：input 是估计的输入 token，output 是这类调用的 max_tokens（估计额 = input × 输入单价 + output × 输出单价）
export interface LlmCall {
  id: number // 同一个进程（worker）里递增，onUsage 用它对上是哪一次
  kind: string // 调用类型：提示词版本去掉末尾的 -vN（article-v5 → article）
  model: string // 请求的模型（按它计价）
  input: number
  output: number
}
// 一次调用结束：拿到响应里的 usage 就是实际的 token 数；拿不到的（超时、非 200、响应坏了、没有 usage）照抄 onCall 的估计数，estimated 为 true；
// 连接都没建立（连不上、域名解析失败）的 input、output 都是 0：上游没收到请求，不收费
export interface LlmUsage extends LlmCall {
  cached: number // 输入里命中上游缓存的 token 数（先按全价算，只记下来）
  estimated: boolean
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
    baseUrl: get('LLM_BASE_URL') ?? 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    apiKey: get('LLM_API_KEY') || get('tokenspace_apikey') || '', // 旧名 tokenspace_apikey 兼容以前的 .env
    model: get('PIPELINE_MODEL') ?? 'deepseek-v4-pro',
    cacheDir: get('PIPELINE_CACHE') ?? 'pipeline/cache',
    replay: opts.replay ?? false,
    timeoutMs: Number(get('PIPELINE_TIMEOUT_MS') ?? 300000),
    thinking: get('PIPELINE_THINKING') === 'on', // 默认关闭思考，PIPELINE_THINKING=on 才让模型思考
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

// 每类调用的输出上限（max_tokens）：给一次调用的花费封顶，也是估计额里的输出 token 数。起草一段正常几千 token，
// 90 秒超时以内也出不了更多；全文词义一批 40 个词；标题、梯子第 1 步的修正只有一两个字段。没列的按 DEFAULT_MAX_TOKENS
const MAX_TOKENS: Record<string, number> = { article: 8192, draft: 8192, lexicon: 3000, title: 200, 'repair-l1': 600 }
const DEFAULT_MAX_TOKENS = 8192
export const callKind = (promptVersion: string) => promptVersion.replace(/-v\d+$/, '')
// 估计输入 token：UTF-8 每 3 个字节算 1 个，往多了算（中文一个字 3 字节、约 1 个 token；英文约 4 个字母 1 个 token）。与 server/index.mjs 的 estimateTokens 一致
export const estimateTokens = (text: string) => Math.ceil(Buffer.byteLength(text, 'utf8') / 3)
// 响应里的 usage（百炼 OpenAI 兼容接口：prompt_tokens、completion_tokens、prompt_tokens_details.cached_tokens），格式不对返回 null。与 server/index.mjs 的 readUsage 一致
function readUsage(u: unknown): { input: number; output: number; cached: number } | null {
  const x = u as { prompt_tokens?: unknown; completion_tokens?: unknown; prompt_tokens_details?: { cached_tokens?: unknown } } | null
  if (!x || !Number.isSafeInteger(x.prompt_tokens) || !Number.isSafeInteger(x.completion_tokens)) return null
  const cached = x.prompt_tokens_details?.cached_tokens
  return { input: x.prompt_tokens as number, output: x.completion_tokens as number, cached: Number.isSafeInteger(cached) ? (cached as number) : 0 }
}
// 连接都没建立：上游没收到请求。别的网络错误（连上以后断了）可能已经在算了，按估计额记
const NOT_SENT = ['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'UND_ERR_CONNECT_TIMEOUT']
const neverSent = (err: unknown) => NOT_SENT.includes(String((err as { cause?: { code?: unknown } })?.cause?.code))
let callSeq = 0

function cacheKey(cfg: LlmConfig, req: ChatRequest): string {
  return createHash('sha256')
    .update(JSON.stringify([cfg.model, req.promptVersion, req.system, req.user]))
    .digest('hex')
    .slice(0, 24)
}

async function callOnce(cfg: LlmConfig, req: ChatRequest, extra?: string): Promise<{ content: string; model: string }> {
  if (!cfg.apiKey) throw new Error('缺少 LLM_API_KEY（写在 .env 里）')
  const user = extra ? `${req.user}\n\n${extra}` : req.user
  const kind = callKind(req.promptVersion)
  const call: LlmCall = { id: ++callSeq, kind, model: cfg.model, input: estimateTokens(req.system + user), output: MAX_TOKENS[kind] ?? DEFAULT_MAX_TOKENS }
  let open = true
  const report = (u: { input: number; output: number; cached: number } | null) => {
    if (open) cfg.onUsage?.({ ...call, ...u, cached: u?.cached ?? 0, estimated: !u })
    open = false
  }
  cfg.onCall?.(call)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), cfg.timeoutMs)
  try {
    const res = await fetch(`${cfg.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` },
      body: JSON.stringify({
        model: cfg.model,
        temperature: 0,
        max_tokens: call.output,
        ...(cfg.thinking === true ? {} : { enable_thinking: false }), // 百炼：放在请求体顶层；不传的话 qwen3.8 / deepseek-v4 默认会思考
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: req.system },
          { role: 'user', content: user },
        ],
      }),
      signal: controller.signal,
    })
    if (!res.ok) throw new Error(`模型接口返回 ${res.status}: ${(await res.text()).slice(0, 300)}`)
    const body = (await res.json()) as { model?: string; choices?: { message?: { content?: string } }[]; usage?: unknown }
    report(readUsage(body.usage))
    const content = body.choices?.[0]?.message?.content
    if (!content) throw new Error('模型没有返回内容')
    return { content, model: body.model ?? cfg.model }
  } catch (err) {
    report(neverSent(err) ? { input: 0, output: 0, cached: 0 } : null)
    throw err
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
