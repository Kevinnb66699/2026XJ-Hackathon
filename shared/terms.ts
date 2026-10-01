// 学生端（我们生成的文案、梯子、题目、AI 写作理由）不允许出现的语法术语。
// 老师讲解原话（teacherNote）是老师自己的话，不受此限。校验器、前端、后端共用这一份。
export const GRAMMAR_TERMS = ['倒装', '同位语', '从句', '主语', '谓语', '宾语', '状语', '定语', '表语', '语法']

export const hasGrammarTerm = (text: string): string | undefined => GRAMMAR_TERMS.find((t) => text.includes(t))
