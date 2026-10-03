# 部署说明

结构：Nginx 托管前端静态文件（`dist/`），`/api` 反代到本机 Node 后端 `server/index.mjs`（只监听 `127.0.0.1:8787`）。笔记本本地再跑一份兜底。

## 后端接口

| 接口 | 说明 |
|---|---|
| `POST /api/events` | 单个事件或数组（≤200 条），整批校验通过才写，追加到 `DATA_DIR/events-<handoutId>.jsonl`，返回 `{ok, accepted}` |
| `GET /api/events?handoutId=&since=` | 返回 `ts > since` 的事件数组，教师页自己聚合 |
| `POST /api/writing-check` | `{handoutId, text(≤1200), expressions:[{id,text,zh,example}]}` → `{results:[{id,used,verdict,reason}], grammar, model, fallback:false}`，`grammar` 是最多 3 处可能的语法问题 `[{quote,type,hint}]`（`quote` 必是学生原话的片段；没问题是 `[]`，模型没给或一条都不合格是 `null`）；8 秒超时或任何错误返回 `{fallback:true, results:[]}`，前端回落到规则检查 |
| `GET /api/health` | `{ok, llm, model}`，`llm` 表示有没有读到 Key |
| `POST /api/uploads` | 上传文章 `{device, title, text, mustWords?, checkIns?, focus?}` → `202 {jobId, editKey}`；上传不设口令，`editKey` 只用来写讲解（见下）。输入不合格 400、没有 Key 503；已有任务在跑、同一设备一小时超过 5 篇、全站当天超过 60 篇 429。接口约定见 `docs/上传设计.md` |
| `GET /api/uploads/:jobId` | 生成进度：`running` / `done`（带 `handoutId`、入库报告）/ `error`；任务只在内存，保留最近 20 个 |
| `GET /api/handouts/:id` | 单份讲义 JSON，存在 `DATA_DIR/handouts/`。没有公开列表，拿到链接才能打开 |
| `POST /api/handouts/:id/publish` | → `{ok:true}` |
| `POST /api/handouts/:id/notes` | 老师讲解 `{key, notes: {S01: '…', …}}` → `{ok:true, count}`（`count` 是现在有讲解的句子数）；`key` 是上传时拿到的 `editKey`（存在讲义的 meta 和上传那台浏览器里），对不上或这份讲义没有就 403，拿到学生链接的人改不了。给了的句子写进去（去掉首尾空白），空字符串就删掉，没给的不动。格式不对、句子 id 不在讲义里、超过 600 字 400；讲义不存在 404。同一份讲义的保存排队，先写临时文件再改名 |
| `POST /api/handouts/:id/edits` | 老师改 AI 起草的原句题、梯子、段意题 `{key, sentences?: {S03: {question?: {prompt, options, answer}, ladder?: {subject, predicate, l2, plain, glosses: [{term, zh}]}}}, paragraphs?: {2: {gist: {prompt, options, answer}}}}` → `{ok:true, handout}`；只发改过的块，给了的整块换掉（题目 id 不变），来源记成 `{by:'human', reviewedBy:'teacher'}`。口令同 `/notes`（不对 403，不是上传的讲义或不存在 404）。规则和校验器一致：梯子第 1 步「谁」「做了什么」必须是原句原话，选项 2–4 个、不空、不重复，答案序号在范围内，题目、选项、梯子里不能有语法术语（老师讲解不受此限），难词只能改中文意思；去掉首尾空白后检查。有一处不合格就一处都不写，`400 {error, fields: {'S03.ladder.subject': '梯子第 1 步的「谁」必须是原句里的原话', …}}`。和 `/notes` 排同一条保存队，先写临时文件再改名。学生已经答过的记录不变 |
| `POST /api/handouts/:id/notes/draft` | AI 起草讲解 `{key, device}` → `202 {draftId}`：只做检查、记次数，模型在后台跑，前端每 1.5 秒查下面的 `/api/notes-drafts/:draftId`（模型一次 12–38 秒，比 nginx 的读超时长，不能在一个请求里等）。草稿只回给老师，不写进讲义（老师点保存才走上面的 `/notes`）。只给还没有讲解的句子写，最多 8 句；模型 `PIPELINE_MODEL`，`PIPELINE_FALLBACKS` 做备选，关闭思考，60 秒超时；第一次在 25 秒内失败、又不是 4xx（上游 5xx、断网、不是 JSON、条目全不合格）才再试一次，超时和 4xx 不再试。讲义不存在 404；口令不对 403；`device` 不对、每一句都有讲解 400；没有 Key 503；同一设备一小时超过 10 次、同一篇文章一小时超过 10 次、全站当天超过 100 次 429 |
| `GET /api/notes-drafts/:draftId` | 起草结果：`{status:'running'}` / `{status:'done', notes:{S03:'…'}, model}`（模型给的是空列表时 `notes` 是 `{}`，不算失败）/ `{status:'error', error}`。`draftId` 是 24 位随机十六进制；结果只在内存，保留最近 50 个、10 分钟，找不到 404 |

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
ENV_FILE=/path/to/.env npm run server   # 后端 127.0.0.1:8787
npm run dev                             # 前端，/api 由 Vite 代理到 8787
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
