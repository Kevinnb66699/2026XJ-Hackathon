// 通用界面组件，样式照 docs/设计规范.md 的「组件」一节
import { Fragment, type ReactNode } from 'react'

const PATHS: Record<string, ReactNode> = {
  back: <path d="M15 18l-6-6 6-6" />,
  book: (
    <>
      <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
      <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
    </>
  ),
  check: <path d="M20 6L9 17l-5-5" />,
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

// 选择题：选错标红，选对标绿；选项原样全部显示。pending：选了还没提交，只标出选中、不判对错
export function Choices({ options, answer, picked, onPick, cols = 1, locked = false, pending = false }: {
  options: string[]
  answer: number
  picked: number | null
  onPick: (i: number) => void
  cols?: 1 | 2
  locked?: boolean
  pending?: boolean
}) {
  return (
    <div className={`grid gap-2 ${cols === 2 ? 'grid-cols-2' : 'grid-cols-1'}`}>
      {options.map((o, i) => {
        const tone =
          picked !== i
            ? 'border border-line bg-surface text-ink'
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
