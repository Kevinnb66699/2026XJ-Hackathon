// server/index.mjs 的类型声明，供 tests/*.ts 引用
import type { Server } from 'http'

export interface ServerConfig {
  port: number
  dataDir: string
  apiKey: string
  llmBaseUrl: string
  llmModel: string
  llmFallbacks: string[]
  llmTimeoutMs: number
  log: (line: string) => void
}

export const EVENT_TYPES: string[]
export function readEnvFile(file: string): Record<string, string>
export function loadConfig(env?: Record<string, string | undefined>): ServerConfig
export function buildBody(model: string, fallbacks: string[], text: string, expressions: unknown[]): Record<string, unknown>
export function createApp(config?: Partial<ServerConfig>): { listen(port: number, host: string, cb?: () => void): Server }
