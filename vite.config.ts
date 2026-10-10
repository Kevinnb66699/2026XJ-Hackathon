/// <reference types="vitest" />
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: { '/api': 'http://localhost:8787' },
  },
  test: {
    include: ['tests/**/*.test.ts'],
    // 后端测试用 undici：Node 16 的 worker 线程结束时若有 FinalizationRegistry 清理任务会卡死，
    // vitest 报「Failed to terminate worker」不退出（约 1/10）。这几个文件改用子进程跑。
    // vitest 拿绝对路径匹配，且 ** 不匹配 .claude 这类点目录，所以写成绝对路径
    poolMatchGlobs: [
      [fileURLToPath(new URL('./tests/server.test.ts', import.meta.url)), 'child_process'],
      [fileURLToPath(new URL('./tests/server-advice.test.ts', import.meta.url)), 'child_process'],
      [fileURLToPath(new URL('./tests/server-notes.test.ts', import.meta.url)), 'child_process'],
      [fileURLToPath(new URL('./tests/server-edits.test.ts', import.meta.url)), 'child_process'],
      [fileURLToPath(new URL('./tests/server-perms.test.ts', import.meta.url)), 'child_process'],
    ],
  },
})
