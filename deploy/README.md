# 部署说明

结构：Nginx 托管前端静态文件（`dist/`），`/api` 反代到本机 Node 后端 `server/index.mjs`（只监听 `127.0.0.1:8787`）。笔记本本地再跑一份兜底。

## 后端接口

| 接口 | 说明 |
|---|---|
| `POST /api/events` | 单个事件或数组（≤200 条），整批校验通过才写，追加到 `DATA_DIR/events-<handoutId>.jsonl`，返回 `{ok, accepted}`，`accepted` 是实际写进去的条数。逐条决定留不留：页面报错 `client_error` 照留（任何讲义）；别的类型只留「选了座号」的学生的，即这条事件的 `sid` 现在绑定在某个班的某个座号上，这个班在讲义的 `meta.classes` 里、讲义已发布、班级和讲义是同一位老师的；内置讲义（不是 `up-` 开头）的一律不留。没选座号的（「只是看看」、老师预览、演示画像、旧页面和浏览器里积压的匿名事件、伪造的）不报错、不写，照样 `200`（前端看到 200 就把这批从队列删掉，不会反复重发）。同一个事件文件的追加和改写（删座号的记录、到期清理）排同一条队，改写期间新到的行不会丢。写盘前按字段白名单重建每条事件：只留 `sid, ts, handoutId, type, sentenceId, paragraph, lemma, level, correct, firstTry, value`，类型不对的可选字段丢掉（`paragraph`、`level` 要整数，`correct`、`firstTry` 要布尔，`sentenceId`、`lemma` 截到 64 个字符）；写作原文和反馈理由不进服务器：`writing_submit` 不留 `value`，`feedback` 的 `value` 只留「｜」前面的评分（太简单 / 刚好 / 太难，别的去掉），其他类型的 `value` 截到 200 个字符 |
| `GET /api/events?handoutId=&classId=&since=` | 按班返回 `ts > since` 的事件数组，教师页自己聚合：只含这个班已选座号的学生（`sid`）的事件，匿名做的（「只是看看」、扫码前的）不算。只给上传这篇文章的老师看（登录的会话 cookie）。`handoutId` 格式不对 `400`；内置演示讲义（不是 `up-` 开头）`403 {ok:false, error:'内置演示讲义不开放学习记录'}`；没登录 `401 {ok:false, error:'请先登录'}`；讲义不存在 `404 {ok:false, error:'没有这份讲义'}`；不是自己上传的（包括没有 owner 的旧讲义）`403 {ok:false, error:'只有上传这篇文章的老师能看全班的学习记录'}`；`classId` 没带、不是这份讲义发布到的班、不是自己的班 `400 {ok:false, error:'请选一个班'}` |
| `POST /api/writing-check` | `{handoutId, sid, text(≤1200), expressions:[{id,text,zh,example}]}` → `{results:[{id,used,verdict,reason}], grammar, model, fallback:false}`，`grammar` 是最多 3 处可能的语法问题 `[{quote,type,hint}]`（`quote` 必是学生原话的片段；没问题是 `[]`，模型没给或一条都不合格是 `null`）；8 秒超时或任何错误返回 `{fallback:true, results:[]}`，前端回落到规则检查。不落盘，日志不记内容。只有选了座号、座号开着 AI 的学生能用（写作原文要发给模型）：`sid` 要现在绑定在这份讲义发布到的班的座号上（同上面 `/api/events` 的条件），不满足（没带 `sid`、没选座号、内置讲义）`403 {fallback:true, results:[], error:'没有选座号时不用 AI 检查'}`；老师关了这个座号的 AI `403 {fallback:true, results:[], error:'老师关闭了这个座号的 AI 检查'}`；都不调用模型、不算次数，前端回落到规则检查。限次（模型费用封顶）：同一个 `sid` 每小时 20 次、全站每天（北京时间）1500 次，只有真要调用模型时才算；超了 `429 {fallback:true, results:[], error}`，不调用模型，前端照样回落到规则检查 |
| `GET /api/health` | `{ok, llm, model}`，`llm` 表示有没有读到 Key |
| `POST /api/auth/register` | 老师用邀请码注册 `{invite, username, password, name?}` → `201 {teacher:{id, username, name}}`，同时登录（`Set-Cookie`，见下文「老师账号」）。依次检查：登录 + 注册全站每分钟超过 60 次 `429 {error:'现在登录的人太多了，请稍后再试'}`；没配置邀请码 `403 {error:'注册目前只对受邀老师开放'}`；邀请码没带或不对 `403 {error:'邀请码不对，请向知适团队确认'}`；这个码已经注册过账号 `409 {error:'这个邀请码已经注册过账号了'}`；字段不合格 `400 {error, fields:{username?, password?, name?}}`；用户名已经有人用了（不分大小写）`409 {error:'这个用户名已经有人用了', fields:{username}}`。先查邀请码，没有邀请码的人试不出哪些用户名被占了。用户名去首尾空白后转小写，3–32 个字符，只能是 `a-z 0-9 _ . -`，以字母或数字开头；密码 8–128 个字符，不能和用户名一样；称呼可选（如「王老师」），最多 20 个字、不能有控制字符，空就用用户名。不收手机号、邮箱 |
| `POST /api/auth/login` | `{username, password}` → `200 {teacher}`，`Set-Cookie`。用户名不存在、密码不对一律 `401 {error:'用户名或密码不对'}`（用户名不存在时也跑一遍 scrypt，耗时一样）；同一用户名 15 分钟内失败 10 次 `429 {error:'试错太多次了，请 15 分钟后再试'}`（成功登录清零，只记在内存）；全站限次同上 |
| `POST /api/auth/logout` | → `{ok:true}`：删掉服务器上的会话，清 cookie（`Max-Age=0`）；没登录也 200 |
| `GET /api/auth/me` | `{teacher:{id, username, name}}`；没登录、会话过期、会话早于重置密码、账号已不在都是 `{teacher:null}` |
| `GET /api/my/handouts` | 我上传过的讲义 `{handouts:[{id, title, createdAt, published, classes}]}`（`classes` 是发布到的班级 id，已经删掉的班不列），只列自己的，新的在前；没登录 `401 {error:'请先登录'}` |
| `GET /api/classes` | 我的班级 `{classes:[{id, name, createdAt, seats, joined}]}`（`seats` 名单人数，`joined` 已选座号人数），新建的在前；没登录 `401 {error:'请先登录'}`。下面的班级接口都要登录：没登录 401，班级不存在 `404 {error:'没有这个班'}`，不是自己建的 `403 {error:'这个班不是你建的'}` |
| `POST /api/classes` | 建班 `{name, roster:[{n, name}]}` → `201 {class}`（详情同下）。班级名去首尾空白 1–20 个字；名单 1–80 人，座号 `n` 是 1–99 的整数、班内不重复，姓名去首尾空白 0–20 个字（可以不填），都不能有控制字符；不合格 `400 {error, fields:{name?, roster?}}`（`roster` 的提示说是哪个座号）。每位老师最多 20 个班，超了 `400 {error:'每位老师最多建 20 个班'}` |
| `GET /api/classes/:id` | 班级详情 `{class:{id, name, createdAt, seats:[{n, name, joined, joinedAt?, sid?, ai}]}}`，按座号排；`joinedAt` 是选座号的时间（毫秒），`sid` 只给老师，用来把事件对上座号；`ai` 是这个座号开着 AI 写作检查没有。`Cache-Control: no-store` |
| `POST /api/classes/:id` | 改班名、换名单 `{name?, roster?}` → `{class, deletedEvents}`。名单整体替换：留下的座号绑定不变（姓名可以改，关没关 AI 照旧），新座号开着 AI；删掉的座号连绑定一起删，已进班的连同它在所有讲义里的学习记录一起删（同清空座号），`deletedEvents` 是删掉的事件条数（只改班名是 0），没删完时多一个 `incomplete: true`（同清空座号）；两样都没给 `400 {error:'没有要保存的改动'}`，字段不对同建班 |
| `POST /api/classes/:id/delete` | `{}` → `{ok:true, deletedEvents}`：删除班级，名单、座号绑定和这些座号在所有讲义里的学习记录一起删（同清空座号，没删完时多一个 `incomplete: true`）；发布到这个班的讲义里留下的班级 id 以后一律忽略 |
| `POST /api/classes/:id/seats/:n/reset-code` | `{}` → `{recoveryCode}`（只这一次）：给这个座号换一个找回码，旧码作废，已经进来的设备照常能用，这个座号的试错次数清零，15 分钟内这个座号也不受「整个班 30 次」那层限次（照旧按座号限 5 次）。座号不在名单 `400 {error:'没有这个座号'}`；还没人选 `400 {error:'这个座号还没有学生进来'}` |
| `POST /api/classes/:id/seats/:n/clear` | `{}` → `{ok:true, deletedEvents}`：清空这个座号的绑定，学生要重新选；这个座号原来的 `sid` 在所有讲义里的学习记录一起删：`DATA_DIR` 里所有 `events-` 开头、`.jsonl` 结尾的文件（各讲义的事件文件，以及 `archive-events.sh`、`archive-sessions.sh` 留下的存档和备份），按 `sid` 精确匹配，解析不了的行原样保留，删空的文件删掉；`deletedEvents` 是删掉的条数（还没人选也 200，`deletedEvents:0`），日志只记条数。有的文件这次改不了（磁盘满、读不了）时接着删别的，绑定照样删，响应多一个 `incomplete: true`（班级页提示「还有一部分这次没删成功，服务器会自动再删」），日志 `events deleted N clear incomplete <错误类型>`；没删完的 `sid` 记在 `classes.json` 的待删列表 `purge` 里（和删绑定同一次写盘），每次到期清理都按它再删一遍，全删完才去掉。关没关 AI 记在名单上，清空不变。座号不在名单 `400 {error:'没有这个座号'}` |
| `POST /api/classes/:id/seats/:n/ai` | `{enabled: true/false}` → `{ok:true, n, ai}`：开关这个座号的 AI 写作检查（家长回执第 2 项选了不同意的座号关掉）。记在名单的座号上（`classes.json` 里 `noAi: true`），还没进班也能先关，清空座号、重新进班不变。座号不在名单 `400 {error:'没有这个座号'}`；`enabled` 不是布尔 `400 {error:'AI 开关的格式不对，请刷新页面后再试'}` |
| `GET /api/join/:classId?h=` | 学生扫码进班（不登录）：`{className, seats:[{n, taken}]}`，`taken` 是已经有人选了；没有姓名、`sid`。下面四个学生接口都先查「有效的班级 + 讲义」：班级存在，讲义 `h` 已发布、发布到了这个班，班级和讲义是同一位老师的，否则一律 `404 {error:'找不到这个班，请重新扫老师发的二维码'}` |
| `POST /api/join/:classId` | 选座号 `{h, seat}` → `201 {seat, sid, token, recoveryCode, ai}`：`sid` 是 `s-` 加 16 位随机十六进制，学生之后照旧用它发事件；`ai` 是这个座号现在开着 AI 写作检查没有（找回、`my-progress` 也带）；`token`（学生设备，64 位十六进制）和 6 位找回码只在这次响应里出现，服务器只存 sha256。座号不在名单 `400 {error:'没有这个座号'}`；已经有人选了 `409 {error:'这个座号已经有人选了。如果是你换了手机，点「用找回码找回」', taken:true}`（同时选同一个座号只有一个成功）；同一个班每小时超过 120 次选座号请求 `429 {error:'现在选座号的人太多了，请稍后再试'}` |
| `POST /api/join/:classId/recover` | 换了手机用找回码找回 `{h, seat, code}` → `{seat, sid, token, ai}`：`sid` 不变，给这台设备一个新 `token`（每个座号只留最新 5 个）。找回码不分大小写，空格和「-」去掉再比。座号不在名单 400；还没人选 `400 {error:'这个座号还没有人选，直接选座号就行'}`；码不对 `403 {error:'找回码不对。找不到找回码的话，请老师在老师端给你重置'}`；同一个座号 15 分钟内失败 5 次、同一个班 15 分钟内失败 30 次 `429 {error:'试错太多次了，请 15 分钟后再试，或者请老师给你重置找回码'}`（和登录一样先记失败再比对，并发请求绕不过去；老师重置找回码后这个座号清零）；码对了的找回同一个座号每小时最多 10 次，超了 `429 {error:'找回太频繁了，请过一会儿再试'}`（每次都要重写 `classes.json`） |
| `GET /api/my-progress?h=&c=` | 请求头 `X-Student-Token` → `{events, ai}`：这个座号的 `sid` 在这份讲义里的全部事件（找回后重建学习进度），`ai` 是这个座号现在开着 AI 写作检查没有。token 不属于这个班的任何座号 `401 {error:'找不到你的座号记录，请重新扫码'}`；`Cache-Control: no-store` |
| `POST /api/uploads` | 上传文章 `{title, text, mustWords?, checkIns?, focus?}` → `202 {jobId}`；要登录，讲义的 meta 记上 `owner`（老师 id），之后查进度、预览、发布、写讲解、改题目、看全班记录都只有这位老师能做（见下）。依次检查：没有 Key 503；没登录 `401 {error:'请先登录'}`；输入不合格 400；已有任务在跑、同一位老师一小时超过 5 篇、全站当天超过 60 篇 429。接口约定见 `docs/上传设计.md` |
| `GET /api/uploads/:jobId` | 生成进度：`running` / `done`（带 `handoutId`、入库报告）/ `error`；只有提交的老师能查，别人（包括没登录）和找不到一样 `404`；任务只在内存，保留最近 20 个 |
| `GET /api/handouts/:id` | 单份讲义 JSON，存在 `DATA_DIR/handouts/`。发布了的谁都能读（学生扫码，不用登录）；没发布的只有上传它的老师登录后能读（发布前预览），否则和不存在一样 `404 {error:'没有这份讲义'}`。没有公开列表 |
| `POST /api/handouts/:id/publish` | `{classes:[班级 id…]}` → `{ok:true, classes}`：发布到这些班（`meta.published=true`，`meta.classes` 换成这次给的列表，去重；再发布一次就能增减班级）。没登录 401，讲义不存在 404，不是自己上传的 `403 {error:'只有上传这篇文章的老师能发布'}`；一个班都没选 `400 {error:'请至少选一个班'}`；有的班不存在或不是自己建的 `400 {error:'有的班不存在或不是你建的，请刷新后再选'}` |
| `POST /api/handouts/:id/notes` | 老师讲解 `{notes: {S01: '…', …}}` → `{ok:true, count}`（`count` 是现在有讲解的句子数）；只有上传这篇的老师能写：没登录 401，讲义不存在 404，不是自己上传的（包括没有 owner 的旧讲义）`403 {error:'只有上传这篇文章的老师能写讲解'}`，拿到学生链接的人改不了。给了的句子写进去（去掉首尾空白），空字符串就删掉，没给的不动。格式不对、句子 id 不在讲义里、超过 600 字 400。同一份讲义的保存排队，先写临时文件再改名 |
| `POST /api/handouts/:id/edits` | 老师改 AI 起草的原句题、梯子、段意题 `{sentences?: {S03: {question?: {prompt, options, answer}, ladder?: {subject, predicate, l2, plain, glosses: [{term, zh}]}}}, paragraphs?: {2: {gist: {prompt, options, answer}}}}` → `{ok:true, handout}`；只发改过的块，给了的整块换掉（题目 id 不变），来源记成 `{by:'human', reviewedBy:'teacher'}`。权限同 `/notes`（没登录 401，不是上传的讲义或不存在 404，不是自己上传的 `403 {error:'只有上传这篇文章的老师能改题目和梯子'}`）。规则和校验器一致：梯子第 1 步「谁」「做了什么」必须是原句原话，选项 2–4 个、不空、不重复，答案序号在范围内，题目、选项、梯子里不能有语法术语（老师讲解不受此限），难词只能改中文意思；去掉首尾空白后检查。有一处不合格就一处都不写，`400 {error, fields: {'S03.ladder.subject': '梯子第 1 步的「谁」必须是原句里的原话', …}}`。和 `/notes` 排同一条保存队，先写临时文件再改名。学生已经答过的记录不变 |
| `POST /api/handouts/:id/notes/draft` | AI 起草讲解 `{}` → `202 {draftId}`：只做检查、记次数，模型在后台跑，前端每 1.5 秒查下面的 `/api/notes-drafts/:draftId`（一批十几到几十秒，句子多的文章一两分钟，比 nginx 的读超时长，不能在一个请求里等；前端最多查 10 分钟）。草稿只回给老师，不写进讲义（老师点保存才走上面的 `/notes`）。只给还没有讲解的句子写，值得讲的都写、不限句数：按段落顺序 8 句一批，同时最多 2 批；模型 `PIPELINE_MODEL`，`PIPELINE_FALLBACKS` 做备选，关闭思考，每批 60 秒超时；每批第一次在 25 秒内失败、又不是 4xx（上游 5xx、断网、不是 JSON、条目全不合格）才再试一次，超时和 4xx 不再试；所有批都失败才是 `error`，有的批失败就返回成功的草稿加 `message`。权限同 `/notes`（没登录 401，讲义不存在 404，不是自己上传的 403）；没有 Key 503；每一句都有讲解 400；同一位老师一小时超过 10 次、同一篇文章一小时超过 10 次、全站当天超过 100 次 429（次数按点击算，一次点击分几批也只算一次） |
| `GET /api/notes-drafts/:draftId` | 起草结果：`{status:'running', done, total}`（已完成几批 / 共几批）/ `{status:'done', notes:{S03:'…'}, model}`（模型给的是空列表时 `notes` 是 `{}`，不算失败；有的批没起草成时多一个 `message`：「另有 N 句这次 AI 没能起草，可以过一会儿再点一次「AI 起草讲解」。」）/ `{status:'error', error}`。`draftId` 是 24 位随机十六进制；只有发起起草的老师能查，别人（包括没登录）和找不到一样 404；结果只在内存，还在跑的不删，结束的保留最近 50 个、10 分钟 |

要登录的 POST（`/api/uploads`、`/publish`、`/notes`、`/edits`、`/notes/draft`、班级的几个 POST）、学生的选座号和找回、注册、登录、退出都只收 `Content-Type: application/json`，别的一律 `415 {error:'请求格式不对'}`（别的网站用表单跨站提交带不上这个类型）；后端不加任何 CORS 头。

配置（环境变量优先，其次是 `ENV_FILE` 指向的文件，没有就读当前目录 `.env`）：

| 变量 | 默认 |
|---|---|
| `tokenspace_apikey` | 无（没有就只做规则检查） |
| `PORT` | `8787` |
| `DATA_DIR` | `server/data` |
| `LLM_BASE_URL` | `https://tokendance.space/gateway/v1` |
| `LLM_MODEL` | `deepseek-v4-flash` |
| `LLM_FALLBACKS` | `qwen3.8-flash,deepseek-v4.1-flash`（放进请求体的 `models`，主模型报错时 TokenDance 按顺序换） |
| `PIPELINE_MODEL` | `deepseek-v4-pro`（上传文章起草用，需要先 `npm run build` 生成 `dist-server/article.mjs`；AI 起草老师讲解也用它） |
| `PIPELINE_FALLBACKS` | `qwen3.7-max,glm-5.2` |
| `UPLOAD_INVITES` | 空（谁都不能注册）。老师注册邀请码，每个码注册一个账号（变量名沿用以前的上传邀请码）。逗号分隔，去掉首尾空白和空项；少于 8 个字符的码不用（日志记一行个数，不记码） |
| `COOKIE_INSECURE` | 不设（会话 cookie 带 `Secure`，只走 https）。设成 `1` 时不带 `Secure`，只给本机 http 调试用，线上不要设 |
| `CLEANUP_ANON_DAYS` | `30`：到期清理时页面报错和没绑定座号的事件留几天（见下文「数据留存和到期清理」）。正整数才用，别的忽略（日志记一行） |
| `CLEANUP_CACHE_DAYS` | `30`：到期清理时 `llm-cache/`、`advice-cache/` 里的文件留几天。正整数才用，别的忽略 |

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
   nano /srv/zhishi/.env      # 写一行：tokenspace_apikey="……"
   chmod 600 /srv/zhishi/.env
   ```
   只写 `KEY=VALUE` 形式，不要加 `export`（systemd 的 EnvironmentFile 不认）。
5. **systemd**：
   ```bash
   sudo cp deploy/zhishi.service /etc/systemd/system/zhishi.service   # 按需改路径、用户、node 路径
   sudo systemctl daemon-reload
   sudo systemctl enable --now zhishi
   journalctl -u zhishi -f     # 日志只有请求序号、路径、状态码、耗时
   ```
6. **Nginx**：
   ```bash
   sudo cp deploy/nginx.conf.example /etc/nginx/sites-available/zhishi
   sudo ln -s /etc/nginx/sites-available/zhishi /etc/nginx/sites-enabled/zhishi
   sudo nginx -t && sudo systemctl reload nginx
   ```
7. **验证**：`curl http://<服务器>/api/health` 应返回 `{"ok":true,"llm":true,...}`。
8. **在服务器上重新测一次模型**（服务器到 TokenDance 的延迟可能和笔记本不同）：
   ```bash
   cd /srv/zhishi && ENV_FILE=/srv/zhishi/.env node server/probe-models.mjs
   ```
   要换模型，在 `.env` 里加 `LLM_MODEL=...`，然后 `sudo systemctl restart zhishi`。

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
- 上传的讲义归上传它的老师：写讲解、改题目、发布、看全班的学习记录都要他本人登录。账号功能上线前上传的讲义（meta 里没有 `owner`）谁都不能改、不能发布、不能看全班记录；已经发布的照旧谁都能读。学生端不登录（扫本班的二维码选座号，见下文「班级和学生座号」）。班级和名单也归建班的老师。
- 数据在 `server/data/`（`DATA_DIR`）：`accounts.json`（老师账号，密码只存 scrypt 哈希，邀请码只存 sha256）和 `sessions.json`（会话，只存 token 的 sha256，过期的写盘时顺手删掉）。两个文件都不进仓库、部署不覆盖，备份时和事件数据一起备份。
- 限次（只记在内存，重启清零）：同一用户名 15 分钟内登录失败 10 次先锁住；登录 + 注册全站每分钟最多 60 次。

团队在服务器上用命令行工具管账号（只改 `accounts.json`，服务器按文件修改时间重新读，不用重启）。用和服务相同的用户（`zhishi.service` 里的 `User=ubuntu`）跑，不要加 `sudo`：`accounts.json` 只给属主读写，用 root 写过之后服务就读不了，登录、注册都会出错：

```bash
cd /srv/zhishi
node scripts/teacher.mjs list                       # 列出用户名、称呼、注册时间（北京时间）、讲义数，不输出哈希
node scripts/teacher.mjs reset-password <用户名>    # 老师忘了密码：生成一个 12 位临时密码（只显示这一次）
```

`reset-password` 之后这位老师所有已登录的设备都要用临时密码重新登录；把临时密码私下告诉他，不要发到群里。现在还没有让老师自己改密码的页面，临时密码就是他的新密码。用户名不存在、参数不对时给中文提示、退出码不是 0。`DATA_DIR` 和后端一样：环境变量或 `.env` 里有就用它，否则 `server/data`。也可以写成 `npm run teacher -- list`。

## 班级和学生座号（数据和隐私）

- 老师在网站的「班级」页（`#/classes`）建班、导入名单（座号 + 姓名），发布讲义时选发布到哪些班，每个班一张二维码（`/?h=<讲义 id>&c=<班级 id>#/student`）。学生扫本班的码进来，第一次选自己的座号，拿到一个 6 位找回码；换手机时用座号 + 找回码找回，找回码丢了由老师在班级页给这个座号换一个。一位老师最多 20 个班，每班最多 80 人。
- **服务器上存了学生姓名**（未成年人个人信息）：在 `DATA_DIR/classes.json` 里，记在建班的老师名下，只有这位老师登录后能通过班级接口看到。学生端的接口和页面只有座号和「已有人」，事件、日志、教学建议的汇总里都没有姓名。删除班级会把名单、座号绑定和这些座号的全部学习记录一起删掉。
- **没选座号的学生作答只在本机**：内置演示讲义、上传讲义点「只是看看」、老师预览、演示画像都不发学习事件、写作不发给 AI；服务器也兜底：这些 `sid` 的学习事件不写盘，AI 写作检查 `403`（见上面接口表）。页面报错 `client_error` 照常收（只有错误信息，没有作答）。
- **AI 写作检查按座号关**：家长回执第 2 项（AI 写作检查）选了不同意的座号，老师在班级页的「AI 写作检查」一列关掉；关了的座号写作只做规则检查，原文不发给模型。
- **撤回同意**：老师在班级页「清空座号」，这个座号在所有讲义里的学习记录（含存档和备份文件）一起删掉，不能恢复；学生要重新选座号。
- `classes.json` 和 `accounts.json` 一样：写临时文件再改名，只给属主读写（600），不进仓库、部署不覆盖，备份时和事件数据一起备份（备份里也有姓名，不要随手拷到别处）。找回码和学生设备 token 只存 sha256，`sid` 是随机的、和姓名没有关系。
- 限次（只记在内存，重启清零）：同一个班每小时最多 120 次选座号请求；找回码同一个座号 15 分钟内失败 5 次、同一个班 15 分钟内失败 30 次先锁住（老师重置过找回码的座号 15 分钟内只按座号算）；码对了的找回同一个座号每小时最多 10 次。
- 这次更新之前发布的讲义没有发布到任何班：老师要在上传页选班再发布一次，老师端才看得到按班的记录；之前匿名做的记录不算在任何座号名下，到期后按下文的到期清理删掉。

## 数据留存和到期清理

后端进程自己清理（`node server/index.mjs` 直接运行时）：启动后先跑一次，之后每 24 小时一次，不用配 cron。日志一行：`cleanup N files N events N cache files`（改写或删掉了几个事件文件、删了几行事件、几个缓存文件），出错时后面加 `error <错误类型>`，不记内容，也不会让进程退出。

- **事件文件**（`DATA_DIR` 里所有 `events-` 开头、`.jsonl` 结尾的文件，包括 `archive-events.sh`、`archive-sessions.sh` 留下的存档和 `.bak` 备份）：删掉 `ts` 早于 `CLEANUP_ANON_DAYS` 天前（默认 30 天）、并且是下面任一种的行：页面报错 `client_error`；`sid` 现在没绑定在任何班的任何座号上（匿名、演示、老师预览留下的，座号被清空前的旧 `sid`）。现在绑定在座号上的学习事件不按天数删，由老师删班级、清空座号时删（见上面接口表）。`classes.json` 待删列表 `purge` 里的 `sid`（删座号的记录时有文件没改成）不看天数全删，所有事件文件都改成了才从列表里去掉。解析不了的行原样保留；删空的文件删掉。和后端自己的追加排同一条写队列，清理期间新到的事件不会丢。
- **模型缓存**：`DATA_DIR/llm-cache/`、`DATA_DIR/advice-cache/` 里修改时间早于 `CLEANUP_CACHE_DAYS` 天前（默认 30 天）的文件删掉（教学建议的内存缓存不管，重启就清）。
- **不动**：`accounts.json`、`sessions.json`（过期会话在写会话时顺手删）、讲义（`handouts/`）；`classes.json` 只从待删列表 `purge` 里去掉删完的 `sid`，名单和绑定不动。
- 改天数：在 `.env` 里加 `CLEANUP_ANON_DAYS=…`、`CLEANUP_CACHE_DAYS=…`（正整数），再 `sudo systemctl restart zhishi`。
- **第一次更新到带清理的版本**：重启后马上就会清理一次，比赛期间留下的匿名试用记录（`events-social-media.jsonl`、`events-mini-phones.jsonl`、各种存档和备份里超过 30 天的）会被删掉。还要用的（比如 `npm run trial:funnel` 的分析），更新前先把这些 `events-*.jsonl` 拷出来再重启。笔记本上 `npm run server` 也是直接运行，一样会清理本机的 `DATA_DIR`。
- **试点结束时**：老师在班级页（`#/classes`）删除班级，会删掉这个班的名单、进班记录和全部学习记录（所有讲义的事件文件、存档和备份里这些座号的记录），不能恢复。服务器上另外做过的整份备份（比如拷到别处的 `server/data/`）不在清理范围内，要另外删。

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

## 模型实测（10-01 深夜，笔记本网络）

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
| **deepseek-v4-flash（默认）** | 5 | 1.7–2.0s | 5/5 | 5/5 | 80 字 |
| qwen3.5-flash | 6 | 1.5–1.7s | 6/6 | 5/6（1 次只返回了 1 个表达） | 71 字 |
| deepseek-v4.1-flash（备选） | 6 | 2.0–3.9s | 6/6 | 6/6 | 61 字 |
| qwen3.8-flash（备选） | 4 | 2.3–3.6s | 4/4 | 4/4 | 53 字 |
| deepseek-v3.2 | 3 | 2.4–2.6s | 3/3 | 0/3（每次都把 E2 判成用对） | 49 字 |
| qwen3.7-plus | 1 | 4.2s | 1/1 | 1/1 | 75 字 |

选择：`deepseek-v4-flash` 最快且每次都判对；备选选了不同厂商的 `qwen3.8-flash`，再加 `deepseek-v4.1-flash`。

通过后端端到端再跑 3 次（带 `models` 备选）：1.3–1.9s，全部 `fallback:false`。其中 1 次模型在理由里写了「放在主语位置」，后端按规则换成了不含术语的通用理由。
