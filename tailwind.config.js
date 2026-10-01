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
        blue: { DEFAULT: '#1D4E89', hover: '#163B68', light: '#E3ECF7' },
        amber: { DEFAULT: '#A3570C', light: '#FBE8C8', dark: '#7A3F06', soft: '#FFF8EC', edge: '#F0D4A8' },
        green: { DEFAULT: '#2F6B3F', light: '#E2F0E4', dark: '#1F4A2B' },
        red: { DEFAULT: '#A33A2B', light: '#F7E1DD', dark: '#7C2A1F' },
        note: { DEFAULT: '#FFFBEF', line: '#C9A15A' },
        who: '#FBE8C8',
        what: '#DCE8F7',
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
