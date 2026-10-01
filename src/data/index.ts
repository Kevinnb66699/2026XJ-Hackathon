// 讲义注册表。暂时只有团队自写的迷你讲义，以后换成真实讲义（data/handouts/*.json）。
import type { Handout } from '../../shared/schema'
import { miniHandout } from '../../tests/fixtures/mini-handout'

export const handouts: Handout[] = [miniHandout]

export const currentHandout: Handout = handouts[0]
