/** @type {import('tailwindcss').Config} */
// 颜色和字体照 docs/设计规范.md
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        ground: '#F3F4EF',
        surface: '#FFFFFF',
        line: { DEFAULT: '#DDE0D8', soft: '#ECEEE8', strong: '#C9CEC4' },
        ink: '#1B1F1D',
        ink2: '#4A524E',
        muted: '#5C6560',
        dim: '#9AA29D',
        primary: { DEFAULT: '#0F4C3A', hover: '#0A382B', light: '#E1EEE9' }, // 主色：深墨绿
        amber: { DEFAULT: '#A3570C', light: '#FBE8C8', dark: '#7A3F06', soft: '#FFF8EC', edge: '#F0D4A8' },
        green: { DEFAULT: '#4A7A1E', light: '#EEF5E3', dark: '#36581A' }, // 「对 / 用上了」：偏黄的叶绿，和主色在色相和明度上都拉开
        red: { DEFAULT: '#A33A2B', light: '#F7E1DD', dark: '#7C2A1F' },
        select: { DEFAULT: '#1D4E89', light: '#E3ECF7' }, // 「选中了、还没提交」：蓝色，和绿色的「答对」区分开
        note: { DEFAULT: '#FFFBEF', line: '#C9A15A' },
        who: { DEFAULT: '#FBE8C8', mark: '#F2C98A' }, // 梯子第 1 步「谁」：高亮底色 / 图例色块
        what: { DEFAULT: '#D6EAE1', mark: '#9CC7B3' }, // 「做了什么」
        heat: { 1: '#FFF4E3', 2: '#FBE0B5', 3: '#F2C07A', 4: '#E39A3B' },
      },
      fontFamily: {
        serif: ['Georgia', "'Times New Roman'", "'Songti SC'", 'serif'],
        sans: ['-apple-system', 'BlinkMacSystemFont', "'PingFang SC'", "'Microsoft YaHei'", "'Segoe UI'", 'sans-serif'],
      },
    },
  },
  plugins: [],
}
