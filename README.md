# 知适：把讲义里的「如果」，改成「你」

> 杭州学军中学「回响 · 48H 青年创造营」Echo 赛道作品（2026-10-01 22:00 至 10-03 24:00）
>
> 在线体验：**https://zhishi.jiling.chat**（学生 / 老师 / 评委三个入口）

老师写一份外刊讲义，全班拿到的是同一份 PDF。讲义里写着「如果不认识 fret 一词，很大概率可能会不理解本句话的意思」，但一份 PDF 只能对全班写「如果」。

**知适**让每个学生读到写给自己的那一份：

- **原文一字不改**，老师的教学目标一个不少。
- 只在**你卡住的地方**搭一架会自己撤掉的「读懂梯子」：谁 → 做了什么 → 正常语序 → 简单英文。
- 你读到的表达，要在你自己的写作里用出来（表达链）。
- 全班的卡点回响给老师，变成一张「今天点评这几个人」和卡点热力图。

## 架构

```
老师侧（离线，每份讲义一次）                     学生侧（运行时，纯规则）               数据回流
data/raw/day1-5.txt                              问卷 + 行为事件                         POST /api/events
  → pipeline/extract.ts   规则抽取（句子、核心词、    → src/engine  personalize()           → 教师页：今天点评谁、
     打卡句、填空、老师精讲）                          纯函数，按直接证据适配支架              卡点热力图、下一届起点
  → pipeline/draft.ts     大模型按段起草（梯子、    → 写作：规则检查用没用上 +
     原句题、段意题、注释、表达）                        POST /api/writing-check（服务器代理大模型，
  → pipeline/validate.ts  校验器（原文子串、出处、     只判断用得对不对，不改写）
     语法术语、必练覆盖）
  → 人工确认 → data/handouts/<id>.json
```

- **AI 只在老师那一侧用一次**：每份讲义入库时调用一次，成本和学生人数无关；所有输出都经过校验器检查，并附老师原话作为出处。
- **学生侧是确定性规则**：可解释，没有延迟，不会直接给答案，也不存「已掌握」标签。
- **唯一的运行时 AI 是写作检查**：判断表达用得对不对，绝不改写学生的句子；8 秒超时后回落到规则检查。

| 目录 | 内容 |
|---|---|
| `shared/schema.ts` | 数据契约（zod），管线、前端、测试共用 |
| `src/engine/` | 适配引擎：`personalize` / `stuck` / `ladderMode` / `reviewPicks` |
| `src/` | 前端（Vite + React + TypeScript + Tailwind） |
| `pipeline/` | 讲义入库：`extract` → `draft` → `validate`，带缓存（`pipeline/cache/`）和报告 |
| `server/index.mjs` | 极小后端：事件回流和写作检查（Express，JSONL 存储） |
| `tests/` | Vitest 测试，含团队自写的迷你讲义样例 `tests/fixtures/mini-handout.ts` |
| `deploy/` | Nginx、systemd 示例和部署说明 |
| `docs/` | 开发规格、设计规范、方案演进记录 |

## 运行

需要 Node ≥ 16.14。

```bash
npm install
npm run dev          # 前端，http://localhost:5173
npm run server       # 后端，127.0.0.1:8787（写作检查需要 .env 里的 tokenspace_apikey）
npm run check        # 类型检查 + 测试 + 讲义校验 + 构建
```

讲义入库（老师侧）：

```bash
npm run ingest -- --replay   # 只用 pipeline/cache 里的模型响应复跑，不联网，可复现
npm run ingest               # 调用大模型重新起草（需要 .env 里的 tokenspace_apikey）
```

## 学生侧的硬规则（写在测试里）

- 句子原文与讲义逐字一致；
- 老师的必练项（打卡句、核心词、写作要求的表达）永不收起；
- 题目选项数不减少；
- 打卡句交初稿前只开放梯子第 1 级；
- 学生端不出现语法术语；
- 写作反馈不给改写后的句子；
- 不显示任何等级标签。

## 声明

- AI 工具使用说明：[AI_USAGE.md](AI_USAGE.md)
- 数据来源与授权：[DATA_SOURCES.md](DATA_SOURCES.md)
- 开发过程记录：[MEMORY_LOG.md](MEMORY_LOG.md)，以及 git 提交历史（北京时间）
