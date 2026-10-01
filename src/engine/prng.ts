// 种子随机数（mulberry32）：同一个种子永远得到同一串数，点评名单可复现
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// 字符串哈希（FNV-1a 32 位），用于按 sid 确定性地选假词
export function hashString(x: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < x.length; i++) {
    h ^= x.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}
