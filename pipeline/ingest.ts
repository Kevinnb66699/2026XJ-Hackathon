// 入库管线（老师侧，每份讲义跑一次）：
//   规则抽取 extract.json  +  大模型按段起草（并行）  →  合成 Handout  →  校验  →  data/handouts/<id>.json + pipeline/report.md
// 用法：npm run ingest                  调用模型（结果写入 pipeline/cache/）
//       npm run ingest -- --replay      只用缓存复跑，不联网（评委可复现）
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { dirname } from 'path'
import { Handout, type Expression, type Paragraph, type Provenance, type Sentence, type Source, type Word } from '../shared/schema'
import { draftParagraph, PROMPT_VERSION, repairLadderL1, type DraftParagraph, type ParagraphInput } from './draft'
import { Extract } from './extract-schema'
import { configFromEnv } from './llm'
import { findForms, patternFor, shuffleChoice } from './text-utils'
import { validateHandout, type Issue } from './validate'

interface Options {
  extractPath: string
  outPath: string
  reportPath: string
  replay: boolean
}

function parseArgs(argv: string[]): Options {
  const get = (k: string) => argv.find((a) => a.startsWith(`--${k}=`))?.split('=')[1]
  return {
    extractPath: get('extract') ?? 'data/extract/social-media.extract.json',
    outPath: get('out') ?? 'data/handouts/social-media.json',
    reportPath: get('report') ?? 'pipeline/report.md',
    replay: argv.includes('--replay'),
  }
}

const lower = (s: string) => s.toLowerCase()

export async function ingest(opts: Options) {
  const started = Date.now()
  const ex = Extract.parse(JSON.parse(readFileSync(opts.extractPath, 'utf8')))
  const rawByDay: Record<number, string> = {}
  for (let d = 1; d <= 5; d++) if (existsSync(`data/raw/day${d}.txt`)) rawByDay[d] = readFileSync(`data/raw/day${d}.txt`, 'utf8')

  const checkInBy = new Map(ex.checkIn.map((c) => [c.sentenceId, c]))
  const coreLower = ex.coreVocab.map((v) => ({ ...v, key: lower(v.term.replace(/\.\.\./g, ' ').trim()) }))
  const dayOf = (paragraph: number) => ex.dayCoverage.find((c) => c.paragraphs.includes(paragraph))?.day ?? 2

  // ① 每段准备输入（全部来自规则抽取），并行起草
  const inputs: ParagraphInput[] = ex.article.paragraphs.map((p) => {
    const sents = ex.article.sentences.filter((s) => s.paragraph === p.n)
    const paraText = sents.map((s) => s.text).join(' ')
    return {
      n: p.n,
      sentences: sents.map((s) => ({
        id: s.id,
        text: s.text,
        checkIn: checkInBy.has(s.id),
        teacherNote: ex.analyses.bySentence[s.id]?.notes.join(' ') || undefined,
        teacherWords: ex.analyses.bySentence[s.id]?.vocab,
      })),
      coreVocab: ex.coreVocab.filter((v) => findForms(v.term, sents).sentenceIds.length).map((v) => ({ term: v.term, zh: v.zh })),
      requiredExpressions: ex.day5.writing.requiredExpressions.map((e) => e.text).filter((t) => new RegExp(patternFor(t), 'i').test(paraText)),
    }
  })
  const cfg = { ...configFromEnv({ replay: opts.replay }) }
  // 各段并行起草；某段失败不影响其他段（已成功的会写进缓存），失败的段再重试一次
  const settle = (list: ParagraphInput[]) => Promise.allSettled(list.map((inp) => draftParagraph(cfg, inp)))
  let results = await settle(inputs)
  const failedIdx = results.map((r, i) => (r.status === 'rejected' ? i : -1)).filter((i) => i >= 0)
  if (failedIdx.length) {
    // 重试时关闭模型思考：首轮超时多半是思考太久，关掉后快很多
    console.log(`第 ${failedIdx.map((i) => inputs[i].n).join('、')} 段起草失败，关闭思考模式重试一次……`)
    const retried = await Promise.allSettled(failedIdx.map((i) => draftParagraph({ ...cfg, thinking: false }, inputs[i])))
    failedIdx.forEach((i, k) => (results[i] = retried[k]))
  }
  const stillFailed = results.map((r, i) => (r.status === 'rejected' ? `第 ${inputs[i].n} 段：${String((r as PromiseRejectedResult).reason).slice(0, 200)}` : '')).filter(Boolean)
  if (stillFailed.length) throw new Error(`起草失败：\n${stillFailed.join('\n')}`)
  const drafts = results.map((r) => (r as PromiseFulfilledResult<Awaited<ReturnType<typeof draftParagraph>>>).value)
  const llm = (model: string): Provenance => ({ by: 'llm', model, promptVersion: PROMPT_VERSION })

  // ② 合成 Handout：确定部分来自规则，模糊部分来自模型
  const draftById = new Map<string, { d: DraftParagraph['sentences'][number]; model: string }>()
  drafts.forEach((r) => r.data.sentences.forEach((d) => draftById.set(d.id, { d, model: r.model })))

  const sentences: Sentence[] = ex.article.sentences.map((s) => {
    const dr = draftById.get(s.id)
    const notes = ex.analyses.bySentence[s.id]?.notes ?? []
    const sources: Source[] = [s.source]
    const ci = checkInBy.get(s.id)
    if (ci) sources.push(ci.source)
    for (const b of ex.analyses.blocks) if (b.sentenceIds.includes(s.id)) sources.push(b.source)
    const d = dr?.d
    return {
      id: s.id,
      paragraph: s.paragraph,
      day: dayOf(s.paragraph),
      text: s.text,
      tier: ci ? 'must' : notes.length ? 'focus' : 'other',
      checkIn: !!ci,
      tag: d?.tag ?? undefined,
      mainObstacle: d?.mainObstacle ?? undefined,
      ladder: d?.ladder
        ? {
            l1: { subject: d.ladder.subject, predicate: d.ladder.predicate },
            l2: d.ladder.normalOrder,
            l3: { plain: d.ladder.plain, glosses: d.ladder.glosses },
            provenance: llm(dr!.model),
          }
        : undefined,
      question: d?.question ? shuffleChoice({ id: `${s.id}-q`, ...d.question, provenance: llm(dr!.model) }) : undefined,
      teacherNote: notes.join(' ') || undefined,
      sources,
    }
  })

  const paragraphs: Paragraph[] = drafts.map((r, i) => {
    const n = inputs[i].n
    const inPara = sentences.filter((s) => s.paragraph === n)
    const topic = inPara.some((s) => s.id === r.data.topicSentenceId) ? r.data.topicSentenceId : inPara[0].id
    return { n, gist: shuffleChoice({ id: `P${n}-gist`, ...r.data.gist, provenance: llm(r.model) }), topicSentenceId: topic, gistEn: r.data.gistEn, provenance: llm(r.model) }
  })

  // 词：模型起草的词 + 老师核心词（核心词以老师释义为准，标为必练）
  const words = new Map<string, Word>()
  drafts.forEach((r) =>
    r.data.words.forEach((w) => {
      const key = lower(w.lemma)
      const prev = words.get(key)
      if (prev) {
        prev.forms = [...new Set([...prev.forms, ...w.forms.map((f) => f.split('...')[0].trim()).filter(Boolean)])]
        prev.sentenceIds = [...new Set([...prev.sentenceIds, ...w.sentenceIds])]
        return
      }
      const teacherWord = Object.values(ex.analyses.bySentence).some((b) => b.vocab.some((v) => lower(v).startsWith(key)))
      words.set(key, {
        lemma: w.lemma,
        forms: [...new Set(w.forms.map((f) => f.split('...')[0].trim()).filter(Boolean))],
        sentenceIds: w.sentenceIds,
        zh: w.zh,
        familiarTrap: w.familiarTrap,
        teacherCore: false,
        guess: w.guess ? shuffleChoice({ id: `w-${key.replace(/\W+/g, '-')}`, ...w.guess, provenance: llm(r.model) }) : undefined,
        tier: teacherWord ? 'focus' : 'other',
        sources: [],
      })
    }),
  )
  for (const v of coreLower) {
    const first = v.key.split(/\s+/)[0]
    const match = [...words.values()].find((w) => lower(w.lemma) === v.key || lower(w.lemma).startsWith(first.slice(0, Math.max(4, first.length - 1))))
    const found = findForms(v.term, ex.article.sentences)
    if (match) {
      match.teacherCore = true
      match.tier = 'must'
      match.zh = v.zh
      match.en = v.enHint || undefined
      match.sources = [v.source]
    } else if (found.sentenceIds.length) {
      words.set(v.key, { lemma: v.term, forms: found.forms, sentenceIds: found.sentenceIds, zh: v.zh, en: v.enHint || undefined, teacherCore: true, familiarTrap: false, tier: 'must', sources: [v.source] })
    }
  }

  // 表达：模型起草 + Day 5 写作要求（老师要求的标为必练）
  const expressions: Expression[] = []
  const seen = new Set<string>()
  const addExpr = (e: Omit<Expression, 'id'>) => {
    const key = lower(e.text).replace(/s\b/g, '')
    if (seen.has(key)) return expressions.find((x) => lower(x.text).replace(/s\b/g, '') === key)!
    seen.add(key)
    const full = { id: `E${String(expressions.length + 1).padStart(2, '0')}`, ...e }
    expressions.push(full)
    return full
  }
  const requiredIds: string[] = []
  for (const req of ex.day5.writing.requiredExpressions) {
    const pattern = patternFor(req.text)
    const sent = ex.article.sentences.find((s) => new RegExp(pattern, 'i').test(s.text))
    if (!sent) continue
    const core = coreLower.find((v) => lower(req.text).startsWith(v.key.split(/\s+/)[0].slice(0, 5)))
    const e = addExpr({ text: req.text, sentenceId: sent.id, zh: core?.zh ?? req.text, teacherRequired: true, pattern, sources: [req.source] })
    e.teacherRequired = true
    requiredIds.push(e.id)
  }
  drafts.forEach((r) => r.data.expressions.forEach((e) => addExpr({ text: e.text, sentenceId: e.sentenceId, zh: e.zh, teacherRequired: false, pattern: patternFor(e.text), sources: [] })))

  const handout = Handout.parse({
    id: ex.handoutId,
    title: '青少年社交媒体禁令（外刊精读 Day 1–5）',
    rights: '学校老师布置的外刊讲义，仅用于比赛演示；授权情况见 DATA_SOURCES.md',
    paragraphs,
    sentences,
    words: [...words.values()],
    expressions,
    writing: { prompt: `用这周学到的表达写 2–3 句：${ex.day5.writing.topicZh}`, requiredExpressionIds: [...new Set(requiredIds)] },
  })

  // ③ 自我修正：梯子 L1 不是原句子串的，把错误反馈给模型重写一次（并行）
  const repaired: string[] = []
  await Promise.all(
    handout.sentences
      .filter((s) => s.ladder && !(s.text.includes(s.ladder.l1.subject) && s.text.includes(s.ladder.l1.predicate)))
      .map(async (s) => {
        try {
          const fix = await repairLadderL1(cfg, s.text, s.ladder!.l1)
          if (s.text.includes(fix.data.subject) && s.text.includes(fix.data.predicate)) {
            repaired.push(`${s.id}：${s.ladder!.l1.predicate} → ${fix.data.predicate}`)
            s.ladder!.l1 = fix.data
          }
        } catch {
          // 修正失败就交给下面的校验剔除
        }
      }),
  )

  // ④ 校验：仍不合格的模型产出自动剔除，并列进报告等人工补
  const dropped: string[] = []
  let issues: Issue[] = validateHandout(handout, rawByDay)
  for (const i of issues.filter((x) => x.level === 'error')) {
    const m = i.where.match(/^sentence (S\d+)( question)?$/)
    const s = m && handout.sentences.find((x) => x.id === m[1])
    if (s && i.message.includes('梯子')) {
      s.ladder = undefined
      dropped.push(`${s.id} 梯子：${i.message}`)
    } else if (s && m![2]) {
      s.question = undefined
      dropped.push(`${s.id} 原句题：${i.message}`)
    }
    const w = i.where.match(/^word (.+?)( guess)?$/)
    const word = w && handout.words.find((x) => x.lemma === w[1])
    if (word && w![2]) {
      word.guess = undefined
      dropped.push(`${word.lemma} 先猜后看：${i.message}`)
    } else if (word && i.message.includes('不在句子')) {
      handout.words = handout.words.filter((x) => x !== word)
      dropped.push(`词 ${word.lemma}：${i.message}`)
    }
    const e = i.where.match(/^expression (E\d+)$/)
    if (e && !handout.expressions.find((x) => x.id === e[1])?.teacherRequired) {
      handout.expressions = handout.expressions.filter((x) => x.id !== e[1])
      dropped.push(`表达 ${e[1]}：${i.message}`)
    }
  }
  issues = validateHandout(handout, rawByDay)
  const errors = issues.filter((x) => x.level === 'error')

  mkdirSync(dirname(opts.outPath), { recursive: true })
  writeFileSync(opts.outPath, JSON.stringify(handout, null, 1) + '\n')

  // ⑤ 报告：过程留痕，也是给评委看的「AI 在哪一步、做了什么、被拦下了什么」
  const ladders = handout.sentences.filter((s) => s.ladder).length
  const questions = handout.sentences.filter((s) => s.question).length
  const models = [...new Set(drafts.map((r) => r.model))]
  const report = [
    `# 入库报告：${handout.title}`,
    '',
    `- 生成时间：${new Date().toISOString()}；耗时 ${((Date.now() - started) / 1000).toFixed(1)} 秒；${opts.replay ? '回放缓存（未联网）' : '调用模型'}`,
    `- 模型：${models.join('、')}；提示词版本 ${PROMPT_VERSION}；${drafts.filter((r) => r.cached).length}/${drafts.length} 段命中缓存`,
    `- 规则抽取：${handout.sentences.length} 句、${ex.coreVocab.length} 个核心词、${ex.checkIn.length} 句打卡、${ex.functionCloze.length} 个功能词填空、${ex.analyses.blocks.length} 段精讲`,
    `- 模型起草：${ladders} 架梯子、${questions} 道原句题、${handout.paragraphs.length} 道段意题、${handout.words.length} 个注释词、${handout.expressions.length} 个表达`,
    `- 自我修正 ${repaired.length} 条（把校验错误反馈给模型重写）：`,
    ...repaired.map((r) => `  - ${r}`),
    `- 校验器自动剔除 ${dropped.length} 条（需人工补写）：`,
    ...dropped.map((d) => `  - ${d}`),
    `- 剔除后校验：${errors.length} 个错误，${issues.length - errors.length} 个提醒`,
    ...issues.map((i) => `  - ${i.level === 'error' ? '错误' : '提醒'} [${i.where}] ${i.message}`),
    '',
    '人工确认：以上内容需由老师或队友逐条确认后才发布给学生。',
  ].join('\n')
  writeFileSync(opts.reportPath, report + '\n')
  // 结构化报告：教师页的「讲义入库」面板直接读它，展示 AI 起草了什么、校验拦下了什么
  writeFileSync(
    opts.outPath.replace(/\.json$/, '.report.json'),
    JSON.stringify(
      {
        handoutId: handout.id,
        durationSec: Math.round((Date.now() - started) / 100) / 10,
        replay: opts.replay,
        models,
        promptVersion: PROMPT_VERSION,
        cachedParagraphs: drafts.filter((r) => r.cached).length,
        paragraphs: drafts.length,
        extracted: { sentences: handout.sentences.length, coreWords: ex.coreVocab.length, checkIn: ex.checkIn.length, functionCloze: ex.functionCloze.length, analyses: ex.analyses.blocks.length },
        drafted: { ladders, questions, gists: handout.paragraphs.length, words: handout.words.length, expressions: handout.expressions.length },
        repaired,
        dropped,
        warnings: issues.filter((i) => i.level === 'warn').map((i) => `[${i.where}] ${i.message}`),
        errors: errors.length,
      },
      null,
      1,
    ) + '\n',
  )
  console.log(report)
  if (errors.length) process.exitCode = 1
  return { handout, issues, dropped, repaired }
}

ingest(parseArgs(process.argv.slice(2))).catch((e) => {
  console.error(e)
  process.exit(1)
})
