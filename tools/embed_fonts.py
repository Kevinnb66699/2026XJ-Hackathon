# 把思源黑体（Noto Sans SC 400/500/700/900）和 Noto Serif 斜体嵌进网页版路演稿，只截取稿子里用到的字。
# 可以反复运行：已经嵌过的会整段替换。网页里加了新字，重新跑一次就行。
# 用法（在仓库根目录）：python3 tools/embed_fonts.py docs/知适-路演PPT-网页版.html（原地改写；需要 pip install fonttools brotli）
# 需要：fontTools（brotli 可选，有就出 woff2，没有就出 woff）。字体变量文件放在 FONTS 目录（默认 ~/.cache/zhishi-fonts），缺了会自动下载：
#   NotoSansSC-VF.ttf      https://github.com/google/fonts/raw/main/ofl/notosanssc/NotoSansSC%5Bwght%5D.ttf
#   NotoSerif-Italic-VF.ttf https://github.com/google/fonts/raw/main/ofl/notoserif/NotoSerif-Italic%5Bwdth%2Cwght%5D.ttf
# 字体许可：SIL Open Font License 1.1，可以免费嵌入和分发。
import base64, io, os, re, sys
from fontTools.ttLib import TTFont
from fontTools.varLib import instancer
from fontTools import subset

FONTS = os.environ.get('FONTS', os.path.expanduser('~/.cache/zhishi-fonts'))
SOURCES = {
    'NotoSansSC-VF.ttf': 'https://github.com/google/fonts/raw/main/ofl/notosanssc/NotoSansSC%5Bwght%5D.ttf',
    'NotoSerif-Italic-VF.ttf': 'https://github.com/google/fonts/raw/main/ofl/notoserif/NotoSerif-Italic%5Bwdth%2Cwght%5D.ttf',
}
os.makedirs(FONTS, exist_ok=True)
for name, url in SOURCES.items():
    if not os.path.exists(os.path.join(FONTS, name)):
        import urllib.request
        print('downloading', name, '...')
        urllib.request.urlretrieve(url, os.path.join(FONTS, name))
path = sys.argv[1]
html = open(path, encoding='utf-8').read()

try:
    import brotli  # noqa: F401
    FLAVOR, MIME, FMT = 'woff2', 'font/woff2', 'woff2'
except ImportError:
    FLAVOR, MIME, FMT = 'woff', 'font/woff', 'woff'

# 页面上会显示的字：去掉脚本、样式、注释后的全部文字和 data-title，再加上全部 ASCII 和常用中文标点（以后改字少缺字）
body = re.sub(r'<script\b.*?</script>|<style\b.*?</style>|<!--.*?-->', '', html, flags=re.S)
titles = ''.join(re.findall(r'data-title="([^"]*)"', body))
text = re.sub(r'<[^>]+>', '', body) + titles
import html as htmlmod
text = htmlmod.unescape(text)
chars = set(text) | set(chr(c) for c in range(0x20, 0x7F)) | set('，。、；：？！「」『』（）《》〈〉【】——……·・“”‘’％＋－×÷→←↑↓⇔～')
chars = {c for c in chars if not c.isspace() or c == ' '}
serif_chars = set(chr(c) for c in range(0x20, 0x7F)) | set('“”‘’')


def build(vf, axes, keep):
    font = TTFont(os.path.join(FONTS, vf))
    font = instancer.instantiateVariableFont(font, axes)
    opts = subset.Options()
    opts.flavor = FLAVOR
    opts.layout_features = ['*']
    opts.name_IDs = ['*']
    opts.notdef_outline = True
    opts.hinting = False
    sub = subset.Subsetter(opts)
    sub.populate(text=''.join(sorted(keep)))
    sub.subset(font)
    b = io.BytesIO()
    font.flavor = FLAVOR
    font.save(b)
    return base64.b64encode(b.getvalue()).decode(), len(b.getvalue())


rules, total = [], 0
for w in (400, 500, 700, 900):
    data, n = build('NotoSansSC-VF.ttf', {'wght': w}, chars)
    total += n
    rules.append(f"@font-face {{ font-family: 'Noto Sans SC'; font-weight: {w}; font-style: normal; font-display: block; src: url(data:{MIME};base64,{data}) format('{FMT}'); }}")
data, n = build('NotoSerif-Italic-VF.ttf', {'wght': 400, 'wdth': 100}, serif_chars)
total += n
rules.append(f"@font-face {{ font-family: 'Noto Serif'; font-weight: 400; font-style: italic; font-display: block; src: url(data:{MIME};base64,{data}) format('{FMT}'); }}")

block = ('<style id="fonts">\n/* 内嵌字体：思源黑体 Noto Sans SC 400/500/700/900、Noto Serif 斜体，SIL Open Font License 1.1。'
         f'只含稿子里用到的 {len(chars)} 个字符；新加的字如果不在里面，会自动用苹方显示，重新嵌一次即可。 */\n'
         + '\n'.join(rules) + '\n</style>')

# 去掉 Google Fonts 链接和联网预载代码；已经嵌过的整段替换
html = re.sub(r'<link id="gf"[^>]*>\n?', '', html)
html = re.sub(r'<link rel="stylesheet" href="https://fonts\.googleapis\.com[^>]*>\n?', '', html)
html = re.sub(r"// 字体：Google Fonts 连得上时.*?\nif \(gf\)[^\n]*\n", '', html, flags=re.S)
NOTE = ('  - 字体：已内嵌思源黑体（Noto Sans SC 400/500/700/900）和 Noto Serif 斜体，断网也和设计稿一样（字体许可 SIL OFL 1.1）。'
        '只嵌了稿子里用到的字；以后新加的字如果不在里面，会自动用苹方 / 微软雅黑显示，运行仓库里的 tools/embed_fonts.py 重新嵌一次即可补上。')
html = re.sub(r'  - 字体：[^\n]*', lambda m: NOTE, html, count=1)
if '<style id="fonts">' in html:
    html = re.sub(r'<style id="fonts">.*?</style>', lambda m: block, html, flags=re.S)
else:
    html = html.replace('</head>', block + '\n</head>', 1)
open(path, 'w', encoding='utf-8').write(html)
print(f'embedded {FLAVOR}: {len(chars)} chars, fonts {total // 1024} KB, html {os.path.getsize(path) // 1024} KB')
