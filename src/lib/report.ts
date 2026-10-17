// 学生端「小结」（10-16）：只用本机已有的学生状态算出这一篇是怎么读的，不新增任何收集，也不发给服务器。
// 只说发生了什么（几句第一次就答对、没开提示、几段第一次就选对、哪些词不认识），不说进步、分数、正确率。
// 「自己读懂」和老师端一样：第一次就答对，而且没开提示（梯子）
import type { Handout, Word } from '../../shared/schema'
import { lookupWord, unknownWords } from '../engine'
import type { StudentState } from '../engine/types'

export interface HandoutReport {
  close: { own: number; answered: number; total: number } // 带原句题的句子：第一次就答对、没开提示 / 答过 / 一共
  gist: { first: number; answered: number; total: number } // 段意题：第一次就选对 / 答过 / 一共
  words: Word[] // 生词：粗读点过、标了不认识、第一次猜错，减去标了认识的；只列查得到意思的
  pending: { id: string; paragraph: number; text: string; status: 'wrong' | 'todo' }[] // 还没答对、还没答的句子，按原文顺序
  started: boolean // 动过手：答过题、点过词、标过词卡、开过提示
}

export function handoutReport(h: Handout, s: StudentState): HandoutReport {
  const qs = h.sentences.filter((x) => x.question)
  const ans = (x: (typeof qs)[number]) => s.answers[x.question!.id]
  const gists = h.paragraphs.map((p) => s.answers[p.gist.id]).filter(Boolean)
  // 旧状态里可能有 10-16 前假词卡的标记、查不到意思的词：个数按列出来的算
  const words = [...unknownWords(h, s)].flatMap((l) => lookupWord(h, l) ?? [])
  return {
    close: { own: qs.filter((x) => ans(x)?.firstTryCorrect && !s.ladder[x.id]).length, answered: qs.filter(ans).length, total: qs.length },
    gist: { first: gists.filter((a) => a.firstTryCorrect).length, answered: gists.length, total: h.paragraphs.length },
    words: [...new Map(words.map((w) => [w.lemma, w])).values()],
    pending: qs.flatMap((x) => (ans(x)?.correct ? [] : [{ id: x.id, paragraph: x.paragraph, text: x.text, status: ans(x) ? ('wrong' as const) : ('todo' as const) }])),
    started: Object.keys(s.answers).length > 0 || s.tappedWords.length > 0 || Object.keys(s.wordMarks).length > 0 || Object.values(s.ladder).some(Boolean),
  }
}
