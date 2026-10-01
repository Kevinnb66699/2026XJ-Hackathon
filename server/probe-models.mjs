// 手动实测候选模型（不进 vitest）：每个模型发一次很短的写作检查，记录耗时和 JSON 是否合格。
// 用法：ENV_FILE=/path/to/.env node server/probe-models.mjs [model1,model2,...]
// 只打印模型名、耗时和判定结果，绝不打印 Key。
import { fetch } from 'undici'
import { buildBody, loadConfig } from './index.mjs'

const cfg = loadConfig()
if (!cfg.apiKey) {
  console.error('没有读到 tokenspace_apikey，检查 ENV_FILE')
  process.exit(1)
}
// 请求体和服务器完全一致；EXTRA='{"enable_thinking":true}' 可覆盖参数做对比
const extra = JSON.parse(process.env.EXTRA || '{}')
const models = (process.argv[2] || 'deepseek-v4-flash,qwen3.8-flash,deepseek-v4.1-flash,qwen3.5-flash,deepseek-v3.2').split(',')

// 预期：E1 用对；E2 用错（人不能 feel counterproductive）；E3 没用上
const text = 'My school is toying with the idea of banning phones. I feel very counterproductive when I use my phone in class.'
const expressions = [
  { id: 'E1', text: 'toy with the idea', zh: '不太认真地考虑这个想法', example: 'Many schools are toying with the idea of banning phones in class.' },
  { id: 'E2', text: 'counterproductive', zh: '适得其反的', example: 'A blanket ban may prove counterproductive.' },
  { id: 'E3', text: 'blanket ban', zh: '全面禁令', example: 'A blanket ban may prove counterproductive.' },
]
const expected = { E1: 'correct', E2: 'incorrect', E3: 'unused' }

for (const model of models) {
  const t0 = Date.now()
  let line = `${model.padEnd(16)}`
  try {
    const res = await fetch(`${cfg.llmBaseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.apiKey}` },
      body: JSON.stringify({ ...buildBody(model, [], text, expressions), ...extra }),
      signal: AbortSignal.timeout(30000),
    })
    const ms = Date.now() - t0
    const data = await res.json()
    if (!res.ok) console.log(`    ${String(data?.error?.message ?? '').slice(0, 200)}`)
    const content = String(data?.choices?.[0]?.message?.content ?? '')
    let strict = false
    let parsed = null
    try {
      parsed = JSON.parse(content.trim())
      strict = true
    } catch {
      const m = content.match(/\{[\s\S]*\}/)
      try {
        parsed = m && JSON.parse(m[0])
      } catch {
        parsed = null
      }
    }
    const results = Array.isArray(parsed?.results) ? parsed.results : []
    const got = Object.fromEntries(results.map((r) => [r.id, r.used === false ? 'unused' : r.verdict]))
    const match = Object.keys(expected).filter((id) => got[id] === expected[id]).length
    const maxReason = Math.max(0, ...results.map((r) => String(r.reason || '').length))
    line += ` http=${res.status} ${ms}ms strictJSON=${strict} parsed=${Boolean(parsed)} ids=${results.length}/3 expected=${match}/3 maxReason=${maxReason}字 served=${data?.model ?? '-'}`
    console.log(line)
    for (const r of results) console.log(`    ${r.id} used=${r.used} ${r.verdict}：${r.reason}`)
  } catch (err) {
    console.log(`${line} error ${err?.name} ${Date.now() - t0}ms`)
  }
}
