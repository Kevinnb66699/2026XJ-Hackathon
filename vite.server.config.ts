// 后端用的上传管线包：npm run build 时输出 dist-server/article.mjs，Node 20 直接 import()
import { defineConfig } from 'vite'

export default defineConfig({
  build: {
    ssr: 'pipeline/article.ts',
    outDir: 'dist-server',
    emptyOutDir: true,
    rollupOptions: { output: { entryFileNames: '[name].mjs' } },
  },
  ssr: { external: ['zod', 'undici'] },
})
