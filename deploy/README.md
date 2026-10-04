# 部署说明

结构：Nginx 托管前端静态文件（`dist/`），`/api` 反代到本机 Node 后端 `server/index.mjs`（只监听 `127.0.0.1:8787`）。笔记本本地再跑一份兜底。

## 后端接口

| 接口 | 说明 |
|---|---|
| `POST /api/events` | 单个事件或数组（≤200 条），整批校验通过才写，追加到 `DATA_DIR/events-<handoutId>.jsonl`，返回 `{ok, accepted}`。写盘前按字段白名单重建每条事件：只留 `sid, ts, handoutId, type, sentenceId, paragraph, lemma, level, correct, firstTry, value`，类型不对的可选字段丢掉（`paragraph`、`level` 要整数，`correct`、`firstTry` 要布尔，`sentenceId`、`lemma` 截到 64 个字符）；写作原文和反馈理由不进服务器：`writing_submit` 不留 `value`，`feedback` 的 `value` 只留「｜」前面的评分（太简单 / 刚好 / 太难，别的去掉），其他类型的 `value` 截到 200 个字符 |
| `GET /api/events?handoutId=&since=` | 返回 `ts > since` 的事件数组，教师页自己聚合。只给上传这篇文章的老师看（登录的会话 cookie）。`handoutId` 格式不对 `400`；内置演示讲义（不是 `up-` 开头）`403 {ok:false, error:'内置演示讲义不开放学习记录'}`；没登录 `401 {ok:false, error:'请先登录'}`；讲义不存在 `404 {ok:false, error:'没有这份讲义'}`；不是自己上传的（包括没有 owner 的旧讲义）`403 {ok:false, error:'只有上传这篇文章的老师能看全班的学习记录'}` |
| `POST /api/writing-check` | `{handoutId, sid, text(≤1200), expressions:[{id,text,zh,example}]}` → `{results:[{id,used,verdict,reason}], grammar, model, fallback:false}`，`grammar` 是最多 3 处可能的语法问题 `[{quote,type,hint}]`（`quote` 必是学生原话的片段；没问题是 `[]`，模型没给或一条都不合格是 `null`）；8 秒超时或任何错误返回 `{fallback:true, results:[]}`，前端回落到规则检查。不落盘，日志不记内容。限次（模型费用封顶）：同一个 `sid`（学生匿名编号，1–64 个字符；没带或格式不对都算进同一个共享桶；首页演示画像同学 A / B 的编号人人相同，前端改发设备 id）每小时 20 次、全站每天（北京时间）1500 次，只有真要调用模型时才算；超了 `429 {fallback:true, results:[], error}`，不调用模型，前端照样回落到规则检查 |
| `GET /api/health` | `{ok, llm, model}`，`llm` 表示有没有读到 Key |
| `POST /api/auth/register` | 老师用邀请码注册 `{invite, username, password, name?}` → `201 {teacher:{id, username, name}}`，同时登录（`Set-Cookie`，见下文「老师账号」）。依次检查：登录 + 注册全站每分钟超过 60 次 `429 {error:'现在登录的人太多了，请稍后再试'}`；没配置邀请码 `403 {error:'注册目前只对受邀老师开放'}`；邀请码没带或不对 `403 {error:'邀请码不对，请向知适团队确认'}`；这个码已经注册过账号 `409 {error:'这个邀请码已经注册过账号了'}`；字段不合格 `400 {error, fields:{username?, password?, name?}}`；用户名已经有人用了（不分大小写）`409 {error:'这个用户名已经有人用了', fields:{username}}`。先查邀请码，没有邀请码的人试不出哪些用户名被占了。用户名去首尾空白后转小写，3–32 个字符，只能是 `a-z 0-9 _ . -`，以字母或数字开头；密码 8–128 个字符，不能和用户名一样；称呼可选（如「王老师」），最多 20 个字、不能有控制字符，空就用用户名。不收手机号、邮箱 |
| `POST /api/auth/login` | `{username, password}` → `200 {teacher}`，`Set-Cookie`。用户名不存在、密码不对一律 `401 {error:'用户名或密码不对'}`（用户名不存在时也跑一遍 scrypt，耗时一样）；同一用户名 15 分钟内失败 10 次 `429 {error:'试错太多次了，请 15 分钟后再试'}`（成功登录清零，只记在内存）；全站限次同上 |
| `POST /api/auth/logout` | → `{ok:true}`：删掉服务器上的会话，清 cookie（`Max-Age=0`）；没登录也 200 |
| `GET /api/auth/me` | `{teacher:{id, username, name}}`；没登录、会话过期、会话早于重置密码、账号已不在都是 `{teacher:null}` |
| `GET /api/my/handouts` | 我上传过的讲义 `{handouts:[{id, title, createdAt, published}]}`，只列自己的，新的在前；没登录 `401 {error:'请先登录'}` |
| `POST /api/uploads` | 上传文章 `{title, text, mustWords?, checkIns?, focus?}` → `202 {jobId}`；要登录，讲义的 meta 记上 `owner`（老师 id），之后查进度、预览、发布、写讲解、改题目、看全班记录都只有这位老师能做（见下）。依次检查：没有 Key 503；没登录 `401 {error:'请先登录'}`；输入不合格 400；已有任务在跑、同一位老师一小时超过 5 篇、全站当天超过 60 篇 429。接口约定见 `docs/上传设计.md` |
| `GET /api/uploads/:jobId` | 生成进度：`running` / `done`（带 `handoutId`、入库报告）/ `error`；只有提交的老师能查，别人（包括没登录）和找不到一样 `404`；任务只在内存，保留最近 20 个 |
| `GET /api/handouts/:id` | 单份讲义 JSON，存在 `DATA_DIR/handouts/`。发布了的谁都能读（学生扫码，不用登录）；没发布的只有上传它的老师登录后能读（发布前预览），否则和不存在一样 `404 {error:'没有这份讲义'}`。没有公开列表 |
| `POST /api/handouts/:id/publish` | `{}` → `{ok:true}`；没登录 401，讲义不存在 404，不是自己上传的 `403 {error:'只有上传这篇文章的老师能发布'}` |
| `POST /api/handouts/:id/notes` | 老师讲解 `{notes: {S01: '…', …}}` → `{ok:true, count}`（`count` 是现在有讲解的句子数）；只有上传这篇的老师能写：没登录 401，讲义不存在 404，不是自己上传的（包括没有 owner 的旧讲义）`403 {error:'只有上传这篇文章的老师能写讲解'}`，拿到学生链接的人改不了。给了的句子写进去（去掉首尾空白），空字符串就删掉，没给的不动。格式不对、句子 id 不在讲义里、超过 600 字 400。同一份讲义的保存排队，先写临时文件再改名 |
| `POST /api/handouts/:id/edits` | 老师改 AI 起草的原句题、梯子、段意题 `{sentences?: {S03: {question?: {prompt, options, answer}, ladder?: {subject, predicate, l2, plain, glosses: [{term, zh}]}}}, paragraphs?: {2: {gist: {prompt, options, answer}}}}` → `{ok:true, handout}`；只发改过的块，给了的整块换掉（题目 id 不变），来源记成 `{by:'human', reviewedBy:'teacher'}`。权限同 `/notes`（没登录 401，不是上传的讲义或不存在 404，不是自己上传的 `403 {error:'只有上传这篇文章的老师能改题目和梯子'}`）。规则和校验器一致：梯子第 1 步「谁」「做了什么」必须是原句原话，选项 2–4 个、不空、不重复，答案序号在范围内，题目、选项、梯子里不能有语法术语（老师讲解不受此限），难词只能改中文意思；去掉首尾空白后检查。有一处不合格就一处都不写，`400 {error, fields: {'S03.ladder.subject': '梯子第 1 步的「谁」必须是原句里的原话', …}}`。和 `/notes` 排同一条保存队，先写临时文件再改名。学生已经答过的记录不变 |
| `POST /api/handouts/:id/notes/draft` | AI 起草讲解 `{}` → `202 {draftId}`：只做检查、记次数，模型在后台跑，前端每 1.5 秒查下面的 `/api/notes-drafts/:draftId`（一批十几到几十秒，句子多的文章一两分钟，比 nginx 的读超时长，不能在一个请求里等；前端最多查 10 分钟）。草稿只回给老师，不写进讲义（老师点保存才走上面的 `/notes`）。只给还没有讲解的句子写，值得讲的都写、不限句数：按段落顺序 8 句一批，同时最多 2 批；模型 `PIPELINE_MODEL`，`PIPELINE_FALLBACKS` 做备选，关闭思考，每批 60 秒超时；每批第一次在 25 秒内失败、又不是 4xx（上游 5xx、断网、不是 JSON、条目全不合格）才再试一次，超时和 4xx 不再试；所有批都失败才是 `error`，有的批失败就返回成功的草稿加 `message`。权限同 `/notes`（没登录 401，讲义不存在 404，不是自己上传的 403）；没有 Key 503；每一句都有讲解 400；同一位老师一小时超过 10 次、同一篇文章一小时超过 10 次、全站当天超过 100 次 429（次数按点击算，一次点击分几批也只算一次） |
| `GET /api/notes-drafts/:draftId` | 起草结果：`{status:'running', done, total}`（已完成几批 / 共几批）/ `{status:'done', notes:{S03:'…'}, model}`（模型给的是空列表时 `notes` 是 `{}`，不算失败；有的批没起草成时多一个 `message`：「另有 N 句这次 AI 没能起草，可以过一会儿再点一次「AI 起草讲解」。」）/ `{status:'error', error}`。`draftId` 是 24 位随机十六进制；只有发起起草的老师能查，别人（包括没登录）和找不到一样 404；结果只在内存，还在跑的不删，结束的保留最近 50 个、10 分钟 |

要登录的 POST（`/api/uploads`、`/publish`、`/notes`、`/edits`、`/notes/draft`）和注册、登录、退出都只收 `Content-Type: application/json`，别的一律 `415 {error:'请求格式不对'}`（别的网站用表单跨站提交带不上这个类型）；后端不加任何 CORS 头。

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
- 上传的讲义归上传它的老师：写讲解、改题目、发布、看全班的学习记录都要他本人登录。账号功能上线前上传的讲义（meta 里没有 `owner`）谁都不能改、不能发布、不能看全班记录；已经发布的照旧谁都能读。学生端不登录。
- 数据在 `server/data/`（`DATA_DIR`）：`accounts.json`（老师账号，密码只存 scrypt 哈希，邀请码只存 sha256）和 `sessions.json`（会话，只存 token 的 sha256，过期的写盘时顺手删掉）。两个文件都不进仓库、部署不覆盖，备份时和事件数据一起备份。
- 限次（只记在内存，重启清零）：同一用户名 15 分钟内登录失败 10 次先锁住；登录 + 注册全站每分钟最多 60 次。

团队在服务器上用命令行工具管账号（只改 `accounts.json`，服务器按文件修改时间重新读，不用重启）。用和服务相同的用户（`zhishi.service` 里的 `User=ubuntu`）跑，不要加 `sudo`：`accounts.json` 只给属主读写，用 root 写过之后服务就读不了，登录、注册都会出错：

```bash
cd /srv/zhishi
node scripts/teacher.mjs list                       # 列出用户名、称呼、注册时间（北京时间）、讲义数，不输出哈希
node scripts/teacher.mjs reset-password <用户名>    # 老师忘了密码：生成一个 12 位临时密码（只显示这一次）
```

`reset-password` 之后这位老师所有已登录的设备都要用临时密码重新登录；把临时密码私下告诉他，不要发到群里。现在还没有让老师自己改密码的页面，临时密码就是他的新密码。用户名不存在、参数不对时给中文提示、退出码不是 0。`DATA_DIR` 和后端一样：环境变量或 `.env` 里有就用它，否则 `server/data`。也可以写成 `npm run teacher -- list`。

## 更新

```bash
cd /srv/zhishi && git pull && npm ci --omit=dev && sudo systemctl restart zhishi
# 前端：笔记本上 npm run build，再 rsync dist/
```

事件数据在 `server/data/events-*.jsonl`（已在 `.gitignore`），演示前后各备份一次。

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
