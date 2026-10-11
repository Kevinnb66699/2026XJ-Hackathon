// 手动实测候选模型（不进 vitest）：每个模型发几次很短的写作检查，记录每次的耗时、HTTP 状态、JSON 能不能解析、
// 响应里有没有 reasoning_content（有就是思考没关掉）。配置和后端用同一个 loadConfig（环境变量，其次 ENV_FILE 或当前目录 .env）。
// 用法：ENV_FILE=/path/to/.env RUNS=5 node server/probe-models.mjs [model1,model2,...]
// 只打印模型名、耗时和判定结果，绝不打印 Key。
import { fetch } from 'undici'
import { buildBody, loadConfig } from './index.mjs'

const cfg = loadConfig()
if (!cfg.apiKey) {
  console.error('没有读到 LLM_API_KEY，检查 .env 或 ENV_FILE')
  process.exit(1)
}
// 请求体和服务器完全一致；EXTRA='{"enable_thinking":true}' 可覆盖参数做对比
const extra = JSON.parse(process.env.EXTRA || '{}')
const models = (process.argv[2] || 'qwen3.8-flash,qwen3.7-flash,deepseek-v4.1-flash').split(',').map((s) => s.trim()).filter(Boolean)
const runs = Number(process.env.RUNS || 5)
const url = `${cfg.llmBaseUrl.replace(/\/+$/, '')}/chat/completions`
const mask = (s) => String(s ?? '').split(cfg.apiKey).join('***')

// 预期：E1 用对；E2 用错（人不能 feel counterproductive）；E3 没用上
const text = 'My school is toying with the idea of banning phones. I feel very counterproductive when I use my phone in class.'
const expressions = [
  { id: 'E1', text: 'toy with the idea', zh: '不太认真地考虑这个想法', example: 'Many schools are toying with the idea of banning phones in class.' },
  { id: 'E2', text: 'counterproductive', zh: '适得其反的', example: 'A blanket ban may prove counterproductive.' },
  { id: 'E3', text: 'blanket ban', zh: '全面禁令', example: 'A blanket ban may prove counterproductive.' },
]
const expected = { E1: 'correct', E2: 'incorrect', E3: 'unused' }

console.log(`${url}，每个模型 ${runs} 次`)
for (const model of models) {
  for (let i = 1; i <= runs; i++) {
    const t0 = Date.now()
    const line = `${model.padEnd(20)} #${i}`
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.apiKey}` },
        body: JSON.stringify({ ...buildBody(model, text, expressions), ...extra }),
        signal: AbortSignal.timeout(30000),
      })
      const raw = await res.text()
      const ms = Date.now() - t0
      let data = null
      try {
        data = JSON.parse(raw)
      } catch {
        // 不是 JSON（比如网关的 HTML 错误页）
      }
      const message = data?.choices?.[0]?.message
      const content = String(message?.content ?? '')
      // json：整段能直接 JSON.parse 是「严格」，要从 ```json 之类里抠出来才能解析是「提取」，都不行是「失败」
      let json = '失败'
      let parsed = null
      try {
        parsed = JSON.parse(content.trim())
        json = '严格'
      } catch {
        try {
          parsed = JSON.parse(content.match(/\{[\s\S]*\}/)?.[0] ?? '')
          json = '提取'
        } catch {
          parsed = null
        }
      }
      const reasoning = typeof message?.reasoning_content === 'string' && message.reasoning_content.length ? `有（${message.reasoning_content.length} 字）` : '无'
      const results = Array.isArray(parsed?.results) ? parsed.results : []
      const got = Object.fromEntries(results.map((r) => [r.id, r.used === false ? 'unused' : r.verdict]))
      const match = Object.keys(expected).filter((id) => got[id] === expected[id]).length
      console.log(`${line} http=${res.status} ${ms}ms json=${json} reasoning=${reasoning} 判对=${match}/3 served=${data?.model ?? '-'}`)
      // 上游错误信息可能回显 Key，打印前先遮掉
      if (!res.ok) console.log(`    ${mask(data?.error?.message ?? raw).slice(0, 200)}`)
    } catch (err) {
      console.log(`${line} error ${err?.name} ${Date.now() - t0}ms`)
    }
  }
}
