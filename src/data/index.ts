// 讲义注册表。默认是老师的真实讲义（data/handouts/social-media.json，入库管线产物）；
// URL 带 ?h=mini-phones 时切到团队自写的迷你讲义。
import { Handout } from '../../shared/schema'
import socialMedia from '../../data/handouts/social-media.json'
import { miniHandout } from '../../tests/fixtures/mini-handout'

export const handouts: Handout[] = [Handout.parse(socialMedia), miniHandout]

function pick(): Handout {
  try {
    const id = new URLSearchParams(window.location.search || window.location.hash.split('?')[1] || '').get('h')
    return handouts.find((h) => h.id === id) ?? handouts[0]
  } catch {
    return handouts[0]
  }
}

export const currentHandout: Handout = pick()
