/** @type {import('tailwindcss').Config} */
// 颜色和字体照 docs/设计规范.md
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        ground: '#FAFDF6', // 底色（10-11 新配色）
        surface: '#FFFFFF',
        line: { DEFAULT: '#DDE0D8', soft: '#ECEEE8', strong: '#C9CEC4' },
        ink: '#1B1F1D',
        ink2: '#4A524E',
        muted: '#5C6560',
        dim: '#9AA29D',
        primary: { DEFAULT: '#002642', hover: '#001B2E', light: '#E6E9EC' }, // 主色：深海军蓝（按钮、链接、logo 背景）
        // 芥末黄：知识点高亮和装饰图标。DEFAULT 只做图标、边框、色块（白底对比度 2.2:1，不能当文字）；文字一律用 dark（白底 6.8:1）
        amber: { DEFAULT: '#DEA82B', light: '#F6E7C4', dark: '#735716', soft: '#FCF8EE', edge: '#F0D8A0' },
        green: { DEFAULT: '#5DAC97', light: '#E8F3F0', dark: '#3A6B5E' }, // 「对 / 用上了」：青绿。DEFAULT 做图标、边框、圆点；文字用 dark
        red: { DEFAULT: '#E3514F', light: '#FBE7E6', dark: '#A33A39' }, // 「错」：珊瑚红。DEFAULT 做边框和图标；文字用 dark
        select: { DEFAULT: '#1D4E89', light: '#E3ECF7' }, // 「选中了、还没提交」：蓝色，和绿色的「答对」区分开
        note: { DEFAULT: '#FDFAF2', line: '#DEA82B' },
        who: { DEFAULT: '#F6E7C4', mark: '#EBCB80' }, // 梯子第 1 步「谁」：高亮底色 / 图例色块
        what: { DEFAULT: '#D6EAE1', mark: '#9CC7B3' }, // 「做了什么」
        heat: { 1: '#FBF5E6', 2: '#F3E1B5', 3: '#EAC675', 4: '#DEA82B' }, // 热力图：芥末黄由浅到深
      },
      fontFamily: {
        serif: ['Georgia', "'Times New Roman'", "'Songti SC'", 'serif'],
        sans: ['-apple-system', 'BlinkMacSystemFont', "'PingFang SC'", "'Microsoft YaHei'", "'Segoe UI'", 'sans-serif'],
      },
    },
  },
  plugins: [],
}
