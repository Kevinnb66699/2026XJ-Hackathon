// 团队自写的迷你讲义（非老师讲义），用于测试和公开复现。格式与真实讲义入库结果一致。
import { Handout } from '../../shared/schema'

const human = { by: 'human' as const }

export const miniHandout = Handout.parse({
  id: 'mini-phones',
  title: 'Phones in class (团队自写样例)',
  rights: '团队原创样例文本，可自由使用',
  paragraphs: [
    {
      n: 1,
      gist: { id: 'P1-gist', prompt: '第一段主要讲了什么？', options: ['有人考虑禁止课堂用手机，但禁令可能适得其反', '手机让学生成绩变好', '家长反对学校'], answer: 0, provenance: human },
      topicSentenceId: 'S03',
      gistEn: 'Some want to ban phones in class, but a total ban may backfire before the evidence is clear.',
      provenance: human,
    },
    {
      n: 2,
      gist: { id: 'P2-gist', prompt: '第二段作者的建议是什么？', options: ['全面禁止手机', '教学生聪明地用手机', '让家长决定'], answer: 1, provenance: human },
      topicSentenceId: 'S05',
      gistEn: 'The evidence of harm is weak, so teaching wise use may work better.',
      provenance: human,
    },
  ],
  sentences: [
    {
      id: 'S01', paragraph: 1, day: 2, tier: 'focus', tag: 'inversion', mainObstacle: 'structure',
      text: 'Many schools are toying with the idea of banning phones in class; so are some parents.',
      ladder: {
        l1: { subject: 'Many schools', predicate: 'are toying with' },
        l2: 'Many schools are toying with the idea of banning phones in class; some parents are toying with it too.',
        l3: { plain: 'Schools, and some parents too, are thinking about banning phones.', glosses: [{ term: 'toy with', zh: '不太认真地考虑' }] },
        provenance: human,
      },
      question: { id: 'S01-q', prompt: '除了学校，还有谁在考虑这个想法？', options: ['一些家长', '一些学生', '没有别人'], answer: 0, provenance: human },
      teacherNote: 'so are some parents 是倒装，意思是「一些家长也是如此」。',
      sources: [{ day: 2, section: '原文精读学习', quote: 'so are some parents' }],
    },
    {
      id: 'S02', paragraph: 1, day: 2, tier: 'focus', tag: 'appositive_that', mainObstacle: 'structure',
      text: 'The proposal arises from a worry that screens distract pupils.',
      ladder: {
        l1: { subject: 'The proposal', predicate: 'arises from' },
        l2: 'The proposal comes from a worry: screens distract pupils.',
        l3: { plain: 'People suggest it because they worry screens distract students.', glosses: [{ term: 'arise from', zh: '由……引起' }] },
        provenance: human,
      },
      question: { id: 'S02-q', prompt: '人们担心的是什么？', options: ['屏幕让学生分心', '手机太贵', '老师不会用手机'], answer: 0, provenance: human },
      teacherNote: 'that 引导的从句解释 worry 的具体内容。',
      sources: [],
    },
    {
      id: 'S03', paragraph: 1, day: 2, tier: 'must', checkIn: true, mainObstacle: 'word',
      text: 'Yet, pending clearer evidence, a blanket ban may prove counterproductive.',
      ladder: {
        l1: { subject: 'a blanket ban', predicate: 'may prove' },
        l2: 'Yet a blanket ban may prove counterproductive, pending clearer evidence.',
        l3: { plain: 'Until the evidence is clearer, banning phones for everyone may backfire.', glosses: [{ term: 'pending', zh: '在……之前；等待……期间' }, { term: 'counterproductive', zh: '适得其反的' }] },
        provenance: human,
      },
      question: { id: 'S03-q', prompt: '这里的 pending clearer evidence 是什么意思？', options: ['在有更清楚的证据之前', '证据已经很清楚了', '等待中的禁令'], answer: 0, provenance: human },
      teacherNote: '如果对 pending 一词不够熟悉，可能会造成理解困难。',
      sources: [{ day: 2, section: '句子翻译#1', quote: 'a blanket ban may prove counterproductive' }],
    },
    {
      id: 'S04', paragraph: 2, day: 3, tier: 'focus', tag: 'appositive_that', mainObstacle: 'structure',
      text: 'The claim that phones harm every pupil has only limited support.',
      ladder: {
        l1: { subject: 'The claim', predicate: 'has' },
        l2: 'The claim (phones harm every pupil) has only limited support.',
        l3: { plain: 'There is little evidence that phones hurt all students.', glosses: [] },
        provenance: human,
      },
      question: { id: 'S04-q', prompt: '作者怎么看「手机伤害每个学生」这个说法？', options: ['证据有限', '完全正确', '没有提到'], answer: 0, provenance: human },
      teacherNote: 'that 从句说明 claim 的内容，主干是 The claim has only limited support。',
      sources: [],
    },
    {
      id: 'S05', paragraph: 2, day: 3, tier: 'other', tag: 'long_subject',
      text: 'Teachers who fret about distraction could instead teach pupils to use phones wisely.',
      sources: [],
    },
  ],
  words: [
    { lemma: 'pending', forms: ['pending'], sentenceIds: ['S03'], zh: '在……之前；等待……期间', teacherCore: true, familiarTrap: true, tier: 'must',
      guess: { id: 'w-pending', prompt: '这里 pending 最可能的意思？', options: ['在……之前', '待定的'], answer: 0, provenance: human }, sources: [{ day: 1, section: '核心词汇表', quote: 'pending' }] },
    { lemma: 'counterproductive', forms: ['counterproductive'], sentenceIds: ['S03'], zh: '适得其反的', teacherCore: true, tier: 'must', sources: [{ day: 1, section: '核心词汇表', quote: 'counterproductive' }] },
    { lemma: 'blanket', forms: ['blanket'], sentenceIds: ['S03'], zh: '全面的', familiarTrap: true, tier: 'focus',
      guess: { id: 'w-blanket', prompt: '这里 blanket 最可能的意思？', options: ['全面的', '毯子'], answer: 0, provenance: human }, sources: [] },
    { lemma: 'fret', forms: ['fret'], sentenceIds: ['S05'], zh: '苦恼；焦虑', teacherCore: true, tier: 'must', sources: [{ day: 1, section: '核心词汇表', quote: 'fret' }] },
    { lemma: 'distract', forms: ['distract', 'distraction'], sentenceIds: ['S02', 'S05'], zh: '使分心', tier: 'other', sources: [] },
    { lemma: 'pupil', forms: ['pupils', 'pupil'], sentenceIds: ['S02', 'S04', 'S05'], zh: '学生', tier: 'other', sources: [] },
  ],
  expressions: [
    { id: 'E1', text: 'toy with the idea', sentenceId: 'S01', zh: '不太认真地考虑这个想法', pattern: '\\btoy(s|ed|ing)?\\s+with\\b', sources: [] },
    { id: 'E2', text: 'counterproductive', sentenceId: 'S03', zh: '适得其反的', teacherRequired: true, pattern: '\\bcounterproductive\\b', sources: [{ day: 5, section: '写作', quote: 'counterproductive' }] },
    { id: 'E3', text: 'blanket ban', sentenceId: 'S03', zh: '全面禁令', teacherRequired: true, pattern: '\\bblanket\\s+bans?\\b', sources: [{ day: 5, section: '写作', quote: 'blanket bans' }] },
  ],
  writing: { prompt: '用今天学到的表达，写 2-3 句话谈谈你对课堂手机禁令的看法。', requiredExpressionIds: ['E2', 'E3'] },
})
