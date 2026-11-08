// server/index.mjs 的类型声明，供 tests/*.ts 引用
import type { Server } from 'http'
import type { LlmCall, LlmConfig, LlmUsage } from '../pipeline/llm'
import type * as NotebookLib from '../src/lib/notebook'

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
  // onCall / onUsage：每次调模型的开始和用量（默认的管线从 worker 传回来），交给后端记进 usage 日志
  opts: { id: string; llm: LlmConfig; onProgress: (p: unknown) => void; onCall: (c: LlmCall) => void; onUsage: (u: LlmUsage) => void },
) => Promise<{ handout: unknown; report: unknown }>

export interface ServerConfig {
  port: number
  dataDir: string
  apiKey: string
  llmBaseUrl: string
  llmModel: string
  llmTimeoutMs: number
  writingPerSidPerHour: number
  writingPerDay: number
  uploadInvites: string[] // 老师注册邀请码，每个码注册一个账号
  uploadsPerTeacherPerHour: number
  uploadsPerDay: number
  cookieSecure: boolean
  authPerMinute: number
  joinsPerClassPerHour: number // 学生选学号：同一个班每小时最多几次请求
  adviceTimeoutMs: number
  advicePerDevicePerHour: number
  advicePerDay: number
  notesTimeoutMs: number
  notesPerTeacherPerHour: number
  notesPerDay: number
  pipelineModel: string
  spendDayYuan: number // 花费上限（元，北京时间的当天，SPEND_DAY_YUAN）
  spendMonthYuan: number // 花费上限（元，北京时间的本月，SPEND_MONTH_YUAN）
  prices: Record<string, { input: number; output: number }> // 单价（元/百万 token），MODEL_PRICES 覆盖
  cleanupAnonDays: number // 到期清理：页面报错和没绑定学号的事件留几天（CLEANUP_ANON_DAYS）
  cleanupCacheDays: number // 到期清理：llm-cache、advice-cache 里的文件留几天（CLEANUP_CACHE_DAYS）
  cleanupIntervalHours: number // 到期清理多久跑一次（只有直接运行时才定时跑）
  nameKey: string // 学生姓名加密存储的密钥（NAME_KEY）：64 位十六进制；空就照旧存明文
  studentAi: boolean // 学生账号的 AI 写作检查开放没有（STUDENT_AI=1）；开放了还要学生自己在账号页打开
  studentEventsPerDay: number // 学生账号每天（北京时间）最多收几条学习事件
  studentEventsMaxBytes: number // students/<sid>.jsonl 单个文件最大字节数
  studentExportsPerHour: number // 「下载我的数据」每个账号每小时最多几次
  studentUpload: boolean // 学生上传开放没有（STUDENT_UPLOAD=1）
  studentUploadsPerWeek: number // 每人每周（北京时间周一 0 点清零）最多生成几篇，只在成功时计（STUDENT_UPLOADS_PER_WEEK）
  studentUploadFailsPerDay: number // 每人每天最多失败几次，内容安全拦截也算（STUDENT_UPLOAD_FAILS_PER_DAY）
  deletionsDir: string // 删除台账的目录（DELETIONS_DIR），要在 dataDir 外面
  buildArticle: BuildArticle
  // 单词本、表达本、学习记录的推算：测试注入 src/lib/notebook.ts；null 时第一次用到才加载 dist-server/notebook.mjs
  notebook: Pick<typeof NotebookLib, 'buildNotebook' | 'buildRecords' | 'parseHandout'> | null
  // 学生上传的内容检查（pipeline/article.ts 的 checkArticle，不过就抛 ArticleError）：测试注入；null 时第一次用到才加载 dist-server/article.mjs
  checkArticle: ((text: string) => void) | null
  log: (line: string) => void
}

export const EVENT_TYPES: string[]
export const NOTEBOOK_ID: string // 单词本里的事件用的保留 handoutId，与 shared/schema.ts 的一致
export const EXPORT_NOTE: string // 「下载我的数据」文件开头的说明
export const EXPORT_AI_FIELDS: Record<string, string> // 「下载我的数据」里哪些字段是 AI 生成的
export const EXPORT_ADAPT_NOTE: string // 「下载我的数据」里说明哪些数据被用来调整提示
export const PROFILE_CHOICES: Record<'goal' | 'grade' | 'curriculum', string[]> // 问卷每一项的取值，与 shared/schema.ts 的 PROFILE_* 一致
export const BREAKDOWN_LABELS: string[]
export function readEnvFile(file: string): Record<string, string>
export function loadConfig(env?: Record<string, string | undefined>): ServerConfig
export function buildBody(model: string, text: string, expressions: unknown[]): Record<string, unknown>
export const PRICES: Record<string, { input: number; output: number }> // 代码里的单价表（元/百万 token）
// 金额（整数，单位是百万分之一元）：token 数乘单价，向上取整；价格表里没有的模型按最高的单价
export function usageCost(prices: Record<string, { input: number; output: number }>, model: string, input: number, output: number): number
export function articleEstimate(chars: number): number // 生成一篇讲义的估计额（百万分之一元）
// 往 dataDir 的 usage-YYYY-MM.jsonl 追加一行，返回金额；input、output 都是 0 的不记（带 call 的照记）。
// call：生成讲义的一次调用（讲义 id:调用序号），开始时记一行 open 的估计额、结束时再记一行，加总时按 settleUsage 只算一行
export function appendUsage(cfg: Pick<ServerConfig, 'dataDir' | 'prices' | 'log'>, u: Omit<LlmUsage, 'id'> & { handoutId?: string; call?: string; open?: boolean }, now?: number): number
// usage 日志的行去重：同一个 call 有结束那行就只留它（token 是 0 的结束行也去掉），没有就留开始那行；不带 call 的行都留
export function settleUsage<T extends { call?: unknown; open?: unknown; input?: unknown; output?: unknown }>(rows: T[]): T[]
// 到期清理一次的结果：改写或删掉了几个事件文件、删了几行事件、删了几个缓存文件；删了长期没用的学生账号时多一个 students，删了学生讲义时多一个 handouts
export interface CleanupResult {
  files: number
  events: number
  cacheFiles: number
  students?: number
  handouts?: number // 删了几篇没人用了的学生讲义
}
export interface App {
  listen(port: number, host: string, cb?: () => void): Server
  cleanup(): Promise<CleanupResult> // 到期清理跑一次（测试用）
  startCleanup(): NodeJS.Timeout // 先跑一次，之后每 cleanupIntervalHours 小时一次；定时器已 unref（直接运行时用）
}
export function createApp(config?: Partial<ServerConfig>): App
export const MIN_AGE: number // 学生账号注册的年龄门槛（周岁）
export const STUDENT_INACTIVE_MONTHS: number // 学生账号多少个月没用就自动删除
export const STUDENT_HANDOUT_DAYS: number // 学生上传的讲义没人用了多少天以后删
// 学生上传判断「同一篇」：paragraphsOf 是后端照 pipeline/article.ts 的 toParagraphs 写的分段（先做 NFC 规范化），articleKeys 是精确键和近似键（sha256 十六进制）
export function paragraphsOf(text: string): string[]
export function articleKeys(text: string): { exact: string; near: string }
export const DELETIONS_FILE: string // 删除台账的文件名（在 deletionsDir 里）
export function sidHash(sid: string): string // 删除台账里记的 sid 的 sha256（十六进制）
export function studentInviteHash(code: string): string // 学生邀请码存的哈希：去掉空白和「-」、转大写后的 sha256（十六进制）
export function hashPassword(password: string): Promise<string>
export function verifyPassword(password: string, stored: string): Promise<boolean>
