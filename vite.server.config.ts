// 后端用的两个包：npm run build 时输出到 dist-server/，Node 20 直接 import()。
// article.mjs 是上传管线（server/article-worker.mjs、scripts/lexicon.mjs 用），notebook.mjs 是单词本和表达本的推算（server/index.mjs 用）。
// 两个包共用的代码（如 shared/schema.ts）打成 dist-server/ 里的另一个文件，一起部署
import { defineConfig } from 'vite'

export default defineConfig({
  build: {
    ssr: true,
    outDir: 'dist-server',
    emptyOutDir: true,
    rollupOptions: {
      input: { article: 'pipeline/article.ts', notebook: 'src/lib/notebook.ts' },
      output: { entryFileNames: '[name].mjs', chunkFileNames: '[name]-[hash].mjs' },
    },
  },
  ssr: { external: ['zod', 'undici'] },
})
