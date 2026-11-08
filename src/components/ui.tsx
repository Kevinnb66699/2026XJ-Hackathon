// 通用界面组件，样式照 docs/设计规范.md 的「组件」一节
import { Fragment, type ReactNode } from 'react'
import type { Handout, Provenance } from '../../shared/schema'

const PATHS: Record<string, ReactNode> = {
  back: <path d="M15 18l-6-6 6-6" />,
  book: (
    <>
      <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
      <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
    </>
  ),
  check: <path d="M20 6L9 17l-5-5" />,
  // 列表：首页的「学习记录」入口
  list: <path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01" />,
  lock: (
    <>
      <rect x="4" y="11" width="16" height="10" rx="2" />
      <path d="M8 11V7a4 4 0 0 1 8 0v4" />
    </>
  ),
  pin: (
    <>
      <path d="M12 17v5" />
      <path d="M9 10.76V6h6v4.76l2 3.24H7z" />
    </>
  ),
  // 点击箭头：「点一下」的提示（不用手势图标，免得被看成别的手势）
  click: (
    <>
      <path d="M14 4.1 12 6" />
      <path d="m5.1 8-2.9-.8" />
      <path d="m6 12-1.9 2" />
      <path d="M7.2 2.2 8 5.1" />
      <path d="M9.04 9.69a.5.5 0 0 1 .65-.65l11 4.5a.5.5 0 0 1-.07.95l-4.35 1.04a1 1 0 0 0-.74.74l-1.04 4.35a.5.5 0 0 1-.95.07z" />
    </>
  ),
  // 举手（张开的手掌）：「我卡住了」
  raise: (
    <>
      <path d="M18 11V6a2 2 0 0 0-4 0" />
      <path d="M14 10V4a2 2 0 0 0-4 0v2" />
      <path d="M10 10.5V6a2 2 0 0 0-4 0v8" />
      <path d="M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.86-6-2.34l-3.6-3.6a2 2 0 0 1 2.83-2.82L7 15" />
    </>
  ),
  info: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 8v4" />
      <path d="M12 16h.01" />
    </>
  ),
  close: <path d="M18 6L6 18M6 6l12 12" />,
  // 芝士角（10-16）：装饰图标，和图钉一样用芥末黄；10-24 起只放在首页页脚那句谐音旁边
  cheese: (
    <>
      <path d="M2 14 13 5l9 5v9H2z" />
      <path d="M2 14l20-4" />
      <circle cx="8" cy="16" r="1.2" />
      <circle cx="16.5" cy="14.5" r="1.2" />
    </>
  ),
}

export function Icon({ name, size = 18, className = '' }: { name: keyof typeof PATHS; size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className={`shrink-0 ${className}`}>
      {PATHS[name]}
    </svg>
  )
}

export const btn = {
  primary: 'min-h-[50px] rounded-[14px] bg-primary px-5 text-[16px] font-semibold text-white hover:bg-primary-hover disabled:opacity-40',
  secondary: 'min-h-[46px] rounded-xl border border-line-strong bg-surface px-4 text-[15px] text-ink hover:bg-ground disabled:opacity-40',
  small: 'min-h-[36px] rounded-lg border border-line bg-surface px-3 text-[13px] text-primary hover:bg-ground',
}
export const card = 'rounded-[14px] border border-line bg-surface'
export const serifText = 'font-serif text-[19px] leading-[1.75]'

type Tone = 'amber' | 'primary' | 'gray' | 'green' | 'red'
const TONES: Record<Tone, string> = {
  amber: 'bg-amber-light text-amber-dark',
  primary: 'bg-primary-light text-primary',
  gray: 'bg-line-soft text-ink2',
  green: 'bg-green-light text-green-dark',
  red: 'bg-red-light text-red-dark',
}

export function Pill({ tone = 'gray', children }: { tone?: Tone; children: ReactNode }) {
  return <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-[12px] font-semibold ${TONES[tone]}`}>{children}</span>
}

// 「高中新词」小标签（阶段 6，目标选了高考时）：说的是词，不是学生，不给学生贴等级。贴了它的页面上用 NEW_WORD_NOTE 说一句范围
export const NEW_WORD = '高中新词'
export const NEW_WORD_NOTE = '高中新词：课标里高中阶段新学的词。初中学过的词也在高考范围内。'
export const NewWordTag = () => <Pill tone="green">{NEW_WORD}</Pill>

// AI 生成的内容（11-07 起）：按来源（Provenance）标，by 是 llm 才标；人写的、老师改过的（记成 human）不标，原文永远不标
export const byAi = (p?: Provenance) => p?.by === 'llm'

// 这篇的题目、提示、译文、要点有没有 AI 生成的：有就在学生端开头说一句。
// 讲义词表的词义和表达的中文没有逐条记来源，是和题目、提示同一次起草的（pipeline/article.ts），也看这个
export const aiDrafted = (h: Handout) =>
  h.paragraphs.some((p) => byAi(p.provenance) || byAi(p.gist.provenance)) ||
  h.sentences.some((x) => byAi(x.question?.provenance) || byAi(x.ladder?.provenance) || byAi(x.breakdown?.provenance)) ||
  h.words.some((w) => byAi(w.guess?.provenance)) ||
  byAi(h.structure?.provenance)

// 一个词的词义：讲义词表里的跟着讲义走（见上）；词表外的取自全文词义（lexicon），看全文词义自己的来源
export const meaningByAi = (h: Handout, lemma: string) => (h.words.some((w) => w.lemma === lemma) ? aiDrafted(h) : byAi(h.lexicon?.provenance))

// 「AI 生成」小标签：放在这块内容的标题旁，中性灰色小字，不抢眼；不折行，手机上不挤
export function AiTag({ className = '' }: { className?: string }) {
  return <span className={`inline-flex shrink-0 items-center whitespace-nowrap rounded border border-line px-1 font-sans text-[11px] font-normal leading-4 text-muted ${className}`}>AI 生成</span>
}

// 所有页面同一个顶栏：容器和首页一样宽，logo 每页都在同一位置；高 56px，只有一行（页面名太长就截断，按钮手机上用短字）
export function SiteHeader({ label, actions }: { label?: string; actions?: ReactNode }) {
  return (
    <header className="sticky top-0 z-20 border-b border-line bg-surface">
      <div className="mx-auto flex h-14 max-w-6xl items-center gap-2 px-4 sm:px-8">
        <a href="#/" aria-label="知适首页" className="flex shrink-0 items-center gap-2 self-stretch text-[18px] font-bold tracking-wider text-ink">
          <img src="/logo.png" alt="" width={28} height={28} className="h-7 w-7 object-contain" />
          知适
        </a>
        {label && <span className="min-w-0 truncate border-l border-line pl-2 text-[13px] text-muted sm:text-[14px]">{label}</span>}
        {actions && <div className="ml-auto flex shrink-0 items-center gap-2">{actions}</div>}
      </div>
    </header>
  )
}

// 顶栏按钮的字：手机上换成短的，一行放得下
export function Short({ full, short }: { full: string; short: string }) {
  return (
    <>
      <span className="sm:hidden">{short}</span>
      <span className="hidden sm:inline">{full}</span>
    </>
  )
}

// note：电脑上放在步骤条右边的一行小字（如「本周外刊：…」）
export function StepBar({ steps, current, onPick, note }: { steps: string[]; current: number; onPick: (i: number) => void; note?: string }) {
  return (
    <nav aria-label="学习步骤" className="border-b border-line bg-surface">
      {/* 和顶栏同一个容器，第一步和 logo 左对齐 */}
      <div className="mx-auto flex max-w-6xl items-center gap-1.5 overflow-x-auto px-4 text-[13px] sm:px-8">
        {steps.map((s, i) => (
          <Fragment key={s}>
            {i > 0 && <span className="text-dim">·</span>}
            <button
              type="button"
              onClick={() => onPick(i)}
              aria-current={i === current ? 'step' : undefined}
              className={`shrink-0 py-2.5 ${i === current ? 'border-b-2 border-primary font-bold text-primary' : 'text-muted'}`}
            >
              {s}
            </button>
          </Fragment>
        ))}
        {note && <span className="ml-auto hidden shrink-0 pl-4 text-[12px] text-muted sm:block">{note}</span>}
      </div>
    </nav>
  )
}

// 选择题：选错标红，选对标绿；选项原样全部显示。pending：选了还没提交，只标出选中、不判对错。
// missed：另外标红的一项（粗读题答错后 picked 标出正确答案，missed 是学生选错的那一项）
export function Choices({ options, answer, picked, onPick, cols = 1, locked = false, pending = false, missed }: {
  options: string[]
  answer: number
  picked: number | null
  onPick: (i: number) => void
  cols?: 1 | 2
  locked?: boolean
  pending?: boolean
  missed?: number
}) {
  return (
    <div className={`grid gap-2 ${cols === 2 ? 'grid-cols-2' : 'grid-cols-1'}`}>
      {options.map((o, i) => {
        const tone =
          picked !== i
            ? i === missed
              ? 'border-[1.5px] border-red bg-red-light text-red-dark'
              : 'border border-line bg-surface text-ink'
            : pending
              ? 'border-[1.5px] border-select bg-select-light font-semibold text-select'
              : i === answer
                ? 'border-[1.5px] border-green bg-green-light font-semibold text-green-dark'
                : 'border-[1.5px] border-red bg-red-light text-red-dark'
        return (
          <button key={i} type="button" disabled={locked} onClick={() => onPick(i)} className={`flex min-h-[46px] items-center gap-2 rounded-xl px-3 py-2 text-left text-[15px] leading-snug ${tone}`}>
            {picked === i && !pending && i === answer && <Icon name="check" />}
            {o}
          </button>
        )
      })}
    </div>
  )
}
