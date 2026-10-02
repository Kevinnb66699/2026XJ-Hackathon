// ④ 精读在电脑上：左边是原文、右边是一句一卡（children），和粗读答题时一样；手机上左边隐藏，只有卡片。
// 左边高亮右边正在读的那一句（最靠上的卡片，或刚点过的卡片），点左边一句右边跳到它的卡片。
// 左边只放原文，不加注释、不标梯子；学生精读每句都有卡片，所以每句都能点。
import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { Handout } from '../../../shared/schema'
import { Icon, card } from '../../components/ui'

export function CloseArticle({ h, children }: { h: Handout; children: ReactNode }) {
  const nums = useMemo(() => [...new Set(h.sentences.map((x) => x.paragraph))].sort((a, b) => a - b), [h])
  const [active, setActive] = useState<string | null>(null)
  const articleRef = useRef<HTMLElement>(null)
  const cardsRef = useRef<HTMLDivElement>(null)
  const hold = useRef(0) // 点了左边、页面还在平滑滚动：这时先不按滚动位置改高亮
  const release = (ms: number) => {
    clearTimeout(hold.current)
    hold.current = window.setTimeout(() => (hold.current = 0), ms)
  }

  // 滚动时：顶栏下面最靠上、还露出来的那张卡片就是正在读的
  useEffect(() => {
    const onScroll = () => {
      if (hold.current) return release(150)
      const cards = cardsRef.current?.querySelectorAll<HTMLElement>('[data-sentence]') ?? []
      const top = [...cards].find((el) => el.getBoundingClientRect().bottom > 120)
      if (top) setActive(top.dataset.sentence ?? null)
    }
    onScroll()
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      window.removeEventListener('scroll', onScroll)
      clearTimeout(hold.current)
    }
  }, [])

  // 高亮的句子不在左边可见范围里，就只滚左边的原文（不滚页面）；要让开顶上那条提示
  useEffect(() => {
    const box = articleRef.current
    const el = active ? box?.querySelector(`[data-sid="${active}"]`) : null
    if (!box || !el) return
    const head = (box.firstElementChild as HTMLElement).offsetHeight
    const b = box.getBoundingClientRect()
    const r = el.getBoundingClientRect()
    if (r.top < b.top + head || r.bottom > b.bottom) box.scrollTo({ top: box.scrollTop + r.top - b.top - head - 12, behavior: 'smooth' })
  }, [active])

  const jump = (id: string) => {
    setActive(id)
    release(300)
    cardsRef.current?.querySelector(`[data-sentence="${id}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  return (
    <div className="flex flex-col gap-3.5 lg:grid lg:grid-cols-2 lg:items-start lg:gap-6">
      <aside
        ref={articleRef}
        aria-label="原文"
        className={`${card} hidden lg:sticky lg:top-[72px] lg:block lg:max-h-[calc(100vh-88px)] lg:overflow-y-auto`}
      >
        <div className="sticky top-0 z-10 flex items-center gap-2 border-b border-line bg-surface px-5 py-2.5 text-[13px] text-primary-hover">
          <Icon name="hand" />
          <span className="flex-1">点一句原文，右边跳到这一句的卡片</span>
        </div>
        <div className="flex flex-col gap-5 px-5 py-4">
          {nums.map((n) => (
            <div key={n} className="flex flex-col gap-1">
              <span className="text-[12px] text-muted">第 {n} 段</span>
              <p className="m-0 font-serif text-[17px] leading-[1.75]">
                {h.sentences
                  .filter((x) => x.paragraph === n)
                  .map((x, k) => (
                    <Fragment key={x.id}>
                      {k > 0 && ' '}
                      <span
                        role="button"
                        tabIndex={0}
                        data-sid={x.id}
                        aria-current={x.id === active || undefined}
                        onClick={() => jump(x.id)}
                        onKeyDown={(e) => {
                          if (e.key !== 'Enter' && e.key !== ' ') return
                          e.preventDefault()
                          jump(x.id)
                        }}
                        className={`cursor-pointer rounded ${x.id === active ? 'bg-what' : '[@media(hover:hover)]:hover:bg-what/50'}`}
                      >
                        {x.text}
                      </span>
                    </Fragment>
                  ))}
              </p>
            </div>
          ))}
        </div>
      </aside>

      {/* 在哪张卡片上点了东西，左边就高亮那一句 */}
      <div
        ref={cardsRef}
        className="flex flex-col gap-3.5"
        onClickCapture={(e) => {
          const id = (e.target as HTMLElement).closest<HTMLElement>('[data-sentence]')?.dataset.sentence
          if (id) setActive(id)
        }}
      >
        {children}
      </div>
    </div>
  )
}
