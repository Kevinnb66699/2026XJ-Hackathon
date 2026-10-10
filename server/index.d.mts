// server/index.mjs 的类型声明，供 tests/*.ts 引用
import type { Server } from 'http'
import type { LlmConfig } from '../pipeline/llm'

// 与 pipeline/article.ts 的 ArticleInput / buildFromArticle 一致（这里只声明后端用到的部分）
export interface UploadInput {
  title: string
  text: string
  mustWords?: string[]
  checkIns?: string[]
  focus?: string
}
export type BuildArticle = (
  input: UploadInput,
  opts: { id: string; llm: LlmConfig; onProgress: (p: unknown) => void },
) => Promise<{ handout: unknown; report: unknown }>

export interface ServerConfig {
  port: number
  dataDir: string
  apiKey: string
  llmBaseUrl: string
  llmModel: string
  llmFallbacks: string[]
  llmTimeoutMs: number
  writingPerSidPerHour: number
  writingPerDay: number
  uploadInvites: string[] // 老师注册邀请码，每个码注册一个账号
  uploadsPerTeacherPerHour: number
  uploadsPerDay: number
  cookieSecure: boolean
  authPerMinute: number
  joinsPerClassPerHour: number // 学生选座号：同一个班每小时最多几次请求
  adviceTimeoutMs: number
  advicePerDevicePerHour: number
  advicePerDay: number
  notesTimeoutMs: number
  notesPerTeacherPerHour: number
  notesPerDay: number
  pipelineModel: string
  pipelineFallbacks: string[]
  cleanupAnonDays: number // 到期清理：页面报错和没绑定座号的事件留几天（CLEANUP_ANON_DAYS）
  cleanupCacheDays: number // 到期清理：llm-cache、advice-cache 里的文件留几天（CLEANUP_CACHE_DAYS）
  cleanupIntervalHours: number // 到期清理多久跑一次（只有直接运行时才定时跑）
  buildArticle: BuildArticle
  log: (line: string) => void
}

export const EVENT_TYPES: string[]
export const BREAKDOWN_LABELS: string[]
export function readEnvFile(file: string): Record<string, string>
export function loadConfig(env?: Record<string, string | undefined>): ServerConfig
export function buildBody(model: string, fallbacks: string[], text: string, expressions: unknown[]): Record<string, unknown>
// 到期清理一次的结果：改写或删掉了几个事件文件、删了几行事件、删了几个缓存文件
export interface CleanupResult {
  files: number
  events: number
  cacheFiles: number
}
export interface App {
  listen(port: number, host: string, cb?: () => void): Server
  cleanup(): Promise<CleanupResult> // 到期清理跑一次（测试用）
  startCleanup(): NodeJS.Timeout // 先跑一次，之后每 cleanupIntervalHours 小时一次；定时器已 unref（直接运行时用）
}
export function createApp(config?: Partial<ServerConfig>): App
export function hashPassword(password: string): Promise<string>
export function verifyPassword(password: string, stored: string): Promise<boolean>
