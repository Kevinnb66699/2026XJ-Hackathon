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
  hand: (
    <>
      <path d="M9 11V5a2 2 0 0 1 4 0v6" />
      <path d="M13 10a2 2 0 0 1 4 0v3a6 6 0 0 1-6 6h-1a6 6 0 0 1-5-3l-1.5-3a1.5 1.5 0 0 1 2.5-1.5L8 13" />
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

export function TopBar({ title, subtitle, onBack, right }: { title: string; subtitle?: string; onBack?: () => void; right?: ReactNode }) {
  return (
    <header className="sticky top-0 z-20 flex h-14 items-center gap-2 border-b border-line bg-surface px-3">
      {onBack && (
        <button type="button" aria-label="返回" onClick={onBack} className="flex h-11 w-11 items-center justify-center">
          <Icon name="back" size={22} />
        </button>
      )}
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-[16px] font-semibold">{title}</span>
        {subtitle && <span className="truncate text-[12px] text-muted">{subtitle}</span>}
      </div>
      {right}
    </header>
  )
}

export function StepBar({ steps, current, onPick }: { steps: string[]; current: number; onPick: (i: number) => void }) {
  return (
    <nav aria-label="学习步骤" className="flex items-center gap-1.5 overflow-x-auto border-b border-line bg-surface px-4 text-[13px]">
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
    </nav>
  )
}

// 选择题：选错标红，选对标绿；选项原样全部显示
export function Choices({ options, answer, picked, onPick, cols = 1, locked = false }: {
  options: string[]
  answer: number
  picked: number | null
  onPick: (i: number) => void
  cols?: 1 | 2
  locked?: boolean
}) {
  return (
    <div className={`grid gap-2 ${cols === 2 ? 'grid-cols-2' : 'grid-cols-1'}`}>
      {options.map((o, i) => {
        const tone =
          picked !== i
            ? 'border border-line bg-surface text-ink'
            : i === answer
              ? 'border-[1.5px] border-green bg-green-light font-semibold text-green-dark'
              : 'border-[1.5px] border-red bg-red-light text-red-dark'
        return (
          <button key={i} type="button" disabled={locked} onClick={() => onPick(i)} className={`flex min-h-[46px] items-center gap-2 rounded-xl px-3 py-2 text-left text-[15px] leading-snug ${tone}`}>
            {picked === i && i === answer && <Icon name="check" />}
            {o}
          </button>
        )
      })}
    </div>
  )
}
