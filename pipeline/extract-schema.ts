// 讲义规则抽取结果（extract.json）的结构。这是入库管线的第一步产物：只有讲义里明写的内容，
// 不含大模型起草的梯子/题目。数量（29 句、15 词……）属于这份讲义，放在测试里检查，不写死在这里。
import { z } from 'zod'
import { Source } from '../shared/schema'

const SentenceId = z.string().regex(/^S\d{2}$/)
const Day = z.number().int().min(1).max(5)
const Choice = z.object({
  n: z.number().int().min(1),
  stem: z.string().min(1),
  options: z.array(z.string().min(1)).length(4), // A-D
  answer: z.null(), // 讲义不给答案
  source: Source,
})

export const Extract = z.object({
  handoutId: z.string(),
  article: z.object({
    paragraphs: z.array(z.object({ n: z.number().int().min(1), text: z.string(), sentenceIds: z.array(SentenceId).min(1) })),
    sentences: z.array(z.object({ id: SentenceId, paragraph: z.number().int().min(1), text: z.string().min(1), source: Source })),
  }),
  // 精读哪一天覆盖哪几段
  dayCoverage: z.array(z.object({ day: Day, paragraphs: z.array(z.number().int()), sentenceIds: z.array(SentenceId), source: Source })),
  coreVocab: z.array(
    z.object({
      term: z.string(),
      phonetic: z.string().nullable(), // 讲义写「-」的为 null
      pos: z.string(),
      zh: z.string(),
      enHint: z.string(),
      source: Source,
    }),
  ),
  vocabQuiz: z.array(Choice),
  summaryCloze: z.object({
    text: z.string(),
    blanks: z.array(
      z.object({
        n: z.number().int().min(1),
        initial: z.string().length(1),
        answer: z.string().nullable(), // 能唯一推断才填
        inferred: z.boolean(), // 讲义没给答案，填上的都是推断的
        source: Source,
      }),
    ),
  }),
  detailQuestions: z.array(Choice.extend({ day: Day })),
  functionCloze: z.array(
    z.object({ day: Day, n: z.number().int().min(1), sentenceId: SentenceId, answer: z.string().min(1), source: Source }),
  ),
  checkIn: z.array(z.object({ day: Day, n: z.number().int().min(1), sentenceId: SentenceId, source: Source })),
  analyses: z.object({
    blocks: z.array(
      z.object({
        day: Day,
        n: z.number().int().min(1),
        sentenceIds: z.array(SentenceId).min(1),
        source: Source, // quote = 老师引用的原文片段
        vocab: z.array(
          z.object({ term: z.string(), pos: z.string().optional(), note: z.string(), sentenceIds: z.array(SentenceId).min(1), source: Source }),
        ),
        notes: z.array(z.object({ text: z.string(), sentenceIds: z.array(SentenceId).min(1), source: Source })),
      }),
    ),
    // 按句子归集：句子 id → 该句的词汇精讲词条和句子分析原话
    bySentence: z.record(z.object({ vocab: z.array(z.string()), notes: z.array(z.string()) })),
  }),
  sightTranslation: z.array(z.object({ n: z.number().int().min(1), sentenceIds: z.array(SentenceId).min(1), source: Source })),
  retellKeywords: z.array(
    z.object({ part: z.number().int().min(1), title: z.string(), keywords: z.array(z.string()).min(1), tip: z.string(), source: Source }),
  ),
  day5: z.object({
    questions: z.array(z.object({ n: z.number().int().min(1), question: z.string(), hint: z.string(), source: Source })),
    writing: z.object({
      topic: z.string(),
      topicZh: z.string(),
      requirements: z.array(z.string()),
      structure: z.array(z.string()),
      requiredExpressions: z.array(z.object({ text: z.string(), source: Source })),
      source: Source,
    }),
  }),
})
export type Extract = z.infer<typeof Extract>
