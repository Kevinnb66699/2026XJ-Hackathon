// 全班情况：教师端「全班情况」卡片显示它，「生成教学建议」把它原样发给后端。纯函数，不调用 AI。
// 只有人数、次数、句子编号和原文、老师的精讲、结构标签、词、段意题题干；没有学生编号、称呼、写作和反馈原文。
// 「卡在中以上」「做过这一句」的口径和热力图、抽屉一样（engine 的 stuck）；段意题和「粗读 · 段意题」一样。
import type { Handout, LearningEvent, StructureTag } from '../../shared/schema'
import { stuck, unknownWords } from '../engine'
import type { StudentState } from '../engine/types'

export interface ClassSummary {
  students: number // 有学习记录的人数
  reached: { gist: number; words: number; close: number; writing: number } // 粗读、词汇、精读、写作各有记录的人数
  // 卡在「中」以上的人最多的 3 句：n 人卡住 / of 人做过，ok 人自己读懂（没开梯子、第一次就答对）；note 是老师讲义里的精讲
  hardSentences: { id: string; text: string; tag?: StructureTag; n: number; of: number; ok: number; note?: string }[]
  hardTag: { tag: StructureTag; n: number; of: number } | null // 至少一句卡在「中」以上的人数最多的结构
  words: { lemma: string; zh: string; n: number; of: number }[] // 核心词、熟词僻义、必练词里不认识的人最多的 5 个：n 人不认识 / of 人有记录
  wordsTied: number // 和第 5 个词数字一样的词一共几个（含列出的）；没有因为只列 5 个被截掉的词时为 0
  // 第一次答对比例最低的段意题，并列的都列上；prompt 是讲义里这一段段意题的题干
  gist: { paragraph: number; prompt: string; firstTry: number; of: number }[]
  firstTry: { correct: number; answered: number; pct: number } // 原句题：第一次就答对的次数 / 作答次数
}

// 比例高的在前：a/b 与 c/d 交叉相乘，免得除以 0
const byShare = (a: { n: number; of: number }, b: { n: number; of: number }) => b.n - a.n || b.n * a.of - a.n * b.of

export function classSummary(h: Handout, students: StudentState[], events: LearningEvent[]): ClassSummary {
  const levels = new Map(h.sentences.map((x) => [x.id, students.map((s) => stuck(h, s, x.id).level)]))
  const hardSids = (id: string) => students.filter((_, i) => (levels.get(id)![i] ?? 0) >= 2).map((s) => s.sid)
  const touchedSids = (id: string) => students.filter((_, i) => levels.get(id)![i] !== null).map((s) => s.sid)

  const own = (id: string) => {
    const q = h.sentences.find((x) => x.id === id)?.question
    return q ? students.filter((s) => s.answers[q.id]?.firstTryCorrect && !s.ladder[id]).length : 0
  }
  const hardSentences = h.sentences
    .map((x) => ({ x, n: hardSids(x.id).length, of: touchedSids(x.id).length }))
    .filter((r) => r.n > 0)
    .sort(byShare)
    .slice(0, 3)
    .map(({ x, n, of }) => ({ id: x.id, text: x.text, ...(x.tag ? { tag: x.tag } : {}), n, of, ok: own(x.id), ...(x.teacherNote ? { note: x.teacherNote } : {}) }))

  const tags = [...new Set(h.sentences.flatMap((x) => (x.tag ? [x.tag] : [])))]
  const ofTag = (tag: StructureTag, pick: (id: string) => string[]) => new Set(h.sentences.filter((x) => x.tag === tag).flatMap((x) => pick(x.id))).size
  const [hardTag = null] = tags
    .map((tag) => ({ tag, n: ofTag(tag, hardSids), of: ofTag(tag, touchedSids) }))
    .filter((r) => r.n > 0)
    .sort(byShare)

  const U = students.map((s) => unknownWords(h, s))
  const allWords = h.words
    .filter((w) => w.teacherCore || w.familiarTrap || w.tier === 'must')
    .map((w) => ({
      lemma: w.lemma,
      zh: w.zh,
      n: U.filter((u) => u.has(w.lemma)).length,
      of: students.filter((s) => s.tappedWords.includes(w.lemma) || s.wordMarks[w.lemma] || (w.guess && s.answers[w.guess.id])).length,
    }))
    .filter((r) => r.n > 0)
    .sort(byShare)
  const words = allWords.slice(0, 5)
  const same = (w?: { n: number; of: number }) => !!w && w.n === words[4].n && w.of === words[4].of
  const wordsTied = same(allWords[5]) ? allWords.filter(same).length : 0

  // 段意题：第一次答对的比例最低的段（同比例取答错人数多的）；人数一样的并列，按段落顺序
  const miss = (g: { firstTry: number; of: number }) => g.of - g.firstTry
  const gists = h.paragraphs
    .map((p) => {
      const recs = students.flatMap((s) => (s.answers[p.gist.id] ? [s.answers[p.gist.id]] : []))
      return { paragraph: p.n, prompt: p.gist.prompt, firstTry: recs.filter((a) => a.firstTryCorrect).length, of: recs.length }
    })
    .filter((g) => g.of > 0)
    .sort((a, b) => miss(b) * a.of - miss(a) * b.of || miss(b) - miss(a))
  // 第一次答对的比例并列最低的段都列出来（按比例比，分母不同也算并列）
  const gist = gists.filter((g) => g.firstTry * gists[0].of === gists[0].firstTry * g.of)

  const recs = students.flatMap((s) => h.sentences.flatMap((x) => (x.question && s.answers[x.question.id] ? [s.answers[x.question.id]] : [])))
  const correct = recs.filter((a) => a.firstTryCorrect).length

  const present = new Set(students.map((s) => s.sid))
  const gistIds = new Set(h.paragraphs.map((p) => p.gist.id))
  const guessIds = new Set(h.words.flatMap((w) => (w.guess ? [w.guess.id] : [])))
  const has = (s: StudentState, ids: Set<string>) => Object.keys(s.answers).some((id) => ids.has(id))
  return {
    students: students.length,
    reached: {
      gist: students.filter((s) => s.tappedWords.length || has(s, gistIds)).length,
      words: students.filter((s) => Object.keys(s.wordMarks).length || s.fakeWordClaimedKnown || has(s, guessIds)).length,
      close: students.filter((s) => h.sentences.some((x) => s.ladder[x.id] || (x.question && s.answers[x.question.id]))).length,
      // 写作不改状态，按事件数；带 sentenceId 的是已删掉的打卡句初稿，不算
      writing: new Set(events.filter((e) => e.type === 'writing_submit' && !e.sentenceId && present.has(e.sid)).map((e) => e.sid)).size,
    },
    hardSentences,
    hardTag,
    words,
    wordsTied,
    gist,
    firstTry: { correct, answered: recs.length, pct: recs.length ? Math.round((correct * 100) / recs.length) : 0 },
  }
}
