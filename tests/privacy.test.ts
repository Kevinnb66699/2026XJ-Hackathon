// 隐私页面四项：隐私说明页（#/privacy，src/content/privacy.md + 自写 Markdown 渲染器）和页脚链接、选学号页的要点框和必勾复选框、
// 建班 / 换名单的两项确认、写作页的私人信息提醒。渲染器用 react-dom/server 渲染成 HTML 字符串查；没有 DOM 测试环境，页面条件和文案直接查源码
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { fileURLToPath } from 'url'
import { createElement, Fragment } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { EXPORT_ADAPT_NOTE, EXPORT_AI_FIELDS, MIN_AGE, STUDENT_HANDOUT_DAYS, STUDENT_INACTIVE_MONTHS, appendUsage } from '../server/index.mjs'
import { EventType } from '../shared/schema'
import { renderMarkdown } from '../src/lib/markdown'
import { privateInfo } from '../src/lib/writing'
import { REASONS } from '../src/pages/student/StudentUpload'

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

  it('单独一行的截图：只认 /guide-img/ 下的 png、jpg，「=宽x高」给出显示尺寸，说明写在图下面；别的地址整行原样当文字', () => {
    expect(html('![建班页](/guide-img/classes-new.png =760x1012)')).toBe(
      '<figure class="m-0 flex flex-col gap-1.5"><img src="/guide-img/classes-new.png" alt="建班页" loading="lazy" width="760" height="1012" class="block h-auto max-w-full self-center rounded-xl border border-line"/><figcaption class="text-[13px] text-muted">建班页</figcaption></figure>',
    )
    const bare = html('![](/guide-img/a.jpg)') // 不写尺寸也能显示，只是加载前不占位
    expect(bare).toContain('<img src="/guide-img/a.jpg"')
    expect(bare).not.toContain('width=')
    expect(bare).not.toContain('figcaption')
    expect(html('![图](https://example.com/a.png)')).not.toContain('<img') // 外链图不显示（当普通链接）
    for (const src of ['/guide/a.png', '/guide-img/../secret.png', '../guide-img/a.png', 'javascript:alert(1)', '/guide-img/a.svg', '/other/a.png', 'data:image/png;base64,AA', '/guide-img/a.png =12', '/guide-img/a.png =12xab']) {
      const out = html(`![图](${src})`)
      expect(out).not.toContain('<img')
      expect(out).toBe(`<p class="m-0">![图](${src})</p>`)
    }
    expect(html('文字 ![图](/guide-img/a.png)')).not.toContain('<img') // 只认单独一行
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
    expect(md.trim().split('\n').pop()).toBe('版本：试点前简要版，2026-11-07')
  })

  // 只管简要版：对外联系方式还没定。正式版写上定好的真实联系方式时，这里改成只断言那几个值
  it('没有【待定】，没有编造的邮箱、电话、地址：班级的同学找任课老师，账号的同学找知适团队', () => {
    expect(md).not.toMatch(/待定|【|TODO/)
    expect(privateInfo(md)).toEqual([])
    expect(md).not.toContain('@')
    expect(md).not.toMatch(/电话|邮箱|地址：/)
    expect(md).toContain('班级的同学请联系任课老师，老师会转给知适团队处理')
    expect(md).toContain('现在请联系知适团队')
  })

  it('如实写：运营方、AI 发给阿里云百炼、服务器不保存原文、腾讯云上海、30 天删除、日志 190 天、姓名和备份加密；没做的（访问登记、审计）不写成已做', () => {
    for (const x of ['上海学光科技有限公司', '沪ICP备2026006107号-2', '不保存你写的原文', '老师可以按学号关掉', '腾讯云上海', '30 天后自动删除', '表达本、写作草稿，还有以前每篇开头填的问卷，只存在', '同学和其他老师看不到', '只是看看（不记学号）']) {
      expect(md).toContain(x)
    }
    // 10-10 起服务器上做了：姓名加密存储（NAME_KEY）、每天加密备份 30 天、知适 nginx 日志 190 天
    for (const x of ['学生姓名在服务器上加密保存', '备份保存 30 天', '在备份里最多还会留 30 天', '网站访问日志保存 190 天']) expect(md).toContain(x)
    expect(md).not.toMatch(/访问登记|审计|云硬盘/)
    expect(md).not.toContain('不收姓名')
  })

  it('AI 如实写成阿里云百炼：通义千问和 DeepSeek、按量付费不用于训练、北京地域、平台存储期限没有公布；不再提 TokenDance 和网关，不写「不留存」', () => {
    for (const x of [
      '写的英文句子会发给阿里云百炼平台上的大模型（通义千问、DeepSeek）',
      '知适用的是百炼按量付费的接口，发过去的数据不用于训练模型，在北京地域处理。',
      '百炼平台按法律法规存储调用数据，具体保存多久，平台没有公布。',
      '老师上传的文章，也会发给阿里云百炼上的大模型，用来生成讲义和起草讲解。',
    ]) {
      expect(md).toContain(x)
    }
    expect(md).not.toMatch(/TokenDance|网关|不留存/)
  })

  it('和代码对得上：删除按三种情况分开写（清空学号时名单上的姓名还在）；关了 AI 是「不发给 AI」；词卡记的是认识还是不认识', () => {
    expect(md).toContain('- 老师删除班级时，名单、进班记录和全班的学习记录一起删除。')
    expect(md).toContain('- 老师在名单里删掉某个学号时，这个学号的姓名、进班记录和学习记录一起删除。')
    expect(md).toContain('- 老师清空某个学号时，这个学号的进班记录和学习记录删除，名单上的学号和姓名还在。')
    expect(md).toContain('关掉以后，写作只检查有没有用上要求的表达，句子不发给 AI。')
    expect(md).not.toContain('不发出去')
    expect(md).toContain('- 点了哪些词，词卡上点了「认识」还是「不认识」')
  })

  // 11-07 起有内测的学生账号（server/index.mjs 的 /api/student/*）：开头不再说「学生不用注册」，账号单独一节
  it('开头分开说：班级的学生不用注册，内测同学用邀请码注册账号', () => {
    expect(md).toContain('班级的学生不用注册，也不用登录。')
    expect(md).toContain('参加内测的同学用知适团队给的邀请码注册账号，见下面「用账号登录的同学」。')
    expect(md).not.toMatch(/^学生不用注册/m)
    expect(md.indexOf('### 选了学号的学生')).toBeLessThan(md.indexOf('### 用账号登录的同学'))
  })

  it('「用账号登录的同学」：存什么（不存出生年月）、谁能看、示例文章和班级二维码不记到账号、退出清掉本机什么、下载数据', () => {
    const sec = md.slice(md.indexOf('### 用账号登录的同学'), md.indexOf('### 不记学号也不记账号的时候'))
    for (const x of [
      '- 用户名和加密保存的密码',
      '- 找回码的哈希：',
      '- 注册用的邀请码，也只存哈希',
      '- 注册时间、注册时勾选同意的时间、最近一次用知适的时间（每天只记一次）', // createdAt、agreedAt、lastSeenAt
      `- 确认你满 ${MIN_AGE} 周岁的时间。出生年月只用来判断满没满 ${MIN_AGE} 周岁，不保存`, // ageOkAt
      '- 设置：AI 写作检查、「按我以前的记录调整提示」打开了没有', // ai、adapt
      // 问卷答案在账号记录的 profile 上（PUT /api/student/profile），注册后做一次、可以跳过
      '- 问卷答案（答了才有）：年级、课程体系、读英文主要为了什么。注册后可以跳过，账号页随时可以改。用来决定词卡里要不要放「高中新词」、单词本里要不要贴这个标签，年级也用来调整注释，见下面「按以前的记录调整提示」。课程体系只用来在问卷里帮你先选好目标（选了普通高中，目标先选上高考），存下来是为了在账号页显示、让你能改，不用来调整提示',
      '交了写作也只记「交了」，不记你写的内容',
      // 阶段 4 只给账号的四类事件（collect_expression、drop_expression、review_word、drop_word），按钮名和单词本页对得上
      '另外还记收进、移出表达本，单词本里复习时点了「认识」还是「还不认识」，和移出单词本',
      '只有你自己和知适团队的维护人员能看到，老师和别的同学看不到。',
      // GET /api/student/notebook 从 students/<sid>.jsonl 推算（lib/notebook 的 buildNotebook），不另存
      '单词本和表达本是从这些学习记录算出来的，换一台设备登录看到的也一样。',
      '示例文章的作答照旧只存在本机，登录了也一样。', // 内置讲义不走账号，后端也丢掉内置讲义的账号事件
      '从老师发的班级二维码进来时，作答照旧记在学号上，不记到账号上。',
      '这两种时候点的词、收的表达，也不进账号的单词本和表达本。',
      '用找回码改了密码，所有设备都要重新登录。',
      // 退出清掉的是 clearSid（state 里有问卷和表达本）和这个账号的队列；没传完的先问
      '退出账号时，这台设备上这个账号的作答、读到哪一步、以前每篇开头填的问卷、表达本和写作草稿都会清掉。',
      '传不完会先问你',
      // 阶段 5：GET /api/student/records 和单词本同一份推算（lib/notebook 的 buildRecords），每行只有标题、日期、难度、状态
      '学习记录页也是这样算出来的，不另存一份：列出你动过手的每一篇、最近一次读的日期、你选的难度，和还有没有没答的句子。',
      // 完整导出：profile（问卷答案）、articles（我的文章）、records、words、expressions、events；aiFields 和每一条的 ai；写作草稿和以前每篇里的问卷在浏览器里合进去（withLocal、localData）
      '在账号页点「下载我的数据」，可以下载一个文件，里面是用户名、注册时间、设置、问卷答案、「我的文章」，学习记录页上的每一篇、单词本、表达本，还有账号上原样的全部学习记录。',
      '单词本和表达本里由 AI 生成的中文，文件里有标记；自己贴的文章的标题由 AI 起，文件开头也写明了。',
      '调整提示用到了哪些数据，文件里也写明了。', // 导出的 adaptNote
      '写作草稿不在服务器上：下载时，浏览器把这台设备上的写作草稿（还有以前每篇开头填的问卷）直接加进文件，不发给服务器；在别的设备上下载，就没有这台设备上的这些。',
    ]) {
      expect(sec).toContain(x)
    }
    expect(sec).not.toContain('称呼') // 学生账号没有称呼（老师账号才有）
    expect(read('pages/StudentLogin.tsx')).toContain('下载我的数据') // 说明里的按钮名和账号页对得上
    // 和代码对得上：学习记录页的四样、导出里标 AI 的是单词本和表达本的中文和自己贴的文章的标题、本机的两样只在浏览器里合
    const records = read('pages/student/Records.tsx')
    for (const x of ['最近一次读：', '你选的难度：', '还有没答的句子', '都答过了']) expect(records).toContain(x)
    expect(read('pages/Home.tsx')).toContain('学习记录')
    expect(Object.keys(EXPORT_AI_FIELDS)).toEqual(['words[].zh', 'expressions[].zh', 'articles[].title', 'records[].title', 'words[].sources[].title', 'expressions[].title'])
    expect(read('pages/StudentLogin.tsx')).toContain('withLocal(await blob.text(), localData(me.sid))')
    expect(read('lib/store.ts')).toMatch(/export function localData[\s\S]*?zhishi:\(state\|writing\)/)
    const book = read('pages/student/WordBook.tsx')
    for (const x of ['还不认识', '认识', '移出单词本']) expect(book).toContain(x)
    expect(book).toContain("record({ handoutId: NOTEBOOK_ID, type: 'review_word', lemma: w.lemma, correct })")
    expect(book).toContain("record({ handoutId: NOTEBOOK_ID, type: 'drop_word', lemma: w.lemma })")
  })

  // 阶段 7（11-07 队长定：不升版本、不重新同意）：按以前的记录调整提示。画像只有问卷答案和单词本，读文章时现算、不另存；不给学生看等级；
  // 开关默认开，关掉就是标准版；示例文章、班级学号不调整
  it('按以前的记录调整提示：开关默认开、用了哪两样、现算不另存、不给你看等级、怎么看怎么改、关掉是标准版、哪些时候不调整；和代码对得上', () => {
    const sec = md.slice(md.indexOf('### 用账号登录的同学'), md.indexOf('### 不记学号也不记账号的时候'))
    for (const x of [
      '按以前的记录调整提示：账号页有「按我以前的记录调整提示（关掉就用标准版）」开关，默认开着。',
      '会根据你填的年级和单词本里还在练的词调整注释和词卡：单词本里的词在新文章里出现，会加注释、放进词卡；按你填的年级，先给一部分高中阶段才学的词加注释；读英文主要为了高考的，词卡里放「高中新词」，单词本里也给这些词贴上这个标签。',
      '用到的只有问卷答案和单词本，每次打开文章时现算，推算的结果不另存，不会给你看等级。',
      '单词本里的词可以在单词本页移出，问卷答案在账号页能改。',
      '关掉开关就用标准版，只按你在这一篇里点过、标过的词调整。',
      '示例文章和从班级二维码进来时，不按以前的记录调整。',
    ]) {
      expect(sec).toContain(x)
    }
    // 开关：账号页的按钮名一样；服务器默认开（没记过的算开），导出里有 settings.adapt 和说明
    expect(read('pages/StudentLogin.tsx')).toContain('按我以前的记录调整提示<span className="font-normal text-ink2">（关掉就用标准版）</span>')
    const server = readFileSync(fileURLToPath(new URL('../server/index.mjs', import.meta.url)), 'utf8')
    expect(server).toContain('const adaptOn = (s) => s.adapt !== false')
    expect(server).toContain('settings: { ai: st.ai === true, adapt: adaptOn(st) }, profile: profileOf(st), adaptNote: EXPORT_ADAPT_NOTE,')
    for (const x of ['profile', 'words', '不另存', '标准版']) expect(EXPORT_ADAPT_NOTE).toContain(x)
    // 现算、不另存：画像是 GET /api/student/profile 里从单词本推算的（notebookOf），students.json 里只多一个开关；引擎里不存「已掌握」
    expect(server).toContain('(x) => x.notebook.words.map((w) => w.lemma)')
    expect(read('engine/types.ts')).toContain('export type LearnerProfile = Profile & { practicing?: string[] }')
    // 开关关着、示例文章、班级学号都不传画像（Student.tsx 只有账号模式的 Synced 拉画像）
    expect(read('lib/student-auth.ts')).toContain('if (r.adapt === false) return undefined')
    const learn = read('pages/student/Student.tsx')
    expect(learn.match(/getLearner\(\)/g)).toHaveLength(1)
    expect(learn).toContain('if (!gated || look) return <Learn preset={preset} preview={preview} />')
    expect(learn).toContain('if (seat) return <Learn key={seat.sid} seat={seat} />')
  })

  it('写作 AI：账号同学在开放之前不发给 AI，开放后默认开着、可以在账号页关掉', () => {
    expect(md).toContain('用账号登录的同学：AI 写作检查对账号开放之前，写作只检查有没有用上要求的表达，句子不发给 AI。')
    expect(md).toContain('开放以后，AI 写作检查默认开着，账号页有「AI 写作检查」开关')
    expect(md).toContain('你随时可以在账号页关掉。')
    expect(read('pages/StudentLogin.tsx')).toContain('aria-label="AI 写作检查"')
  })

  // 阶段 4 起按身份分开：账号的表达本记在账号上；学号和没登录的问卷、表达本、写作草稿照旧只存本机；写作草稿一律只存本机。
  // 阶段 6 起问卷不在每篇里了，改成账号注册后做一次、记在账号上
  it('只存本机：学号和没登录时问卷、表达本、写作草稿只存本机；账号的写作草稿也只存本机，问卷答案和表达本记在账号上', () => {
    const sec = md.slice(md.indexOf('## 只存在本机的信息'), md.indexOf('## 老师的信息'))
    expect(sec).toContain('选了学号的同学，还有不记学号也不记账号的时候：表达本、写作草稿，还有以前每篇开头填的问卷，只存在你自己的手机或电脑上。')
    expect(sec).toContain('用账号登录的同学：写作草稿也只存在这台设备上，不记到账号上，换一台设备登录看不到，退出账号时也会从这台设备上清掉。')
    expect(sec).toContain('在账号页下载数据时，写作草稿在浏览器里加进下载的文件，也不发给服务器。问卷答案记在账号上，见上面「用账号登录的同学」。')
    expect(sec).toContain('表达本不一样，收进、移出都记在账号的学习记录里（示例文章和从班级二维码进来时除外，见上面「用账号登录的同学」），换一台设备登录也能看到，注销时一起删除。')
    expect(md).not.toContain('这三样不记到账号上')
    // 和代码对得上：账号模式收进、移出发事件，学号和没登录只改本机；打开一篇时账号的表达本以服务器为准
    const learn = read('pages/student/Student.tsx')
    expect(learn).toContain("const collect = (id: string) => (me ? act({ type: 'collect_expression', value: id }) : patch(collectExpression(id)))")
    expect(learn).toContain("const drop = (id: string) => act({ type: 'drop_expression', value: id })")
    expect(learn).toContain('onDrop={me ? drop : undefined}')
    expect(learn).toContain('restoreState(h, sid, events, true)')
    expect(read('lib/store.ts')).toContain('collectedExpressions: account ? rebuilt.collectedExpressions : local.collectedExpressions')
    // 问卷不在每篇里了（账号的存在 profile 上，不是事件）；写作草稿只写本机存储（检查时发的句子服务器不存）
    expect(learn).not.toContain('survey')
    expect(EventType.options.some((t) => /survey|profile|writing_draft/.test(t))).toBe(false)
    expect(read('pages/student/Writing.tsx')).toContain('writeLS(writingKey(h.id, sid), e.target.value)')
  })

  it(`存多久：30 天清理不包括账号，账号自己注销时删、${STUDENT_INACTIVE_MONTHS} 个月没用自动删`, () => {
    expect(md).toContain('- 没有记在学号或账号上的记录、页面报错信息、AI 缓存，30 天后自动删除。')
    expect(md).not.toContain('- 没有记在学号上的记录')
    expect(md).not.toContain('现在不会自动删除')
    const keep = md.slice(md.indexOf('## 存多久'), md.indexOf('## 怎么保护'))
    expect(keep).toContain('- 用账号登录的同学自己注销时，账号和账号上的学习记录马上删除。')
    // 和 server 的 STUDENT_INACTIVE_MONTHS 一致；按 lastSeenAt（「最近一次用知适的时间」）算；不收联系方式，删之前没法通知
    expect(keep).toContain(`- 账号连续 ${STUDENT_INACTIVE_MONTHS} 个月没用（按上面说的「最近一次用知适的时间」算），账号和账号上的学习记录自动删除，删法和自己注销一样。我们没有你的联系方式，删之前没法通知你。`)
    // 恢复备份时按删除台账再删一遍：deploy/restore-backup.sh 解完就跑 apply-deletions
    expect(keep).toContain('从备份恢复数据时，已经注销和自动删除的账号会再删一遍。')
    expect(readFileSync(fileURLToPath(new URL('../deploy/restore-backup.sh', import.meta.url)), 'utf8')).toContain('scripts/student.mjs" apply-deletions "$target"')
    expect(md).toContain('- 用账号登录的同学：账号上的记录老师看不到。')
  })

  it('注销：账号页自己注销、要再输一次密码；删掉什么、本机清掉什么、没删成的每天再删、码只留哈希不能再用、用户名放出来、台账只留编号的哈希和日期', () => {
    const sec = md.slice(md.indexOf('### 用账号登录的同学'), md.indexOf('### 不记学号也不记账号的时候'))
    for (const x of [
      '在账号页点「注销账号」、再输一次密码，可以自己注销。',
      // deleteStudent：students.json 里删掉账号、作废会话、删 students/<sid>.jsonl 和事件文件里这个 sid 的行
      '注销以后，服务器上这个账号存的信息和账号上的全部学习记录（包括单词本和表达本）马上删除，不能恢复，所有设备上的登录都会退出；',
      // 前端 deleteAccount：clearSid + forget，和退出清掉的一样
      '这台设备上这个账号的作答、读到哪一步、问卷、表达本和写作草稿也一起清掉。',
      // incomplete：sid 留在待删列表里，到期清理（每 24 小时）补删
      '万一有一部分这次没删成，服务器每天清理时会再删。',
      // usedInvites 不动；用户名放出来
      '用过的邀请码只留下哈希，不能再注册；这个用户名以后别人可以注册。',
      // 删除台账 {sidHash, date}
      '另外只留一行记录：账号随机编号的哈希和删除的日期，从备份恢复数据时用它把这个账号再删一遍。',
    ]) {
      expect(sec).toContain(x)
    }
    const page = read('pages/StudentLogin.tsx')
    expect(page).toContain('注销账号') // 说明里的按钮名和账号页对得上
    expect(page).toContain('label="再输一次密码"')
    expect(read('lib/student-auth.ts')).toMatch(/export async function deleteAccount[\s\S]*?clearSid\(sid\)\s+forget\(sid\)/)
  })

  it('你的权利：账号同学自己下载数据、用找回码改密码、注销账号；更正和撤回同意联系团队', () => {
    const sec = md.slice(md.indexOf('## 你的权利'))
    expect(sec).toContain('用账号登录的同学，可以在账号页自己下载数据（「下载我的数据」）、用找回码改密码、注销账号（「注销账号」）。')
    expect(sec).toContain('更正信息、撤回同意，现在请联系知适团队。')
    expect(md).not.toContain('还在做')
  })

  it(`未成年人一节如实写账号注册门槛 ${MIN_AGE} 周岁（和 server 的 MIN_AGE 一致），满门槛的那个月按还没满算`, () => {
    const sec = md.slice(md.indexOf('{#minors}'), md.indexOf('## 你的权利'))
    expect(sec).toContain(`用邀请码注册账号要年满 ${MIN_AGE} 周岁。`)
    expect(sec).toContain(`满 ${MIN_AGE} 周岁的那个月按还没满算`)
    expect(sec).toContain(`不满 ${MIN_AGE} 周岁的不能注册，这个邀请码也不能再用。`)
    expect(md).not.toMatch(/年满 16 周岁|16 周岁/)
  })

  // 阶段 2、3：学生贴文章（POST /api/student/uploads、library.json、upload-counts.json、upload-blocked.json）和 usage 日志
  it(`贴文章生成讲义：查过才发给百炼、拦截留哈希、已有的回答照缓存期限删、讲义只给「我的文章」里有它的人读、不显示上传人、没人用 ${STUDENT_HANDOUT_DAYS} 天后删；用量日志不记原文和账号`, () => {
    const sec = md.slice(md.indexOf('## 贴文章生成讲义'), md.indexOf('## 只存在本机的信息'))
    for (const x of [
      '用账号登录的同学：贴文章生成讲义对账号开放以后，', // STUDENT_UPLOAD=1 才开放
      // checkArticle 在开始生成之前跑，不过就 400，什么都不存
      '这几种不收：长度或格式不对，不像英文，像试卷，有手机号、身份证号这类个人信息，同一句重复太多。不收的文章不保存，也不发给 AI。',
      '查过的原文发给阿里云百炼上的大模型，生成标题、题目、词义和提示。',
      // upload-blocked.json 只有 {keys: [精确键]}；同一篇里别的调用已经写进 llm-cache 的回答照缓存期限删（cleanupCacheDays）
      '被百炼的内容安全拦截的文章不生成讲义，同一篇以后不能再贴：服务器留下由这篇原文算出的哈希，不记是谁贴的。',
      '拦截之前 AI 已经给出的那部分回答，和别的 AI 回答缓存一样 30 天后删除。',
      // meta 的 createdBy 不出现在任何返回体里
      '服务器上记着这份讲义是哪个账号贴的，页面上不显示，别的同学看不到。',
      // 精确键复用不再生成；近似键回 similar 让学生选
      '别的同学贴了同一篇（只差空格、空行的也算），直接读已有的这份讲义，不再发给 AI。',
      '只差标点或大小写的，由贴的同学自己选：读已有的那一份，还是按自己贴的再生成一份。',
      // GET /api/handouts/:id 只认本人的「我的文章」；学生讲义不开放 GET /api/events
      '只有「我的文章」里有这一篇的同学能读这份讲义，没有公开的目录，也没有分享链接。读的同学看不到是谁贴的，也看不到别人在这篇里的作答。',
      '也算进单词本、表达本和学习记录页。',
      '服务器上还记着你每周生成了几篇、当天有几次没生成成功，用来限制次数。', // upload-counts.json 的 used、fails
    ]) {
      expect(sec).toContain(x)
    }
    // 和代码对得上：拒收的几类就是上传页认的几种 reason（长度和格式的照后端的说法）
    expect(Object.keys(REASONS).sort()).toEqual(['exam', 'not_english', 'personal_info', 'repeated', 'unsafe'])
    const server = readFileSync(fileURLToPath(new URL('../server/index.mjs', import.meta.url)), 'utf8')
    const upload = server.slice(server.indexOf('async function studentUpload'), server.indexOf("app.get('/api/uploads/:jobId'"))
    expect(upload.indexOf('check(text)')).toBeGreaterThan(0)
    expect(upload.indexOf('check(text)')).toBeLessThan(upload.indexOf('runJob('))
    expect(server).toContain("keys: [...(Array.isArray(d.keys) ? d.keys : []), sj.exact]") // studentFailed：拦截过的只记精确键
    expect(server).toContain('articles: await myArticles(st.id)') // 导出里的「我的文章」

    // 注销：列表和次数删掉，别人在用的讲义留着、去掉 createdBy，没人用的按留存删
    const account = md.slice(md.indexOf('### 用账号登录的同学'), md.indexOf('### 不记学号也不记账号的时候'))
    expect(account).toContain('- 贴文章生成讲义开放以后：「我的文章」（贴过的文章的讲义编号、标题、加进来的时间）和生成的次数，见下面「贴文章生成讲义」')
    expect(account).toContain(`「我的文章」和生成的次数一起删除；你贴的文章生成的讲义，还在别的同学「我的文章」里的照旧留着，服务器上不再记着是你贴的，不在任何人「我的文章」里的 ${STUDENT_HANDOUT_DAYS} 天后删除。`)
    const keep = md.slice(md.indexOf('## 存多久'), md.indexOf('## 怎么保护'))
    expect(keep).toContain(`- 同学贴文章生成的讲义，还在哪位同学的「我的文章」里就一直保存；不在任何人的「我的文章」里以后，${STUDENT_HANDOUT_DAYS} 天后自动删除。`)
    expect(keep).toContain('- 生成讲义时大模型的回答缓存在服务器上，里面有原文的片段，30 天后自动删除。') // llm-cache，cleanupCacheDays
    expect(keep).toContain('- 调用大模型的用量记录不自动删除，用来核对花费，里面没有原文和账号。')
    expect(md).toContain('- 贴过同一篇文章的同学：能读同一份讲义，看不到是谁贴的，也看不到彼此的作答。')

    // 用量日志：一行只有这几样，写作检查不带讲义 id
    expect(md).toContain('每次调用大模型，服务器记下用量：时间、哪一类调用、哪个模型、用了多少、花了多少钱；写作检查以外的几类还记是哪一份讲义。这些只用来控制和核对花费，不记发过去的原文，也不记是哪个账号。')
    const dir = mkdtempSync(join(tmpdir(), 'zhishi-privacy-'))
    try {
      const cfg = { dataDir: dir, prices: { m: { input: 1, output: 1 } }, log: () => {} }
      appendUsage(cfg, { kind: 'article', model: 'm', input: 3, output: 4, cached: 0, estimated: false, handoutId: 'up-x' })
      const [file] = readdirSync(dir)
      expect(Object.keys(JSON.parse(readFileSync(join(dir, file), 'utf8')))).toEqual(['ts', 'kind', 'model', 'input', 'output', 'cached', 'cost', 'estimated', 'handoutId'])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
    expect(server).toContain("meter({ ...u, kind: 'writing' })")
  })

  // 法规这几样队长另行处理，这份说明里先不写
  it('不写服务协议、AI 使用说明、内测群、投诉渠道', () => {
    expect(md).not.toMatch(/服务协议|AI 使用说明|内测群|投诉/)
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

describe('选学号页：要点框、必勾复选框、只是看看', () => {
  const join_ = read('pages/student/JoinClass.tsx')
  const student = read('pages/student/Student.tsx')

  it('学号格子上方的要点框：记在学号上、AI 写作检查、家长没签同意书点「只是看看」、两个说明链接、找任课老师；「只有你的老师能看到」只写一次', () => {
    for (const x of [
      '选好学号后，你的作答会记在这个学号上，只有你的老师能看到。',
      '写作检查时，你写的英文句子会发给 AI 检查（老师可能已经关掉），知适不保存原文。',
      '家长没有签同意书的同学，请点下面的「只是看看（不记学号）」。',
      '有问题请联系任课老师。',
    ]) {
      expect(join_.split(x)).toHaveLength(2)
      expect(join_.indexOf(x)).toBeLessThan(join_.indexOf('grid-cols-5'))
    }
    expect(join_).toMatch(/<a href="#\/privacy" [^>]*>\s+完整说明\s+<\/a>/)
    expect(join_).toMatch(/<a href="#\/privacy\?s=minors" [^>]*>\s+不满 14 周岁学生个人信息保护规则\s+<\/a>/)
  })

  it('必勾的复选框在学号格子上面；没勾时格子灰掉，点了提示先勾选（不发请求、不弹确认）', () => {
    expect(join_).toContain('<span>我已读过上面的说明。年满 14 周岁的同学，勾选表示你本人也同意按学号记录作答。</span>')
    expect(join_.indexOf('type="checkbox"')).toBeLessThan(join_.indexOf('grid-cols-5'))
    expect(join_).toContain('checked={agreed}')
    expect(join_).toContain("`grid grid-cols-5 gap-2 sm:grid-cols-8 ${agreed ? '' : 'opacity-40'}`")
    expect(join_).toContain('aria-disabled={!agreed || undefined}')
    expect(join_).toContain('disabled={busy || s.taken}') // 没勾不用 disabled：点了要能提示
    // 没勾时每次点都滚到提示条（已经在提示「先勾选」时 error 不变，effect 不跑，要在这里直接滚）
    expect(join_).toMatch(/const pick = async \(n: number\) => \{\s+if \(!agreed\) \{\s+setError\(MUST_CHECK\)\s+errorRef\.current\?\.scrollIntoView\(\{ block: 'center' \}\)(.*)\s+return\s+\}\s+if \(!window\.confirm\(/)
    // 提示条在说明框和复选框上面：说「下面的说明」
    expect(join_).toContain("const MUST_CHECK = '请先读完下面的说明，勾选「我已读过上面的说明」，再点学号。'")
    expect(join_.indexOf('ref={errorRef}')).toBeLessThan(join_.indexOf('type="checkbox"'))
    expect(join_).toContain("if (e.target.checked) setError((x) => (x === MUST_CHECK ? '' : x))") // 勾上后去掉「先勾选」的提示，别的提示留着
  })

  it('选学号的请求带 confirm: true；找回不带', () => {
    expect(join_).toContain('send<Binding & { recoveryCode: string }>(base, { h: h.id, seat: n, confirm: true })')
    expect(join_).toContain('send<Binding>(`${base}/recover`, { h: h.id, seat: Number(form.seat), code: cleanCode(form.code) })')
    expect(join_.replace(/\/\/.*$/gm, '').match(/confirm: true/g)).toHaveLength(1) // 注释以外只有选学号这一处
  })

  it('「只是看看（不记学号）」按钮：和没有班级参数时走同一条路（作答只在本机）；找回入口照旧', () => {
    expect(join_).toContain('onClick={onLook}')
    expect(join_).toMatch(/onClick=\{onLook\}>\s+只是看看（不记学号）\s+<\/button>/)
    expect(join_).toMatch(/<button type="button" disabled=\{busy\} [^>]*onClick=\{onLook\}>/) // 选学号的请求还没回来时不能点
    expect(join_.indexOf('onClick={onLook}')).toBeGreaterThan(join_.indexOf('grid-cols-5')) // 在「请点下面的」下面
    expect(join_).toContain('换了手机？用找回码找回')
    expect(student).toContain('<JoinClass classId={classId} notice={notice} onJoined={setSeat} onLook={() => setLook(true)} />')
    expect(student).toContain('if (!gated || look) return <Learn preset={preset} preview={preview} />')
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
