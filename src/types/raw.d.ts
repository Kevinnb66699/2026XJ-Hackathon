// Vite 的 ?raw 导入（整个文件当字符串）：tsconfig 没带 vite/client 的类型，只声明用到的 .md
declare module '*.md?raw' {
  const text: string
  export default text
}
