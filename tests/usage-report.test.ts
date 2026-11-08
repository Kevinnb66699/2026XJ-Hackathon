// 用量报表 scripts/usage-report.mjs：用假的 usage 日志测合计（按天、按类型、按模型，估计额单列；每篇生成的平均和最多），只出合计数。
// 照 student-cli.test.ts 用子进程跑，DATA_DIR 指向临时目录，ENV_FILE 指向不存在的文件（不读仓库里的 .env）
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const root = fileURLToPath(new URL('..', import.meta.url))
const H = 3600 * 1000
const month = new Date(Date.now() + 8 * H).toISOString().slice(0, 7) // 这个月（北京时间）
const [y, m] = month.split('-').map(Number)
const at = (day: number, hour = 10) => Date.UTC(y, m - 1, day, hour) - 8 * H // 这个月某一天北京时间几点

function run(dir: string, ...args: string[]) {
  const r = spawnSync(process.execPath, ['scripts/usage-report.mjs', ...args], { cwd: root, encoding: 'utf8', env: { ...process.env, DATA_DIR: dir, ENV_FILE: path.join(dir, 'missing.env') } })
  return { code: r.status, out: r.stdout, err: r.stderr }
}
const row = (ts: number, kind: string, model: string, cost: number, o: Record<string, unknown> = {}) => JSON.stringify({ ts, kind, model, input: 1, output: 1, cached: 0, cost, estimated: false, ...o })

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zhishi-usage-report-'))
  fs.writeFileSync(
    path.join(dir, `usage-${month}.jsonl`),
    [
      row(at(1), 'writing', 'qwen3.8-flash', 2000),
      row(at(1, 23), 'writing', 'qwen3.8-flash', 4300, { estimated: true }),
      row(at(2), 'article', 'deepseek-v4-pro', 500000, { handoutId: 'up-aaaa' }),
      row(at(2), 'lexicon', 'deepseek-v4-pro', 100000, { handoutId: 'up-aaaa' }),
      row(at(2), 'title', 'deepseek-v4-pro', 6000, { handoutId: 'up-aaaa', estimated: true }),
      row(at(2), 'article', 'deepseek-v4-pro', 300000, { handoutId: 'up-bbbb' }),
      row(at(2), 'lexicon', 'deepseek-v4-pro', 50000, { handoutId: 'up-cccc' }), // 只补了词义的旧讲义：不算一篇
      '写坏的一行',
      row(at(2), 'writing', 'qwen3.8-flash', -1),
      '',
    ].join('\n'),
  )
  fs.writeFileSync(path.join(dir, 'usage-2020-01.jsonl'), `${row(Date.UTC(2020, 0, 5), 'advice', 'qwen3.8-flash', 1000)}\n`)
  return dir
}

describe('scripts/usage-report.mjs', () => {
  it('默认这个月：合计、按天（北京时间）、按类型、按模型，实际和估计额分开；每篇生成的平均和最多；格式不对的行单说；不列讲义 id', () => {
    const dir = fixture()
    const r = run(dir)
    expect(r.code).toBe(0)
    const lines = r.out.split('\n')
    expect(lines).toContain(`usage 日志：usage-${month}.jsonl（金额单位：元）`)
    expect(lines).toContain('合计：0.9623 元，其中实际 0.9520 元（5 次），估计额 0.0103 元（2 次）')
    const after = (title: string) => lines.slice(lines.indexOf(title) + 1)
    expect(after('按天（北京时间）').slice(0, 2)).toEqual([
      `  ${month}-01  实际 0.0020 元（1 次）  估计额 0.0043 元（1 次）`,
      `  ${month}-02  实际 0.9500 元（4 次）  估计额 0.0060 元（1 次）`,
    ])
    expect(after('按类型').slice(0, 4)).toEqual([
      '  article  实际 0.8000 元（2 次）  估计额 0.0000 元（0 次）',
      '  lexicon  实际 0.1500 元（2 次）  估计额 0.0000 元（0 次）',
      '  title  实际 0.0000 元（0 次）  估计额 0.0060 元（1 次）',
      '  writing  实际 0.0020 元（1 次）  估计额 0.0043 元（1 次）',
    ])
    expect(after('按模型').slice(0, 2)).toEqual([
      '  deepseek-v4-pro  实际 0.9500 元（4 次）  估计额 0.0060 元（1 次）',
      '  qwen3.8-flash  实际 0.0020 元（1 次）  估计额 0.0043 元（1 次）',
    ])
    expect(lines).toContain('生成讲义：2 篇，每篇平均 0.4530 元，最多 0.6060 元（含估计额）')
    expect(lines).toContain('有 2 行格式不对，没算进去')
    expect(r.out).not.toMatch(/up-/)
  })

  it('生成讲义的一次调用有开始（open）、结束两行：有结束那行只算它；token 是 0 的结束行两行都不算；没结束的（进程中途被重启）按开始那行的估计额算', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zhishi-usage-report-'))
    const h = { handoutId: 'up-dddd' }
    fs.writeFileSync(
      path.join(dir, `usage-${month}.jsonl`),
      [
        row(at(3), 'article', 'deepseek-v4-pro', 200000, { ...h, call: 'up-dddd:1', open: true, estimated: true }),
        row(at(3), 'article', 'deepseek-v4-pro', 50000, { ...h, call: 'up-dddd:1' }),
        row(at(3), 'lexicon', 'deepseek-v4-pro', 70000, { ...h, call: 'up-dddd:2', open: true, estimated: true }),
        JSON.stringify({ ts: at(3), kind: 'lexicon', model: 'deepseek-v4-pro', input: 0, output: 0, cached: 0, cost: 0, estimated: false, ...h, call: 'up-dddd:2' }),
        row(at(3), 'title', 'deepseek-v4-pro', 6000, { ...h, call: 'up-dddd:3', open: true, estimated: true }),
        '',
      ].join('\n'),
    )
    const r = run(dir)
    expect(r.code).toBe(0)
    expect(r.out).toContain('合计：0.0560 元，其中实际 0.0500 元（1 次），估计额 0.0060 元（1 次）')
    expect(r.out).toContain('生成讲义：1 篇，每篇平均 0.0560 元，最多 0.0560 元（含估计额）')
    expect(r.out).not.toMatch(/up-|格式不对/)
  })

  it('指定月份、all；没有的月份单说；参数不认识退出码 1；数据目录不在退出码 1', () => {
    const dir = fixture()
    const old = run(dir, '2020-01')
    expect(old.code).toBe(0)
    expect(old.out).toContain('合计：0.0010 元，其中实际 0.0010 元（1 次），估计额 0.0000 元（0 次）')
    expect(old.out).toContain('  2020-01-05  实际 0.0010 元（1 次）')
    expect(old.out).toContain('生成讲义：0 篇')
    expect(run(dir, 'all').out).toContain(`usage 日志：usage-2020-01.jsonl、usage-${month}.jsonl（金额单位：元）`)
    expect(run(dir, 'all').out).toContain('合计：0.9633 元')
    const none = run(dir, '2019-12')
    expect(none.code).toBe(0)
    expect(none.out).toContain('没有这几个文件：usage-2019-12.jsonl')
    expect(none.out).toContain('合计：0.0000 元')
    expect(run(dir, '2026-1').code).toBe(1)
    expect(run(path.join(dir, 'nope')).code).toBe(1)
  })
})
