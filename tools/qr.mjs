// 生成展位和试用用的二维码（离线生成，不经过第三方网站），并解码一遍确认内容。
// 用法：npm run qr        输出到 docs/assets/qr/
import fs from 'node:fs'
import path from 'node:path'
import QRCode from 'qrcode'
import jsQR from 'jsqr'
import { PNG } from 'pngjs'

const BASE = process.env.QR_BASE || 'https://zhishi.jiling.chat'
const OUT = 'docs/assets/qr'
const TARGETS = [
  { file: 'home', url: BASE, label: '首页（易拉宝主码）' },
  { file: 'judge', url: `${BASE}/#/judge`, label: '评委模式' },
  { file: 'student', url: `${BASE}/#/student`, label: '学生端' },
  { file: 'teacher', url: `${BASE}/#/teacher`, label: '老师端' },
]
// 最高纠错等级 H：KT 板反光、折痕、局部遮挡也能扫
const OPTS = { errorCorrectionLevel: 'H', margin: 4, color: { dark: '#1B1F1DFF', light: '#FFFFFFFF' } }

fs.mkdirSync(OUT, { recursive: true })
let ok = true
for (const t of TARGETS) {
  const png = path.join(OUT, `${t.file}.png`)
  const svg = path.join(OUT, `${t.file}.svg`)
  await QRCode.toFile(png, t.url, { ...OPTS, width: 2000 })
  fs.writeFileSync(svg, await QRCode.toString(t.url, { ...OPTS, type: 'svg' }))
  // 解码校验：生成的图必须能被读出同一个网址
  const img = PNG.sync.read(fs.readFileSync(png))
  const decoded = jsQR(new Uint8ClampedArray(img.data), img.width, img.height)
  const pass = decoded?.data === t.url
  ok &&= pass
  console.log(`${pass ? '✓' : '✗'} ${t.label}  ${t.url}  →  ${png}、${svg}`)
}
if (!ok) process.exit(1)
