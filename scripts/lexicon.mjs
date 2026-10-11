// 给已经生成好的上传讲义补「全文词义」（10-11 之前生成的没有，学生粗读点了词表外的词，「生词」里不出现）。在服务器上用：
//   cd /srv/zhishi && node scripts/lexicon.mjs [讲义 id …]      不给 id 就补所有还没有的
// 模型配置和上传一样（.env 的 LLM_API_KEY、LLM_BASE_URL、PIPELINE_MODEL），要先 npm run build（部署时已经做了）。
// 请模型要十几秒；写之前重新读一次讲义，只加 lexicon，老师这时改了讲解也不会被盖掉。临时文件 + 改名，文件只给本用户读写
import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { loadConfig } from '../server/index.mjs'

const { addLexicon } = await import('../dist-server/article.mjs')

const cfg = loadConfig()
if (!cfg.apiKey) {
  console.error('缺少 LLM_API_KEY（写在 .env 里）')
  process.exitCode = 1
}
const llm = {
  baseUrl: cfg.llmBaseUrl,
  apiKey: cfg.apiKey,
  model: cfg.pipelineModel,
  cacheDir: path.join(cfg.dataDir, 'llm-cache'),
  replay: false,
  timeoutMs: 90000,
  thinking: false,
}
const dir = path.join(cfg.dataDir, 'handouts')
const file = (id) => path.join(dir, `${id}.json`)
const ids = !cfg.apiKey ? [] : process.argv.slice(2).length
  ? process.argv.slice(2)
  : fs.readdirSync(dir).filter((f) => /^up-[a-z0-9]+\.json$/.test(f)).map((f) => f.slice(0, -5))

for (const id of ids) {
  if (!/^up-[a-z0-9]+$/.test(id) || !fs.existsSync(file(id))) {
    console.error(`${id}：没有这份讲义`)
    process.exitCode = 1
    continue
  }
  const h = JSON.parse(fs.readFileSync(file(id), 'utf8'))
  if (h.lexicon) {
    console.log(`${id}：已经有全文词义（${h.lexicon.words.length} 个词条），跳过`)
    continue
  }
  const t0 = Date.now()
  const r = await addLexicon(llm, h)
  // 有一批出错就不写：写了下次就当「已经有」跳过，缺的词再也补不上。重跑时答成的批从 llm-cache 取，只重问出错的
  if (!h.lexicon || r.failed) {
    console.error(`${id}：没配全（${r.failed} 批出错），讲义没动，过一会儿再跑一次`)
    process.exitCode = 1
    continue
  }
  const fresh = JSON.parse(fs.readFileSync(file(id), 'utf8'))
  fresh.lexicon = h.lexicon
  const tmp = `${file(id)}.${randomBytes(6).toString('hex')}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(fresh), { mode: 0o600 })
  fs.renameSync(tmp, file(id))
  console.log(`${id}：配了 ${r.words} 个词条，${r.missing} 个词没配上${r.failed ? `（${r.failed} 批出错）` : ''}，${((Date.now() - t0) / 1000).toFixed(1)} 秒`)
}
