// 隐私页面四项：隐私说明页（#/privacy，src/content/privacy.md + 自写 Markdown 渲染器）和页脚链接、选座号页的要点框和必勾复选框、
// 建班 / 换名单的两项确认、写作页的私人信息提醒。渲染器用 react-dom/server 渲染成 HTML 字符串查；没有 DOM 测试环境，页面条件和文案直接查源码
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { createElement, Fragment } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { renderMarkdown } from '../src/lib/markdown'
import { privateInfo } from '../src/lib/writing'

const read = (f: string) => readFileSync(fileURLToPath(new URL(`../src/${f}`, import.meta.url)), 'utf8')
const html = (md: string) => renderToStaticMarkup(createElement(Fragment, null, ...renderMarkdown(md)))

describe('renderMarkdown：自写的小 Markdown 渲染器', () => {
  it('# / ## / ### 标题；末尾写 {#id} 给标题加 id，不写就没有 id；#### 不认，当段落', () => {
    const out = html('# 大标题\n\n## 不满 14 周岁的学生 {#minors}\n\n### 小标题\n\n#### 四级')
    expect(out).toMatch(/^<h1 class="[^"]*">大标题<\/h1><h2 id="minors" class="[^"]*">不满 14 周岁的学生<\/h2><h3 class="[^"]*">小标题<\/h3><p class="m-0">#### 四级<\/p>$/)
    expect(html('## 标题 {#a b}')).not.toContain('id=') // id 只认字母、数字、_ 和 -，别的原样当标题文字
    expect(html('## 标题 {#a b}')).toContain('标题 {#a b}')
    expect(html('## 标题 {#minors}')).toContain('scroll-mt-20') // 滚过去时不被固定的顶栏挡住
  })

  it('段落：空行隔开；同一段里的几行合成一段；标题、列表、表格之前自动断开', () => {
    expect(html('第一段\n第一段第二行\n\n第二段\n- 列表')).toBe('<p class="m-0">第一段\n第一段第二行</p><p class="m-0">第二段</p><ul class="m-0 flex flex-col gap-1 pl-6 list-disc"><li>列表</li></ul>')
    expect(html('')).toBe('')
    expect(html('\n\n  \n')).toBe('')
  })

  it('- 列表和 1. 列表；有序列表不从 1 开始时带上 start', () => {
    expect(html('- 甲\n- 乙')).toBe('<ul class="m-0 flex flex-col gap-1 pl-6 list-disc"><li>甲</li><li>乙</li></ul>')
    expect(html('1. 甲\n2. 乙')).toBe('<ol class="m-0 flex flex-col gap-1 pl-6 list-decimal"><li>甲</li><li>乙</li></ol>')
    expect(html('3. 丙\n4. 丁')).toContain('<ol start="3"')
    expect(html('- 甲\n1. 乙').match(/<(ul|ol) /g)).toEqual(['<ul ', '<ol ']) // 换了列表种类就是两个列表
  })

  it('**粗体**，粗体里可以有链接', () => {
    expect(html('这是**重点**。')).toBe('<p class="m-0">这是<strong class="font-semibold">重点</strong>。</p>')
    expect(html('**看[说明](#/privacy)**')).toBe('<p class="m-0"><strong class="font-semibold">看<a href="#/privacy" class="text-primary underline">说明</a></strong></p>')
  })

  it('链接：https:// 新标签页打开（noopener），#/ 站内链接本页打开', () => {
    expect(html('[备案](https://beian.miit.gov.cn/)')).toBe('<p class="m-0"><a href="https://beian.miit.gov.cn/" target="_blank" rel="noopener noreferrer" class="text-primary underline">备案</a></p>')
    expect(html('[规则](#/privacy?s=minors)')).toBe('<p class="m-0"><a href="#/privacy?s=minors" class="text-primary underline">规则</a></p>')
  })

  it('别的链接协议不渲染成链接，整段原样当文字', () => {
    for (const href of ['javascript:alert', 'JAVASCRIPT:alert', 'http://example.com', 'mailto:a@b.cn', '//evil.example', 'data:text/html,hi', '#top', 'privacy']) {
      const out = html(`[点这里](${href})`)
      expect(out).not.toContain('<a')
      expect(out).toBe(`<p class="m-0">[点这里](${href})</p>`)
    }
  })

  it('文里写的 HTML 原样当文字（转义），不会变成标签', () => {
    const out = html('<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>\n\n- <b>粗</b>\n\n## <i>标题</i>')
    expect(out).not.toMatch(/<(script|img|b|i)[\s>]/)
    expect(out).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
    expect(out).toContain('&lt;img src=x onerror=alert(1)&gt;')
    expect(out).toContain('<li>&lt;b&gt;粗&lt;/b&gt;</li>')
    // 渲染器和隐私说明页都不用 dangerouslySetInnerHTML（注释里写着「不用」，去掉注释再查）
    for (const f of ['lib/markdown.ts', 'pages/Privacy.tsx']) expect(read(f).replace(/\/\/.*$/gm, '')).not.toContain('dangerouslySetInnerHTML')
  })

  it('管道表格：第一行表头，第二行 |---|，单元格里可以有粗体和链接；少的格子补空，外面套一层横向滚动', () => {
    const out = html('| 信息 | 存多久 |\n|---|:-:|\n| 页面报错 | **30 天** |\n| 名单 |\n\n后面的段落')
    expect(out).toContain('<div class="overflow-x-auto"><table')
    expect(out).toMatch(/<thead><tr><th[^>]*>信息<\/th><th[^>]*>存多久<\/th><\/tr><\/thead>/)
    expect(out).toMatch(/<tbody><tr><td[^>]*>页面报错<\/td><td[^>]*><strong class="font-semibold">30 天<\/strong><\/td><\/tr><tr><td[^>]*>名单<\/td><td[^>]*><\/td><\/tr><\/tbody>/)
    expect(out).toMatch(/<\/div><p class="m-0">后面的段落<\/p>$/)
    // 没有第二行的分隔线：不是表格，当段落
    expect(html('| a | b |')).toBe('<p class="m-0">| a | b |</p>')
  })
})

describe('隐私说明：src/content/privacy.md（试点前简要版）', () => {
  const md = read('content/privacy.md')

  it('标题、开头一句、版本行', () => {
    expect(md.split('\n')[0]).toBe('# 知适隐私说明（试点前简要版）')
    expect(md).toContain('正式的隐私说明和《不满 14 周岁学生个人信息保护规则》会在第一个班级试点开始前发布在这个网址。')
    expect(md.trim().split('\n').pop()).toBe('版本：试点前简要版，2026-10-10')
  })

  // 只管简要版：对外联系方式还没定。正式版写上定好的真实联系方式时，这里改成只断言那几个值
  it('没有【待定】，没有编造的邮箱、电话、地址：有问题找任课老师', () => {
    expect(md).not.toMatch(/待定|【|TODO/)
    expect(privateInfo(md)).toEqual([])
    expect(md).not.toContain('@')
    expect(md).not.toMatch(/电话|邮箱|地址：/)
    expect(md).toContain('请联系任课老师，老师会转给知适团队处理')
  })

  it('如实写：运营方、AI 经 TokenDance 网关、服务器不保存原文、腾讯云上海、30 天删除、日志 190 天、姓名和备份加密；没做的（访问登记、审计）不写成已做', () => {
    for (const x of ['上海学光科技有限公司', '沪ICP备2026006107号-2', 'TokenDance', '不保存你写的原文', '老师可以按座号关掉', '腾讯云上海', '30 天后自动删除', '问卷、表达本、写作草稿只存在', '同学和其他老师看不到', '只是看看（不记座号）']) {
      expect(md).toContain(x)
    }
    // 10-10 起服务器上做了：姓名加密存储（NAME_KEY）、每天加密备份 30 天、知适 nginx 日志 190 天
    for (const x of ['学生姓名在服务器上加密保存', '备份保存 30 天', '在备份里最多还会留 30 天', '网站访问日志保存 190 天']) expect(md).toContain(x)
    expect(md).not.toMatch(/访问登记|审计|云硬盘/)
    expect(md).not.toContain('不收姓名')
  })

  it('和代码对得上：删除按三种情况分开写（清空座号时名单上的姓名还在）；关了 AI 是「不发给 AI」；词卡记的是认识还是不认识', () => {
    expect(md).toContain('- 老师删除班级时，名单、进班记录和全班的学习记录一起删除。')
    expect(md).toContain('- 老师在名单里删掉某个座号时，这个座号的姓名、进班记录和学习记录一起删除。')
    expect(md).toContain('- 老师清空某个座号时，这个座号的进班记录和学习记录删除，名单上的座号和姓名还在。')
    expect(md).toContain('关掉以后，写作只检查有没有用上要求的表达，句子不发给 AI。')
    expect(md).not.toContain('不发出去')
    expect(md).toContain('- 点了哪些词，词卡上点了「认识」还是「不认识」')
  })

  it('「不满 14 周岁的学生」一节的标题带 id minors（#/privacy?s=minors 滚到这里）', () => {
    expect(md).toContain('## 不满 14 周岁的学生 {#minors}')
    expect(html(md)).toContain('<h2 id="minors"')
    expect(html(md).match(/ id="/g)).toHaveLength(1)
    expect(html(md)).not.toContain('{#')
  })
})

describe('隐私说明页和页脚', () => {
  it('路由：#/privacy 是隐私说明页，换了 ?s= 重新加载；router 的注释写上', () => {
    const app = read('App.tsx')
    expect(app).toContain("path === '/privacy' ? <PrivacyPage key={hash} />")
    expect(app).toContain('<BeianFooter />') // 每个页面都有页脚
    expect(read('lib/router.ts')).toContain('#/privacy（隐私说明')
  })

  it('页面：正文用 ?raw 导入 privacy.md，用 renderMarkdown 显示；?s= 等 App 回到顶部之后再滚到那一节', () => {
    const page = read('pages/Privacy.tsx')
    expect(page).toContain("import text from '../content/privacy.md?raw'")
    expect(page).toContain('const body = renderMarkdown(text)')
    expect(page).toContain("const s = getParams().get('s')")
    expect(page).toContain('setTimeout(() => (s ? document.getElementById(s)?.scrollIntoView() : window.scrollTo(0, 0)))')
  })

  it('页脚：备案号旁边是「隐私说明」和「不满 14 周岁学生个人信息保护规则」，手机上能换行', () => {
    const footer = read('components/BeianFooter.tsx')
    expect(footer).toContain('沪ICP备2026006107号-2')
    expect(footer).toMatch(/<a href="#\/privacy" [^>]*>\s+隐私说明\s+<\/a>/)
    expect(footer).toMatch(/<a href="#\/privacy\?s=minors" [^>]*>\s+不满 14 周岁学生个人信息保护规则\s+<\/a>/)
    expect(footer).toContain('flex flex-wrap justify-center')
  })
})

describe('选座号页：要点框、必勾复选框、只是看看', () => {
  const join_ = read('pages/student/JoinClass.tsx')
  const student = read('pages/student/Student.tsx')

  it('座号格子上方的要点框：记在座号上、AI 写作检查、家长没签同意书点「只是看看」、两个说明链接、找任课老师；「只有你的老师能看到」只写一次', () => {
    for (const x of [
      '选好座号后，你的作答会记在这个座号上，只有你的老师能看到。',
      '写作检查时，你写的英文句子会发给 AI 检查（老师可能已经关掉），知适不保存原文。',
      '家长没有签同意书的同学，请点下面的「只是看看（不记座号）」。',
      '有问题请联系任课老师。',
    ]) {
      expect(join_.split(x)).toHaveLength(2)
      expect(join_.indexOf(x)).toBeLessThan(join_.indexOf('grid-cols-5'))
    }
    expect(join_).toMatch(/<a href="#\/privacy" [^>]*>\s+完整说明\s+<\/a>/)
    expect(join_).toMatch(/<a href="#\/privacy\?s=minors" [^>]*>\s+不满 14 周岁学生个人信息保护规则\s+<\/a>/)
  })

  it('必勾的复选框在座号格子上面；没勾时格子灰掉，点了提示先勾选（不发请求、不弹确认）', () => {
    expect(join_).toContain('<span>我已读过上面的说明。年满 14 周岁的同学，勾选表示你本人也同意按座号记录作答。</span>')
    expect(join_.indexOf('type="checkbox"')).toBeLessThan(join_.indexOf('grid-cols-5'))
    expect(join_).toContain('checked={agreed}')
    expect(join_).toContain("`grid grid-cols-5 gap-2 sm:grid-cols-8 ${agreed ? '' : 'opacity-40'}`")
    expect(join_).toContain('aria-disabled={!agreed || undefined}')
    expect(join_).toContain('disabled={busy || s.taken}') // 没勾不用 disabled：点了要能提示
    // 没勾时每次点都滚到提示条（已经在提示「先勾选」时 error 不变，effect 不跑，要在这里直接滚）
    expect(join_).toMatch(/const pick = async \(n: number\) => \{\s+if \(!agreed\) \{\s+setError\(MUST_CHECK\)\s+errorRef\.current\?\.scrollIntoView\(\{ block: 'center' \}\)(.*)\s+return\s+\}\s+if \(!window\.confirm\(/)
    // 提示条在说明框和复选框上面：说「下面的说明」
    expect(join_).toContain("const MUST_CHECK = '请先读完下面的说明，勾选「我已读过上面的说明」，再点座号。'")
    expect(join_.indexOf('ref={errorRef}')).toBeLessThan(join_.indexOf('type="checkbox"'))
    expect(join_).toContain("if (e.target.checked) setError((x) => (x === MUST_CHECK ? '' : x))") // 勾上后去掉「先勾选」的提示，别的提示留着
  })

  it('选座号的请求带 confirm: true；找回不带', () => {
    expect(join_).toContain('send<Binding & { recoveryCode: string }>(base, { h: h.id, seat: n, confirm: true })')
    expect(join_).toContain('send<Binding>(`${base}/recover`, { h: h.id, seat: Number(form.seat), code: cleanCode(form.code) })')
    expect(join_.replace(/\/\/.*$/gm, '').match(/confirm: true/g)).toHaveLength(1) // 注释以外只有选座号这一处
  })

  it('「只是看看（不记座号）」按钮：和没有班级参数时走同一条路（作答只在本机）；找回入口照旧', () => {
    expect(join_).toContain('onClick={onLook}')
    expect(join_).toMatch(/onClick=\{onLook\}>\s+只是看看（不记座号）\s+<\/button>/)
    expect(join_).toMatch(/<button type="button" disabled=\{busy\} [^>]*onClick=\{onLook\}>/) // 选座号的请求还没回来时不能点
    expect(join_.indexOf('onClick={onLook}')).toBeGreaterThan(join_.indexOf('grid-cols-5')) // 在「请点下面的」下面
    expect(join_).toContain('换了手机？用找回码找回')
    expect(student).toContain('<JoinClass classId={classId} notice={notice} onJoined={setSeat} onLook={() => setLook(true)} />')
    expect(student).toContain('if (!gated || look) return <Learn preset={preset} />')
  })
})

describe('班级页：建班、换名单前的两项确认', () => {
  const classes = read('pages/Classes.tsx')

  it('两项确认和旁边的说明；新建班级、改名单两处都有，每次打开改名单重新勾', () => {
    expect(classes).toContain("['school', '学校已同意在这个班使用知适']")
    expect(classes).toContain("['consent', '已收回家长告知同意书，名单里只录入了第 1 项选了同意的同学']")
    expect(classes).toContain('家长同意书还没收回时，先不要建班录名单。')
    expect(classes.match(/<Confirms value=\{checks\} onChange=\{setChecks\} \/>/g)).toHaveLength(2)
    expect(classes).toMatch(/if \(k === 'roster'\) \{\s+setText\(formatRoster\(c\.seats\)\)\s+setChecks\(NO_CHECKS\)/)
  })

  it('两项都勾了保存按钮才能点；请求带 confirm；只改班名不用勾、不带 confirm', () => {
    expect(classes.match(/disabled=\{busy \|\| [^}]*!checks\.school \|\| !checks\.consent\}/g)).toHaveLength(2)
    expect(classes).toContain("'/api/classes', { name: name.trim(), roster: seats, confirm: checks }")
    expect(classes).toContain('send<{ class: Detail } & Deleted>(base, { roster: parsed.seats, confirm: checks })')
    expect(classes).toContain('send<{ class: Detail }>(base, { name: newName.trim() })')
    expect(classes.match(/confirm: checks/g)).toHaveLength(2)
  })
})

describe('写作页：私人信息提醒', () => {
  it('privateInfo：手机号（可带空格、短横线、+86）、18 位身份证号（末位可以是 X/x）、邮箱；按固定顺序返回类别', () => {
    for (const t of ['13812345678', 'Call me at 138 1234 5678.', '138-1234-5678', '1381-234-5678', '1 3812345678', '+86 13812345678', '+8613812345678', '我的电话13812345678好', 'tel:19912345678']) {
      expect(privateInfo(t)).toEqual(['手机号'])
    }
    for (const t of ['My ID is 11010519491231002X.', '11010519491231002x', '身份证110105194912310021']) expect(privateInfo(t)).toEqual(['身份证号'])
    for (const t of ['Write to li.hua+1@example.com.cn', 'a_b@mail.school.edu']) expect(privateInfo(t)).toEqual(['邮箱'])
    expect(privateInfo('a@b.com, 110105194912310021, 13812345678')).toEqual(['手机号', '身份证号', '邮箱'])
  })

  it('privateInfo 不误判：普通数字、年份、日期、短数字、位数不对、第二位不是 3–9、不像邮箱的 @', () => {
    for (const t of [
      '',
      'In 2023, 15 students read 300 books.',
      'From 2019 to 2023, prices rose 13.8% in 12 months.',
      'It was 2026-10-10, room 1801.',
      '12345',
      '12812345678', // 第二位是 2
      '10000000000',
      '1381234567', // 10 位
      '138123456789', // 12 位
      '13 14 15 16 17 18 19',
      'About 13,800,000,000 people.',
      '1234567890123456789', // 19 位
      '11010519491231002', // 17 位
      '1101051949123100211', // 19 位
      'me @ home',
      'a@b',
      'I love toying with the idea of a gap year.',
    ]) {
      expect(privateInfo(t)).toEqual([])
    }
  })

  it('只在会发给 AI 时查；发现了不发、不记 writing_submit、不动 run，显示按类别拼的提醒', () => {
    const writing = read('pages/student/Writing.tsx')
    const submit = writing.slice(writing.indexOf('const submit = async'), writing.indexOf('const chips'))
    expect(submit).toMatch(/const t = text\.trim\(\)\s+(\/\/.*\s+)?const found = noAi \? \[\] : privateInfo\(t\)\s+setLeak\(found\)\s+if \(found\.length\) return\s+const n = \+\+run\.current/)
    expect(submit.indexOf('if (found.length) return')).toBeLessThan(submit.indexOf("act({ type: 'writing_submit' })"))
    expect(submit.indexOf('if (found.length) return')).toBeLessThan(submit.indexOf('checkWriting('))
    expect(writing.match(/privateInfo\(/g)).toHaveLength(1)
    expect(writing).toContain("你写的内容里好像有{leak.join(' / ')}，请删掉再检查。")
    expect(writing).toContain('{leak.length > 0 && (')
  })
})
