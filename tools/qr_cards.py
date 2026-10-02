"""把二维码排成带标题和网址的卡片（PNG，可直接打印或在手机上展示）。
先运行 npm run qr 生成二维码，再运行：python3 tools/qr_cards.py
需要 Pillow；字体用 macOS 自带的 Hiragino Sans GB 和 Georgia（换机器时改 FONT_* 路径）。
"""
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

QR_DIR = Path("docs/assets/qr")
FONT_SANS = "/System/Library/Fonts/Hiragino Sans GB.ttc"
FONT_SERIF = "/System/Library/Fonts/Supplemental/Georgia.ttf"
INK, INK2, PRIMARY, LINE, PAPER = "#1B1F1D", "#4A524E", "#0F4C3A", "#DDE0D8", "#F3F4EF"

CARDS = [
    ("judge", "评委扫码", "3 道题，马上看到「你的这一份」"),
    ("student", "扫码试用", "用手机读一篇外刊，原文一字不改"),
    ("teacher", "老师端", "今天点评这几个人，全班卡在哪几句"),
]

W, H = 1200, 1650


def center(draw: ImageDraw.ImageDraw, y: int, text: str, font, fill) -> None:
    w = draw.textlength(text, font=font)
    draw.text(((W - w) / 2, y), text, font=font, fill=fill)


for name, title, subtitle in CARDS:
    card = Image.new("RGB", (W, H), PAPER)
    d = ImageDraw.Draw(card)
    # 白色卡片
    d.rounded_rectangle((60, 60, W - 60, H - 60), radius=40, fill="white", outline=LINE, width=3)
    center(d, 130, "知适", ImageFont.truetype(FONT_SANS, 64, index=1), INK)  # index=1：粗体
    center(d, 225, "把讲义里的「如果」，改成「你」", ImageFont.truetype(FONT_SANS, 34), INK2)
    center(d, 320, title, ImageFont.truetype(FONT_SANS, 76, index=1), PRIMARY)
    center(d, 425, subtitle, ImageFont.truetype(FONT_SANS, 38), INK)
    qr = Image.open(QR_DIR / f"{name}.png").convert("RGB").resize((860, 860), Image.NEAREST)
    card.paste(qr, ((W - 860) // 2, 510))
    center(d, 1400, "zhishi.jiling.chat", ImageFont.truetype(FONT_SERIF, 52), INK)
    center(d, 1480, "扫不了可以直接输入网址", ImageFont.truetype(FONT_SANS, 30), INK2)
    out = QR_DIR / f"{name}-card.png"
    card.save(out)
    print(f"✓ {out}")
