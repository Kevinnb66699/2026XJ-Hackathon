// 演示用的预设画像。按讲义的字段（核心词、熟词僻义、mainObstacle、结构标签）生成事件，换讲义也能用。
//   同学 A：生词多。点了核心词和熟词僻义，卡在「卡点主要在词」的句子上（开到第 2 级）。
//   同学 B：词基本认识（熟词僻义标了认识），卡在长句上：每类结构第一次遇到时开到第 3 级，
//          只有 appositive_that 第一次就读懂了，所以后面同类的句子轮到「先自己试」。
// 教师端拿不到实时数据时，用这两个画像加随机扰动生成一个班的快照（标明「示例数据」）。
import type { EventType, Handout, LearningEvent, Sentence } from '../../shared/schema'
import { emptyState, personalize } from '../engine'
import { mulberry32 } from '../engine/prng'
import type { StudentState } from '../engine/types'
import { replay } from '../lib/replay'

export type PresetId = 'A' | 'B'
export const PRESET_NAME: Record<PresetId, string> = { A: '同学 A（生词多）', B: '同学 B（长句难）' }

const BASE_TS = Date.UTC(2026, 9, 1, 12, 0, 0)
const DRAFT = '（示例初稿）'

export function presetEvents(h: Handout, p: PresetId, sid = `demo-${p}`, rand?: () => number): LearningEvent[] {
  const out: LearningEvent[] = []
  let ts = BASE_TS
  const ev = (type: EventType, extra: Partial<LearningEvent> = {}) => out.push({ sid, ts: ts++, handoutId: h.id, type, ...extra })
  const flip = (pr: number) => (rand ? rand() < pr : false) // 只有生成班级快照时才加扰动

  const smooth = (x: Sentence) => {
    if (x.question) ev('answer_question', { sentenceId: x.id, correct: true, firstTry: true })
    if (x.checkIn) ev('writing_submit', { sentenceId: x.id, value: DRAFT })
  }
  // top=1：开第 1 步后首答就对；top=2：首答错，开到第 2 步后答对；top=3：开到第 3 步，第 3 次才答对
  const struggle = (x: Sentence, top: 1 | 2 | 3) => {
    if (top > 1 && x.question) ev('answer_question', { sentenceId: x.id, correct: false, firstTry: true })
    if (x.checkIn) ev('writing_submit', { sentenceId: x.id, value: DRAFT })
    if (x.ladder) for (let l = 1; l <= top; l++) ev('open_ladder', { sentenceId: x.id, level: l })
    if (x.question) {
      if (top === 3) ev('answer_question', { sentenceId: x.id, correct: false, firstTry: false })
      ev('answer_question', { sentenceId: x.id, correct: true, firstTry: top === 1 })
    }
  }

  // 粗读：点词 + 段意题
  const hard = h.words.filter((w) => w.teacherCore || w.familiarTrap)
  if (p === 'A') {
    for (const w of hard) if (!flip(0.2)) ev('tap_word', { lemma: w.lemma })
  } else if (rand && flip(0.3) && h.words.length) {
    ev('tap_word', { lemma: h.words[Math.floor(rand() * h.words.length)].lemma })
  }
  for (const para of h.paragraphs) {
    const miss = (p === 'A' && para.n === 1) !== flip(0.25)
    if (miss) ev('gist_answer', { paragraph: para.n, correct: false, firstTry: true })
    ev('gist_answer', { paragraph: para.n, correct: true, firstTry: !miss })
  }

  // 学生词：A 全标不认识；B 认识熟词僻义，其余不认识；少数人把假词点成「认识」
  for (const w of hard) ev('word_card', { lemma: w.lemma, value: p === 'B' && w.familiarTrap ? 'known' : 'unknown' })
  if (flip(0.15)) {
    const fake = personalize(h, emptyState(sid)).deck.find((c) => c.kind === 'fake')
    if (fake) ev('word_card', { lemma: fake.lemma, value: 'known' })
  }

  // 精读
  const seen = new Set<string>()
  for (const x of h.sentences) {
    if (!x.question && !x.ladder) continue
    if (p === 'A') {
      if (x.mainObstacle === 'word') struggle(x, flip(0.3) ? 1 : 2)
      else if (flip(0.2)) struggle(x, 2)
      else smooth(x)
      continue
    }
    if (!x.tag) {
      if (flip(0.2)) struggle(x, 1)
      else smooth(x)
    } else if (seen.has(x.tag)) {
      // 演示用的 B 还没做到这句，留给「先自己试」；快照里的同学照常做完
      if (rand) {
        if (flip(0.25)) struggle(x, 2)
        else smooth(x)
      }
    } else {
      seen.add(x.tag)
      if (x.tag === 'appositive_that') {
        if (flip(0.2)) struggle(x, 2)
        else smooth(x)
      } else struggle(x, flip(0.3) ? 2 : 3)
    }
  }
  return out
}

// 预设状态 = 重放预设事件 + 本机字段（问卷、表达本没有对应事件）
export function presetState(h: Handout, p: PresetId, sid = `demo-${p}`): StudentState {
  const [s = emptyState(sid)] = replay(h, presetEvents(h, p, sid))
  return {
    ...s,
    survey: p === 'A' ? { grade: '高一', curriculum: '普通高中', stuckOn: 'words' } : { grade: '高二', curriculum: 'A-Level', stuckOn: 'long_sentences' },
    collectedExpressions: p === 'B' ? h.expressions.filter((e) => !e.teacherRequired).slice(0, 1).map((e) => e.id) : [],
  }
}

// 教师端快照：n 个同学，A、B 两种画像交替，各自用固定种子扰动，结果可复现
export function snapshotEvents(h: Handout, n = 12): LearningEvent[] {
  const out: LearningEvent[] = []
  for (let i = 0; i < n; i++) {
    out.push(...presetEvents(h, i % 2 ? 'B' : 'A', `同学 ${String(i + 1).padStart(2, '0')}`, mulberry32(i + 1)))
  }
  return out
}
