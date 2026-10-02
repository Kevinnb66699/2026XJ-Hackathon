# 数据来源与授权

| 数据 | 来源 | 授权 / 许可 | 位置 |
|---|---|---|---|
| 一周外刊讲义（Day 1–5，主题：青少年社交媒体禁令） | 团队购买的外刊精读讲义；文中外刊原文版权归原刊物所有 | 团队购买，**可以公开使用**（队长 2026-10-02 确认） | `data/raw/day1-5.txt`（由 PDF 用 pdftotext 转成的文本） |
| 迷你讲义样例 | 团队原创 | 可自由使用 | `tests/fixtures/mini-handout.ts` |
| 老师上传的文章 | 使用者自己粘贴的文章 | 由上传者负责；只有拿到链接才能打开，不公开列出 | 服务器 `server/data/handouts/`（不进仓库） |
| 大模型 | 组委会提供的 TokenDance 接口（国内模型） | 按赛事提供的额度使用 | — |
| 营地问卷和试用数据 | 营地同龄人自愿匿名填写，不收集姓名 | 问卷首页已说明用途 | 汇总结果见路演材料 |

## 开源依赖

React、Vite、TypeScript、Tailwind CSS、Vitest、zod、Express、undici，均为 MIT 许可。完整列表见 `package.json`。
