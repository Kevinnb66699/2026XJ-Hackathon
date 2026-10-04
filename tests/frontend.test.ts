import { readdirSync, readFileSync, statSync } from 'fs'
import { join } from 'path'
import { fileURLToPath } from 'url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Handout, type LearningEvent } from '../shared/schema'
import { GRAMMAR_TERMS } from '../pipeline/validate'
import { noteCover, noteGroup, personalWord } from '../src/components/SentenceCard'
import { personalize, emptyState } from '../src/engine'
import { flush, pendingCount, sendEvent } from '../src/lib/events'
import { annotate, findAll, lemmaIndex, markWords, noteQuote, sameWording, segment, tokenize } from '../src/lib/text'
import { checkWriting, safeReason } from '../src/lib/writing'
import { miniHandout as h } from './fixtures/mini-handout'

const join_ = (parts: { text: string }[]) => parts.map((p) => p.text).join('')

describe('原文切分：拼回去与原文逐字一致', () => {
  it('tokenize：每个英文单词单独成块', () => {
    for (const x of h.sentences) expect(join_(tokenize(x.text))).toBe(x.text)
    expect(tokenize("Teachers don’t fret; pupils' phones.").filter((t) => t.word).map((t) => t.text)).toEqual(['Teachers', 'don’t', 'fret', 'pupils', 'phones'])
  })

  it('segment：注释词 + 可跳过词，整句切或按梯子批注一块一块地切', () => {
    const v = personalize(h, { ...emptyState('x'), tappedWords: h.words.map((w) => w.lemma) })
    for (const sv of v.sentences) {
      const x = h.sentences.find((y) => y.id === sv.id)!
      const marks = markWords(sv.text, sv.glosses, 'gloss')
      expect(join_(segment(sv.text, marks))).toBe(x.text)
      const chunks = annotate(sv.text, x.ladder ? [{ text: x.ladder.l1.subject }, { text: x.ladder.l1.predicate }] : [])
      expect(chunks.map((c) => join_(segment(sv.text, marks, c.start, c.end))).join('')).toBe(x.text)
    }
    // 跨块的标记切成两段，各自还带着标记
    const m = { start: 0, end: 7, kind: 'gloss' as const, lemma: 'abc def' }
    expect(segment('abc def!', [m], 2, 5)).toEqual([{ text: 'c d', mark: m }])
    expect(segment('abc def!', [m], 5, 8)).toEqual([{ text: 'ef', mark: m }, { text: '!', mark: undefined }])
  })

  it('findAll 整词、不区分大小写', () => {
    expect(findAll('Pupils and pupil, pupillage', 'pupil')).toEqual([[11, 16]])
    expect(findAll('Pupils and pupil', 'pupils')).toEqual([[0, 6]])
    expect(findAll('abc', '')).toEqual([])
  })

  it('梯子第 1 步在原句上标出「谁」「做了什么」两段子串', () => {
    const x = h.sentences.find((y) => y.id === 'S03')!
    const chunks = annotate(x.text, [{ label: '谁', text: x.ladder!.l1.subject }, { label: '做了什么', text: x.ladder!.l1.predicate }])
    expect(chunks.filter((c) => c.part).map((c) => [c.part!.label, c.text])).toEqual([['谁', 'a blanket ban'], ['做了什么', 'may prove']])
  })
})

describe('annotate：梯子批注把各块放回原句', () => {
  const text = 'Kids barred from sites could flock to obscure ones, and fall victim there.'
  const labels = (parts: { label: string; text: string }[]) =>
    annotate(text, parts).map((c) => (c.part ? `[${c.part.label}]${c.text}` : c.text))

  it('按在原句里的位置排，没盖住的原文夹在中间，拼回去逐字一致', () => {
    const parts = [
      { label: '谁', text: 'Kids barred from sites' },
      { label: '做了什么', text: 'could flock to obscure ones' },
      { label: '怎么样', text: 'fall victim there' },
    ]
    expect(labels([parts[2], parts[0], parts[1]])).toEqual(['[谁]Kids barred from sites', ' ', '[做了什么]could flock to obscure ones', ', and ', '[怎么样]fall victim there', '.'])
    const chunks = annotate(text, parts)
    expect(join_(chunks)).toBe(text)
    for (const c of chunks) expect(text.slice(c.start, c.end)).toBe(c.text)
    expect(annotate(text, [])).toEqual([{ text, start: 0, end: text.length }])
  })

  it('和已放好的块重叠的跳过，先列的优先', () => {
    expect(labels([{ label: '谁', text: 'Kids barred' }, { label: '补充说明', text: 'barred from sites' }, { label: '为什么', text: 'nowhere' }])).toEqual(['[谁]Kids barred', ' from sites could flock to obscure ones, and fall victim there.'])
  })

  it('优先放在整词的位置：it 不落在 With 中间；没有整词的位置才退回任意位置', () => {
    const t = 'With prices up, it is hard.'
    expect(annotate(t, [{ label: '谁', text: 'it' }]).find((c) => c.part)!.start).toBe(16)
    expect(annotate('Withit', [{ label: '谁', text: 'it' }]).find((c) => c.part)!.start).toBe(1)
  })

  it('一块在原句里出现多次时，取不和已放好的块重叠的那一处', () => {
    const t = 'They said they would, and they did.'
    const out = annotate(t, [{ label: '谁', text: 'they would' }, { label: '补充说明', text: 'they' }])
    expect(out.map((c) => [c.part?.label ?? '', c.text])).toEqual([['', 'They said '], ['谁', 'they would'], ['', ', and '], ['补充说明', 'they'], ['', ' did.']])
    expect(join_(out)).toBe(t)
  })
})

// 10-04 起购买讲义已从仓库移除，这一组改用迷你讲义和内联的小例子
describe('粗读点词、「给你」便签、梯子第 2 步', () => {
  it('lemmaIndex：点短语里的单个词也算这个词条', () => {
    const m = lemmaIndex([
      { lemma: 'toy with', forms: ['toying with'] },
      { lemma: 'arise from', forms: ['arises from'] },
      { lemma: 'pupil', forms: ['pupils'] },
      { lemma: 'for fear of', forms: ['for fear of'] },
      { lemma: 'as a whole', forms: ['as a whole'] },
    ])
    expect(['toying', 'arises'].map((t) => m.get(t))).toEqual(['toy with', 'arise from'])
    expect(m.get('pupils')).toBe('pupil') // 单词词形照旧
    expect(m.get('for')).toBeUndefined() // for fear of：第一个词是虚词
    expect(m.get('as')).toBeUndefined() // as a whole：太短
  })

  it('lemmaIndex：已被别的词条占用的词不改指（不管词条先后）', () => {
    const m = lemmaIndex([
      { lemma: 'blanket ban', forms: ['blanket bans'] },
      { lemma: 'blanket', forms: ['blanket'] },
      { lemma: 'kick off', forms: ['kicking off'] },
      { lemma: 'kick out', forms: ['kicking out'] },
    ])
    expect(m.get('blanket')).toBe('blanket')
    expect(m.get('kicking')).toBe('kick off')
  })

  it('noteQuote：只引既点名这个词、又带「如果」、没有术语的那一句', () => {
    const note = '这句话的意思是一些家长也在考虑。第二句中如果不认识 fret 一词，很可能读不懂这句话；clearer 是比较级，意思是更清楚的。'
    expect(noteQuote(note, ['fret'])).toBe('第二句中如果不认识 fret 一词，很可能读不懂这句话')
    expect(noteQuote(h.sentences[2].teacherNote!, ['pending'])).toBe('如果对 pending 一词不够熟悉，可能会造成理解困难')
    expect(noteQuote(note, ['clearer'])).toBeUndefined() // 讲了词义、这一句没带「如果」，不拿别的句子凑
    expect(noteQuote('如果不认识 fret，这个从句读不懂。', ['fret'])).toBeUndefined() // 有术语
  })

  it('上传的文章：老师在预览里写的讲解（没有出处）也会收起，也会出「给你」便签', () => {
    const up = Handout.parse({
      ...h,
      id: 'up-test1',
      sentences: h.sentences.map((x) => ({ ...x, sources: [], teacherNote: x.id === 'S05' ? '这句很长\n如果不认识 fret 一词，很可能读不懂这句话。' : x.id === 'S02' ? '和第一句对比：担心的是屏幕让学生分心。' : undefined })),
    })
    const state = { ...emptyState('u1'), wordMarks: { fret: 'unknown' as const }, answers: { 'S02-q': { firstTryCorrect: true, attempts: 1, correct: true } } }
    const views = personalize(up, state).sentences
    const v = (id: string) => views.find((x) => x.id === id)!
    expect(personalWord(up, v('S05'), state)?.lemma).toBe('fret')
    expect(noteQuote(up.sentences[4].teacherNote!, ['fret'])).toBe('如果不认识 fret 一词，很可能读不懂这句话') // 换行也算断句，不把上一行引进来
    expect(personalWord(up, v('S05'), emptyState('u2'))).toBeUndefined() // 认识 fret 的不给
    expect(v('S02').teacherNoteCollapsed).toBe(true) // 第一次就答对、没开梯子
    expect(up.sentences.map((x) => noteCover(up, x.id)).filter(Boolean)).toEqual([]) // 没有出处，不说「一起讲了几句」，讲解里的「第一句」也不指认
  })

  it('noteGroup / noteCover：几句一起讲的讲解，说清讲了哪几句、哪一句是这张卡（issue #18）', () => {
    // 迷你讲义改出一个例子：S01、S02 同一段精讲引文、讲解一字不差（S02 换成短句，看整句给出）；S03、S04 同一段引文，讲解各讲各的，S04 的讲解点到「第二句」；S05 和 S03 同一段引文但没有讲解
    const quote = (q: string) => [{ day: 2, section: '原文精读学习', quote: q }]
    const pair = '第一句讲谁在考虑禁令，第二句讲这个提议是怎么来的。'
    const g = Handout.parse({
      ...h,
      sentences: h.sentences.map((x) =>
        x.id === 'S01' || x.id === 'S02'
          ? { ...x, teacherNote: pair, sources: quote('引文一'), ...(x.id === 'S02' ? { text: 'Screens distract pupils.', ladder: undefined } : {}) }
          : x.id === 'S04'
            ? { ...x, teacherNote: '第二句：只有有限的证据。', sources: quote('引文二') }
            : { ...x, sources: x.id === 'S03' || x.id === 'S05' ? quote('引文二') : [] },
      ),
    })
    const groups = g.sentences.map((x) => [x.id, noteGroup(g, x.id).map((r) => `${r.n}${r.id}`).join(' ')])
    expect(Object.fromEntries(groups)).toEqual({ S01: '一S01 二S02', S02: '一S01 二S02', S03: '一S03', S04: '二S04', S05: '' })
    expect(noteCover(g, 'S01')).toBe('这段讲解一起讲了 2 句：第一句「Many schools are toying…」（就是这一句），第二句「Screens distract pupils.」') // 短句整句给出
    expect(noteCover(g, 'S02')).toBe('这段讲解一起讲了 2 句：第一句「Many schools are toying…」，第二句「Screens distract pupils.」（就是这一句）')
    // 只讲这一句，但按精讲引文里的顺序叫它「第几句」
    expect(noteCover(g, 'S04')).toBe('讲解里的「第二句」就是这一句')
    // 只讲这一句、也没叫它第几句，或没有讲解
    expect(['S03', 'S05'].map((id) => noteCover(g, id))).toEqual(['', ''])
    expect(h.sentences.map((x) => noteCover(h, x.id)).filter(Boolean)).toEqual([])
  })

  it('sameWording：不计首尾空白、空白个数和引号写法', () => {
    expect(sameWording(' It’s  “fine”. ', "It's \"fine\".")).toBe(true)
    expect(sameWording('And even if you wanted', 'Even if you wanted')).toBe(false)
    const s04 = h.sentences[3]
    expect(sameWording(` ${s04.text.replace(/ /g, '  ')}`, s04.text)).toBe(true)
    expect(sameWording(h.sentences[2].ladder!.l2, h.sentences[2].text)).toBe(false)
  })
})

describe('写作反馈不给改写后的句子', () => {
  const example = 'Yet, pending clearer evidence, a blanket ban may prove counterproductive.'
  it('可以引用原文例句和学生原话', () => {
    const r = '和原文 a blanket ban may prove counterproductive 的用法一致。'
    expect(safeReason(r, 'correct', ['I think bans are counterproductive.', example])).toBe(r)
    expect(safeReason('你写的 bans are counterproductive 没问题。', 'correct', ['I think bans are counterproductive.', example])).toContain('bans are counterproductive')
  })
  it('出现原文和学生原话里都没有的英文句子，就换成通用说法', () => {
    const out = safeReason('可以改成 a blanket ban would be counterproductive here。', 'incorrect', ['I think ban is counterproductive.', example])
    expect(out).toBe('对照原文例句再想想。')
  })

  describe('checkWriting：理由可以引用表达本身（原形），改写照样换掉', () => {
    afterEach(() => {
      vi.unstubAllGlobals()
    })
    const reply = (results: unknown, grammar?: unknown) => vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ fallback: false, results, grammar }) }))
    // 学生写 toying with a ban；原文例句是 toying with the idea；理由引用表达原形 toy with the idea
    const text = 'Some schools are toying with a ban.'

    it('引用表达原形的理由原样保留', async () => {
      const reason = 'toy with the idea 指不太认真地考虑一个想法，这里的搭配和原文不一样。'
      reply([{ id: 'E1', verdict: 'incorrect', reason }])
      expect(await checkWriting(h, text, ['E1'], 'stu-x')).toEqual({ results: [{ id: 'E1', verdict: 'incorrect', reason }], grammar: null })
    })

    it('请求体带学生编号（后端按它限次数）', async () => {
      reply([])
      await checkWriting(h, text, ['E1'], 'stu-x')
      const body = JSON.parse((fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1].body)
      expect(body).toMatchObject({ handoutId: h.id, sid: 'stu-x', text })
    })

    it('演示画像（demo-A / demo-B）的编号所有访客都一样：限次改用设备 id，不发 demo-A', async () => {
      reply([])
      await checkWriting(h, text, ['E1'], 'demo-A')
      const { sid } = JSON.parse((fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1].body)
      expect(sid).not.toBe('demo-A')
      expect(sid).toMatch(/^dev-[a-z0-9]{6,60}$/) // 后端只认 1–64 字符
    })

    it('超过次数上限（429）当 AI 不可用，回落到规则反馈', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 429, json: async () => ({ fallback: true, results: [], error: '今天检查的次数用完了' }) }))
      expect(await checkWriting(h, text, ['E1'], 'stu-x')).toBeNull()
    })

    it('可能写错的地方：引用不在学生原话里的去掉；服务器没给就是 null（没查成）', async () => {
      const ok = { quote: 'toying with a ban', type: '冠词', hint: '你看看这里说的是哪一个。' }
      reply([{ id: 'E1', verdict: 'correct', reason: '对。' }], [ok, { quote: 'toyed with', type: '时态', hint: '' }])
      expect((await checkWriting(h, text, ['E1'], 'stu-x'))?.grammar).toEqual([ok])
      reply([{ id: 'E1', verdict: 'correct', reason: '对。' }], [])
      expect((await checkWriting(h, text, ['E1'], 'stu-x'))?.grammar).toEqual([])
    })

    it('改写后的句子照样换成通用说法；回落或请求失败返回 null', async () => {
      reply([{ id: 'E1', verdict: 'incorrect', reason: '可以改成 schools are toying with the idea of a ban。' }])
      expect((await checkWriting(h, text, ['E1'], 'stu-x'))?.results[0].reason).toBe('对照原文例句再想想。')
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ fallback: true, results: [] }) }))
      expect(await checkWriting(h, text, ['E1'], 'stu-x')).toBeNull()
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')))
      expect(await checkWriting(h, text, ['E1'], 'stu-x')).toBeNull()
    })
  })
})

describe('学生端文案不出现语法术语', () => {
  const root = fileURLToPath(new URL('../src', import.meta.url))
  const files = (dir: string): string[] =>
    readdirSync(dir).flatMap((f) => {
      const p = join(dir, f)
      return statSync(p).isDirectory() ? files(p) : [p]
    })
  // 教师端（Teacher.tsx）可以显示结构名称；其余页面和组件都是学生或评委看的（writing.ts 里有给学生的兜底理由）
  const studentFiles = [...files(join(root, 'pages/student')), ...files(join(root, 'components')), join(root, 'pages/Judge.tsx'), join(root, 'pages/Home.tsx'), join(root, 'data/presets.ts'), join(root, 'lib/writing.ts')]

  // 写作页的 AI 检查（#19）那一栏也叫「可能写错的地方」，不再单独放行
  it.each(studentFiles.map((f) => [f.slice(root.length + 1), f]))('%s', (_name, f) => {
    const text = readFileSync(f, 'utf8')
    expect(GRAMMAR_TERMS.filter((t) => text.includes(t))).toEqual([])
  })
})

// 没有 DOM 测试环境，上传页、老师端、登录页的几处说明和条件直接查源码
describe('上传页、老师端、登录页：老师账号', () => {
  const read = (f: string) => readFileSync(fileURLToPath(new URL(`../src/${f}`, import.meta.url)), 'utf8')
  const upload = read('pages/Upload.tsx')
  const teacher = read('pages/Teacher.tsx')
  const login = read('pages/Login.tsx')

  it('旧的编辑口令、邀请码输入框、本机上传记录都去掉了，文案里没有「口令」「设备」这类旧说法', () => {
    for (const f of [upload, teacher, login, read('data/index.ts'), read('lib/store.ts'), read('lib/auth.ts'), read('components/Account.tsx')]) {
      expect(f).not.toMatch(/editKey|X-Edit-Key|zhishi:uploads|zhishi:invite|口令/)
    }
    for (const f of [upload, login, read('components/Account.tsx')]) expect(f).not.toContain('设备')
    expect(teacher).not.toContain('那台设备')
    expect(upload).not.toMatch(/invite|deviceId/) // 上传不再带邀请码和设备 id
  })

  it('路由：#/login 是登录页', () => {
    expect(read('App.tsx')).toContain("path === '/login' ? <LoginPage />")
  })

  it('顶栏的账号只放在老师侧页面（上传、老师端、登录），学生端和首页不放', () => {
    for (const f of [upload, teacher, login]) expect(f).toContain('<Account />')
    for (const f of ['pages/Home.tsx', 'pages/student/Student.tsx', 'pages/Judge.tsx', 'pages/NextPreview.tsx']) expect(read(f)).not.toContain('Account')
    const account = read('components/Account.tsx')
    expect(account).toContain('老师登录')
    expect(account).toContain('退出')
    expect(account).toContain("go('#/login')") // 退出后回到登录页
    expect(account).toContain('loginHref(window.location.hash') // 登录后回到这一页
  })

  it('上传页有没保存的讲解、题目改动时，点顶栏「退出」和点站内链接一样先问，取消就不退出', () => {
    const account = read('components/Account.tsx')
    expect(account).toContain('data-leave')
    expect(account).toContain('if (!e.defaultPrevented) void out()') // 问的人在捕获阶段 preventDefault
    expect(upload.split(`closest?.('a[href^="#"], [data-leave]')`)).toHaveLength(3) // 讲解、题目和梯子两个编辑区都拦
    expect(upload).not.toContain(`closest?.('a[href^="#"]')`)
  })

  it('上传页：没登录不显示表单，只给登录入口；登录了从服务器拉「我上传过的讲义」', () => {
    expect(upload).toContain('上传、写讲解、发布都要先登录')
    expect(upload).toContain('还没有账号？向知适团队要邀请码注册')
    expect(upload).toContain("loginHref('#/upload')")
    expect(upload).toContain('if (teacher) return <Uploader key={teacher.id} />') // 表单只在登录后出现
    expect(upload).toContain("'/api/my/handouts'")
    expect(upload).toContain('我上传过的讲义')
  })

  it('上传页：没发布的讲义，说明发布前只有自己（登录后）能打开，链接叫「预览学生端」', () => {
    expect(upload).toContain('发布前只有你（登录后）能打开，学生要等你点「发布」后才能用')
    expect(upload).toContain("{x.published ? '学生端' : '预览学生端'}")
    expect(upload).not.toContain('需要的话请重新上传一次') // 没有「早期没有口令」的记录了
  })

  it('上传页：后端回 401（或没登录时 GET 回 404）时提示登录已过期，带登录链接（新标签页打开，没保存的不丢）', () => {
    expect(upload).toContain("const EXPIRED = '登录已过期，请重新登录'")
    // 查进度、读没发布的讲义、查起草结果没登录时后端回 404：问一次 me，确实没登录也按过期提示，不让老师以为任务丢了去重新提交
    expect(upload).toContain('if (res.status === 401 || (res.status === 404 && !init && (await loggedOut()))) throw new Error(EXPIRED)')
    expect(upload).toContain("d?.teacher === null, () => false")
    expect(upload).toContain("res.status === 401 ? EXPIRED") // 改题目和梯子自己发的请求也算
    expect(upload).toMatch(/href=\{`\$\{window\.location\.origin\}\/\$\{loginHref\('#\/upload'\)\}`\} target="_blank"/)
  })

  it('上传页：查进度时登录过期不停下（按钮还是「正在生成……」，不会重新提交），放慢再查，重新登录后接上、去掉过期提示', () => {
    expect(upload).toMatch(/if \(msg === EXPIRED\) \{\s+setError\(EXPIRED\)\s+wait = 5000\s+\} else if \(msg !== OFFLINE\) \{\s+\/\/[^\n]*\s+setJobId\(null\)/)
    expect(upload).toContain("setError((e) => (e === EXPIRED ? '' : e))")
    expect(upload).toContain("{jobId ? '正在生成……' : '开始生成'}")
  })

  it('老师端：401 / 403 / 404 各说各的，都不放示例班级、停止自动拉；轮询途中碰到也切过去', () => {
    expect(teacher).toContain('登录后才能看这篇文章的全班情况')
    expect(teacher).toContain('loginHref(`#/teacher?h=${encodeURIComponent(h.id)}`)')
    expect(teacher).toContain('这篇文章不是你上传的，只有上传它的老师能看全班情况')
    expect(teacher).toContain("'没有这份讲义。'")
    expect(teacher).toContain('res.status === 401 || res.status === 403 || res.status === 404')
    expect(teacher).toContain("dataRef.current?.mode === 'denied'") // 看不了就不再自动拉
    expect(teacher).toMatch(/if \(!alive \|\| !prev\) return\s+if \(next\.mode === 'denied'\) \{/) // 先切到「看不了」，再看这次有没有拉到
    expect(teacher).toContain("data.mode === 'snapshot' && (data.liveCount > 0 || uploaded())")
    expect(teacher).toContain('回到实时（还没有学生）')
  })

  it('老师端：看不了（401 / 403）时刷新登录状态，顶栏的账号不和正文对不上', () => {
    expect(teacher).toContain("import { getMe, loginHref } from '../lib/auth'")
    expect(teacher).toContain('if (denied === 401 || denied === 403) void getMe(true)')
  })

  it('登录页：两种模式、隐私说明、忘了密码找团队；成功后只去站内地址', () => {
    expect(login).toContain("m === 'login' ? '登录' : '用邀请码注册'")
    expect(login).toContain('只保存用户名、称呼和加密后的密码，不收手机号和邮箱')
    expect(login).toContain('忘了密码：请联系知适团队重置')
    expect(login).toContain("go(safeNext(getParams().get('next')))")
    expect(login).toContain('已登录为')
    expect(login).toContain('void getMe(true)') // 打开登录页时不信缓存：会话可能已经过期
    expect(login).toContain('两次输入的密码不一样')
    for (const k of ['username', 'password', 'name', 'password2']) expect(login).toContain(`error={fields.${k}}`) // 后端按输入框给的错误标在框下面
  })
})

describe('事件队列：先进队列，失败重试，不报错', () => {
  const e = (n: number): LearningEvent => ({ sid: 's', ts: n, handoutId: h.id, type: 'tap_word', lemma: 'fret' })
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('网络失败留在队列，退避后重试成功', async () => {
    vi.useFakeTimers()
    const fetchMock = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue({ ok: true, status: 200 })
    vi.stubGlobal('fetch', fetchMock)
    await sendEvent(e(1))
    expect(pendingCount()).toBe(1)
    await vi.advanceTimersByTimeAsync(2000)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual([e(1)])
    expect(pendingCount()).toBe(0)
  })

  it('服务器 500 重试；400（数据本身有问题）丢掉', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce({ ok: false, status: 500 }).mockResolvedValueOnce({ ok: false, status: 400 })
    vi.stubGlobal('fetch', fetchMock)
    await sendEvent(e(2))
    expect(pendingCount()).toBe(1)
    await flush()
    expect(pendingCount()).toBe(0)
  })

  it('还没更新的后端拒收诊断事件（400）：只丢诊断事件，同批的学习事件重发', async () => {
    const view: LearningEvent = { sid: 's', ts: 3, handoutId: h.id, type: 'page_view', value: '粗读' }
    const fetchMock = vi.fn().mockResolvedValueOnce({ ok: false, status: 500 }).mockResolvedValueOnce({ ok: false, status: 400 }).mockResolvedValue({ ok: true, status: 200 })
    vi.stubGlobal('fetch', fetchMock)
    await sendEvent(view) // 第一次 500，留在队列
    await sendEvent(e(4)) // 和学习事件攒成一批
    await flush()
    const bodies = fetchMock.mock.calls.map((c) => JSON.parse(c[1].body))
    expect(bodies[1]).toEqual([view, e(4)]) // 这一批被拒收
    expect(bodies[2]).toEqual([e(4)]) // 只重发学习事件
    expect(pendingCount()).toBe(0)
  })
})
