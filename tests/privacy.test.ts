// 隐私页面四项：隐私说明页（#/privacy，src/content/privacy.md + 自写 Markdown 渲染器）和页脚链接、选学号页的要点框和必勾复选框、
// 建班 / 换名单的两项确认、写作页的私人信息提醒。渲染器用 react-dom/server 渲染成 HTML 字符串查；没有 DOM 测试环境，页面条件和文案直接查源码
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { fileURLToPath } from 'url'
import { createElement, Fragment } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { EXPORT_ADAPT_NOTE, EXPORT_AI_FIELDS, EXPORT_GUARDIAN_NOTE, GUARDIAN_AGE, MIN_AGE, PROFILE_CHOICES, STUDENT_HANDOUT_DAYS, STUDENT_INACTIVE_MONTHS, appendUsage } from '../server/index.mjs'
import { EventType } from '../shared/schema'
import { renderMarkdown } from '../src/lib/markdown'
import { GUARDIAN_AGE as CLIENT_GUARDIAN_AGE } from '../src/lib/student-auth'
import { noAiNote, privateInfo } from '../src/lib/writing'
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

// 11-08 队长定：整篇改成以学生账号为主的写法（账号同学放最前面），去掉「试点前简要版」，已经开着的功能不写「开放以后」，
// 联系方式写「在内测群里联系知适团队」，不满 14 周岁注册要勾家长同意（GUARDIAN_AGE）。老师和班级那部分照旧保留（老师端还开着）
describe('隐私说明：src/content/privacy.md（内测版）', () => {
  const md = read('content/privacy.md')
  const server = readFileSync(fileURLToPath(new URL('../server/index.mjs', import.meta.url)), 'utf8')
  const between = (from: string, to: string) => {
    expect(md).toContain(from)
    expect(md).toContain(to)
    return md.slice(md.indexOf(from), md.indexOf(to))
  }
  const account = () => between('## 用账号登录的同学', '## 从班级二维码进来的同学')

  it('标题、开头、版本行；没有「试点前简要版」「第一个班级试点」，已经开着的功能不写「开放以后」', () => {
    expect(md.split('\n')[0]).toBe('# 知适隐私说明')
    expect(md).toContain('知适是一个英语外刊阅读学习网站，由上海学光科技有限公司运营，网站备案号沪ICP备2026006107号-2。')
    expect(md).toContain('知适现在在小范围内测。参加内测的同学用知适团队给的邀请码注册账号，读团队选的文章，也可以自己贴文章生成讲义，见下面「用账号登录的同学」。')
    expect(md).toContain('老师建班、学生扫班级二维码选学号的那条路也照常能用，见下面「从班级二维码进来的同学」和「老师的信息」。')
    expect(md.trim().split('\n').pop()).toBe('版本：内测版，2026-11-08')
    expect(md).not.toMatch(/试点|简要版|正式版/)
    expect(md).not.toMatch(/开放以后|开放之前|还没开放/)
    // 原来「会随正式版隐私说明一起发布」的承诺，改成不依赖试点的说法
    expect(md).toContain('完整的《不满 14 周岁学生个人信息保护规则》会另行发布。')
  })

  it('结构：账号同学在最前面，然后是班级二维码、不记学号也不记账号、老师、所有访问者、AI、用量、存在哪、存多久、怎么保护、谁能看到、不满 14 周岁、你的权利', () => {
    const order = [
      '## 用账号登录的同学',
      '## 从班级二维码进来的同学',
      '## 不记学号也不记账号的时候',
      '## 老师的信息',
      '## 所有访问者',
      '## 写作检查、生成讲义和 AI',
      '## 用量记录',
      '## 存在哪',
      '## 存多久',
      '## 怎么保护',
      '## 谁能看到',
      '## 不满 14 周岁的学生 {#minors}',
      '## 你的权利',
    ]
    expect(md.split('\n').filter((l) => l.startsWith('## '))).toEqual(order)
    const sub = account().split('\n').filter((l) => l.startsWith('### '))
    expect(sub).toEqual(['### 注册', '### 服务器上存什么', '### 学习记录', '### 问卷', '### 按以前的记录调整提示', '### AI 写作检查', '### 贴文章生成讲义', '### 下载我的数据', '### 登录和退出', '### 注销账号', '### 只存在这台设备上的'])
    expect(md.split('\n').filter((l) => l.startsWith('### ')).length).toBe(sub.length) // 别的节没有小标题
  })

  // 11-08 队长定的联系方式：在内测群里联系知适团队。别的联系方式（电话、地址等）一律不写，免得编造
  it('联系方式：账号的同学在内测群里联系知适团队，班级的同学找任课老师；没有【待定】，没有编造的邮箱、电话、地址', () => {
    expect(md).not.toMatch(/待定|【|TODO/)
    expect(privateInfo(md)).toEqual([])
    expect(md).not.toContain('@')
    expect(md).not.toMatch(/电话|邮箱|地址：/)
    const rights = md.slice(md.indexOf('## 你的权利'))
    expect(rights).toContain('忘了密码又丢了找回码、要看下载的文件里没有的信息、更正信息、撤回同意，或者对这份说明有问题，请在内测群里联系知适团队。')
    expect(rights).toContain('班级的同学请联系任课老师，老师会转给知适团队处理。')
    // 「内测群」只出现在这一句联系方式里
    expect(md.split('内测群')).toHaveLength(2)
    expect(md.split('在内测群里联系知适团队')).toHaveLength(2)
    expect(md).not.toContain('现在请联系知适团队')
  })

  it('如实写：运营方、AI 发给阿里云百炼、服务器不保存原文、腾讯云上海、30 天删除、日志 190 天、密码和姓名加密、备份加密；没做的（访问登记、审计）不写成已做', () => {
    for (const x of ['上海学光科技有限公司', '沪ICP备2026006107号-2', '不保存你写的原文', '老师可以按学号关掉', '腾讯云上海', '30 天后自动删除', '表达本、写作草稿，还有以前每篇开头填的问卷，只存在', '同学和其他老师看不到', '只是看看（不记学号）']) {
      expect(md).toContain(x)
    }
    // 10-10 起服务器上做了：姓名加密存储（NAME_KEY）、每天加密备份 30 天（deploy/backup.sh 的 BACKUP_DAYS）、知适 nginx 日志 190 天（deploy/logrotate-zhishi）
    for (const x of ['老师录入的学生姓名在服务器上加密保存', '备份保存 30 天', '在备份里最多还会留 30 天', '网站访问日志保存 190 天']) expect(md).toContain(x)
    const deploy = (f: string) => readFileSync(fileURLToPath(new URL(`../deploy/${f}`, import.meta.url)), 'utf8')
    expect(deploy('backup.sh')).toContain('BACKUP_DAYS=${BACKUP_DAYS:-30}')
    expect(deploy('logrotate-zhishi')).toMatch(/^\s+rotate 190$/m)
    // 密码 scrypt、找回码和学生邀请码只存 sha256
    expect(md).toContain('密码加密保存，找回码和学生注册用的邀请码只存哈希。')
    expect(server).toContain('recoveryHash: hex(code)')
    expect(server).toContain('const got = Buffer.from(studentInviteHash(code), \'hex\')')
    expect(md).toContain('知适的服务器在腾讯云上海，信息存在中国境内。发给 AI 的内容在阿里云百炼的北京地域处理。')
    expect(md).not.toMatch(/访问登记|审计|云硬盘/)
    expect(md).not.toContain('不收姓名')
  })

  it('AI 如实写成阿里云百炼：通义千问和 DeepSeek、按量付费不用于训练、北京地域、平台存储期限没有公布、只在两种时候发；不再提 TokenDance 和网关，不写「不留存」', () => {
    const ai = between('## 写作检查、生成讲义和 AI', '## 用量记录')
    for (const x of [
      '写作检查时，写的英文句子会发给阿里云百炼平台上的大模型（通义千问、DeepSeek），检查要求的表达用得对不对、有没有写错的地方。',
      '只在这两种时候发：用账号登录、开着 AI 写作检查的同学；从班级二维码进来、老师没有关掉这个学号的 AI 写作检查的同学。',
      '知适用的是百炼按量付费的接口，发过去的数据不用于训练模型，在北京地域处理。',
      '百炼平台按法律法规存储调用数据，具体保存多久，平台没有公布。',
      '同学自己贴的文章，查过以后也发给百炼上的大模型生成讲义，见上面「贴文章生成讲义」。',
      '老师上传的文章，也会发给阿里云百炼上的大模型，用来生成讲义和起草讲解。',
      '老师端的教学建议只把全班的汇总统计发给大模型，不带学生的姓名和学号。',
    ]) {
      expect(ai).toContain(x)
    }
    expect(md).not.toMatch(/TokenDance|网关|不留存/)
    // 和代码对得上：写作原文只有学号开着 AI，或者服务器开放了、账号开着 AI 才发（server 的 writing-check）
    const check = server.slice(server.indexOf("app.post('/api/writing-check'"), server.indexOf("app.post('/api/advice'"))
    expect(check).toContain("} else if (!ai) return deny('老师关闭了这个学号的 AI 检查')")
    expect(check).toContain("if (!cfg.studentAi) return deny('AI 写作检查还没开放')")
    expect(check).toContain("if (st.ai !== true) return deny('你在账号页关掉了 AI 写作检查')")
    expect(server).toContain("llmBaseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1'")
  })

  // 已经开着的功能（11-07 起 STUDENT_AI=1、11-08 起 STUDENT_UPLOAD=1）照现在写；可能停下来的几种情况照代码写
  it('次数和花费上限、暂停：写作检查回落到规则检查、贴文章不生成新的但已有的照常能读、老师端也停；团队可以关掉两项；和代码对得上', () => {
    const ai = between('## 写作检查、生成讲义和 AI', '## 用量记录')
    for (const x of [
      '调用 AI 有次数上限和花费上限：AI 写作检查每人每小时、全站每天都有次数上限；知适调用大模型的花费每天、每月都有上限，当天的上限到第二天恢复，当月的上限到下个月 1 日恢复。',
      '- 写作检查这次不发给 AI，只检查有没有用上要求的表达。',
      '- 贴文章先不生成新的讲义，页面上写着哪天恢复。已经生成的讲义照常能读，贴进来的文章已经有现成讲义的，也能直接读。',
      '- 老师上传文章、AI 起草讲解和教学建议也先停下。',
      'AI 一时连不上或超时的时候，写作检查这次也只显示有没有用上要求的表达。',
      '知适团队也可以暂停账号的 AI 写作检查或贴文章。暂停 AI 写作检查时，账号页没有「AI 写作检查」开关，写作只检查有没有用上要求的表达，句子不发给 AI；暂停贴文章时，不能贴新的文章，「我的文章」里已有的照常能读。',
    ]) {
      expect(ai).toContain(x)
    }
    // 写作检查：次数（每个 sid 或账号每小时、全站每天）和花费都在调模型之前查，超了 429 回落
    const check = server.slice(server.indexOf("app.post('/api/writing-check'"), server.indexOf("app.post('/api/advice'"))
    for (const x of ['cfg.writingPerDay', 'cfg.writingPerSidPerHour', 'overSpend(']) expect(check.indexOf(x)).toBeLessThan(check.indexOf('callLLM('))
    // 花费上限：当天的到明天 0 点，本月的到下个月 1 日；教学建议、老师上传、AI 起草讲解都查
    expect(server).toContain("return { scope: 'month', resumesAt: Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1) - 8 * HOUR }")
    expect(server).toContain("return { scope: 'day', resumesAt: Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1) - 8 * HOUR }")
    expect(server).toContain('const over = overSpend(bodyCost(adviceBody(cfg, summary)))')
    expect(server).toContain('const over = overSpendNow(notesEst)')
    // 学生贴文章：先查复用（不看花费），再查次数和花费（kind 是 spend，带恢复的时间）；页面上说哪天恢复、已有的照常能读
    const upload = server.slice(server.indexOf('async function studentUpload'), server.indexOf("app.get('/api/uploads/:jobId'"))
    expect(upload.indexOf('reuse(exact)')).toBeLessThan(upload.indexOf('let stop = limited()'))
    expect(upload).toContain("kind: 'spend', resumesAt: isoOf(over.resumesAt)")
    expect(read('pages/student/StudentUpload.tsx')).toContain('已经生成过的文章照常能读；贴进来的文章如果已经有现成讲义，也能直接读。')
    // 团队暂停（.env 不写 STUDENT_AI=1 / STUDENT_UPLOAD=1）：账号页不显示 AI 开关；不能贴，但「我的文章」照常列、讲义照常能读
    expect(read('pages/StudentLogin.tsx')).toContain('{me.aiAvailable && (')
    expect(upload).toContain("if (!cfg.studentUpload) return res.status(403)")
    expect(read('pages/Home.tsx')).toContain('if (!enabled && !items?.length) return null')
    const handouts = server.slice(server.indexOf("app.get('/api/handouts/:id'"), server.indexOf("app.post('/api/handouts/:id/publish'"))
    expect(handouts).not.toContain('studentUpload')
    // 超时、出错时前端回落到规则检查
    expect(read('pages/student/Writing.tsx')).toContain("if (n === run.current) setAi(res ?? 'off')")
  })

  it('和代码对得上：删除按三种情况分开写（清空学号时名单上的姓名还在）；关了 AI 是「不发给 AI」；词卡记的是认识还是不认识', () => {
    expect(md).toContain('- 老师删除班级时，名单、进班记录和全班的学习记录一起删除。')
    expect(md).toContain('- 老师在名单里删掉某个学号时，这个学号的姓名、进班记录和学习记录一起删除。')
    expect(md).toContain('- 老师清空某个学号时，这个学号的进班记录和学习记录删除，名单上的学号和姓名还在。')
    expect(md).toContain('关掉以后，写作只检查有没有用上要求的表达，句子不发给 AI。')
    expect(md).not.toContain('不发出去')
    expect(md).toContain('- 点了哪些词，词卡上点了「认识」还是「不认识」')
  })

  it('「从班级二维码进来的同学」：不用注册、姓名只有老师看、按学号记的六类、就算登录了也记在学号上、老师能关 AI、本机的三样', () => {
    const sec = between('## 从班级二维码进来的同学', '## 不记学号也不记账号的时候')
    for (const x of [
      '班级的学生不用注册，也不用登录。老师从学校的名单里录入学号和姓名。姓名只有建这个班的老师登录后能看到，学生这边只显示学号。',
      '扫老师发给本班的二维码、选好自己的学号后，你在讲义里的学习动作会按学号记在服务器上，给你的老师看全班的学习情况：',
      '- 交了写作（只记「交了」，不记你写的内容）',
      '每一条都记着发生的时间。',
      // 绑定 {sid, recoveryHash, tokens（最多 MAX_DEVICE_TOKENS 个）, boundAt, confirmedAt}；老师可以重置找回码
      '选学号时要勾选「我已读过上面的说明」，选好后会拿到一个找回码，只显示这一次；换了手机，用学号和找回码找回，弄丢了可以请老师重置。服务器上这个学号还记着：选学号的时间、勾选的时间、找回码的哈希，和每台设备登录凭证的哈希（每个学号最多留 5 台设备的）。',
      '从班级二维码进来时，就算登录了账号，作答也记在学号上，不记到账号上，也不按以前的记录调整提示。',
      '老师可以按学号关掉 AI 写作检查。关掉以后，写作只检查有没有用上要求的表达，句子不发给 AI。',
      '从班级二维码进来时，AI 写作检查只看老师给这个学号的设置，账号页的「AI 写作检查」开关在这里不管用。',
      '表达本、写作草稿，还有以前每篇开头填的问卷，只存在你自己的手机或电脑上，服务器不保存。',
      // 本机 zhishi:class:<班级 id> 存 {seat, sid, token, ai}
      '这台设备上还记着你在这个班选的学号、这台设备的登录凭证和老师有没有关掉 AI 写作检查，下次扫码就不用再选。',
    ]) {
      expect(sec).toContain(x)
    }
    expect(server).toContain('const bound = { sid, recoveryHash: hex(code), tokens: [hex(token)], boundAt: Date.now(), confirmedAt: now }')
    expect(server).toMatch(/const MAX_DEVICE_TOKENS = 5\b/)
    expect(server).toContain('.slice(-MAX_DEVICE_TOKENS)')
    expect(server).toContain("app.post('/api/classes/:id/seats/:n/reset-code'")
    expect(read('pages/student/JoinClass.tsx')).toContain('找回码只显示这一次。')
    expect(read('lib/classes.ts')).toContain('JSON.stringify({ seat: b.seat, sid: b.sid, token: b.token, ai: b.ai })')
    // 有学号时只看学号的 AI 设置，账号的开关不管：前端 noAiNote 先看 seat，后端是学号的 sid 就不查账号
    expect(noAiNote({ ai: true }, { ai: false, aiAvailable: true })).toBeNull()
    const check = server.slice(server.indexOf("app.post('/api/writing-check'"), server.indexOf("app.post('/api/advice'"))
    expect(check).toMatch(/if \(ai === undefined\) \{\s+const st = await currentStudent\(req\)/)
    // 学号那条路只有六类，账号才有的四类（表达本、单词本）不在这里
    expect(sec.split('\n').filter((l) => l.startsWith('- '))).toHaveLength(6)
    expect(sec).not.toMatch(/单词本|收进、移出/)
    expect(md).not.toMatch(/^学生不用注册/m)
    // 和代码对得上：链接带班级（c）就走学号，账号不参与；学号那条路不收只给账号的四类
    const learn = read('pages/student/Student.tsx')
    expect(learn).toContain('if (seat) return <Learn key={seat.sid} seat={seat} />')
    expect(server).toContain("const ACCOUNT_ONLY = ['collect_expression', 'drop_expression', 'review_word', 'drop_word']")
    expect(server).toContain('for (const e of rest) if (!ACCOUNT_ONLY.includes(e.type))')
  })

  it('「老师的信息」和「所有访问者」：老师账号、会话、班级、发布存的几样；页面报错带的几样；程序日志记什么；和代码对得上', () => {
    const teacher = between('## 老师的信息', '## 所有访问者')
    expect(teacher.split('\n').filter((l) => l.startsWith('- '))).toEqual([
      '- 用户名、称呼和加密保存的密码',
      '- 注册时间；注册用的邀请码只存哈希',
      '- 登录记录：每次登录的时间和到期时间，登录凭证只存哈希；还有最近一次知适团队重置密码的时间',
      '- 老师上传的文章和讲解，每份讲义发布到了哪些班',
      '- 班级名、建班时间，建班和换名单时勾选那两项确认的时间',
      '- 老师录入的班级名单（学号和姓名）',
    ])
    expect(server).toContain('const teacher = { id: `t-${randomBytes(6).toString(\'hex\')}`, username, name, passwordHash, createdAt: new Date().toISOString(), inviteHash }')
    expect(server).toContain('[tokenKey(token)]: { teacher: teacherId, createdAt, expiresAt: createdAt + SESSION_MS } }))')
    expect(readFileSync(fileURLToPath(new URL('../scripts/teacher.mjs', import.meta.url)), 'utf8')).toContain('{ ...x, passwordHash, sessionsValidAfter: Date.now() }')
    expect(server).toContain("const cls = { id: `c-${randomBytes(6).toString('hex')}`, owner: teacher.id, name, createdAt: new Date().toISOString(), confirmedAt: Date.now(),")
    expect(server).toContain('next.confirmedAt = Date.now()')
    expect(server).toContain('JSON.stringify({ ...own.meta, published: true, classes })')

    const all = between('## 所有访问者', '## 写作检查、生成讲义和 AI')
    expect(all).toContain('- 页面报错信息：页面出错时，错误信息（最多 200 字）、出错的时间、当时打开的讲义编号，和这台设备上的一个随机编号（不是账号，也不是学号）会发给服务器，用来修问题')
    expect(all).toContain('- 程序日志：每次请求的方法、路径（里面可能有讲义、班级的编号和学号）、状态码和耗时；生成讲义出错时，还记一小段出错信息，里面可能有文章原文或 AI 回答的片段。没有 IP，没有作答、写作原文和姓名')
    // 报错的 sid：匿名学生编号或只用于诊断的编号（账号、学号的 sid 不写进 zhishi:sid:student）
    const main = read('main.tsx')
    expect(main).toContain(".slice(0, 200)")
    expect(main).toContain("sendEvent({ sid: diagSid(), ts: Date.now(), handoutId: currentHandout.id, type: 'client_error', value })")
    expect(read('lib/store.ts')).toContain('if (!preset && !sid) writeLS(sidKey(role), state.sid) // 学号、账号的 sid 不顶替匿名 sid')
    // 程序日志：每个请求一行；生成讲义出错时最多 160 字的出错信息（校验出错的信息里带最多 40 字的原文片段）
    expect(server).toContain('res.on(\'finish\', () => cfg.log(`#${n} ${req.method} ${req.path} ${res.statusCode} ${Date.now() - t0}ms`))')
    expect(server).toContain('.split(cfg.apiKey).join(\'***\').slice(0, 160)')
    expect(readFileSync(fileURLToPath(new URL('../pipeline/validate.ts', import.meta.url)), 'utf8')).toContain('「${q.slice(0, 40)}」')
    expect(readFileSync(fileURLToPath(new URL('../deploy/README.md', import.meta.url)), 'utf8')).toContain('在 journald（`journalctl -u zhishi`），全服务器共用，留多久按全局设置，不单独改')
  })

  it('「用账号登录的同学」：注册填什么、存什么（不存出生年月）、不满 14 周岁的勾选时间、学习记录八类、谁能看、示例文章和班级二维码不记到账号、退出清掉本机什么、下载数据', () => {
    const sec = account()
    for (const x of [
      '注册时要填邀请码、用户名、密码和出生年月，并勾选「我读过隐私说明，同意按账号保存学习记录」。一个邀请码注册一个账号。用户名不要用真实姓名或手机号，有 11 位连着的数字的用户名注册不了。',
      `出生年月只用来判断满没满 ${MIN_AGE} 周岁、满没满 ${GUARDIAN_AGE} 周岁，不保存。不满 ${MIN_AGE} 周岁的不能注册；不满 ${GUARDIAN_AGE} 周岁的，要先请家长看过这份说明并同意，见下面「不满 14 周岁的学生」。`,
      '- 用户名和加密保存的密码',
      // 找回码在注册、用找回码改密码的响应里给本人；团队 reset-password 时打印在团队的终端上
      '- 找回码的哈希：哈希是由找回码算出来的一串字符，推不回原来的码。找回码本身不存，只在生成时显示一次：注册和改密码时显示给你；知适团队帮你重置密码时显示给团队，由团队私下告诉你',
      '- 注册用的邀请码，也只存哈希，知适团队帮你重置密码时用它核对是不是你的账号', // inviteHash
      '- 注册时间、注册时勾选同意的时间、最近一次用知适的时间（每天只记一次）', // createdAt、agreedAt、lastSeenAt
      // student-sessions.json：{token 的 sha256: {student, createdAt, expiresAt}}，写盘时 live() 去掉过期的；sessionsValidAfter
      '- 登录记录：每次登录的时间和到期时间，登录凭证只存哈希。退出时删掉这一条，过期的在之后有人登录或退出时清掉',
      '- 最近一次改密码的时间（用找回码改，或者知适团队重置），用来让这之前的登录失效',
      `- 确认你满 ${MIN_AGE} 周岁的时间`, // ageOkAt
      `- 注册时不满 ${GUARDIAN_AGE} 周岁的：勾选「我不满 ${GUARDIAN_AGE} 周岁，家长已经看过隐私说明并同意我注册」的时间`, // guardianAt
      '- 设置：AI 写作检查、「按我以前的记录调整提示」打开了没有', // ai、adapt
      '- 问卷答案（答了才有），见下面「问卷」',
      '- 学习记录，见下面「学习记录」',
      '- 交了写作（只记「交了」，不记你写的内容）',
      // 阶段 4 只给账号的四类事件（collect_expression、drop_expression、review_word、drop_word），按钮名和单词本页对得上
      '- 收进、移出表达本',
      '- 单词本里复习时点了「认识」还是「还不认识」，和移出单词本',
      '每一条都记着发生的时间。', // 事件的 ts
      '只有你自己和知适团队的维护人员能看到，老师和别的同学看不到。',
      // GET /api/student/notebook 从 students/<sid>.jsonl 推算（lib/notebook 的 buildNotebook），不另存
      '单词本和表达本是从这些学习记录算出来的，换一台设备登录看到的也一样。',
      '示例文章的作答只存在本机，登录了也一样。', // 内置讲义不走账号，后端也丢掉内置讲义的账号事件
      '从老师发的班级二维码进来时，作答记在学号上，不记到账号上。',
      '这两种时候点的词、收的表达，也不进账号的单词本和表达本。',
      '登录状态记在浏览器和服务器上，30 天后要重新登录；用找回码改了密码，或者知适团队重置了密码，所有设备都要重新登录。',
      '忘了密码又丢了找回码的，可以请知适团队重置（见下面「你的权利」）：团队用注册时的邀请码核对是不是你的账号，重置以后私下告诉你一个临时密码和新的找回码，旧的找回码不能再用。',
      // 退出清掉的是 clearSid（state 里有问卷和表达本）和这个账号的队列；没传完的先问
      '退出账号时，这台设备上这个账号的作答、读到哪一步、以前每篇开头填的问卷、表达本和写作草稿都会清掉。',
      '传不完会先问你',
      // 阶段 5：GET /api/student/records 和单词本同一份推算（lib/notebook 的 buildRecords），每行只有标题、日期、难度、状态
      '学习记录页也是这样算出来的，不另存一份：列出你动过手的每一篇、最近一次读的日期、你选的难度，和还有没有没答的句子。',
      // 完整导出：profile（问卷答案）、articles（我的文章）、records、words、expressions、events；不满 14 周岁的多 guardianAt；aiFields 和每一条的 ai；写作草稿和以前每篇里的问卷在浏览器里合进去（withLocal、localData）
      '在账号页点「下载我的数据」，可以下载一个文件，里面是用户名、注册时间、设置、问卷答案、「我的文章」，学习记录页上的每一篇、单词本、表达本，还有账号上原样的全部学习记录。',
      `注册时不满 ${GUARDIAN_AGE} 周岁的，文件里还有勾选家长同意的时间。`,
      `「服务器上存什么」里的这几样不在文件里：密码和各种哈希、登录记录、注册时勾选同意的时间、确认满 ${MIN_AGE} 周岁的时间、最近一次用知适的时间、最近一次改密码的时间、生成的次数；要看这些，见下面「你的权利」。`,
      '单词本和表达本里由 AI 生成的中文，文件里有标记；自己贴的文章的标题由 AI 起，文件开头也写明了。',
      '调整提示用到了哪些数据，文件里也写明了。', // 导出的 adaptNote
      '写作草稿不在服务器上：下载时，浏览器把这台设备上的写作草稿（还有以前每篇开头填的问卷）直接加进文件，不发给服务器；在别的设备上下载，就没有这台设备上的这些。',
    ]) {
      expect(sec).toContain(x)
    }
    expect(sec).not.toContain('称呼') // 学生账号没有称呼（老师账号才有）
    // 学习记录八类：学号的六类，加上只给账号的四类合成的两条（EventType 里除了 page_view 记的步骤和 client_error，都在这里）
    const learning = between('### 学习记录', '### 问卷')
    expect(learning.split('\n').filter((l) => l.startsWith('- '))).toHaveLength(8)
    // 和代码对得上：注册的字段、用户名不收 11 位连着的数字、一个码一个账号、存的字段里有 ageOkAt、agreedAt、guardianAt（只在不满 14 周岁时），没有 birth
    expect(server).toContain("if (!fields.username && /\\d{11}/.test(username)) fields.username = '用户名不要用手机号'")
    expect(server).toContain('ageOkAt: now, agreedAt: now, ...(young ? { guardianAt: now } : {}), ai: true, recoveryHash: hex(code), lastSeenAt: now }')
    expect(read('pages/StudentLogin.tsx')).toContain('下载我的数据') // 说明里的按钮名和账号页对得上
    // 和代码对得上：学习记录页的四样、导出里标 AI 的是单词本和表达本的中文和自己贴的文章的标题、本机的两样只在浏览器里合
    const records = read('pages/student/Records.tsx')
    for (const x of ['最近一次读：', '你选的难度：', '还有没答的句子', '都答过了']) expect(records).toContain(x)
    expect(read('pages/Home.tsx')).toContain('学习记录')
    expect(Object.keys(EXPORT_AI_FIELDS)).toEqual(['words[].zh', 'expressions[].zh', 'articles[].title', 'records[].title', 'words[].sources[].title', 'expressions[].title'])
    expect(server).toContain("...(typeof st.guardianAt === 'number' ? { guardianAt: new Date(st.guardianAt).toISOString(), guardianNote: EXPORT_GUARDIAN_NOTE } : {})")
    expect(read('pages/StudentLogin.tsx')).toContain('withLocal(await blob.text(), localData(me.sid))')
    expect(read('lib/store.ts')).toMatch(/export function localData[\s\S]*?zhishi:\(state\|writing\)/)
    const book = read('pages/student/WordBook.tsx')
    for (const x of ['还不认识', '认识', '移出单词本']) expect(book).toContain(x)
    expect(book).toContain("record({ handoutId: NOTEBOOK_ID, type: 'review_word', lemma: w.lemma, correct })")
    expect(book).toContain("record({ handoutId: NOTEBOOK_ID, type: 'drop_word', lemma: w.lemma })")

    // 和代码对得上：会话存在服务器上（只存 token 的 sha256、开始和到期时间），退出删自己那条，写盘时去掉过期的；改密码、团队重置都记 sessionsValidAfter
    const cli = readFileSync(fileURLToPath(new URL('../scripts/student.mjs', import.meta.url)), 'utf8')
    expect(server).toContain('[tokenKey(token)]: { student: studentId, createdAt, expiresAt: createdAt + SESSION_MS } }))')
    expect(server).toContain('const live = (all, now) => Object.fromEntries(Object.entries(all).filter(([, s]) => s && s.expiresAt > now))')
    expect(server).toContain('const { [k]: _gone, ...rest } = all')
    expect(server).toContain('recoveryHash: hex(code), sessionsValidAfter: Date.now() }')
    expect(cli).toContain('recoveryHash: studentInviteHash(code), sessionsValidAfter: Date.now() }')
    // 团队重置：新找回码打印给团队、私下告诉同学；按账号上的 inviteHash 核对身份
    expect(cli).toContain('console.log(`新找回码（只显示这一次，旧的已经不能用了）：${code}`)')
    expect(server).toContain('inviteHash 留在账号上，人工重置密码时核实身份用')
    // 导出里没有的几样：agreedAt、ageOkAt、lastSeenAt、sessionsValidAfter、上传次数、哈希
    const exp = server.slice(server.indexOf("app.get('/api/student/export'"), server.indexOf("app.get('/api/student/notebook'"))
    const body = exp.slice(exp.indexOf('const body = {'), exp.indexOf('res.set('))
    for (const x of ['agreedAt', 'ageOkAt', 'lastSeenAt', 'sessionsValidAfter', 'uploadCounts', 'countOf', 'Hash', 'studentSessions']) expect(body).not.toContain(x)
    // 每条事件都带 ts（前端记下时的时间），服务器原样存
    expect(read('lib/store.ts')).toContain('const full: LearningEvent = { ...e, sid: state.sid, ts: Date.now(), handoutId: h.id }')
    expect(server).toContain('const out = { sid: e.sid, ts, handoutId: e.handoutId, type: e.type }')
    // 贴文章正在生成的任务记在本机（按账号分开），生成完再打开时清；退出、注销的 clearSid 只清 state、step、writing
    expect(read('lib/store.ts')).toContain('export const studentUploadKey = (sid: string) => `zhishi:student-upload:${sid}`')
    expect(read('lib/store.ts')).toContain('/^zhishi:(state|step|writing):[^:]+:/.test(k)')
    const up = read('pages/student/StudentUpload.tsx')
    expect(up).toContain('writeLS(key, r.jobId)')
    expect(up).toMatch(/const finish = \(\) => \{\s+writeLS\(key, null\)/)
  })

  // 问卷答案在账号记录的 profile 上（PUT /api/student/profile），注册后做一次、可以跳过；课程体系只用来预选目标（Survey.tsx 的 defaultGoal）
  it('问卷：三项、可以跳过、账号页能改、答了才存；课程体系只用来预选目标', () => {
    const sec = between('### 问卷', '### 按以前的记录调整提示')
    for (const x of [
      '注册以后有一份问卷：年级、课程体系、读英文主要为了什么。可以跳过，账号页随时可以改，答了的才记在账号上。',
      '问卷答案用来决定词卡里要不要放「高中新词」、单词本里要不要贴这个标签，年级也用来调整注释，见下面「按以前的记录调整提示」。',
      '课程体系只用来在问卷里帮你先选好目标（选了普通高中，目标先选上高考），存下来是为了在账号页显示、让你能改，不用来调整提示。',
    ]) {
      expect(sec).toContain(x)
    }
    expect(Object.keys(PROFILE_CHOICES)).toEqual(['goal', 'grade', 'curriculum'])
    expect(server).toContain("const profileOf = (st) => Object.fromEntries(Object.entries(PROFILE_CHOICES).flatMap(([k, xs]) => (xs.includes(st?.profile?.[k]) ? [[k, st.profile[k]]] : [])))")
    expect(read('pages/student/Survey.tsx')).toContain("export const defaultGoal = (curriculum?: Profile['curriculum']): Goal | undefined => (curriculum === '普通高中' ? 'gaokao' : undefined)")
  })

  // 阶段 7（11-07 队长定：不升版本、不重新同意）：按以前的记录调整提示。画像只有问卷答案和单词本，读文章时现算、不另存；不给学生看等级；
  // 开关默认开，关掉就是标准版；示例文章、班级学号不调整
  it('按以前的记录调整提示：开关默认开、用了哪两样、现算不另存、不给你看等级、怎么看怎么改、关掉是标准版、哪些时候不调整；和代码对得上', () => {
    const sec = between('### 按以前的记录调整提示', '### AI 写作检查')
    for (const x of [
      '账号页有「按我以前的记录调整提示（关掉就用标准版）」开关，默认开着。',
      '开着的时候，用账号读文章（团队选的、自己贴的，还有不从班级二维码打开的老师发布的讲义），',
      '会根据你填的年级和单词本里还在练的词调整注释和词卡：单词本里的词在新文章里出现，会加注释、放进词卡；按你填的年级，先给一部分高中阶段才学的词加注释；读英文主要为了高考的，词卡里放「高中新词」，单词本里也给这些词贴上这个标签。',
      '用到的只有问卷答案和单词本，每次打开文章时现算，推算的结果不另存，不会给你看等级。',
      '单词本里的词可以在单词本页移出，问卷答案在账号页能改。',
      '关掉开关就用标准版，只按你在这一篇里的作答调整（点过、标过的词，答题和开提示的情况）。',
      '示例文章和从班级二维码进来时，不按以前的记录调整。',
    ]) {
      expect(sec).toContain(x)
    }
    // 账号读的文章：链接不带班级（c）时，登录了就走账号（Synced 拉画像）；老师发布了的讲义谁都能读，作答也收进账号
    const page = read('pages/student/Student.tsx')
    expect(page).toContain('if (!classId) return <ByLogin onLook={() => setLook(true)} />')
    expect(page).toContain('if (student) return <Synced key={student.sid} me={student} />')
    expect(server).toContain('if (meta?.published !== true) {')
    expect(server).toContain(": shelved.has(id) || meta?.published === true")
    // 标准版也按这一篇的答题和开提示调整：梯子先让自己试、收起讲解看的是 answers 和 ladder
    const engine = read('engine/index.ts')
    expect(engine).toContain("if (own && !own.firstTryCorrect) return 'available'")
    expect(engine).toContain("const collapsed = x.tier !== 'must' && !!q && s.answers[q.id]?.firstTryCorrect === true && (s.ladder[x.id] ?? 0) === 0")
    // 开关：账号页的按钮名一样；服务器默认开（没记过的算开），导出里有 settings.adapt 和说明
    expect(read('pages/StudentLogin.tsx')).toContain('按我以前的记录调整提示<span className="font-normal text-ink2">（关掉就用标准版）</span>')
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

  // 11-07 起 STUDENT_AI=1：账号注册时 ai: true，账号页能关
  it('写作 AI：账号同学默认开着、开着时发给 AI、可以在账号页关掉，关掉就只查表达；不写「开放以后」', () => {
    const sec = between('### AI 写作检查', '### 贴文章生成讲义')
    expect(sec).toContain('AI 写作检查默认开着，账号页有「AI 写作检查」开关。')
    expect(sec).toContain('开着的时候，在写作这一步点「检查一下」，写的英文句子按下面「写作检查、生成讲义和 AI」说的发给 AI 检查，知适的服务器不保存原文。')
    expect(sec).toContain('你随时可以在账号页关掉。关掉以后，写作只检查有没有用上要求的表达，句子不发给 AI。')
    expect(read('pages/StudentLogin.tsx')).toContain('aria-label="AI 写作检查"')
    expect(server).toContain('ai: true, recoveryHash: hex(code)') // 注册时默认开着
    expect(server).toContain("const publicStudent = (s) => ({ username: s.username, sid: s.sid, ai: s.ai === true, aiAvailable: cfg.studentAi === true, adapt: adaptOn(s) })")
    expect(noAiNote(undefined, { ai: false, aiAvailable: true })).toContain('只检查有没有用上要求的表达')
    expect(noAiNote(undefined, { ai: true, aiAvailable: true })).toBeNull()
  })

  // 阶段 4 起按身份分开：账号的表达本记在账号上；学号和没登录的问卷、表达本、写作草稿照旧只存本机；写作草稿一律只存本机。
  // 阶段 6 起问卷不在每篇里了，改成账号注册后做一次、记在账号上
  it('只存本机：学号和没登录时问卷、表达本、写作草稿只存本机；账号的写作草稿也只存本机，问卷答案和表达本记在账号上', () => {
    const sec = md.slice(md.indexOf('### 只存在这台设备上的'), md.indexOf('## 从班级二维码进来的同学'))
    expect(sec).toContain('写作草稿只存在这台设备上，不记到账号上，换一台设备登录看不到，退出账号时也会从这台设备上清掉。')
    expect(sec).toContain('开着 AI 写作检查时，写作只在你点「检查一下」时发给 AI 检查一次，服务器不保存。')
    expect(sec).toContain('在账号页下载数据时，写作草稿在浏览器里加进下载的文件，也不发给服务器。以前每篇开头填的问卷也只在这台设备上。')
    expect(sec).toContain('贴文章正在生成时，这台设备记着这一篇的任务编号，好在你关掉页面再回来时接着看进度，生成完以后再打开这一页时清掉（退出账号时不清）。') // studentUploadKey
    expect(sec).toContain('问卷答案和表达本不一样，记在账号上（示例文章和从班级二维码进来时收的表达除外），换一台设备登录也能看到，注销时一起删除。')
    expect(md).toContain('点「只是看看（不记学号）」、读网站自带的示例文章、打开演示画像时，作答只存在你自己的手机或电脑上，不发给服务器，写作也不请 AI 检查。')
    expect(md).not.toContain('这三样不记到账号上')
    // 和代码对得上：账号模式收进、移出发事件，学号和没登录只改本机；打开一篇时账号的表达本以服务器为准
    const learn = read('pages/student/Student.tsx')
    expect(learn).toContain("const collect = (id: string) => (me ? act({ type: 'collect_expression', value: id }) : patch(collectExpression(id)))")
    expect(learn).toContain("const drop = (id: string) => act({ type: 'drop_expression', value: id })")
    expect(learn).toContain('onDrop={me ? drop : undefined}')
    expect(learn).toContain('restoreState(h, sid, events, true)')
    expect(learn).toContain('useStudent(h, \'student\', preset, seat?.sid ?? me?.sid, !!seat || !!me)') // 只有学号、账号发给服务器
    expect(read('lib/store.ts')).toContain('collectedExpressions: account ? rebuilt.collectedExpressions : local.collectedExpressions')
    // 问卷不在每篇里了（账号的存在 profile 上，不是事件）；写作草稿只写本机存储（检查时发的句子服务器不存）
    expect(learn).not.toContain('survey')
    expect(EventType.options.some((t) => /survey|profile|writing_draft/.test(t))).toBe(false)
    expect(read('pages/student/Writing.tsx')).toContain('writeLS(writingKey(h.id, sid), e.target.value)')
  })

  it(`存多久：账号在前；30 天清理不包括账号，账号自己注销时删、${STUDENT_INACTIVE_MONTHS} 个月没用自动删`, () => {
    expect(md).toContain('- 没有记在学号或账号上的记录、页面报错信息、AI 缓存，30 天后自动删除。')
    expect(md).not.toContain('- 没有记在学号上的记录')
    expect(md).not.toContain('现在不会自动删除')
    const keep = between('## 存多久', '## 怎么保护')
    expect(keep.split('\n').find((l) => l.startsWith('- '))).toBe('- 用账号登录的同学自己注销时，账号和账号上的学习记录马上删除。')
    // 和 server 的 STUDENT_INACTIVE_MONTHS 一致；按 lastSeenAt（「最近一次用知适的时间」）算；不收联系方式，删之前没法通知
    // 自动删除只在服务器上跑（deleteStudent），本机的记录只在页面上退出、注销成功时清（clearSid）
    expect(keep).toContain(`- 账号连续 ${STUDENT_INACTIVE_MONTHS} 个月没用（按上面说的「最近一次用知适的时间」算），账号和账号上的学习记录自动删除，服务器上的删法和自己注销一样。各台设备上这个账号的本机记录（比如写作草稿）不会跟着删，清除浏览器数据才会没有。账号上没有你的联系方式，删之前没法通知你。`)
    expect(server).toContain("const idle = (s) => (typeof s.lastSeenAt === 'number' ? s.lastSeenAt : Date.parse(s.createdAt)) < inactive.getTime()")
    expect(read('lib/student-auth.ts').match(/clearSid\(sid\)/g)).toHaveLength(2) // 只有 logout 和 deleteAccount
    // 拦截过的精确键：只在 studentFailed 里加，到期清理、注销、apply-deletions 都不动
    expect(keep).toContain('- 被内容安全拦截的文章，由原文算出的哈希一直留着（同一篇不能再贴），不自动删除，里面没有原文和账号。')
    expect(server.match(/uploadBlocked\.update\(/g)).toHaveLength(1)
    expect(server.slice(server.indexOf('async function cleanup()'), server.indexOf("app.post('/api/writing-check'"))).not.toContain('uploadBlocked')
    // 程序日志在 journald，留多久按服务器的全局设置
    expect(keep).toContain('- 程序日志按服务器的系统日志设置保存，知适没有单独定期限。')
    // 恢复备份时按删除台账再删一遍：deploy/restore-backup.sh 解完就跑 apply-deletions；台账只有学生账号，班级、学号没有（README 写的是按老师的记录手工再删）
    expect(keep).toContain('从备份恢复数据时，自动再删一遍的是已经注销和自动删除的学生账号；备份之后老师删掉的班级、学号不会自动再删。')
    expect(readFileSync(fileURLToPath(new URL('../deploy/restore-backup.sh', import.meta.url)), 'utf8')).toContain('scripts/student.mjs" apply-deletions "$target"')
    expect(readFileSync(fileURLToPath(new URL('../scripts/student.mjs', import.meta.url)), 'utf8')).not.toContain('classes.json')
    expect(readFileSync(fileURLToPath(new URL('../deploy/README.md', import.meta.url)), 'utf8')).toContain('备份之后老师删掉的班级、学号（撤回同意）会跟着回来，要按老师的记录再删一次')
    expect(md).toContain('- 用账号登录的同学：能看到自己账号上的记录。账号上的记录老师看不到。')
  })

  it('谁能看到：账号同学在前，班级的照旧；维护人员如实写', () => {
    const sec = between('## 谁能看到', '## 不满 14 周岁的学生 {#minors}')
    expect(sec.split('\n').filter((l) => l.startsWith('- '))).toEqual([
      '- 用账号登录的同学：能看到自己账号上的记录。账号上的记录老师看不到。',
      '- 贴过同一篇文章的同学：能读同一份讲义，看不到是谁贴的，也看不到彼此的作答。',
      '- 建班的老师：能看到自己班的名单和按学号记的学习记录。',
      '- 从班级二维码进来的同学：能看到自己的作答。',
      '- 知适团队的维护人员：维护服务器时，技术上能接触到这些信息。',
      '- 除了上面这些，别的同学和其他老师看不到。',
    ])
    // 老师看全班记录只读 events-<讲义>.jsonl 里这个班学号的 sid；账号的记录在 students/<sid>.jsonl
    const events = server.slice(server.indexOf("app.get('/api/events'"), server.indexOf('async function readEvents'))
    expect(events).toContain('(await readEvents(id)).filter((e) => e.ts > since && sids.has(e.sid))')
    expect(events).not.toContain('studentEventsFile')
  })

  it('注销：账号页自己注销、要再输一次密码；删掉什么、本机清掉什么、没删成的每天再删、码只留哈希不能再用、用户名放出来、台账只留编号的哈希和日期', () => {
    const sec = between('### 注销账号', '### 只存在这台设备上的')
    for (const x of [
      '在账号页点「注销账号」、再输一次密码，可以自己注销。',
      // deleteStudent：students.json 里删掉账号（guardianAt 在账号记录里，一起删）、作废会话、删 students/<sid>.jsonl 和事件文件里这个 sid 的行
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
    expect(server).toContain("JSON.stringify({ sidHash: sidHash(sid), date: bjDay(Date.now()) })")
  })

  it('你的权利：账号同学自己下载数据、用找回码改密码、注销账号；更正、撤回同意和问问题在内测群里联系知适团队；班级的同学找任课老师', () => {
    const sec = md.slice(md.indexOf('## 你的权利'))
    expect(sec).toContain('你可以查看、复制、更正、删除你的信息，也可以撤回同意。')
    expect(sec).toContain('用账号登录的同学，可以在账号页自己下载数据（「下载我的数据」）、用找回码改密码、注销账号（「注销账号」）。')
    expect(sec.indexOf('用账号登录的同学')).toBeLessThan(sec.indexOf('班级的同学请联系任课老师'))
    expect(md).not.toContain('还在做')
  })

  it(`不满 14 周岁一节：账号注册门槛 ${MIN_AGE} 周岁、不满 ${GUARDIAN_AGE} 周岁要家长看过并勾选（记下勾选时间）、满门槛的那个月按还没满算；班级照旧由家长签同意书；和代码对得上`, () => {
    const sec = between('{#minors}', '## 你的权利')
    expect(sec).toContain('不满 14 周岁的学生的个人信息属于敏感个人信息。')
    expect(sec).toContain(`用邀请码注册账号要年满 ${MIN_AGE} 周岁。`)
    expect(sec).toContain(`只知道年月，满 ${MIN_AGE} 周岁、满 ${GUARDIAN_AGE} 周岁的那个月都按还没满算。`)
    expect(sec).toContain(`不满 ${MIN_AGE} 周岁的不能注册，这个邀请码也不能再用。`)
    expect(sec).toContain(`不满 ${GUARDIAN_AGE} 周岁的同学，要先请家长看过这份隐私说明并同意，再在注册页勾选「我不满 ${GUARDIAN_AGE} 周岁，家长已经看过隐私说明并同意我注册」，才能注册。`)
    expect(sec).toContain('没勾的不能注册，这个邀请码还能用。')
    expect(sec).toContain('服务器把勾选的时间记在账号上，注销时一起删除，「下载我的数据」的文件里也有。')
    expect(sec).toContain('班级的学生，都要先由家长签告知同意书，老师收回同意书以后才建班录名单；年满 14 周岁的同学，选学号时本人也要勾选同意，勾选的时间记在这个学号上。没有同意的同学不录入名单，可以用「只是看看（不记学号）」学习，作答只存在本机。') // 绑定的 confirmedAt
    expect(md).not.toMatch(/年满 16 周岁|16 周岁/)
    // 和代码对得上：两个门槛都按「满了几个月 <= 门槛 × 12」算；不满 12 的码作废在前，没勾家长那一项的 400、码不作废；勾选时间和 agreedAt 同一刻
    expect(GUARDIAN_AGE).toBe(14)
    expect(CLIENT_GUARDIAN_AGE).toBe(GUARDIAN_AGE)
    const reg = server.slice(server.indexOf("app.post('/api/student/register'"), server.indexOf("app.post('/api/student/login'"))
    expect(reg).toContain('if (months <= MIN_AGE * 12) {')
    expect(reg).toContain('const young = months <= GUARDIAN_AGE * 12')
    expect(reg).toContain("if (young && b.guardian !== true) return res.status(400)")
    expect(reg.indexOf('usedInvites: [...usedOf(data), inviteHash] }))')).toBeLessThan(reg.indexOf('const young'))
    // 说明里引的勾选的字，和注册页、导出里的说明一样
    expect(read('pages/StudentLogin.tsx')).toMatch(/我不满 \{GUARDIAN_AGE\} 周岁，家长已经看过\s+<a href="#\/privacy\?s=minors"[^>]*>\s+隐私说明\s+<\/a>\s+并同意我注册/)
    expect(EXPORT_GUARDIAN_NOTE).toContain(`「我不满 ${GUARDIAN_AGE} 周岁，家长已经看过隐私说明并同意我注册」`)
    // 班级那条路：建班要勾「已收回家长告知同意书」，选学号页有年满 14 周岁本人同意的必勾
    expect(read('pages/Classes.tsx')).toContain("['consent', '已收回家长告知同意书，名单里只录入了第 1 项选了同意的同学']")
    expect(read('pages/student/JoinClass.tsx')).toContain('年满 14 周岁的同学，勾选表示你本人也同意按学号记录作答。')
  })

  // 阶段 2、3：学生贴文章（POST /api/student/uploads、library.json、upload-counts.json、upload-blocked.json）和 usage 日志
  it(`贴文章生成讲义：查过才发给百炼、拦截留哈希、已有的回答照缓存期限删、讲义只给「我的文章」里有它的人读、不显示上传人、没人用 ${STUDENT_HANDOUT_DAYS} 天后删；用量日志不记原文和账号`, () => {
    const sec = between('### 贴文章生成讲义', '### 下载我的数据')
    for (const x of [
      '在「贴一篇文章」页可以贴一篇英文文章，由 AI 生成这一篇的讲义。', // STUDENT_UPLOAD=1，11-08 起开着
      // checkArticle 在开始生成之前跑，不过就 400，什么都不存
      '这几种不收：长度或格式不对，不像英文，像试卷，有手机号、身份证号这类个人信息，同一句重复太多。不收的文章不保存，也不发给 AI。',
      '查过的原文发给阿里云百炼上的大模型，生成标题、题目、词义和提示。',
      // upload-blocked.json 只有 {keys: [精确键]}；同一篇里别的调用已经写进 llm-cache 的回答照缓存期限删（cleanupCacheDays）
      '被百炼的内容安全拦截的文章不生成讲义，同一篇以后不能再贴：服务器留下由这篇原文算出的哈希，不记是谁贴的。',
      '拦截之前 AI 已经给出的那部分回答，和别的 AI 回答缓存一样 30 天后删除。',
      // meta 的 createdBy 不出现在任何返回体里，用途见 studentDone 的注释
      '服务器上记着这份讲义是哪个账号贴的，用来在这篇文章有问题、或者有人滥用贴文章的时候找到是谁贴的，页面上不显示，别的同学看不到。',
      // 精确键复用不再生成；近似键回 similar 让学生选
      '别的同学贴了同一篇（只差空格、空行的也算），直接读已有的这份讲义，不再发给 AI。',
      '只差标点或大小写的，由贴的同学自己选：读已有的那一份，还是按自己贴的再生成一份。',
      // GET /api/handouts/:id 只认本人的「我的文章」；学生讲义不开放 GET /api/events
      '只有「我的文章」里有这一篇的同学能读这份讲义，没有公开的目录，也没有分享链接。读的同学看不到是谁贴的，也看不到别人在这篇里的作答。',
      '也算进单词本、表达本和学习记录页。',
      '服务器上还记着你每周生成了几篇、当天有几次没生成成功，用来限制次数。', // upload-counts.json 的 used、fails
      '每周能生成的篇数只在生成成功时算，直接读已有讲义的不算。', // countUpload(sj.by, 'used') 只在 studentDone
    ]) {
      expect(sec).toContain(x)
    }
    expect(read('pages/student/StudentUpload.tsx')).toContain('<SiteHeader label="贴一篇文章"') // 页面名对得上
    // 和代码对得上：拒收的几类就是上传页认的几种 reason（长度和格式的照后端的说法）
    expect(Object.keys(REASONS).sort()).toEqual(['exam', 'not_english', 'personal_info', 'repeated', 'unsafe'])
    const upload = server.slice(server.indexOf('async function studentUpload'), server.indexOf("app.get('/api/uploads/:jobId'"))
    expect(upload.indexOf('check(text)')).toBeGreaterThan(0)
    expect(upload.indexOf('check(text)')).toBeLessThan(upload.indexOf('runJob('))
    expect(server).toContain("keys: [...(Array.isArray(d.keys) ? d.keys : []), sj.exact]") // studentFailed：拦截过的只记精确键
    expect(server).toContain('articles: await myArticles(st.id)') // 导出里的「我的文章」
    expect(server.match(/countUpload\(sj\.by, 'used'\)/g)).toHaveLength(1)
    expect(server).toContain('createdBy（提交的账号 id，只用来处理投诉和滥用，不出现在任何返回体里')

    // 注销：列表和次数删掉，别人在用的讲义留着、去掉 createdBy，没人用的按留存删
    const acc = account()
    expect(acc).toContain('- 「我的文章」（贴过的文章的讲义编号、标题、加进来的时间）和生成的次数，见下面「贴文章生成讲义」')
    expect(acc).toContain(`「我的文章」和生成的次数一起删除；你贴的文章生成的讲义，还在别的同学「我的文章」里的照旧留着，服务器上不再记着是你贴的，不在任何人「我的文章」里的 ${STUDENT_HANDOUT_DAYS} 天后删除。`)
    const keep = between('## 存多久', '## 怎么保护')
    expect(keep).toContain(`- 同学贴文章生成的讲义，还在哪位同学的「我的文章」里就一直保存；不在任何人的「我的文章」里以后，${STUDENT_HANDOUT_DAYS} 天后自动删除。`)
    expect(keep).toContain('- 生成讲义时大模型的回答缓存在服务器上，里面有原文的片段，30 天后自动删除。') // llm-cache，cleanupCacheDays
    expect(keep).toContain('- 调用大模型的用量记录不自动删除，用来核对花费，里面没有原文和账号。')
    expect(md).toContain('- 贴过同一篇文章的同学：能读同一份讲义，看不到是谁贴的，也看不到彼此的作答。')

    // 用量日志：一行只有这几样，写作检查不带讲义 id
    const usage = between('## 用量记录', '## 存在哪')
    expect(usage).toContain('每次调用大模型，服务器记下用量：时间、哪一类调用、哪个模型、用了多少、花了多少钱；写作检查以外的几类还记是哪一份讲义。这些只用来控制和核对花费，不记发过去的原文，也不记是哪个账号。')
    // 讲义编号能对上学生讲义 meta 的 createdBy（注销时去掉）；写作检查的 ts 能和 writing_submit 对上（server 的注释也这么写）
    expect(usage).toContain('不过，贴文章生成讲义的那几类记着讲义编号，账号还在的时候，能和贴这篇的账号对上，注销以后就对不上了；写作检查那一行的时间，也能和账号或学号上「交了写作」的时间对上。')
    expect(server).toContain("source: 'student', ...(live ? { createdBy: sj.by } : {})")
    expect(server).toContain('写作检查连讲义 id 也不写（和账号事件文件里 writing_submit 对一下时间就能认出是谁）')
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

  // 法规这几样队长另行处理，这份说明里不写（11-08 起联系方式写内测群，见上面「联系方式」）
  it('不写服务协议、AI 使用说明、投诉渠道', () => {
    expect(md).not.toMatch(/服务协议|AI 使用说明|投诉/)
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
