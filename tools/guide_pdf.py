# 把老师使用指南（#/guide）打印成 A4 PDF，存到 public/zhishi-teacher-guide.pdf（指南页顶上「下载 PDF 版」链的就是它）。
# 改了 src/content/guide.md 或截图后重新生成。要先开着本机前端（npm run dev，指南页不用登录、不用后端），本机装着 Chrome，
# Python 装了 websocket-client（pip install websocket-client）。
#   python3 tools/guide_pdf.py [指南页地址，默认 http://localhost:5173/#/guide] [输出，默认 public/zhishi-teacher-guide.pdf]
# 打印前：目录（#/guide?s=…）改成 PDF 里的跳转，别的站内链接换成线上网址（PDF 里点了能打开）；去掉「下载 PDF 版」那一行和顶栏右边的账号区；
# 截图照 guide.md 里写的显示尺寸，最高 8.3 英寸（太高的等比缩小），截图和表格不跨页
import base64, json, os, shutil, subprocess, sys, tempfile, time, urllib.request
import websocket

CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
SITE = 'https://zhishi.jiling.chat/'
url = sys.argv[1] if len(sys.argv) > 1 else 'http://localhost:5173/#/guide'
out = sys.argv[2] if len(sys.argv) > 2 else os.path.join(os.path.dirname(__file__), '..', 'public', 'zhishi-teacher-guide.pdf')

PREPARE = r'''(async () => {
  const imgs = [...document.images]; imgs.forEach((i) => (i.loading = 'eager'));
  await Promise.race([Promise.all(imgs.map((i) => i.decode().catch(() => {}))), new Promise((r) => setTimeout(r, 15000))]);
  document.querySelectorAll('a[href^="#/guide?s="]').forEach((a) => a.setAttribute('href', '#' + new URLSearchParams(a.getAttribute('href').split('?')[1]).get('s')));
  document.querySelectorAll('a[href^="#/"]').forEach((a) => (a.href = SITE + a.getAttribute('href')));
  [...document.querySelectorAll('article a')].filter((a) => a.textContent.includes('下载 PDF 版')).forEach((a) => a.closest('p').remove());
  document.querySelectorAll('header').forEach((h) => (h.style.position = 'static'));
  document.querySelectorAll('header .ml-auto').forEach((x) => x.remove());
  const maxH = 8.3 * 96;
  const shots = imgs.filter((i) => i.getAttribute('src')?.startsWith('/guide-img/'));
  for (const i of shots) {
    const w = Number(i.getAttribute('width')), h = Number(i.getAttribute('height'));
    if (h > maxH) i.style.width = (w * maxH) / h + 'px';
  }
  const st = document.createElement('style');
  st.textContent = 'figure, table, tr { break-inside: avoid; } h1, h2, h3 { break-after: avoid; } body, .bg-ground { background: #fff !important; } article { border: none !important; box-shadow: none !important; }';
  document.head.appendChild(st);
  return { shots: shots.length, broken: imgs.filter((i) => !i.naturalWidth).length, unsized: shots.filter((i) => !i.getAttribute('width')).length };
})()'''.replace('SITE', json.dumps(SITE))

profile = tempfile.mkdtemp(prefix='zhishi-guide-chrome-')
proc = subprocess.Popen([CHROME, '--headless=new', '--remote-debugging-port=9334', f'--user-data-dir={profile}', '--no-first-run', '--lang=zh-CN', 'about:blank'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
try:
    page = None
    for _ in range(50):
        try:
            page = next(p for p in json.load(urllib.request.urlopen('http://127.0.0.1:9334/json')) if p['type'] == 'page')
            break
        except Exception:
            time.sleep(0.2)
    if not page:
        sys.exit('Chrome 没起来')
    ws = websocket.create_connection(page['webSocketDebuggerUrl'], timeout=120, suppress_origin=True)
    seq = [0]

    def cdp(method, **params):
        seq[0] += 1
        ws.send(json.dumps({'id': seq[0], 'method': method, 'params': params}))
        while True:
            m = json.loads(ws.recv())
            if m.get('id') == seq[0]:
                if 'error' in m:
                    raise RuntimeError(f"{method}: {m['error']}")
                return m.get('result', {})

    cdp('Page.enable')
    cdp('Page.navigate', url=url)
    time.sleep(2)
    r = cdp('Runtime.evaluate', expression=PREPARE, awaitPromise=True, returnByValue=True)
    info = r.get('result', {}).get('value') or {}
    if not info.get('shots') or info.get('broken') or info.get('unsized'):
        sys.exit(f'指南页没打开、截图没加载好或没写尺寸：{info}（本机前端开着吗？guide.md 里每张图要写「=宽x高」）')
    time.sleep(0.5)
    pdf = cdp('Page.printToPDF', paperWidth=8.27, paperHeight=11.69, marginTop=0.5, marginBottom=0.5, marginLeft=0.45, marginRight=0.45, printBackground=True)['data']
    with open(out, 'wb') as f:
        f.write(base64.b64decode(pdf))
    print(f'{os.path.normpath(out)}：{info["shots"]} 张截图，{os.path.getsize(out) // 1024} KB')
    ws.close()
finally:
    proc.terminate()
    proc.wait(timeout=10)
    shutil.rmtree(profile, ignore_errors=True)
