# 部署说明

结构：Nginx 托管前端静态文件（`dist/`），`/api` 反代到本机 Node 后端 `server/index.mjs`（只监听 `127.0.0.1:8787`）。笔记本本地再跑一份兜底。

## 后端接口

| 接口 | 说明 |
|---|---|
| `POST /api/events` | 单个事件或数组（≤200 条），整批校验通过才写，追加到 `DATA_DIR/events-<handoutId>.jsonl`，返回 `{ok, accepted}`，`accepted` 是实际写进去的条数。逐条决定留不留：页面报错 `client_error` 照留（任何讲义）；学生账号（内测）的事件见下一句；别的类型只留「选了学号」的学生的，即这条事件的 `sid` 现在绑定在某个班的某个学号上，这个班在讲义的 `meta.classes` 里、讲义已发布、班级和讲义是同一位老师的；内置讲义（不是 `up-` 开头）的一律不留。没选学号的（「只是看看」、老师预览、演示画像、旧页面和浏览器里积压的匿名事件、伪造的）不报错、不写，照样 `200`（前端看到 200 就把这批从队列删掉，不会反复重发）。同一个事件文件的追加和改写（删学号的记录、到期清理）排同一条队，改写期间新到的行不会丢。写盘前按字段白名单重建每条事件：只留 `sid, ts, handoutId, type, sentenceId, paragraph, lemma, level, correct, firstTry, value`，类型不对的可选字段丢掉（`paragraph`、`level` 要整数，`correct`、`firstTry` 要布尔，`sentenceId`、`lemma` 截到 64 个字符）；写作原文和反馈理由不进服务器：`writing_submit` 不留 `value`，`feedback` 的 `value` 只留「｜」前面的评分（太简单 / 刚好 / 太难，别的去掉），其他类型的 `value` 截到 200 个字符；`client_error` 的 `ts` 比服务器收到的时间晚时改成收到的时间（到期清理按 `ts` 算）。**学生账号的事件**（`sid` 是 `students.json` 里某个账号的，`client_error` 除外，它照上面写进 `events-<handoutId>.jsonl`）：只收这个账号自己登录时发的（看学生 cookie，不信请求体里的 `sid`），按同一个白名单重建后追加到 `DATA_DIR/students/<sid>.jsonl`，不进 `events-<handoutId>.jsonl`；请求没带有效的学生 cookie 时 `401 {ok:false, error:'请先登录'}`，整批（连同里面学号的事件）都不写，前端留着这批，登录后再发；登录的是另一个账号、这批里没有一条是它自己的，也 `401`（前端一批只发一个 `sid`，共用电脑换了账号时上一个账号没发出去的作答留着，等它登录再发），和自己的混在一批里的别的账号的 `sid` 直接丢掉；内置讲义（示例文章）的只存本机，也丢掉。**只给学生账号的四类事件**：`collect_expression`、`drop_expression`（收进、移出表达本，`handoutId` 是这一篇，`value` 是表达 id）和 `review_word`、`drop_word`（单词本里复习一张卡、移出单词本，带 `lemma`，复习带 `correct`）只在账号这条路收；后两类的 `handoutId` 必须是保留值 `notebook`，别的类型用 `notebook` 一律丢掉；学号那条路、匿名的这四类都不报错、不写（班级学生的数据按家长同意书收）。每个账号每天（北京时间）最多 3000 条，超了整批 `429`（前端过一会儿重发）；单个文件最多 5 MB，超了整批 `413`（前端丢掉这批）；条数只记在内存，重启清零 |
| `GET /api/events?handoutId=&classId=&since=` | 按班返回 `ts > since` 的事件数组，教师页自己聚合：只含这个班已选学号的学生（`sid`）的事件，匿名做的（「只是看看」、扫码前的）不算。只给上传这篇文章的老师看（登录的会话 cookie）。`handoutId` 格式不对 `400`；内置演示讲义（不是 `up-` 开头）`403 {ok:false, error:'内置演示讲义不开放学习记录'}`；没登录 `401 {ok:false, error:'请先登录'}`；讲义不存在 `404 {ok:false, error:'没有这份讲义'}`；不是自己上传的（包括没有 owner 的旧讲义）`403 {ok:false, error:'只有上传这篇文章的老师能看全班的学习记录'}`；`classId` 没带、不是这份讲义发布到的班、不是自己的班 `400 {ok:false, error:'请选一个班'}` |
| `POST /api/writing-check` | `{handoutId, sid, text(≤1200), expressions:[{id,text,zh,example}]}` → `{results:[{id,used,verdict,reason}], grammar, model, fallback:false}`，`grammar` 是最多 3 处可能的语法问题 `[{quote,type,hint}]`（`quote` 必是学生原话的片段；没问题是 `[]`，模型没给或一条都不合格是 `null`）；8 秒超时或任何错误返回 `{fallback:true, results:[]}`，前端回落到规则检查。不落盘，日志不记内容。只有选了学号、学号开着 AI 的学生能用（写作原文要发给模型）：`sid` 要现在绑定在这份讲义发布到的班的学号上（同上面 `/api/events` 的条件），不满足（没带 `sid`、没选学号、内置讲义）`403 {fallback:true, results:[], error:'没有选学号时不用 AI 检查'}`；老师关了这个学号的 AI `403 {fallback:true, results:[], error:'老师关闭了这个学号的 AI 检查'}`；都不调用模型、不算次数，前端回落到规则检查。`sid` 不是学号的，再看学生账号：服务器开放了（`STUDENT_AI=1`）、学生 cookie 有效、账号开着 AI（注册时默认开着，学生可以在账号页关掉）三样都满足才调用模型，否则 `403 {fallback:true, results:[], error}`：没开放「AI 写作检查还没开放」，账号没打开「你在账号页关掉了 AI 写作检查」，没登录时 `sid` 是账号的（`u-` 开头）「登录以后才能用 AI 检查」、别的照旧「没有选学号时不用 AI 检查」；带着学生 cookie、`sid` 是学号的照旧按学号的规则。限次（模型费用封顶）：同一个 `sid`（学生账号按账号算）每小时 20 次、全站每天（北京时间）1500 次，只有真要调用模型时才算；超了 `429 {fallback:true, results:[], error}`，不调用模型，前端照样回落到规则检查。全站花费到了上限（见下文「用量日志和花费上限」）也是 `429 {fallback:true, results:[], error:'今天的 AI 写作检查名额已经用完了，先看规则检查的反馈吧'}`（本月的上限是「这个月的……」），不算次数。被百炼的内容安全拦截（上游 `400`，错误码 `data_inspection_failed`）时照样回落，多一句提示 `{fallback:true, results:[], error:'这几句里有不适合在这里写的内容，换个说法再试吧', reason:'unsafe'}`，日志 `llm fallback … unsafe`（写作页现在还不显示服务器给的这句） |
| `GET /api/health` | `{ok, llm, model}`，`llm` 表示有没有读到 Key |
| `POST /api/auth/register` | 老师用邀请码注册 `{invite, username, password, name?}` → `201 {teacher:{id, username, name}}`，同时登录（`Set-Cookie`，见下文「老师账号」）。依次检查：登录 + 注册全站每分钟超过 60 次 `429 {error:'现在登录的人太多了，请稍后再试'}`；没配置邀请码 `403 {error:'注册目前只对受邀老师开放'}`；邀请码没带或不对 `403 {error:'邀请码不对，请向知适团队确认'}`；这个码已经注册过账号 `409 {error:'这个邀请码已经注册过账号了'}`；字段不合格 `400 {error, fields:{username?, password?, name?}}`；用户名已经有人用了（不分大小写）`409 {error:'这个用户名已经有人用了', fields:{username}}`。先查邀请码，没有邀请码的人试不出哪些用户名被占了。用户名去首尾空白后转小写，3–32 个字符，只能是 `a-z 0-9 _ . -`，以字母或数字开头；密码 8–128 个字符，不能和用户名一样；称呼可选（如「王老师」），最多 20 个字、不能有控制字符，空就用用户名。不收手机号、邮箱 |
| `POST /api/auth/login` | `{username, password}` → `200 {teacher}`，`Set-Cookie`。用户名不存在、密码不对一律 `401 {error:'用户名或密码不对'}`（用户名不存在时也跑一遍 scrypt，耗时一样）；同一用户名 15 分钟内失败 10 次 `429 {error:'试错太多次了，请 15 分钟后再试'}`（成功登录清零，只记在内存）；全站限次同上 |
| `POST /api/auth/logout` | → `{ok:true}`：删掉服务器上的会话，清 cookie（`Max-Age=0`）；没登录也 200 |
| `GET /api/auth/me` | `{teacher:{id, username, name}}`；没登录、会话过期、会话早于重置密码、账号已不在都是 `{teacher:null}` |
| `GET /api/my/handouts` | 我上传过的讲义 `{handouts:[{id, title, createdAt, published, classes}]}`（`classes` 是发布到的班级 id，已经删掉的班不列），只列自己的，新的在前；没登录 `401 {error:'请先登录'}` |
| `POST /api/student/register` | 内测学生用邀请码注册 `{invite, username, password, birth:'YYYY-MM', agree:true}` → `200 {student:{username, sid, ai, aiAvailable, adapt}, recoveryCode}`，同时登录（`Set-Cookie: zhishi_student=…`，属性同老师的会话 cookie，见下文「学生账号（内测）」）。依次检查：全站登录 + 注册每分钟限次（和老师的一起算）`429`；邀请码没带、不对、作废 `403 {error:'邀请码不对，请向知适团队确认'}`（老师的码不认）；码用过（包括年龄不够作废的）`409 {error:'这个邀请码已经用过了'}`；字段不合格 `400 {error, fields:{username?, password?, birth?}}`（用户名、密码规则同老师，另外不能有 11 位以上连着的数字，像手机号的拒收；`birth` 不是合理的年月）；没勾隐私说明 `400 {error:'请先读隐私说明并勾选'}`；用户名已经有人用了（只和学生账号比）`409`；不满 12 周岁 `400 {error:'知适内测暂时只对年满 12 周岁的同学开放'}`，不建账号，这个码作废。正好满 12 周岁的那个月按还没满算。出生年月只用来判断，不存；没勾、字段不对的码不作废。`sid` 是 `u-` 加 16 位十六进制；8 位找回码只在这次响应里出现，只存 sha256 |
| `POST /api/student/login` | `{username, password}` → `200 {student}`，`Set-Cookie`。用户名不存在、密码不对一律 `401 {error:'用户名或密码不对'}`；同一用户名 15 分钟内失败 10 次 `429`（和老师的分开记）；老师账号登不进来 |
| `POST /api/student/logout` | → `{ok:true}`：删掉服务器上的会话，清 cookie；没登录也 200 |
| `GET /api/student/me` | `{student:{username, sid, ai, aiAvailable, adapt}}` 或 `{student:null}`（老师的 cookie 也是 null）。`ai` 是学生自己开没开 AI 写作检查，`aiAvailable` 是服务器开没开放（`STUDENT_AI`），`adapt` 是「按我以前的记录调整提示」开关（默认开，只有学生关掉时账号上才记 `false`）。登录和这里记 `lastSeenAt`，同一天只写一次。`Cache-Control: no-store` |
| `PUT /api/student/settings` | `{ai}`、`{adapt}` 或两项一起（都是布尔）→ `{student}`。没登录 401；两项都没有、不是布尔 400，什么都不改；服务器没开放时 `ai` 只能关，开 `403 {error:'AI 写作检查还没开放'}`，整个请求都不改 |
| `GET /api/student/profile` | 问卷答案和读文章时交给引擎的画像 `{profile:{goal?, grade?, curriculum?}, adapt, practicing}`：`profile` 只有答了的几项（`goal` 是 `gaokao`/`abroad`/`interest`）；`practicing` 是单词本里的词的原形（同 `GET /api/student/notebook` 的推算，不另存），开关关着时是空的、不推算，推算出错也当空的。没登录、老师的 cookie 401；`Cache-Control: no-store` |
| `PUT /api/student/profile` | 整份换掉问卷答案 `{goal?, grade?, curriculum?}` → `{profile}`：没给的项或 `null` 算没答，一项都没答就去掉 `profile`；多一项、取值不对 `400`，什么都不改。存在 `students.json` 的账号记录里，注销时一起删。没登录 401 |
| `POST /api/student/reset` | 用找回码改密码 `{username, code, newPassword}` → `{recoveryCode}`（新的找回码，旧的作废；这个账号所有已登录的设备都要重新登录，这次也不登录）。新密码不合格 `400 {error, fields:{newPassword}}`；用户名不存在、码不对一律 `403 {error:'用户名或找回码不对'}`；同一用户名 15 分钟内错 5 次 `429`，码对了的同一用户名每小时最多 10 次；全站限次同注册。码不分大小写，空格和「-」去掉再比 |
| `POST /api/student/delete` | 注销 `{password}` → `200 {ok:true}`，清 cookie。先往删除台账（`DELETIONS_DIR`，在 `DATA_DIR` 外面）记一行 `{sidHash, date}`（`sid` 的 sha256、北京时间的日期），记不成 `500 {error:'注销没成功，请稍后再试'}`、什么都不删；再按顺序：`students.json` 里删掉账号、同一次写盘把 `sid` 记进它的待删列表 `purge`（`usedInvites` 不动，码不能再注册；用户名放出来，可以被重新注册）→ 删掉这个账号的全部会话 → 删 `students/<sid>.jsonl`（排在正在进行的追加写后面，追加写排到时账号已经不在就不写、回 `401`）→ 删所有 `events-*.jsonl` 里这个 `sid` 的行（页面报错）→ 都成功才从 `purge` 去掉。有删不成的照样 `200`，多一个 `incomplete: true`，留给到期清理补删。没登录、老师的 cookie `401 {error:'请先登录'}`；密码不对 `401 {error:'密码不对'}`、什么都不删，失败次数和登录记在一起（同一用户名 15 分钟内 10 次 `429`）；全站限次同注册。日志 `student deleted self`（没删完时加 `incomplete <错误类型>`）和 `events deleted N student`，不记用户名和 `sid` |
| `GET /api/student/events?h=` | 本账号在这一篇的学习事件 `{events}`，按 `ts` 排（换设备时重建作答）。没登录 401；`h` 格式不对 400 |
| `GET /api/student/shelf` | 团队上架的文章 `{handouts:[{id, title}]}`，按 `shelf.json` 的顺序（新上架的在前）；讲义不在了的不列。没登录 401 |
| `GET /api/student/notebook` | 单词本和表达本 `{words:[{lemma, pos?, zh, ai, sources:[{handoutId, title}], example?:{handoutId, sentenceId, text}, addedTs, lastReview?:{ts, correct}, syllabusNew}], expressions:[{id, handoutId, title, text, zh, ai, example?, pattern?, ts}]}`，都是最近的在前。从 `students/<sid>.jsonl` 推算，不另存：每一篇先重放、按小结的算法取生词，按原形合并成一条（`sources` 几处出处，先遇到的在前；意思和例句取最近一次进来的那一篇）；移出单词本（`drop_word`）以后在哪一篇里又点了、标了不认识或猜错，才重新进来。`ai` 是这条中文是不是 AI 生成的（按讲义的来源判断，同学生端的「AI 生成」标签）；`syllabusNew` 是不是「高中新词」（课标必修、选择性必修的词，只给布尔，不给档位）。没有「掌握」、等级、合计数这类字段。只用这个账号现在能读的讲义（上架的、发布了的、学生上传的在本人「我的文章」里的，同 `GET /api/handouts/:id`）；讲义文件没了、解析不过的跳过。结果缓存在内存里（事件文件、用到的讲义文件改了就重算）。没登录、老师的 cookie `401 {error:'请先登录'}`；只看得到自己的；`Cache-Control: no-store`。推算代码是 `npm run build` 打出来的 `dist-server/notebook.mjs`，第一次请求时加载 |
| `GET /api/student/records` | 学习记录 `{records:[{handoutId, title, lastTs, rating?, status:'todo'\|'done', firstPending?}]}`，最近读的在前：只列动过手的篇（判断同小结页「这一篇你还没开始读」），`lastTs` 是最近一次学习动作的时间（打开文章、页面报错不算），`rating` 是小结页最近一次选的难度，`status` 是还有没有没答的句子，`firstPending` 是第一句没答的句子 id。不带任何计数。和单词本同一份推算、同一份缓存，只用能读的讲义（同上）。没登录、老师的 cookie `401 {error:'请先登录'}`；`Cache-Control: no-store` |
| `GET /api/student/export` | 「下载我的数据」：附件 JSON `{note, aiFields, username, createdAt, settings:{ai, adapt}, profile, adaptNote, articles, records, words, expressions, events}`：开头一句说明和哪些字段是 AI 生成的；`profile` 是问卷答案，`adaptNote` 说明调整提示用了哪些数据；`articles` 是「我的文章」（同下面 `GET /api/student/library` 的 `handouts`：讲义 id、标题、加入时间）；`records`、`words`、`expressions` 和学习记录、单词本、表达本是同一份推算；`events` 是这个账号的全部原始学习事件；没有任何哈希、会话、账号 id，没有上传人。没登录 401；每个账号每小时 5 次，超了 `429` |
| `GET /api/student/library` | 「我的文章」：学生自己贴过的（自己生成的，和贴了同一篇、直接复用的）`{handouts:[{id, title, addedAt}]}`，新加的在前；标题只在本人的列表里，只有本人看得到；讲义不在了的不列。没登录、老师的 cookie `401 {error:'请先登录'}`；`Cache-Control: no-store` |
| `GET /api/upload-status` | 学生上传的开关和次数 `{enabled, open, weekUsed, weekLimit, resetsAt, paused?:{resumesAt}}`：`enabled` 是 `STUDENT_UPLOAD` 开了没有；`open` 是开了、有 Key、全站花费没到上限、这周还有次数（这时才能生成新的）；`weekUsed` 这周生成成功了几篇，`weekLimit` 是 `STUDENT_UPLOADS_PER_WEEK`；`resetsAt` 是下周一北京时间 0 点（ISO 时间）；全站花费到了上限时多一个 `paused`（恢复的时间，ISO）。不返回钱数。没登录、老师的 cookie 401；`Cache-Control: no-store` |
| `GET /api/classes` | 我的班级 `{classes:[{id, name, createdAt, seats, joined}]}`（`seats` 名单人数，`joined` 已选学号人数），新建的在前；没登录 `401 {error:'请先登录'}`。下面的班级接口都要登录：没登录 401，班级不存在 `404 {error:'没有这个班'}`，不是自己建的 `403 {error:'这个班不是你建的'}` |
| `POST /api/classes` | 建班 `{name, roster:[{n, name}], confirm:{school:true, consent:true}}` → `201 {class}`（详情同下）。班级名去首尾空白 1–20 个字；名单 1–80 人，学号 `n` 是 1–99 的整数、班内不重复，姓名去首尾空白 0–20 个字（可以不填），都不能有控制字符；不合格 `400 {error, fields:{name?, roster?}}`（`roster` 的提示说是哪个学号）。每位老师最多 20 个班，超了 `400 {error:'每位老师最多建 20 个班'}`。`confirm` 是班级页上老师勾的两项确认（「学校已同意在这个班使用知适」「已收回家长告知同意书，名单里只录入了第 1 项选了同意的同学」），两项都要是 `true`，否则 `400 {error:'请先勾选两项确认'}`（字段不对时先报字段）；通过后在班级上记 `confirmedAt`（毫秒） |
| `GET /api/classes/:id` | 班级详情 `{class:{id, name, createdAt, confirmedAt, seats:[{n, name, joined, joinedAt?, sid?, ai}]}}`，按学号排；`confirmedAt` 是最近一次建班、换名单时勾两项确认的时间（毫秒），这项功能之前建的班是 `null`；`joinedAt` 是选学号的时间（毫秒），`sid` 只给老师，用来把事件对上学号；`ai` 是这个学号开着 AI 写作检查没有。配了 `NAME_KEY` 时姓名在 `classes.json` 里是密文，这里（和建班、改班的响应里）解密；解不开的学号（密钥不对、数据坏了）`name` 是空字符串，`class` 上多一个 `nameError: true`，照常 `200`（见下文「服务器运维」）。`Cache-Control: no-store` |
| `POST /api/classes/:id` | 改班名、换名单 `{name?, roster?, confirm?}` → `{class, deletedEvents}`。带 `roster` 时要带两项确认 `confirm`（同建班，不对 `400 {error:'请先勾选两项确认'}`，不改），每次换名单更新 `confirmedAt`；只改班名不用。名单整体替换：留下的学号绑定不变（姓名可以改，关没关 AI 照旧），新学号开着 AI；删掉的学号连绑定一起删，已进班的连同它在所有讲义里的学习记录一起删（同清空学号），`deletedEvents` 是删掉的事件条数（只改班名是 0），没删完时多一个 `incomplete: true`（同清空学号）；两样都没给 `400 {error:'没有要保存的改动'}`，字段不对同建班 |
| `POST /api/classes/:id/delete` | `{}` → `{ok:true, deletedEvents}`：删除班级，名单、学号绑定和这些学号在所有讲义里的学习记录一起删（同清空学号，没删完时多一个 `incomplete: true`）；发布到这个班的讲义里留下的班级 id 以后一律忽略 |
| `POST /api/classes/:id/seats/:n/reset-code` | `{}` → `{recoveryCode}`（只这一次）：给这个学号换一个找回码，旧码作废，已经进来的设备照常能用，这个学号的试错次数清零，15 分钟内这个学号也不受「整个班 30 次」那层限次（照旧按学号限 5 次）。学号不在名单 `400 {error:'没有这个学号'}`；还没人选 `400 {error:'这个学号还没有学生进来'}` |
| `POST /api/classes/:id/seats/:n/clear` | `{}` → `{ok:true, deletedEvents}`：清空这个学号的绑定，学生要重新选；这个学号原来的 `sid` 在所有讲义里的学习记录一起删：`DATA_DIR` 里所有 `events-` 开头、`.jsonl` 结尾的文件（各讲义的事件文件，以及 `archive-events.sh`、`archive-sessions.sh` 留下的存档和备份），按 `sid` 精确匹配，解析不了的行原样保留，删空的文件删掉；`deletedEvents` 是删掉的条数（还没人选也 200，`deletedEvents:0`），日志只记条数。有的文件这次改不了（磁盘满、读不了）时接着删别的，绑定照样删，响应多一个 `incomplete: true`（班级页提示「还有一部分这次没删成功，服务器会自动再删」），日志 `events deleted N clear incomplete <错误类型>`；没删完的 `sid` 记在 `classes.json` 的待删列表 `purge` 里（和删绑定同一次写盘），每次到期清理都按它再删一遍，全删完才去掉。关没关 AI 记在名单上，清空不变。学号不在名单 `400 {error:'没有这个学号'}` |
| `POST /api/classes/:id/seats/:n/ai` | `{enabled: true/false}` → `{ok:true, n, ai}`：开关这个学号的 AI 写作检查（家长回执第 2 项选了不同意的学号关掉）。记在名单的学号上（`classes.json` 里 `noAi: true`），还没进班也能先关，清空学号、重新进班不变。学号不在名单 `400 {error:'没有这个学号'}`；`enabled` 不是布尔 `400 {error:'AI 开关的格式不对，请刷新页面后再试'}` |
| `GET /api/join/:classId?h=` | 学生扫码进班（不登录）：`{className, seats:[{n, taken}]}`，`taken` 是已经有人选了；没有姓名、`sid`。下面四个学生接口都先查「有效的班级 + 讲义」：班级存在，讲义 `h` 已发布、发布到了这个班，班级和讲义是同一位老师的，否则一律 `404 {error:'找不到这个班，请重新扫老师发的二维码'}` |
| `POST /api/join/:classId` | 选学号 `{h, seat, confirm:true}` → `201 {seat, sid, token, recoveryCode, ai}`：`confirm` 是学生在选学号页勾的「我已读过上面的说明……」，不是 `true` 时 `400 {error:'请先读完说明并勾选'}`（查完班级和讲义之后、学号之前，不算下面的限次），绑定里记勾选的时间 `confirmedAt`（毫秒）；`sid` 是 `s-` 加 16 位随机十六进制，学生之后照旧用它发事件；`ai` 是这个学号现在开着 AI 写作检查没有（找回、`my-progress` 也带）；`token`（学生设备，64 位十六进制）和 6 位找回码只在这次响应里出现，服务器只存 sha256。学号不在名单 `400 {error:'没有这个学号'}`；已经有人选了 `409 {error:'这个学号已经有人选了。如果是你换了手机，点「用找回码找回」', taken:true}`（同时选同一个学号只有一个成功）；同一个班每小时超过 120 次选学号请求 `429 {error:'现在选学号的人太多了，请稍后再试'}` |
| `POST /api/join/:classId/recover` | 换了手机用找回码找回 `{h, seat, code}`（不用带 `confirm`）→ `{seat, sid, token, ai}`：`sid` 不变，给这台设备一个新 `token`（每个学号只留最新 5 个）。找回码不分大小写，空格和「-」去掉再比。学号不在名单 400；还没人选 `400 {error:'这个学号还没有人选，直接选学号就行'}`；码不对 `403 {error:'找回码不对。找不到找回码的话，请老师在老师端给你重置'}`；同一个学号 15 分钟内失败 5 次、同一个班 15 分钟内失败 30 次 `429 {error:'试错太多次了，请 15 分钟后再试，或者请老师给你重置找回码'}`（和登录一样先记失败再比对，并发请求绕不过去；老师重置找回码后这个学号清零）；码对了的找回同一个学号每小时最多 10 次，超了 `429 {error:'找回太频繁了，请过一会儿再试'}`（每次都要重写 `classes.json`） |
| `GET /api/my-progress?h=&c=` | 请求头 `X-Student-Token` → `{events, ai}`：这个学号的 `sid` 在这份讲义里的全部事件（找回后重建学习进度），`ai` 是这个学号现在开着 AI 写作检查没有。token 不属于这个班的任何学号 `401 {error:'找不到你的学号记录，请重新扫码'}`；`Cache-Control: no-store` |
| `POST /api/uploads` | 上传文章 `{title, text, mustWords?, checkIns?, focus?}` → `202 {jobId}`；要登录，讲义的 meta 记上 `owner`（老师 id），之后查进度、预览、发布、写讲解、改题目、看全班记录都只有这位老师能做（见下）。依次检查：没有 Key 503；没登录 `401 {error:'请先登录'}`；输入不合格 400；已有任务在跑、同一位老师一小时超过 5 篇、全站当天超过 60 篇 429；全站花费到了上限 `429 {error, resumesAt}`（`resumesAt` 是恢复的时间，毫秒：当天的上限是明天北京时间 0 点，本月的是下个月 1 日 0 点；见下文「用量日志和花费上限」），正在生成的那篇照样跑完；只是加上正在跑的学生生成、AI 起草讲解的估计额才超的 `429 {error}`（「现在有别的文章正在生成，请几分钟后再试」，不带 `resumesAt`）。接口约定见 `docs/上传设计.md`。**学生上传**走自己的 `POST /api/student/uploads`（见下一行），这一条只认老师会话 |
| `POST /api/student/uploads` | 学生贴文章：只认学生会话（没有学生会话、只带老师 cookie 的都是 `401`；同一个浏览器里两种会话都在也不会走错），body `{text, confirm:true, similar?:'use'\|'ignore'}`，标题、必练词这些一律不收、不交给管线（标题由 AI 起）。依次：`STUDENT_UPLOAD` 没开 `403`；没勾三项提醒 `400`；长度不是 200–8000 字符 `400 {error, reason:'length'}`；这一篇（精确键）被内容安全拦截过 `400 {error, reason:'unsafe'}`；精确键命中已有的学生讲义 `200 {handoutId, reused:true}`（加进本人的「我的文章」，不占次数，全站花费到上限也照样复用）；同一篇正在生成 `202 {jobId, joined:true}`（加进这个任务，做好了一起进列表）；只有近似键命中时，没带 `similar` 回 `200 {similar:{handoutId, title}}`，`similar:'use'` 按复用处理那一份，`'ignore'` 往下走；这周用完 `429 {error, kind:'week', resetsAt}`、本人已经有一篇在生成 `429 {error, kind:'busy'}`、今天失败到了上限 `429 {error, kind:'fails'}`、全站花费到了上限 `429 {error, kind:'spend', resumesAt}`（这两个时间是 ISO）；只是加上正在跑的生成、AI 起草讲解还没记账的估计额才超的 `429 {error, kind:'crowded'}`（过几分钟再试，不给恢复时间）；内容检查不过 `400 {error, reason}`（`reason` 是 `not_english`、`exam`、`personal_info`、`repeated`，篇幅和格式的问题是 `length`）；都过了 `202 {jobId}`。只在学生讲义之间复用，不拿老师讲义来复用；学生之间不排队，每人同时一篇。返回体里没有上传人 |
| `GET /api/uploads/:jobId` | 生成进度：`running` / `done`（带 `handoutId`、入库报告）/ `error`；只有提交的老师能查，别人（包括没登录）和找不到一样 `404`；任务只在内存，保留最近 20 个（还在跑的不删）。**学生的任务** `{status:'running'\|'done'\|'failed', progress?, handoutId?, error?, reason?}`：`progress` 是一句中文（「AI 在写第 2 / 3 段的提示和题目」）；被内容安全拦截的 `failed` 带 `reason:'unsafe'` 和「这篇文章里有不适合在这里读的内容，换一篇吧」。只有任务里的账号（提交的和中途贴了同一篇的）查得到，别的学生 `404`，没有学生会话的（退出了、会话过期了）`401`（前端刷新登录状态、留着本机记的任务，登录后接着查）；登录的学生查任务表里没有的（服务器重启了、太早的被淘汰了）`404 {error, lost:true}`，前端提示重新提交（做好了的会直接复用） |
| `GET /api/handouts/:id` | 单份讲义 JSON，存在 `DATA_DIR/handouts/`。发布了的谁都能读（学生扫码，不用登录）。别的：老师、学生都没登录一律 `401 {error:'请先登录'}`，不存在的 id 也是 401（试不出哪些 id 存在）；登录了：上传它的老师能读（发布前预览），学生账号能读团队上架的（`shelf.json`，返回前去掉每句的老师讲解 `teacherNote`，见下文「学生账号」），学生上传的讲义只有在本人「我的文章」里才能读（贴过同一篇的人），否则和不存在一样 `404 {error:'没有这份讲义'}`。学生上传的讲义一律不开放发布、讲解、改题、AI 起草和看全班记录（老师的 cookie 也是 404）。id 格式不对（不是 `up-` 开头的那种）一律 404。没有公开列表 |
| `POST /api/handouts/:id/publish` | `{classes:[班级 id…]}` → `{ok:true, classes}`：发布到这些班（`meta.published=true`，`meta.classes` 换成这次给的列表，去重；再发布一次就能增减班级）。没登录 401，讲义不存在 404，不是自己上传的 `403 {error:'只有上传这篇文章的老师能发布'}`；一个班都没选 `400 {error:'请至少选一个班'}`；有的班不存在或不是自己建的 `400 {error:'有的班不存在或不是你建的，请刷新后再选'}` |
| `POST /api/handouts/:id/notes` | 老师讲解 `{notes: {S01: '…', …}}` → `{ok:true, count}`（`count` 是现在有讲解的句子数）；只有上传这篇的老师能写：没登录 401，讲义不存在 404，不是自己上传的（包括没有 owner 的旧讲义）`403 {error:'只有上传这篇文章的老师能写讲解'}`，拿到学生链接的人改不了。给了的句子写进去（去掉首尾空白），空字符串就删掉，没给的不动。格式不对、句子 id 不在讲义里、超过 600 字 400。同一份讲义的保存排队，先写临时文件再改名 |
| `POST /api/handouts/:id/edits` | 老师改 AI 起草的原句题、梯子、段意题 `{sentences?: {S03: {question?: {prompt, options, answer}, ladder?: {subject, predicate, l2, plain, glosses: [{term, zh}]}}}, paragraphs?: {2: {gist: {prompt, options, answer}}}}` → `{ok:true, handout}`；只发改过的块，给了的整块换掉（题目 id 不变），来源记成 `{by:'human', reviewedBy:'teacher'}`。权限同 `/notes`（没登录 401，不是上传的讲义或不存在 404，不是自己上传的 `403 {error:'只有上传这篇文章的老师能改题目和梯子'}`）。规则和校验器一致：梯子第 1 步「谁」「做了什么」必须是原句原话，选项 2–4 个、不空、不重复，答案序号在范围内，题目、选项、梯子里不能有语法术语（老师讲解不受此限），难词只能改中文意思；去掉首尾空白后检查。有一处不合格就一处都不写，`400 {error, fields: {'S03.ladder.subject': '梯子第 1 步的「谁」必须是原句里的原话', …}}`。和 `/notes` 排同一条保存队，先写临时文件再改名。学生已经答过的记录不变 |
| `POST /api/handouts/:id/notes/draft` | AI 起草讲解 `{}` → `202 {draftId}`：只做检查、记次数，模型在后台跑，前端每 1.5 秒查下面的 `/api/notes-drafts/:draftId`（一批十几到几十秒，句子多的文章一两分钟，比 nginx 的读超时长，不能在一个请求里等；前端最多查 10 分钟）。草稿只回给老师，不写进讲义（老师点保存才走上面的 `/notes`）。只给还没有讲解的句子写，值得讲的都写、不限句数：按段落顺序 8 句一批，同时最多 2 批；模型 `PIPELINE_MODEL`，关闭思考，每批 60 秒超时；每批第一次在 25 秒内失败、又不是 4xx（上游 5xx、断网、不是 JSON、条目全不合格）才再试一次，超时和 4xx 不再试；所有批都失败才是 `error`，有的批失败就返回成功的草稿加 `message`。权限同 `/notes`（没登录 401，讲义不存在 404，不是自己上传的 403）；没有 Key 503；每一句都有讲解 400；同一位老师一小时超过 10 次、同一篇文章一小时超过 10 次、全站当天超过 100 次 429（次数按点击算，一次点击分几批也只算一次）；全站花费到了上限（按这次所有批的估计额比）`429 {error:'今天的 AI 起草名额已经用完了，可以先自己写'}`（本月的是「这个月的……」），不算次数 |
| `GET /api/notes-drafts/:draftId` | 起草结果：`{status:'running', done, total}`（已完成几批 / 共几批）/ `{status:'done', notes:{S03:'…'}, model}`（模型给的是空列表时 `notes` 是 `{}`，不算失败；有的批没起草成时多一个 `message`：「另有 N 句这次 AI 没能起草，可以过一会儿再点一次「AI 起草讲解」。」）/ `{status:'error', error}`。`draftId` 是 24 位随机十六进制；只有发起起草的老师能查，别人（包括没登录）和找不到一样 404；结果只在内存，还在跑的不删，结束的保留最近 50 个、10 分钟 |

要登录的 POST（`/api/uploads`、`/publish`、`/notes`、`/edits`、`/notes/draft`、班级的几个 POST）、学生的选学号和找回、注册、登录、退出（老师的和学生账号的）、学生账号的改密码、注销和 `PUT /api/student/settings` 都只收 `Content-Type: application/json`，别的一律 `415 {error:'请求格式不对'}`（别的网站用表单跨站提交带不上这个类型）；后端不加任何 CORS 头。

配置（环境变量优先，其次是 `ENV_FILE` 指向的文件，没有就读当前目录 `.env`）：

| 变量 | 默认 |
|---|---|
| `LLM_API_KEY` | 无（没有就只做规则检查，上传、AI 起草讲解、教学建议不可用）。阿里云百炼的 API Key；没设时读旧名 `tokenspace_apikey`（兼容以前的 `.env`）。Key 不进日志和响应 |
| `PORT` | `8787` |
| `DATA_DIR` | `server/data` |
| `DELETIONS_DIR` | `server/deletions`：删除台账（注销、长期没用删掉的学生账号，见下文「学生账号（内测）」）的目录。必须在 `DATA_DIR` 外面，放在里面后端启动就报错：备份只打包 `DATA_DIR`，台账在里面会跟着旧备份一起倒回去。默认位置已经在 `deploy.sh` 的 rsync 排除里，`--delete` 删不到；改到别处时也要放在 `/srv/zhishi` 外面或加进排除 |
| `LLM_BASE_URL` | `https://dashscope.aliyuncs.com/compatible-mode/v1`（百炼 OpenAI 兼容接口的旧地址，仍可用）。线上写业务空间专属域名 `https://{WorkspaceId}.cn-beijing.maas.aliyuncs.com/compatible-mode/v1`（华北2 北京），末尾不要 `/`（多写了程序也会去掉） |
| `LLM_MODEL` | `qwen3.8-flash`（写作检查和教学建议用） |
| `PIPELINE_MODEL` | `deepseek-v4-pro`（百炼部署的 DeepSeek，不带前缀；上传文章生成讲义用，需要先 `npm run build` 生成 `dist-server/article.mjs`；AI 起草老师讲解也用它） |
| `UPLOAD_INVITES` | 空（谁都不能注册）。老师注册邀请码，每个码注册一个账号（变量名沿用以前的上传邀请码）。逗号分隔，去掉首尾空白和空项；少于 8 个字符的码不用（日志记一行个数，不记码） |
| `STUDENT_AI` | 不设（学生账号的 AI 写作检查不开放，账号学生写作只用规则检查）。设成 `1` 时开放：账号默认开着、账号页出现开关，学生可以关掉。班级学号那条路不看它 |
| `STUDENT_UPLOAD` | 不设（学生上传不开放）。设成 `1` 时登录的学生能贴文章生成讲义（见下文「学生账号（内测）」）。老师上传不受这三项影响 |
| `STUDENT_UPLOADS_PER_WEEK` | `2`：每人每周（北京时间周一 0 点清零）最多生成几篇，只在生成成功时计，复用别人生成好的不计。0–999 的整数才用，别的忽略（日志记一行） |
| `STUDENT_UPLOAD_FAILS_PER_DAY` | `3`：每人每天（北京时间）最多失败几次（内容安全拦截也算），到了当天就先不让交新的。0–999 的整数才用 |
| `COOKIE_INSECURE` | 不设（会话 cookie 带 `Secure`，只走 https）。设成 `1` 时不带 `Secure`，只给本机 http 调试用，线上不要设 |
| `CLEANUP_ANON_DAYS` | `30`：到期清理时页面报错和没绑定学号的事件留几天（见下文「数据留存和到期清理」）。正整数才用，别的忽略（日志记一行） |
| `CLEANUP_CACHE_DAYS` | `30`：到期清理时 `llm-cache/`、`advice-cache/` 里的文件留几天。正整数才用，别的忽略 |
| `SPEND_DAY_YUAN` | `20`：全站每天（北京时间）模型花费的上限，单位元，可以带小数；`0` 就是 AI 全停。不是数字的忽略（日志记一行）。见下文「用量日志和花费上限」 |
| `SPEND_MONTH_YUAN` | `200`：全站每月（北京时间）模型花费的上限，单位元。要低于百炼控制台设的预算 |
| `MODEL_PRICES` | 不设（用代码里的单价：`deepseek-v4-pro` 输入 12、输出 24，`qwen3.8-flash` 输入 0.8、输出 2.7，元/百万 token）。格式 `模型:输入单价:输出单价`，逗号分隔，如 `MODEL_PRICES=deepseek-v4-pro:12:24,qwen3.8-max:2.4:9.6`：盖掉或加进价格表，格式不对的那一项忽略（日志记一行）。表里没有的模型按表里最高的输入、输出单价算 |
| `NAME_KEY` | 空（学生姓名存明文）。64 位十六进制（32 字节）的学生姓名加密密钥，设了就把 `classes.json` 里的姓名加密存储（见下文「服务器运维：日志、备份、加密」）。格式不对时忽略、姓名不加密，日志记一行（不记值）；启动日志有一行 `姓名加密 on` / `姓名加密 off` |

模型都走阿里云百炼（按量付费）：`POST {LLM_BASE_URL}/chat/completions`，`Authorization: Bearer <Key>`，`response_format: json_object`（四处提示词里都有「JSON」字样，百炼要求的）。写作检查、教学建议、AI 起草讲解、上传生成讲义四处请求体顶层都带 `enable_thinking: false`：qwen3.8 / qwen3.7 系列和百炼部署的 deepseek-v4 系列默认会思考，不传就慢很多。

`LLM_FALLBACKS`、`PIPELINE_FALLBACKS` 已不再使用：以前放进请求体的 `models` 数组，是 TokenDance 网关的备选模型功能，百炼没有。旧 `.env` 里还写着也不报错，启动时日志记一行「已不再使用，忽略」，删掉就行。代码里也不自动换模型，出问题时手动换（见下文「换模型」）。

## 服务器上第一次部署

以下路径以 `/srv/zhishi` 为例，用户以 `ubuntu` 为例。

1. **装 Node 20 LTS**（后端是纯 JS，Node 16/20 都能跑）。装完 `node -v` 确认，`which node` 记下路径。
2. **拉代码、装运行依赖**：
   ```bash
   sudo mkdir -p /srv/zhishi && sudo chown ubuntu /srv/zhishi
   git clone <仓库地址> /srv/zhishi && cd /srv/zhishi
   npm config set registry https://registry.npmmirror.com   # 国内服务器
   npm ci --omit=dev
   ```
3. **前端**：在笔记本上 `npm run build`，再把 `dist/` 传上去：
   ```bash
   rsync -av --delete dist/ ubuntu@<服务器>:/srv/zhishi/dist/
   ```
4. **写 `.env`**（队长自己在服务器上写，不发到聊天里，不进仓库）：
   ```bash
   nano /srv/zhishi/.env
   chmod 600 /srv/zhishi/.env
   ```
   模型相关的写这两行（`{WorkspaceId}` 换成百炼业务空间的 ID，地址末尾不要 `/`）：
   ```
   LLM_API_KEY="sk-……"
   LLM_BASE_URL=https://{WorkspaceId}.cn-beijing.maas.aliyuncs.com/compatible-mode/v1
   ```
   只写 `KEY=VALUE` 形式，不要加 `export`（systemd 的 EnvironmentFile 不认）。从 TokenDance 换过来的旧 `.env`：删掉 `tokenspace_apikey`、`LLM_FALLBACKS`、`PIPELINE_FALLBACKS` 三行，以及指向 TokenDance 的 `LLM_BASE_URL` 和以前写的 `LLM_MODEL`（不写就用上面表里的默认模型）；其他行（`UPLOAD_INVITES`、`NAME_KEY` 等）不动。笔记本本地跑的话，同样两行写在仓库根目录的 `.env`（已在 `.gitignore`）。
5. **systemd**：
   ```bash
   sudo cp deploy/zhishi.service /etc/systemd/system/zhishi.service   # 按需改路径、用户、node 路径
   sudo systemctl daemon-reload
   sudo systemctl enable --now zhishi
   journalctl -u zhishi -f     # 日志只有请求序号、路径、状态码、耗时
   ```
6. **Nginx**：
   ```bash
   sudo install -d -m 755 -o root -g adm /var/log/zhishi-nginx   # 知适自己的 nginx 日志目录（配置里写了，不建 nginx -t 不通过；轮转见下文「服务器运维」）
   sudo cp deploy/nginx.conf.example /etc/nginx/sites-available/zhishi
   sudo ln -s /etc/nginx/sites-available/zhishi /etc/nginx/sites-enabled/zhishi
   sudo nginx -t && sudo systemctl reload nginx
   ```
7. **验证**：`curl http://<服务器>/api/health` 应返回 `{"ok":true,"llm":true,...}`。
8. **在服务器上重新测一次模型**（服务器到百炼的延迟可能和笔记本不同）：
   ```bash
   cd /srv/zhishi && ENV_FILE=/srv/zhishi/.env node server/probe-models.mjs
   ```
   读的是和后端一样的配置（`loadConfig`）。默认测 `qwen3.8-flash,qwen3.7-flash,deepseek-v4.1-flash`，每个 5 次，用的是写作检查的请求体；每次打印耗时、HTTP 状态、JSON 能不能解析（`严格` / `提取` / `失败`）、响应里有没有 `reasoning_content`（`reasoning=无` 说明关思考生效了）、3 个表达判对几个，不打印 Key。指定模型和次数：`RUNS=3 node server/probe-models.mjs qwen3.8-max,deepseek-v4-pro`。

## 换模型

代码里不自动换模型。某个模型一直超时、报错或者判得不对时，手动改 `.env`：

- 写作检查和教学建议（`LLM_MODEL`，默认 `qwen3.8-flash`）：可换 `deepseek-v4.1-flash` 或 `qwen3.7-flash`。
- 生成讲义和 AI 起草讲解（`PIPELINE_MODEL`，默认 `deepseek-v4-pro`）：可换 `qwen3.8-max`。

```bash
nano /srv/zhishi/.env                 # 加一行，比如 LLM_MODEL=deepseek-v4.1-flash
sudo systemctl restart zhishi
curl http://127.0.0.1:8787/api/health # model 是现在写作检查用的模型
```

换之前可以先用上面「服务器上第一次部署」第 8 步的 `probe-models.mjs` 测一下候选模型。换回默认：删掉那一行，再重启。

## 用量日志和花费上限

- **用量日志**：每次调模型（写作检查、教学建议、AI 起草讲解、上传生成讲义，还有 `scripts/lexicon.mjs` 补词义）追加一行到 `DATA_DIR/usage-YYYY-MM.jsonl`（北京时间的月份，文件 600）：`{ts, kind, model, input, output, cached, cost, estimated, handoutId?, call?, open?}`。
  - 上传生成讲义的每次调用记两行，带同一个 `call`（讲义 id:调用序号）：开始时一行估计额（`open: true`、`estimated: true`），结束时一行实际的。后端启动时加总、`npm run usage` 都按 `call` 合并（`settleUsage`）：有结束那行只算它（连接都没建立的结束行 token 是 0，两行都不算），没有结束那行（调用到一半后端被重启、杀掉）按开始那行的估计额算，不会少记。
  - `ts` 是毫秒；`kind` 是调用类型：`writing` 写作检查、`advice` 教学建议、`notes` AI 起草讲解；生成讲义是 `article`（起草一段）、`title`（起标题）、`lexicon`（全文词义）、`repair-l1`（修梯子第 1 步）。`model` 是请求的模型。
  - `input`、`output`、`cached` 是 token 数，取自响应里的 `usage`（`prompt_tokens`、`completion_tokens`、`prompt_tokens_details.cached_tokens`）。字段名是按 OpenAI 兼容接口写的，上线后先用一次真实调用核对（见 `docs/上传设计.md`「用量和花费上限」）。
  - `cost` 是金额，整数，单位是百万分之一元（1 元 = 1000000）：输入 token × 输入单价 + 输出 token × 输出单价（单价是元/百万 token，正好是这个单位），向上取整。命中上游缓存的 token 先按全价算。
  - 拿不到用量的按调用前的估计记，`estimated: true`：超时、上游返回非 200、响应不是 JSON、响应里没有 `usage`，还有生成讲义时线程超时被终止（或起草失败、任务结束）那一刻还在跑的几次。上游很可能已经计费，所以往多了记：输入按请求的字数估（UTF-8 每 3 个字节算 1 个 token），输出按这类调用的 `max_tokens`（写作检查 1000、教学建议 1200、起草讲解 3000；起草一段 8192、全文词义 3000、标题 200、修梯子 600）。连接都没建立的（连不上、域名解析失败）上游没收到请求，不记。
  - 没有原文、没有账号和学号。生成讲义、起草讲解、教学建议、补词义带 `handoutId`；写作检查不带（和账号的事件文件对一下时间就能认出是谁）。
  - 不自动删，到期清理不扫它（没有个人信息）。`deploy/backup.sh` 打包整个数据目录，它一起进备份；`archive-events.sh`、`archive-sessions.sh` 只动 `events-*.jsonl`，碰不到它。不要挪走或删掉这个月的文件：它是花费合计唯一的数据源，没了后端重启后当天、本月就从 0 算。从备份恢复数据目录时，备份之后记的用量会少掉，这一天、这个月的合计偏小，要留意。
- **花费上限**：每次调模型之前，内存里当天、本月（北京时间）的合计加上这次的估计额，超过 `SPEND_DAY_YUAN` 或 `SPEND_MONTH_YUAN` 就不调：
  - 新的生成回 `429 {error, resumesAt}`：「今天全站的上传名额已经用完了，明天再来吧」或「这个月全站的上传名额已经用完了，下个月再来吧」；`resumesAt` 是明天北京时间 0 点或下个月 1 日 0 点（毫秒）。一篇的估计额是 0.3 元 + 每千字符 0.3 元（8000 字符 2.7 元）。正在生成的那篇照样跑完。
  - 生成讲义（老师、学生）和 AI 起草讲解比上限时，把正在跑的那几样还没记账的估计额也算上，几样同时跑不会一起冲过上限；只是加上它们才超的回「过几分钟再试」，不给恢复时间（学生那边 `kind:'crowded'`），`GET /api/upload-status` 的 `paused` 只看已经记账的合计。
  - 写作检查回落到规则检查（`429`，和次数上限一样）；教学建议、AI 起草讲解回 `429`，提示可以先自己写、全班情况不受影响。`/api/advice` 照旧不用登录，用量照样记。被花费上限挡住的不算次数，日志 `llm limited spend`。
  - 合计只在内存里：后端启动时从这个月的日志加总；`scripts/lexicon.mjs` 追加的要到下次重启才算上（报表按日志全部算）。改了上限、单价要 `sudo systemctl restart zhishi`。
  - 测试环境确认上限管用：`.env` 里写 `SPEND_DAY_YUAN=0.01`、重启，上传一篇回 429，写作检查回落到规则检查。
- **单价**：写在代码里（`server/index.mjs` 的 `PRICES`），`.env` 的 `MODEL_PRICES` 可以覆盖或加模型（见上面配置表）。换模型（见上面「换模型」）时把新模型的单价加进 `MODEL_PRICES`，不然按表里最贵的算。
- **看花费**（用 `ubuntu`，不加 `sudo`）：只出合计数（按天、按类型、按模型，估计额单列，再加上这段时间生成讲义的篇数、每篇平均和最多），不列单条记录和讲义 id。
  ```bash
  cd /srv/zhishi
  npm run usage                       # 这个月
  npm run usage -- 2026-10 2026-11    # 这几个月
  npm run usage -- all                # 全部
  ```
- 日志写不进去（磁盘满）时程序日志是 `usage write failed <错误类型>`，内存里的合计照加，重启后这几次就算不上了。

## 发邀请码

老师账号只能用邀请码注册，一个码注册一个账号。给一位老师发一个码（不发到群里，不进仓库），老师在网站的「老师登录」页选「用邀请码注册」：

```bash
openssl rand -hex 8                 # 生成一个 16 位的码
nano /srv/zhishi/.env               # 写成一行：UPLOAD_INVITES=码1,码2（已有就在后面加逗号和新码）
sudo systemctl restart zhishi
```

用过的码不能再注册（服务器按码的 sha256 记在账号上，码本身不存），留在 `.env` 里也没关系。还没用的码要收回：从 `UPLOAD_INVITES` 里删掉，再 `sudo systemctl restart zhishi`。已经注册的账号和上传的讲义不受影响。

## 老师账号

- 用户名 + 密码登录，不收手机号、邮箱。登录后浏览器里存一个会话 cookie（`zhishi_session`，HttpOnly、SameSite=Lax、Path=/api、Secure，30 天到期、不续期），换设备重新登录就行。
- 上传的讲义归上传它的老师：写讲解、改题目、发布、看全班的学习记录都要他本人登录。账号功能上线前上传的讲义（meta 里没有 `owner`）谁都不能改、不能发布、不能看全班记录；已经发布的照旧谁都能读。学生端不登录（扫本班的二维码选学号，见下文「班级和学生学号」）。班级和名单也归建班的老师。
- 数据在 `server/data/`（`DATA_DIR`）：`accounts.json`（老师账号，密码只存 scrypt 哈希，邀请码只存 sha256）和 `sessions.json`（会话，只存 token 的 sha256，过期的写盘时顺手删掉）。两个文件都不进仓库、部署不覆盖，备份时和事件数据一起备份。
- 限次（只记在内存，重启清零）：同一用户名 15 分钟内登录失败 10 次先锁住；登录 + 注册全站每分钟最多 60 次。

团队在服务器上用命令行工具管账号（只改 `accounts.json`，服务器按文件修改时间重新读，不用重启）。用和服务相同的用户（`zhishi.service` 里的 `User=ubuntu`）跑，不要加 `sudo`：`accounts.json` 只给属主读写，用 root 写过之后服务就读不了，登录、注册都会出错：

```bash
cd /srv/zhishi
node scripts/teacher.mjs list                       # 列出用户名、称呼、注册时间（北京时间）、讲义数，不输出哈希
node scripts/teacher.mjs reset-password <用户名>    # 老师忘了密码：生成一个 12 位临时密码（只显示这一次）
```

`reset-password` 之后这位老师所有已登录的设备都要用临时密码重新登录；把临时密码私下告诉他，不要发到群里。现在还没有让老师自己改密码的页面，临时密码就是他的新密码。用户名不存在、参数不对时给中文提示、退出码不是 0。`DATA_DIR` 和后端一样：环境变量或 `.env` 里有就用它，否则 `server/data`。也可以写成 `npm run teacher -- list`。

## 学生账号（内测）：邀请码和上架文章

- 内测学生用团队发的邀请码自己注册（首页登录入口，`#/me`），用户名 + 密码登录，不收手机号、邮箱，不存出生年月。会话 cookie 是 `zhishi_student`（HttpOnly、SameSite=Lax、Path=/api、Secure，30 天到期、不续期），和老师的 `zhishi_session` 互不相认：学生登录了也调不了班级、上传、发布这些老师接口，老师登录了也读不到学生的东西。班级二维码（链接带 `c`）照旧走学号，不看学生账号。
- 数据在 `DATA_DIR`：`students.json`（账号，密码只存 scrypt 哈希，邀请码、找回码只存 sha256；`usedInvites` 是用过和年龄不够作废的码，不能再注册）、`student-sessions.json`（会话，只存 token 的 sha256）、`students/<sid>.jsonl`（每个账号一份学习事件）、`student-invites.json`（邀请码的哈希和批次）、`shelf.json`（上架的讲义）。都不进仓库、部署不覆盖，`deploy/backup.sh` 整个目录一起备份；到期清理按天数只扫顶层的 `events-*.jsonl`，`students/` 下的文件只在删账号时删。
- **注销和长期没用自动删除**：学生在账号页点「注销账号」、再输一次密码（接口见上面 `POST /api/student/delete`）。`lastSeenAt`（登录和打开页面时记，每天一次；没有就看注册时间）早于 12 个月前（代码里的 `STUDENT_INACTIVE_MONTHS`）的账号，到期清理时走同一套删除，日志 `student deleted inactive`。不收手机号和邮箱，删之前没法通知，登录页和隐私说明里写着。
- **删除台账** `DELETIONS_DIR/deleted-students.jsonl`（默认 `/srv/zhishi/server/deletions/`，后端启动时建好；目录 700、文件 600，后端只追加）：每删一个账号一行 `{sidHash, date}`，没有用户名和 `sid`。它在 `DATA_DIR` 外面、不进备份，从备份恢复时按它把备份之后删掉的账号再删一遍（见下文「加密滚动备份」的恢复步骤），注销过的账号不会复活。不要手工删改这个文件，也不要把它和数据目录放在一起。
- 年龄门槛 12 周岁（代码里的 `MIN_AGE`），不满的不建账号、这个码作废。
- **学生上传**（`.env` 加 `STUDENT_UPLOAD=1` 再重启才开放，接口见上面 `POST /api/student/uploads`）：
  - 同一篇只生成一次。精确键（NFC 规范化，按管线的规则分段，段内空白压成一个空格，取 sha256）相同的直接复用；近似键（NFKC 规范化、转小写，只去掉标点、符号和空白，中文和别的文字都留着）相同的让学生自己选：英文一样、另外夹了中文的不算近似。只在学生讲义之间比，老师的讲义不拿来复用。
  - 学生讲义的 meta 记 `source:'student'`、`createdBy`（提交的账号 id，只用来处理投诉和滥用，不出现在任何返回体里，不叫 `owner`，老师接口认不到它）、`exactKey`、`nearKey`；讲义 id 是 `up-` 加 20 位随机十六进制，看不出上传时间。只有「我的文章」里有它的人能读；`shelf add` 不收学生讲义。
  - 开始生成前在后端同步做内容检查（`pipeline/article.ts` 的 `checkArticle`，第一次用到时加载 `dist-server/article.mjs`，没 build 的话学生上传回 503，老师上传不受影响）：英文功能词不到一成半的、像试卷的（一行一个 A–D 选项、填空横线、中文题型说明、连着的题号问句）、有手机号身份证号邮箱的、同一句（5 个词以上）出现 3 次以上的拒收。老师上传不做这几项检查。阈值是拿 `tests/article.test.ts` 里的样本定的，内测时收到误拒再调。
  - 被百炼内容安全拦截（HTTP 400，错误码 `data_inspection_failed`，以百炼文档的错误码表为准）：不再重试，整篇不生成，给学生专门的提示，不算周次数、算失败次数，这个精确键记进 `upload-blocked.json`，以后不让再交。学生上传不填标题，管线先单独起标题（带着全文、输出很短），被拦截就不往下起草、配词义，只花这一次的钱；这一步没被拦、起草或词义被拦的，已经发出去的那几次照样花钱，已经回来的回答照常进 `llm-cache`，30 天后清理。
  - 数据：`library.json`（「我的文章」，账号 id → `[{handoutId, title, addedAt}]`）、`upload-counts.json`（账号 id → `{week, used, day, fails}`，这周成功几篇、今天失败几次，重启后还在）、`upload-blocked.json`（被拦截过的精确键）。都在 `DATA_DIR`，只由后端写，600。
  - 注销：删掉本人的「我的文章」和次数；它上传的讲义去掉 `createdBy`，还有别人在用的照旧留着；没人用了的记 `unusedSince`，到期清理 30 天后（代码里的 `STUDENT_HANDOUT_DAYS`）连同 meta 一起删。`apply-deletions` 也按台账把恢复出来的目录里这几样去掉。
- **单词本和表达本**（`GET /api/student/notebook`）：从 `students/<sid>.jsonl` 现算，服务器上不另存一份，注销、导出不用另外处理。推算代码在 `src/lib/notebook.ts`，`npm run build` 时打成 `dist-server/notebook.mjs`（和上传管线的 `article.mjs` 一起，共用的代码在 `dist-server/` 里另一个文件），部署时整个 `dist-server/` 一起传；没有这个文件时这个接口返回 500，别的不受影响。下架的讲义里的词和表达不再列（作答没删，再上架就回来）。
- AI 写作检查默认不开放，账号学生写作只用规则检查。要开放：`.env` 加一行 `STUDENT_AI=1`，再 `sudo systemctl restart zhishi`；开放后账号默认开着（点「检查一下」就把句子发给 AI），账号页有开关，学生可以关掉。去掉这一行再重启就又关上（学生账号上记的开关不用改）。
- 学生忘了密码：注册时拿到的 8 位找回码在登录页自己改。找回码也丢了：团队核实身份后（码发给了谁，`students.json` 账号上的 `inviteHash` 能对上是哪个码）用下面的 `reset-password`，它同时换一个新找回码、旧的作废（找回码可能是被别人拿去改了密码，旧码留着的话还能再改一次），临时密码和新找回码一起私下发给同学。

团队在服务器上用命令行工具发码、上架（同样用 `ubuntu`，不加 `sudo`）：

```bash
cd /srv/zhishi
node scripts/student.mjs invite 20 beta1          # 生成 20 个码，批次名 beta1；码只在终端显示这一次，服务器只存哈希
node scripts/student.mjs list                     # 各批次的共、已用、作废、可用；学生账号的用户名、注册时间、最近登录、AI 开关（不输出哈希和 sid）
node scripts/student.mjs revoke beta1             # 作废这一批还没用的码（发错了、内测换批次时），已经注册的账号不受影响
node scripts/student.mjs reset-password <用户名>  # 生成一个 12 位临时密码和 8 位新找回码（只显示这一次，旧找回码作废），这个账号所有已登录的设备都要重新登录
node scripts/student.mjs shelf add up-xxxx        # 上架一份讲义，登录的学生在首页看到，新上架的排在前面
node scripts/student.mjs shelf rm up-xxxx         # 下架（学生已经记下的作答不删）
node scripts/student.mjs shelf list
node scripts/student.mjs apply-deletions <目录>   # 按删除台账，把从备份恢复出来的目录里已经删掉的账号再删一遍（restore-backup.sh 会自动跑，见下文）
```

- 码一个一个私下发给同学，不要发到群里，也不要写进仓库或文档。输入时不分大小写，「-」可以不打。
- 上架的讲义由团队用自己的老师账号上传（不用发布到班级）。**有老师讲解（`teacherNote`）的讲义不能上架**：讲解没有来源标记，学生端分不出是不是 AI 写的。要上架就先在上传页把讲解都清空、保存。上架以后再写的讲解（包括 AI 起草后保存的）学生也看不到：学生读上架讲义时后端去掉 `teacherNote`，只有上传的老师自己预览看得到。已经发布到班级的讲义照旧原样给所有人（班级学生要看讲解），所以上架的讲义不要再发布到班级。
- `invite`、`revoke`、`shelf` 只写 `student-invites.json`、`shelf.json`，后端只读这两个文件，随时可以跑，不用重启。**`reset-password` 要改后端也在写的 `students.json`**（后端在注册、登录、改设置、改密码时都会写），同时写会丢掉其中一边的改动：趁没人用的时候跑，或者先 `sudo systemctl stop zhishi`，跑完再 `start`。
- 也可以写成 `npm run student -- list`。参数不对、批次或用户名不存在时给中文提示、退出码不是 0。

## 给旧讲义补全文词义

10-11 起上传时会给原文里讲义词表之外的词配上语境意思（讲义的 `lexicon`，见 `docs/上传设计.md`「全文词义」），学生粗读点了词表外的词，「生词」和精读才有意思可看。之前生成的讲义没有，部署后在服务器上补一次（同样用 `ubuntu`，不加 `sudo`）：

```bash
cd /srv/zhishi
node scripts/lexicon.mjs                 # 补所有还没有全文词义的上传讲义
node scripts/lexicon.mjs up-xxxx         # 只配这几份，已经有的也重配
```

用 `.env` 里和上传一样的模型配置（`PIPELINE_MODEL`），每份讲义要十几秒到半分钟；已经有的跳过。每次调模型往同一份 usage 日志追加一行（`kind` 是 `lexicon`，带讲义 id，见上文「用量日志和花费上限」），不受花费上限限制；后端内存里的合计要到下次重启才算上。请模型的这段时间老师照常可以改讲义：写之前重新读一次，只加 `lexicon`，不盖掉别的改动。有一批没配成（模型出错）的讲义不动、退出码不是 0，输出里写着哪一段、什么原因（超时、接口返回 5xx、输出格式不对……），过一会儿再跑：答成的那几批从缓存取，只重问出错的。学生重新打开讲义就用上了。

上传时也可能有一批没配成：讲义照样生成，老师看到一条「全文词义：有 N 个词 AI 这次没配上意思……」，后端日志的那一行是 `upload up-xxxx done 41234ms lexicon-missing 38 (第 2 段：超时)`（原因只写日志，不存 meta、不给老师）。查有没有这种讲义：`sudo journalctl -u zhishi | grep lexicon-missing`，有就 `node scripts/lexicon.mjs up-xxxx` 重配。只是模型漏了几个词、没有出错的（括号里没有原因），重配也是一样的结果（缓存），不用管。

## 班级和学生学号（数据和隐私）

- 老师在网站的「班级」页（`#/classes`）建班、导入名单（学号 + 姓名），发布讲义时选发布到哪些班，每个班一张二维码（`/?h=<讲义 id>&c=<班级 id>#/student`）。学生扫本班的码进来，第一次选自己的学号，拿到一个 6 位找回码；换手机时用学号 + 找回码找回，找回码丢了由老师在班级页给这个学号换一个。一位老师最多 20 个班，每班最多 80 人。
- **服务器上存了学生姓名**（未成年人个人信息）：在 `DATA_DIR/classes.json` 里，记在建班的老师名下，只有这位老师登录后能通过班级接口看到。学生端的接口和页面只有学号和「已有人」，事件、日志、教学建议的汇总里都没有姓名。删除班级会把名单、学号绑定和这些学号的全部学习记录一起删掉。
- **没选学号的学生作答只在本机**：内置演示讲义、上传讲义点「只是看看」、老师预览、演示画像都不发学习事件、写作不发给 AI；服务器也兜底：这些 `sid` 的学习事件不写盘，AI 写作检查 `403`（见上面接口表）。页面报错 `client_error` 照常收（只有错误信息，没有作答）。
- **AI 写作检查按学号关**：家长回执第 2 项（AI 写作检查）选了不同意的学号，老师在班级页的「AI 写作检查」一列关掉；关了的学号写作只做规则检查，原文不发给模型。
- **建班前的两项确认**：班级页新建班级、改名单保存前要勾「学校已同意在这个班使用知适」「已收回家长告知同意书，名单里只录入了第 1 项选了同意的同学」，两项都勾了才能保存（只改班名不用）；家长同意书还没收回时先不要建班录名单。后端同样要求（见上面接口表），最近一次勾选的时间记在 `classes.json` 班级的 `confirmedAt`（毫秒）。
- **学生选学号前的说明和勾选**：选学号页学号格子上方是一个要点框（作答记在学号上、只有老师能看到；写作检查时英文句子发给 AI 检查、知适不保存原文；家长没有签同意书的同学点「只是看看（不记学号）」；「完整说明」和「不满 14 周岁学生个人信息保护规则」的链接；有问题联系任课老师），勾选「我已读过上面的说明。年满 14 周岁的同学，勾选表示你本人也同意按学号记录作答。」后学号格子才能点。后端要求 `confirm: true`，勾选的时间记在这个学号绑定的 `confirmedAt`（毫秒）；找回不用再勾。
- **撤回同意**：老师在班级页用「改名单」把这个学号从名单里删掉（要勾两项确认），这个学号的姓名、进班记录和它在所有讲义里的学习记录（含存档和备份文件）一起删掉，不能恢复。只点「清空学号」的话，进班记录和学习记录一样删掉、学生要重新选学号，但名单上的学号和姓名还在，所以撤回同意时要用改名单删掉这个学号。
- `classes.json` 和 `accounts.json` 一样：写临时文件再改名，只给属主读写（600），不进仓库、部署不覆盖，备份时和事件数据一起备份（备份里也有姓名，不要随手拷到别处）。配了 `NAME_KEY` 时姓名存的是密文，只在建班老师的班级接口里解密（见下文「服务器运维：日志、备份、加密」）。找回码和学生设备 token 只存 sha256，`sid` 是随机的、和姓名没有关系。
- 限次（只记在内存，重启清零）：同一个班每小时最多 120 次选学号请求；找回码同一个学号 15 分钟内失败 5 次、同一个班 15 分钟内失败 30 次先锁住（老师重置过找回码的学号 15 分钟内只按学号算）；码对了的找回同一个学号每小时最多 10 次。
- **隐私说明页** `#/privacy`：正文是 `src/content/privacy.md`（现在是「试点前简要版」），每一页的页脚在备案号旁边都有「隐私说明」（`#/privacy`）和「不满 14 周岁学生个人信息保护规则」（`#/privacy?s=minors`，打开后滚到 id 是 `minors` 的标题）两个链接，选学号页的要点框里也有。正式的隐私说明和《不满 14 周岁学生个人信息保护规则》定稿后，在第一个班级试点开始前整篇替换这个文件（网址不变），再按下面「更新」重新 `npm run build`、rsync `dist/`。替换时注意：
  - 页面用自写的小渲染器（`src/lib/markdown.ts`）显示，只认 `#` / `##` / `###` 标题、段落、`- ` 列表、`1. ` 列表、`**粗体**`、`[文字](链接)`（只有 `https://` 和 `#/` 开头的会变成链接）、管道表格；HTML 不认，原样显示成文字。段落里的换行显示成一个空格，中文段落请写成一行；表格每行首尾都要写 `|`；不认的链接整段原样显示（连方括号和网址），看得出来哪里没写对。
  - 不满 14 周岁那一节的标题末尾要留 `{#minors}`（比如 `## 不满 14 周岁的学生 {#minors}`），页脚和选学号页的链接靠它定位；规则另写成单独一页时，这两处链接要一起改。
  - 替换后跑一遍 `npm run check`：`tests/privacy.test.ts` 里有检查这个文件的测试。通用的几条（不能有【待定】、要有 `{#minors}` 标题）照旧要过；按简要版写的几条（标题、开头一句、版本行、几句原话）要跟着正式版一起改。「不能有邮箱、电话、地址」只管简要版（对外联系方式还没定，防止编出来）：正式版写上定好的真实联系方式时，把这条改成只断言那几个值。
- 这次更新之前发布的讲义没有发布到任何班：老师要在上传页选班再发布一次，老师端才看得到按班的记录；之前匿名做的记录不算在任何学号名下，到期后按下文的到期清理删掉。

## 数据留存和到期清理

后端进程自己清理（`node server/index.mjs` 直接运行时）：启动后先跑一次，之后每 24 小时一次，不用配 cron。日志一行：`cleanup N files N events N cache files`（改写或删掉了几个事件文件、删了几行事件、几个缓存文件），出错时后面加 `error <错误类型>`，不记内容，也不会让进程退出。

- **事件文件**（`DATA_DIR` 里所有 `events-` 开头、`.jsonl` 结尾的文件，包括 `archive-events.sh`、`archive-sessions.sh` 留下的存档和 `.bak` 备份）：删掉 `ts` 早于 `CLEANUP_ANON_DAYS` 天前（默认 30 天）、并且是下面任一种的行：页面报错 `client_error`（写盘时 `ts` 不超过服务器收到的时间，手机时间往后调了、伪造的未来时间也按收到的时间算）；`sid` 现在没绑定在任何班的任何学号上（匿名、演示、老师预览留下的，学号被清空前的旧 `sid`）。现在绑定在学号上的学习事件不按天数删，由老师删班级、清空学号时删（见上面接口表）。`classes.json` 待删列表 `purge` 里的 `sid`（删学号的记录时有文件没改成）不看天数全删，所有事件文件都改成了才从列表里去掉。解析不了的行原样保留；删空的文件删掉。和后端自己的追加排同一条写队列，清理期间新到的事件不会丢。
- **模型缓存**：`DATA_DIR/llm-cache/`、`DATA_DIR/advice-cache/` 里修改时间早于 `CLEANUP_CACHE_DAYS` 天前（默认 30 天）的文件删掉（教学建议的内存缓存不管，重启就清）。
- **学生账号**：`lastSeenAt` 早于 12 个月前的账号走注销同一套删除（见上面接口表 `POST /api/student/delete`），清理的返回里多一个 `students`（删了几个）；`student-sessions.json` 里账号已经不在的会话删掉；`students.json` 待删列表 `purge` 里的 `sid`（注销时有文件没删成）不看天数，删掉 `students/<sid>.jsonl` 和所有事件文件里这些 `sid` 的行，全删完才从列表去掉。
- **学生上传的讲义**（meta 的 `source` 是 `student`）：不在任何人的「我的文章」里的，第一次清理时记上 `unusedSince`，过了 30 天（`STUDENT_HANDOUT_DAYS`）连同 meta 一起删；又有人用了的去掉 `unusedSince`。`createdBy`、`library.json`、`upload-counts.json` 里账号已经不在的去掉，不是这周也不是今天的次数去掉。删了讲义时日志那一行后面加 `N student handouts`。`llm-cache/` 里的原文照上一条 30 天删。
- **不动**：`accounts.json`、`sessions.json`（过期会话在写会话时顺手删）、没到期的学生账号和它们的学习事件、老师上传的讲义（`handouts/`）；`classes.json` 只从待删列表 `purge` 里去掉删完的 `sid`，名单和绑定不动。
- 改天数：在 `.env` 里加 `CLEANUP_ANON_DAYS=…`、`CLEANUP_CACHE_DAYS=…`（正整数），再 `sudo systemctl restart zhishi`。
- **第一次更新到带清理的版本**：重启后马上就会清理一次，比赛期间留下的匿名试用记录（`events-social-media.jsonl`、`events-mini-phones.jsonl`、各种存档和备份里超过 30 天的）会被删掉。还要用的（比如 `npm run trial:funnel` 的分析），更新前先把这些 `events-*.jsonl` 拷出来再重启。笔记本上 `npm run server` 也是直接运行，一样会清理本机的 `DATA_DIR`。
- **试点结束时**：老师在班级页（`#/classes`）删除班级，会删掉这个班的名单、进班记录和全部学习记录（所有讲义的事件文件、存档和备份里这些学号的记录），不能恢复。服务器上另外做过的整份备份（比如拷到别处的 `server/data/`）不在清理范围内，要另外删。

## 服务器运维：日志、备份、加密

服务器上的安装都是手工做一次（下面的命令在服务器上跑）。服务器上还有别的网站：全局的 nginx 配置、`/etc/logrotate.d/nginx`、journald 都不改。

### 日志

- **知适的 nginx 日志**：`/var/log/zhishi-nginx/access.log`（默认 combined 格式：访问者 IP、时间、请求行（网址里有讲义 id 和班级 id）、状态码、大小、Referer、浏览器信息）和 `error.log`。在知适站点的 `server` 块里单独写（见 `nginx.conf.example`），知适的请求就不再记进全局的 `/var/log/nginx/access.log`。每天轮转、保留 190 天，最近一份轮转出来的先不压缩、更早的压缩成 `.gz`（`deploy/logrotate-zhishi`）：网络安全法要求网络日志留存不少于 6 个月，全局的 `/etc/logrotate.d/nginx` 管 `/var/log/nginx/*.log`、只留 14 天，别的网站也在用，所以知适单独一个目录（放在 `/var/log/nginx/` 里会被两份配置同时匹配，logrotate 会报错）。安装：
  ```bash
  sudo install -d -m 755 -o root -g adm /var/log/zhishi-nginx
  sudo install -m 644 -o root -g root /srv/zhishi/deploy/logrotate-zhishi /etc/logrotate.d/zhishi-nginx
  sudo nano /etc/nginx/sites-available/zhishi   # 在 server 块里加 access_log、error_log 两行（照 nginx.conf.example）；certbot 加过 443 的 server 块，两个块都加
  sudo nginx -t && sudo systemctl reload nginx
  sudo logrotate -d /etc/logrotate.d/zhishi-nginx   # 只检查配置、不真的轮转
  ```
- **程序日志**：在 journald（`journalctl -u zhishi`），全服务器共用，留多久按全局设置，不单独改。知适写进去的只有请求序号、方法、路径、状态码、耗时、模型名，以及清理、删除的条数和出错类型；没有 IP，没有作答、写作原文和姓名。

### 学生姓名加密（`NAME_KEY`）

- 设了 `NAME_KEY` 后，`classes.json` 里每个学号的姓名用 AES-256-GCM 加密存储（每个姓名随机 IV，存成 `enc:v1:…`），只在建班老师登录后的班级接口里解密；空姓名照旧是空字符串。班级名、学号、绑定不加密（找回码、设备 token 本来就只存 sha256，事件里只有随机的 `sid`）。防的是数据文件、备份被拷走以后直接看到姓名：密钥在 `.env` 里，不在数据目录，也不在备份里。拿到服务器 `ubuntu` 或 root 权限的人能读 `.env`，防不住。
- 生成、启用：
  ```bash
  openssl rand -hex 32                 # 64 位十六进制
  nano /srv/zhishi/.env                # 加一行：NAME_KEY=……
  sudo systemctl restart zhishi
  journalctl -u zhishi -n 20 | grep -E '姓名加密|NAME_KEY|names'   # 要看到「姓名加密 on」
  ```
  格式不对时日志是「NAME_KEY 不是 64 位十六进制，已忽略，姓名不加密」，接着是「姓名加密 off」。启用后服务启动时把 `classes.json` 里原来的明文姓名一次改成密文（日志 `names encrypted N`，N 是个数；以后重启没有明文就不改），之后建班、改名单都直接存密文。启用之前做的备份里姓名还是明文，到期（30 天）随备份删掉。
- **离线另存一份**：把 `NAME_KEY` 抄进密码管理器，或打印出来锁好；不发到聊天里、不进仓库，也不要和备份密钥放在同一个地方。**密钥丢了，姓名就解不开**（备份里的也一样），只能请老师在班级页重新录名单（学号、进班记录和学习记录不受影响）。
- **密钥不对、数据坏了**：班级页的姓名是空的，接口多一个 `nameError: true`，日志一行 `name decrypt failed <错误类型>`（`NAME_AUTH_FAILED` 是密钥不对或密文坏了，`NAME_NO_KEY` 是 `.env` 里没有 `NAME_KEY`，`NAME_BAD_FORMAT` 是存的格式不对），其他功能照常。这时**不要在班级页改名单保存**：名单是整体替换的，空着的姓名会把存着的密文覆盖掉。先把正确的密钥找回来、重启。
- **换密钥**：这次没做轮换工具，直接改 `NAME_KEY` 就是上面「密钥不对」的情况。要换的话需要新旧两个密钥同时在手：停服务，用一段脚本（或手工）把 `classes.json` 里每个 `enc:v1:` 的姓名用旧密钥解开、用新密钥重新加密，写回（属主 `ubuntu`、600），再改 `.env`、启动。密钥泄露时要知道：换密钥之前留下的 `classes.json` 副本（包括已有的备份）用旧密钥照样能解开。

### 加密滚动备份

- `deploy/backup.sh` 每天 03:30（随机推迟最多 5 分钟；那时没开机就开机后补跑）由 `zhishi-backup.timer` 以 root 跑一次：把整个数据目录 `/srv/zhishi/server/data`（账号、会话、班级名单、学习事件、讲义、缓存；写到一半的 `.tmp` 不要）打成 tar.gz，用 `openssl enc -aes-256-cbc -md sha256 -pbkdf2 -iter 200000 -salt`、以 `/etc/zhishi/backup.key` 的第一行做口令加密，存成 `/var/backups/zhishi/zhishi-data-YYYYMMDD-HHMMSS.tar.gz.enc`（目录 700、文件 600，先写 `.tmp` 再改名）。备份成功后删掉这个目录里超过 30 天的 `zhishi-data-*.tar.gz.enc`（改天数：在 `zhishi-backup.service` 里加 `Environment=BACKUP_DAYS=…`）和超过 1 小时的残留 `.tmp`。日志（`journalctl -u zhishi-backup`）一行：文件名和大小。`.env`（Key、`NAME_KEY`、邀请码）不在备份里。
- 防的是误删、数据文件写坏、改错了要回到前几天；备份和数据在同一台服务器上，不防整台服务器没了（见下面「没做的」）。
- **备份里的数据在到期前仍然存在**：老师删掉的班级、清空的学号、到期清理删掉的记录、注销和长期没用删掉的学生账号，在之前的备份里还在，最多再留 30 天，随备份到期删掉。隐私说明里讲删除和留存期限时要和这一条一致。删除台账（`DELETIONS_DIR`）不在数据目录里，不进备份。
- **备份密钥**（root 600），生成一次、离线另存一份（丢了备份就解不开）：
  ```bash
  sudo install -d -m 700 /etc/zhishi
  sudo sh -c 'umask 077 && openssl rand -hex 32 > /etc/zhishi/backup.key'
  sudo cat /etc/zhishi/backup.key      # 抄进密码管理器或打印锁好，不发到聊天里；和 NAME_KEY 分开放
  ```
- **安装定时器**：
  ```bash
  sudo install -o root -g root -m 755 /srv/zhishi/deploy/backup.sh /usr/local/sbin/zhishi-backup.sh
  sudo cp /srv/zhishi/deploy/zhishi-backup.service /srv/zhishi/deploy/zhishi-backup.timer /etc/systemd/system/
  sudo systemctl daemon-reload
  sudo systemctl enable --now zhishi-backup.timer
  systemctl list-timers zhishi-backup.timer      # 看下一次什么时候跑
  ```
  服务以 root 跑的是拷出来的 `/usr/local/sbin/zhishi-backup.sh`（root 所有、755），不是仓库里那份：仓库里的 `deploy/backup.sh` 属主是 `ubuntu`、每次部署都会被覆盖，直接用它等于让能改这个文件的人以 root 执行命令。以后改了 `deploy/backup.sh`，要重新跑上面第一行 `install`。
- **手工跑一次、查看**：
  ```bash
  sudo systemctl start zhishi-backup.service
  journalctl -u zhishi-backup -n 5
  sudo ls -lh /var/backups/zhishi/
  ```
- **恢复演练**（装好后做一次，之后每月一次）：解到临时目录和线上数据比对，比完删掉（里面有姓名和学习记录）：
  ```bash
  f=$(sudo sh -c 'ls -t /var/backups/zhishi/zhishi-data-*.tar.gz.enc | head -n 1')
  d=$(mktemp -d)
  sudo bash /srv/zhishi/deploy/restore-backup.sh "$f" "$d/data"
  sudo diff -r /srv/zhishi/server/data "$d/data" | head -20   # 备份之后新写的事件、会话会不一样，别的应该一致
  sudo rm -rf "$d"
  ```
  `restore-backup.sh` 只往给的目录里解：目录不存在就建（700），已经存在而且不是空的就拒绝（加 `--force` 才解，同名文件覆盖），目标是线上数据目录一律拒绝。解完马上按删除台账把备份之后删掉的学生账号再删一遍（`node scripts/student.mjs apply-deletions <目录>`，输出一行「按删除台账（N 条）在 … 里删掉了 …」；台账读不了、台账目录不在时退出码不是 0，提示这份数据不要换到线上）。台账的位置和后端一样：环境变量 `DELETIONS_DIR`，或者 `ENV_FILE` 指的文件（默认 `/srv/zhishi/.env`）里的，都没有就是 `/srv/zhishi/server/deletions`；相对路径按仓库根目录 `/srv/zhishi` 算（脚本先 cd 过去，和后端一样）。台账目录后端启动时就建好，所以目录不在说明路径不对；在新机器上恢复，要先把原来机器上的台账目录搬过来。所以比对时已经删掉的学生账号两边都没有。
- **真要恢复到线上**（数据写坏了）：先解到 `/srv/zhishi` 外面的目录（`deploy.sh` 的 `rsync --delete` 会删掉仓库目录里多出来的东西）→ 按当前的删除台账删一遍 → 停服务、再按台账删一遍（解包到停服务之间可能又有人注销）→ 把坏的挪开，再换上：
  ```bash
  sudo bash /srv/zhishi/deploy/restore-backup.sh <备份文件> /srv/zhishi-restore/data   # 解完自动按台账删，看输出的「按删除台账……」那一行
  sudo systemctl stop zhishi
  cd /srv/zhishi && sudo node scripts/student.mjs apply-deletions /srv/zhishi-restore/data
  sudo mv /srv/zhishi/server/data /srv/zhishi-restore/data.broken-$(date +%Y%m%d-%H%M%S)
  sudo mv /srv/zhishi-restore/data /srv/zhishi/server/data
  sudo chown -R ubuntu:ubuntu /srv/zhishi/server/data && sudo chmod -R go-rwx /srv/zhishi/server/data
  sudo systemctl start zhishi
  ```
  备份之后写的数据会丢；备份之后老师删掉的班级、学号（撤回同意）会跟着回来，要按老师的记录再删一次（学生账号有删除台账，不用手工删）。不要动 `/srv/zhishi/server/deletions/`：换数据目录时台账留在原地。`/srv/zhishi-restore/` 里挪开的旧数据也有姓名和学习记录，查完原因就删掉。

### 数据目录权限

后端在数据目录下新建的文件一律 600、目录一律 700（事件文件、讲义、教学建议和模型缓存、账号、会话、班级、学生账号和 `students/` 目录、学生上传的 `library.json`、`upload-counts.json`、`upload-blocked.json`；命令行写的 `student-invites.json`、`shelf.json` 也是 600；改写时先写的临时文件也是 600，换上去以后就是 600）。程序不去改已经存在的文件和目录的权限，在服务器上手工收紧一次：

```bash
sudo chmod -R go-rwx /srv/zhishi/server/data
ls -la /srv/zhishi/server/data
```

### 没做的

- **云硬盘加密**：腾讯云的云硬盘加密只能在新建硬盘时选，已有的盘不能直接打开：要在控制台新建一块加密云硬盘，再把数据迁过去（停服务、拷数据、改挂载）。这次没做。
- **异地备份**：现在备份和数据在同一台服务器上，防误删和数据损坏，不防整机丢失（服务器被释放、盘坏了、云账号出问题）。建议在腾讯云控制台给云硬盘开定期快照，或定期把 `/var/backups/zhishi/` 里的加密备份拉到别处；快照里是没加密的整块盘（连 `.env` 和两个密钥），拉走的副本和快照都要按 30 天删，备份密钥不要和拉走的副本放在一起。

## 更新

```bash
cd /srv/zhishi && git pull && npm ci --omit=dev && sudo systemctl restart zhishi
# 前端：笔记本上 npm run build，再 rsync dist/
```

事件数据在 `server/data/events-*.jsonl`，账号、班级名单在 `server/data/accounts.json`、`classes.json`（`server/data/` 已在 `.gitignore`），演示前后各备份一次。

## 域名

域名到位后，把 `nginx.conf.example` 里的 `server_name _;` 改成域名。注意：大陆服务器上，**未备案的域名访问 80/443 通常会被云厂商拦截**，48 小时内备案下不来。演示前务必用手机流量实测一次域名能否打开；打不开就用 IP 访问兜底。

## 笔记本本地兜底

```bash
COOKIE_INSECURE=1 ENV_FILE=/path/to/.env npm run server   # 后端 127.0.0.1:8787；本机是 http，会话 cookie 不能带 Secure
npm run dev                                               # 前端，/api 由 Vite 代理到 8787
```

## 模型实测（10-01 深夜，笔记本网络，经 TokenDance 测）

下面是比赛期间经组委会 TokenDance 网关测的旧数据，服务商已经换成阿里云百炼，模型名有的一样、延迟不一定一样，只作参考；在百炼上要用 `server/probe-models.mjs` 重新测（见上文「服务器上第一次部署」第 8 步）。

测试输入：一段很短的学生作文，3 个表达，预期 E1 用对、E2 用错（`I feel very counterproductive`）、E3 没用上。「判对」指 3 个表达的判断都符合预期；「JSON 合格」指整段输出能直接 `JSON.parse`。「理由最长」按字符数算，英文字母逐个计数。

**第一轮：默认参数（不关思考）**，每个模型 1 次

| 模型 | 耗时 | JSON | 判对 |
|---|---|---|---|
| qwen3.5-flash | 20.6s | 合格 | 3/3 |
| qwen3.7-plus | 超过 30s | — | — |
| qwen3.8-flash | 10.3s | 合格 | 3/3 |
| glm-5.3-flash | 15.0s | 合格 | 3/3 |
| deepseek-v4-flash | 4.4s | 合格 | 3/3 |
| deepseek-v4.1-flash | 2.6s | 合格 | 3/3 |
| deepseek-v3.2 | 2.5s | 合格 | 2/3（把 E2 判成用对） |
| glm-4.5-air | 0.3s 报 400 | — | 只支持流式输出，不可用 |

**第二轮：请求体加 `enable_thinking: false`**（服务器现在就是这样发的）

| 模型 | 次数 | 耗时 | JSON 合格 | 判对 3/3 | 理由最长 |
|---|---|---|---|---|---|
| **deepseek-v4-flash（当时的默认）** | 5 | 1.7–2.0s | 5/5 | 5/5 | 80 字 |
| qwen3.5-flash | 6 | 1.5–1.7s | 6/6 | 5/6（1 次只返回了 1 个表达） | 71 字 |
| deepseek-v4.1-flash（当时的备选） | 6 | 2.0–3.9s | 6/6 | 6/6 | 61 字 |
| qwen3.8-flash（当时的备选） | 4 | 2.3–3.6s | 4/4 | 4/4 | 53 字 |
| deepseek-v3.2 | 3 | 2.4–2.6s | 3/3 | 0/3（每次都把 E2 判成用对） | 49 字 |
| qwen3.7-plus | 1 | 4.2s | 1/1 | 1/1 | 75 字 |

当时的选择（TokenDance）：`deepseek-v4-flash` 最快且每次都判对；备选选了不同厂商的 `qwen3.8-flash`，再加 `deepseek-v4.1-flash`。

通过后端端到端再跑 3 次（当时带 `models` 备选）：1.3–1.9s，全部 `fallback:false`。其中 1 次模型在理由里写了「放在主语位置」，后端按规则换成了不含术语的通用理由。
