// 入库管线第 2 步：按段落让大模型起草支架（梯子、原句题、段意题、注释、表达）。
// 规则负责「确定的部分」（句子 id、原文、打卡句、老师目标）；模型只负责「模糊的部分」。
// 模型输出先过 zod，再由 validate.ts 做子串、出处、术语等硬校验，最后人工确认。
import { z } from 'zod'
import { chatJson, type LlmConfig } from './llm'

export const PROMPT_VERSION = 'draft-v1'

const Choice3 = z.object({
  prompt: z.string().min(2),
  options: z.array(z.string().min(1)).length(3),
  answer: z.number().int().min(0).max(2),
})
const Choice2 = z.object({
  prompt: z.string().min(2),
  options: z.array(z.string().min(1)).length(2),
  answer: z.number().int().min(0).max(1),
})

export const DraftSentence = z.object({
  id: z.string(),
  ladder: z
    .object({
      subject: z.string().min(1),
      predicate: z.string().min(1),
      normalOrder: z.string().min(1),
      plain: z.string().min(1),
      glosses: z.array(z.object({ term: z.string(), zh: z.string() })).max(4),
    })
    .nullable(),
  question: Choice3.nullable(),
  mainObstacle: z.enum(['word', 'structure']).nullable(),
  tag: z.enum(['appositive_that', 'inversion', 'long_subject', 'reference']).nullable(),
})
export type DraftSentence = z.infer<typeof DraftSentence>

export const DraftWord = z.object({
  lemma: z.string(),
  forms: z.array(z.string()).min(1),
  sentenceIds: z.array(z.string()).min(1),
  zh: z.string(),
  familiarTrap: z.boolean(),
  guess: Choice2.nullable(),
})
export type DraftWord = z.infer<typeof DraftWord>

export const DraftExpression = z.object({
  text: z.string(),
  sentenceId: z.string(),
  zh: z.string(),
  pattern: z.string(),
})

export const DraftParagraph = z.object({
  gist: Choice3,
  topicSentenceId: z.string(),
  gistEn: z.string(),
  sentences: z.array(DraftSentence),
  words: z.array(DraftWord),
  expressions: z.array(DraftExpression),
})
export type DraftParagraph = z.infer<typeof DraftParagraph>

// 一段话的输入：全部来自规则抽取（讲义原文和老师原话），模型不改它们
export interface ParagraphInput {
  n: number
  sentences: {
    id: string
    text: string
    checkIn: boolean
    teacherNote?: string // 老师的「句子分析」
    teacherWords?: string[] // 老师在「词汇精讲」里讲到的词或短语
  }[]
  coreVocab: { term: string; zh: string }[] // 本段出现的 Day 1 核心词
  requiredExpressions: string[] // Day 5 写作要求的表达（如出现在本段）
}

export const SYSTEM_PROMPT = `你在为中国高中生的英语外刊精读作业起草「读懂支架」。原则：原文一字不改；支架帮助学生读懂意思，不讲语法。

只输出一个 JSON 对象，字段如下：
{
  "gist": {"prompt": 中文引导问题, "options": [3 个中文选项], "answer": 正确选项序号},
  "topicSentenceId": 最能概括本段的句子 id,
  "gistEn": 本段要点（简单英文，B1 水平，一句话）,
  "sentences": [每个输入句子一项: {
    "id": 句子 id,
    "ladder": 难句才给，否则 null: {
      "subject": 「谁」—— 必须是原句里逐字存在的连续片段,
      "predicate": 「做了什么」—— 必须是原句里逐字存在的连续片段,
      "normalOrder": 把句子调回最自然的英文语序（英文）,
      "plain": 用简单英文（B1）说出意思,
      "glosses": [最多 4 个难词/短语 {"term": 原文中的写法, "zh": 在本句语境中的中文意思}]
    },
    "question": 难句和打卡句给一道考「意思」的中文选择题，否则 null: {"prompt", "options": [3 个中文选项], "answer"},
    "mainObstacle": 难句的主要难点是 "word"（生词或熟词僻义）还是 "structure"（句子结构），简单句为 null,
    "tag": 只在老师的句子分析明确提到时才填："appositive_that"（同位语从句）、"inversion"（倒装）、"long_subject"（主语很长要找主干）、"reference"（代词指代），否则 null
  }],
  "words": [本段值得注释的词（必须包含给出的核心词）: {
    "lemma": 原形, "forms": [原文中出现的写法], "sentenceIds": [出现的句子 id],
    "zh": 在本文语境中的中文意思,
    "familiarTrap": 是否「熟词僻义」（常见词在这里是不常见的意思，如 blanket=全面的、pending=在……之前）,
    "guess": 熟词僻义或核心词给一道「先猜后看」二选一：{"prompt": "这里的 X 最可能是？", "options": [语境义, 一个常见但这里错误的意思], "answer"}，否则 null
  }],
  "expressions": [本段值得收进「表达本」、可以用在写作里的地道表达（短语优先，2–4 个；必须包含给出的写作要求表达）: {
    "text": 表达的基本形式（如 do more harm than good）, "sentenceId": 出处句子 id, "zh": 中文意思,
    "pattern": 一个不区分大小写的 JavaScript 正则字符串，能匹配这个表达的常见变形（动词时态、单复数），用 \\b 做边界
  }]
}

硬性要求：
- 学生能看到的所有中文（题目、选项、解释）都不能出现语法术语：倒装、同位语、从句、主语、谓语、宾语、状语、定语、表语、语法。
- 题目考意思（谁、做什么、为什么、作者态度），不考结构名称；干扰项要合理但明确错误。
- 打卡句（checkIn=true）一定要有 ladder 和 question，但 plain 不能是整句中文翻译。
- 不要编造原文没有的信息。`

export function userPrompt(p: ParagraphInput): string {
  return JSON.stringify(
    {
      paragraph: p.n,
      sentences: p.sentences,
      coreVocabInThisParagraph: p.coreVocab,
      requiredExpressionsInThisParagraph: p.requiredExpressions,
    },
    null,
    1,
  )
}

export async function draftParagraph(cfg: LlmConfig, p: ParagraphInput) {
  return chatJson(cfg, { system: SYSTEM_PROMPT, user: userPrompt(p), promptVersion: PROMPT_VERSION }, DraftParagraph)
}

// 自我修正：梯子 L1 不是原句子串时，把具体错误反馈给模型，只重写「谁 / 做了什么」两个片段
export const LadderFix = z.object({ subject: z.string().min(1), predicate: z.string().min(1) })

export async function repairLadderL1(cfg: LlmConfig, sentence: string, prev: { subject: string; predicate: string }) {
  const bad = [prev.subject, prev.predicate].filter((x) => !sentence.includes(x))
  return chatJson(
    cfg,
    {
      system:
        '你在修正一个英文句子的「读懂梯子」第 1 步。只输出 JSON：{"subject": 「谁」, "predicate": 「做了什么」}。两个值都必须是原句里逐字存在的连续片段（大小写、标点、空格完全一致），不能增删或改动任何词。',
      user: JSON.stringify({ sentence, previous: prev, problem: `这些片段不在原句里：${bad.join(' / ')}` }),
      promptVersion: 'repair-l1-v1',
    },
    LadderFix,
  )
}
