// 数据契约：讲义入库管线、前端、测试、校验器共用这一份定义。
// 原则：原文一字不改；适配的是支架（注释、梯子、讲解收起/展开、练习），不是文本。
import { z } from 'zod'

// 老师目标分级：must=必练（永不折叠）, focus=精讲项（可按直接证据收起，可展开）, other=其他
export const Tier = z.enum(['must', 'focus', 'other'])
export type Tier = z.infer<typeof Tier>

// 出处：每条内容都能回到老师讲义原话
export const Source = z.object({
  day: z.number().int().min(1).max(5),
  section: z.string(), // 如 '核心词汇表'、'功能词填空#4'、'句子翻译#1'、'原文精读学习'
  quote: z.string(), // 讲义原文片段，校验器检查它是讲义文本的子串
})
export type Source = z.infer<typeof Source>

// 生成来源留痕
export const Provenance = z.object({
  by: z.enum(['rule', 'llm', 'human']),
  model: z.string().optional(),
  promptVersion: z.string().optional(),
  reviewedBy: z.string().optional(),
})
export type Provenance = z.infer<typeof Provenance>

// 考意思的选择题（原句微题、段意题、先猜后看）
export const Question = z.object({
  id: z.string(),
  prompt: z.string(),
  options: z.array(z.string()).min(2),
  answer: z.number().int().min(0),
  provenance: Provenance,
})
export type Question = z.infer<typeof Question>

// 读懂梯子：L1 谁做了什么 → L2 调回正常语序 → L3 简单英文说出意思（+ 难词中文）
export const Ladder = z.object({
  l1: z.object({
    subject: z.string(), // 必须是原句子串
    predicate: z.string(), // 必须是原句子串
  }),
  l2: z.string(),
  l3: z.object({
    plain: z.string(),
    glosses: z.array(z.object({ term: z.string(), zh: z.string() })),
  }),
  provenance: Provenance,
})
export type Ladder = z.infer<typeof Ladder>

// 梯子新第 2、3 步：把原句拆成几块（每块是原句原话，标签用大白话）+ 整句中文。
// 单独成块、单独记来源，不动人工审过的 ladder；没有它的句子（如上传的讲义）仍用 ladder.l2 / l3.plain
export const BREAKDOWN_LABELS = ['谁', '做了什么', '对谁·对什么', '什么时候·在哪里', '为什么', '怎么样', '补充说明'] as const
export const Breakdown = z.object({
  parts: z.array(z.object({ label: z.string(), text: z.string(), hint: z.string().optional() })).min(1),
  zh: z.string(),
  provenance: Provenance,
})
export type Breakdown = z.infer<typeof Breakdown>

// 结构标签只在教师端出现；学生端不出现任何语法术语
export const StructureTag = z.enum(['appositive_that', 'inversion', 'long_subject', 'reference'])
export type StructureTag = z.infer<typeof StructureTag>

export const Sentence = z.object({
  id: z.string(), // S01..S29
  paragraph: z.number().int().min(1),
  day: z.number().int(), // 哪一天精读覆盖它（2 或 3）
  text: z.string(),
  tier: Tier,
  checkIn: z.boolean().default(false), // 打卡翻译句
  tag: StructureTag.optional(), // 每句只取一个主标签
  mainObstacle: z.enum(['word', 'structure']).optional(), // 卡点主要在词还是结构
  ladder: Ladder.optional(),
  breakdown: Breakdown.optional(), // 梯子第 2、3 步的新内容（拆开 + 整句中文）
  question: Question.optional(), // 原句微题（考意思）
  teacherNote: z.string().optional(), // 老师的「句子分析」
  sources: z.array(Source).default([]),
})
export type Sentence = z.infer<typeof Sentence>

// 段落级读懂支架：引导问题 → 标出主题句 → 英文要点
export const Paragraph = z.object({
  n: z.number().int().min(1),
  gist: Question,
  topicSentenceId: z.string(),
  gistEn: z.string(),
  provenance: Provenance,
})
export type Paragraph = z.infer<typeof Paragraph>

export const Word = z.object({
  lemma: z.string(),
  forms: z.array(z.string()).min(1), // 原文中出现的词形，如 shovelled
  sentenceIds: z.array(z.string()).min(1),
  zh: z.string(),
  en: z.string().optional(),
  pos: z.string().optional(), // 词性，如 v.、phr.（核心词取自老师词汇表）
  cefr: z.string().optional(),
  teacherCore: z.boolean().default(false), // Day 1 核心词汇表
  familiarTrap: z.boolean().default(false), // 熟词僻义，一律按难处理
  guess: Question.optional(), // 先猜后看的二选一
  tier: Tier,
  sources: z.array(Source).default([]),
})
export type Word = z.infer<typeof Word>

// 表达链：精读收集 → 写作中用出来 → 检查 → 下次先自己试
export const Expression = z.object({
  id: z.string(),
  text: z.string(), // 如 'do more harm than good'
  sentenceId: z.string(),
  zh: z.string(),
  teacherRequired: z.boolean().default(false), // Day 5 写作明确要求
  pattern: z.string(), // 规则检查「有没有用上」的正则（不区分大小写）
  sources: z.array(Source).default([]),
})
export type Expression = z.infer<typeof Expression>

export const Handout = z.object({
  id: z.string(),
  title: z.string(),
  rights: z.string(), // 授权说明
  paragraphs: z.array(Paragraph),
  sentences: z.array(Sentence).min(1),
  words: z.array(Word),
  expressions: z.array(Expression),
  writing: z.object({
    prompt: z.string(),
    requiredExpressionIds: z.array(z.string()),
  }),
})
export type Handout = z.infer<typeof Handout>

// 学生画像：3 题问卷 + 学习过程中的行为，不存「已掌握」字段
export const Survey = z.object({
  grade: z.string(),
  curriculum: z.string(),
  stuckOn: z.enum(['words', 'long_sentences', 'paragraph_meaning', 'author_view']),
})
export type Survey = z.infer<typeof Survey>

export const EventType = z.enum([
  'tap_word', // 粗读时点了不认识的词
  'word_card', // 学生词卡片：认识/不认识
  'gist_answer', // 段意题作答
  'open_ladder', // 打开梯子到第 level 级
  'answer_question', // 原句微题作答
  'feedback', // 太简单/刚好/太难
  'writing_submit',
  'page_view', // 学生端进入某一步，value 是步骤名，用来看每台设备走到了哪一步
  'client_error', // 前端报错，value 是截短的错误信息
])
export type EventType = z.infer<typeof EventType>

export const LearningEvent = z.object({
  sid: z.string(), // 匿名学生 id
  ts: z.number(),
  handoutId: z.string(),
  type: EventType,
  sentenceId: z.string().optional(),
  paragraph: z.number().int().optional(),
  lemma: z.string().optional(),
  level: z.number().int().min(1).max(3).optional(),
  correct: z.boolean().optional(),
  firstTry: z.boolean().optional(),
  value: z.string().optional(),
})
export type LearningEvent = z.infer<typeof LearningEvent>
