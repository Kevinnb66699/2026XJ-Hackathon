# 二维码与卡片

所有二维码都在本机离线生成，并用程序解码核对过：

```bash
npm run qr                  # 二维码
python3 tools/qr_cards.py   # 卡片
```

| 文件 | 指向 | 用途 |
|---|---|---|
| `home.png` / `home.svg` | https://zhishi.jiling.chat | **易拉宝主码**：网站首页，扫开后自己选学生 / 老师 / 评委 |
| `judge.png` / `judge.svg` / `judge-card.png` | https://zhishi.jiling.chat/#/judge | 评委模式：展位讲解时在电脑上直接打开演示 |
| `student.png` / `student.svg` / `student-card.png` | https://zhishi.jiling.chat/#/student | 同学试用 |
| `teacher.png` / `teacher.svg` / `teacher-card.png` | https://zhishi.jiling.chat/#/teacher | 老师端（可选） |

## 印刷要求（给打印店和排版）

- **优先用 SVG**（矢量，放多大都不会糊）；没法用 SVG 时用 2000×2000 的 PNG。
- **二维码边长至少 8–10 cm**，评委站在 1 米外也能扫。
- 二维码四周要留白，不要压字或压图，也不要改颜色。纠错等级已经是最高的 H，但不能在码中间盖 logo。
- 码旁边印一行网址 **zhishi.jiling.chat**，扫不了的人可以手动输入。
- 印好后，用**微信扫一扫**和**手机相机**各试一次，确认能打开页面。
