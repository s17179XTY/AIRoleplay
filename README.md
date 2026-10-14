# AI 角色扮演（纯本地 PWA）

一个手机优先、**零后端**的 AI 角色扮演 Web 应用：卡片自带 HTML 交互界面，玩家选完偏好后由平台自动装配多层提示词并开局；游玩时 AI 输出的 HTML 会被安全解析成折叠状态栏、正文与可点选项。

设计文档：[docs/superpowers/specs/2026-10-13-fengyue-like-roleplay-app-design.md](docs/superpowers/specs/2026-10-13-fengyue-like-roleplay-app-design.md)
实施计划：[docs/superpowers/plans/2026-10-13-m0-core-playable-loop.md](docs/superpowers/plans/2026-10-13-m0-core-playable-loop.md)

## 快速开始

    npm install
    npm run dev        # 打开手机视口访问 http://localhost:5173
    npm run test       # 49 个测试文件 / 273 个用例
    npm run build      # 类型检查 + 生产构建（产物在 dist/）

首次打开会自动种下一张演示卡，直接就能玩（默认用 mock 模拟模型，不花钱）。

## 部署到 Cloudflare Pages

**线上地址**：[air-roleplay.pages.dev](https://air-roleplay.pages.dev)（Cloudflare 帐号与资源 id 见本机 `wrangler whoami` 与 `worker/wrangler.jsonc`；Pages 项目 `air-roleplay`，Direct Upload 方式）

纯静态站点，没有 Functions、没有服务端依赖，构建产物就是 `dist/`。仓库里已经放好 Pages 需要的三个文件：

| 文件 | 作用 |
|---|---|
| `public/_redirects` | SPA 回退：未命中静态资源的路径一律 `200` 返回 `index.html`，刷新 / 直达任意路径不会 404 白屏 |
| `public/_headers` | 缓存策略：`/assets/*`（带内容 hash）永久缓存，入口 HTML 与 `/` 每次回源校验；附加 `nosniff`、`no-referrer`。**故意不设 CSP**——模型接口地址由用户自定义，CSP 会误伤直连 |
| `.nvmrc` | 钉死 Node 22（Pages 构建镜像 v2 默认 22.16.0，Vite 6 要求 ≥ 22） |

### 方式一：Dashboard 连接 Git（推荐；push 一次自动发布）

1. Cloudflare Dashboard → **Workers & Pages** → Create application → **Pages** → **Import an existing Git repository**
2. 授权 GitHub，选中仓库 `<你的 GitHub 账号>/AIRoleplay`；**Production branch** 填 `main`
3. **Build command**：`npm run build`；**Build output directory**：`dist`（框架预设选 “React (Vite)” 就是这两个值）
4. 环境变量（可选，`.nvmrc` 已足够）：`NODE_VERSION` = `22`
5. Save and Deploy → 线上地址形如 `https://<项目名>.pages.dev`。之后每次 push 到 `main` 自动重新发布，其他分支自动出预览链接

### 方式二：本地 wrangler 直接上传（不接 Git，手动发布）—— **本项目当前用的就是这条**

线上地址：[air-roleplay.pages.dev](https://air-roleplay.pages.dev)（Pages 项目 `air-roleplay`，Direct Upload；`wrangler pages project list` 可见）

    npm install
    npm run build
    npm i -g wrangler@4                                           # 见下方注①，本机 npx 走不通
    wrangler login                                                # 浏览器里点一次 Allow
    wrangler pages project create air-roleplay --production-branch=main
    wrangler pages deploy dist --project-name=air-roleplay --branch=main

改完代码重新发布：`npm run build && wrangler pages deploy dist --project-name=air-roleplay --branch=main`

> 注①：`npx wrangler ...` 在本机会报 `Unknown arguments: ...\wrangler-dist\cli.js, login`（npm 11.12 的 npx 把脚本路径当成了多余参数）。装成全局命令 `wrangler` 就正常。
> 注②：账号里若挂了多个 Cloudflare 帐号，先 `set CLOUDFLARE_ACCOUNT_ID=<account id>` 再执行，避免 wrangler 让你选。
> 注③：**Direct Upload 项目不能事后改成 Git 集成**。想两种都要，就分别建两个 Pages 项目。

### 方式三：部署同步后端（可选；只有「登录 + 跨装置同步」需要）

静态站本身不需要任何后端。要用账号功能时，后端是 `worker/` 里的**独立 Worker**（与 Pages 各自发布，互不绑定）：

    wrangler login                                   # 浏览器里点一次 Allow
    wrangler d1 create dsh-sync                      # 建库，把印出的 database_id 填进 worker/wrangler.jsonc
    wrangler kv namespace create dsh-blobs           # 建 blob 存储，把印出的 id 填进 worker/wrangler.jsonc
    npm run d1:migrate:remote                        # 建表
    wrangler secret put ADMIN_SECRET                 # 邀请码管理端的口令
    npm run worker:deploy                            # 印出的 workers.dev 网址就是 VITE_SYNC_API
    node worker/scripts/mint-invite.mjs "给 alice"    # 产生一次性邀请码

前端要指向这个网址：在本机建 `.env.local`（已被 gitignore）写 `VITE_SYNC_API=https://<你的 worker>.workers.dev`，再 `npm run build` 并部署 Pages。

**blob 存储用 Workers KV 而不是 R2**：R2 免费额度虽有 10 GB，但启用必须绑付款方式（`code 10042`）；
KV 含在 Workers 免费方案内（1 GB/账号、单值 25 MiB、写入 1000 次/日）。

本机开发**不需要部署**：`npm run d1:migrate:local` + `npm run worker:dev` 就能跑，KV 由 Miniflare 模拟。
别忘了把 Pages 域名写进 `worker/wrangler.jsonc` 的 `vars.ALLOWED_ORIGINS`（CORS 白名单，本机开发来源已一并列入）。

> Windows 提示：若 `npm run worker:*` 报 `Unknown arguments`，那是 npm 的 `.cmd` shim 传参问题
> （本机 `node` 若是包装脚本就会踩到，脚本本身没错）。改从 PowerShell 直接执行 `wrangler ...` 即可。

#### 怎么发邀请码

邀请码是**一次性**的：注册成功立刻作废；明文只在产生的那一刻出现一次（数据库只存 sha256，之后连站长也拿不回来）。

**线上最快**（后端已部署好时）：

    $secret = ((Get-Content .env.local | Where-Object { $_ -match '^ADMIN_SECRET=' }) -replace '^ADMIN_SECRET=','').Trim()
    Invoke-RestMethod -Method Post -Uri 'https://<你的 worker>.workers.dev/api/admin/invites' `
      -Headers @{ 'x-admin-secret' = $secret } -ContentType 'application/json' `
      -Body '{"note":"friend","ttlDays":30}'      # ttlDays 省略 = 永不过期

> 注：PowerShell 用 `-Body` 传中文备注会变成 `????`（编码问题，不影响码本身）；要中文备注就用下面的脚本。

**本机或线上用脚本**（会印出可直接执行的 SQL，适合不想把 secret 打进命令历史）：

    node worker/scripts/mint-invite.mjs "friend" 30
    # 再执行它印出的 wrangler d1 execute 指令；本机不要加 --remote

**看还有哪些没用 / 谁用了**：

    wrangler d1 execute dsh-sync --remote --config worker/wrangler.jsonc --command "SELECT substr(code_hash,1,6) AS hash, note, CASE WHEN used_by IS NULL THEN '未使用' ELSE '已使用' END AS status, datetime(created_at/1000,'unixepoch','localtime') AS created FROM invites ORDER BY created_at DESC LIMIT 20;"

> 这台机器上 `wrangler d1 execute` **加 `--json` 会报 `code: 7403 未授权`**，不加就正常。

**收回某人的访问权**：邀请码本身撤不回来（注册时就作废了）。要挡住已注册的人，去设置页「已登录的设备」把那台踢掉（该装置的 token 立刻失效）；要彻底删除，用 SQL 按 `user_id` 删掉 `users` / `sessions` / `records` / `blobs` / `changes` 里对应的行，他的云端数据一并清掉。

## 账号与同步（核心已就绪）

账号、邀请码、零知识加密与同步引擎在 `src/core/sync/`，后端是独立的 Cloudflare Worker（`worker/`）。

- 设计文档：[账号与云同步（零知识加密）设计](docs/superpowers/specs/2026-10-14-account-sync-design.md)
- 实施计划：[核心（M1–M3）](docs/superpowers/plans/2026-10-14-account-sync-core.md) · [界面与 blob（M4–M7）](docs/superpowers/plans/2026-10-14-account-sync-ui-and-blobs.md)

    npm run test -- src/core/sync                    # 只跑同步核心（含两装置整合测试）
    npm run worker:dev                               # 本机起 Worker（需先 npm run d1:migrate:local）
    node worker/scripts/mint-invite.mjs "给 alice"   # 产生一次性邀请码
    node worker/smoke.mjs                            # 对 wrangler dev 打一轮端到端冒烟

服务器全程看不到明文：云端只有 `ciphertext` 与 `kind / id / rev / 时间 / 大小`。
`providers.apiKey` 与 `extraHeaders` 永远不会上传（有测试守着）。
没登录时行为与纯本地版完全一致——同步是可选的加值，不是前提。

**目前进度**：M1（加密层、账号分库、outbox）+ M2（Worker、认证、D1 端点）+ M3（HTTP 客户端、同步引擎、两装置整合）+
M4（blob/KV 传输、素材与 >256 KiB 的卡片互动页）+ M5（设置页账号 UI：注册/登录/解锁/同步状态/冲突/配额/装置管理）+
M6（改密码、恢复码救援）+ M7（线上部署与验证）**全部完成**。

- 后端已部署：Cloudflare Worker `dsh-sync-api`（D1 `dsh-sync` + KV `dsh-blobs`），26 项冒烟对**正式环境**全过。
- 前端已部署：`https://air-roleplay.pages.dev`，注册 → 恢复码 → 同步已在真实浏览器实测通过。
- 端到端测试：`src/core/sync/integration.test.ts`（两装置一致、秘密不外流、离线补推）、
  `src/core/sync/recovery.test.ts`（改密码、忘密码用恢复码救回）。

## 已实现

**卡片体系**
- zip 卡片包（card.json + ui/index.html + prompt.template.md + worldbook.json + regex.json + assets/）
- 导入/导出酒馆（SillyTavern）PNG 角色卡：解析 tEXt 块里的 base64 JSON，V2/V3 都吃
- 卡片编辑器：基本 / 提示词（前置词·提示词·后置词）/ 世界书 / 正则 / 交互界面 + 模板
- 卡片列表：新建、导入、导出、删除、开始游玩

**卡片交互界面（沙箱）—— 这是玩法的起点**

卡片打开后，**聊天框里直接内嵌这张卡自带的 HTML 互动页**（不是聊天记录，而是卡片的操作台）：

1. 在页面里勾选 XP（搜索 / 随机抽 12 种 / 分类展开）、分配全局XP·主人公自身XP·展现XP·NPC XP、填主人公设定与初始剧情、选叙事视角
2. 页面底部实时生成【初始信息设定】
3. 点页面里的「复制内容并开始游戏」→ 平台接管复制写入剪贴板并提示
4. 把这段文本**粘贴到下方输入框发送** → AI 用卡片提示词 + 你贴的初始化信息生成第一轮

**主人公设定 / 前情提要 / 初始剧情 / 开场白全部由互动页决定**，卡片本身不再存这些静态字段。

平台侧实现：
- sandbox="allow-scripts" 的 iframe，CSP 掐断网络，卡片拿不到 API Key、碰不到数据库
- 内嵌在聊天页顶部（可收起），高度自适应
- 声明式字段：data-dsh-field / data-dsh-type / data-dsh-group / data-dsh-value / data-dsh-label，零 JS 也能做卡
- 提示词模板引擎：{{f:字段}}、{{f:字段|sep=,}}、{{f:字段|raw}}、{{?字段}}…{{/字段}}、{{char}} {{scenario}} 等宏
- 生成 → 可编辑预览 → 一键开局（设定作为会话初始信息注入）

**装配内核**
- 12 层条目按 position → priority 排序；世界书触发（关键词 / 次要关键词 / 常驻 / 递归 3 层 / 扫描深度 / 顺序）
- 记忆托管：从 AI 输出里解析记忆区块 → 记忆库 → 满额归档成永久记忆 → 每轮回注，并从历史里剥离避免重复
  - **默认保留 6 条**（设置页可改，保存时才校验）；**可在「记忆库」面板里一键关掉**（关掉后只当普通文字显示，不解析、不归档、不回注）
- token 估算与预算裁剪：先裁最老历史，再裁世界书

**渲染内核**
- 思维链注释剥离、记忆区块提取（**提取后仍留在消息里显示**，折叠起来可展开）、A–F 选项提取（点一下即作为下一轮输入）
- 纯文字回覆也能正常显示（没有标籤的回复以前会渲染成空气泡）
- DOMPurify 白名单清洗（样式属性逐条过滤，position:fixed / z-index / url() 一律剔除）
- details→折叠面板、plot→正文块

**模型接入**
- OpenAI 兼容适配器（DeepSeek / OpenRouter / 中转站 / Ollama）+ 原生 Anthropic Messages 适配器
- 参数能力矩阵：模型不支持的参数不发送，界面直接标注
- 多服务商 + 多模型配置，测试连接，随时切回 mock
- **还没有「使用中」的模型时，保存模型配置会自动切过去**（不必再手动点一次「设为当前」）
- 请求失败时给出「CORS / 网络 / Base URL」三因提示
- **生成中可随时按「停止」**（保留已吐出的部分，不算错误）；等待吐字时有明确提示

**聊天界面**
- **自动滚动可自己控制**：贴着底部时自动跟随；往上滑就停止跟随并出现「回到底部」，不会再被强行拉下去
- 多媒体字号（小 / 中 / 大 / 特大）即时生效，不用重新载入

**数据**
- IndexedDB（Dexie）14 张表；消息是树结构，支持重新生成与分支回溯
- 一键导出/导入全量备份（含素材图片）
- **恢复默认设置**（保留服务商与模型配置）/ **恢复默认卡片** / **清空本机所有数据**
- 登录后可在「账号」里**删除账号与云端数据**（需输入账号名确认，不可复原）

## 未实现（有意留白）

- 社区/评论/MOD 广场/积分充值：纯本地版没有服务器，全部不做
- 语音、AI 生图、群聊卡：按需求砍掉
- Service Worker 离线缓存：目前只有 PWA 清单（可添加到主屏）
- 记忆的「用模型合并归档」（archive: llm）：先用机械合并
- Playwright 端到端：目前用 RTL 组件/集成测试覆盖

## 界面风格

- **只做手机版式**：单一纵列、大点击区，永远铺满可用宽高（不做桌面多栏，也没有固定宽度手机壳）
- **药丸按钮**：所有按钮 / 标签 / 分页都是 `radius: 9999px`（`dsh-btn` / `dsh-chip`）
- **气泡光晕**：AI 消息 `0 8px 26px rgba(0,114,227,.10)` 柔和外发光 + 细阴影；用户消息蓝色渐变 + `0 10px 24px rgba(0,114,227,.30)`
- **状态栏面板**：`#eef5ff` 浅蓝底、圆角 16px、左侧 ▶ 折叠箭头（对齐参考图）
- 设计 token 全部集中在 `src/index.css` 的 `:root` 与 `.dsh-*` 工具类里，改一处全局生效

## 目录结构

    src/core/assembler/   装配内核：条目模型、宏、世界书、预算、装配
    src/core/render/      渲染内核：提取、正则、清洗、管线
    src/core/providers/   适配内核：OpenAI 兼容、Anthropic、SSE、mock、能力矩阵
    src/core/storage/     存储内核：Dexie schema、卡片仓库、记忆、备份
    src/core/cards/       卡片规格、zip 打包、酒馆卡互转、模板、沙箱桥、正则
    src/core/sync/        同步内核：KDF/信封加解密、blob、表↔信封映射、outbox 收敛点、HTTP 客户端、引擎
    worker/               独立的 Cloudflare Worker：wrangler.jsonc + D1 migrations + src + test
    src/ui/               React 手机版界面（游玩 / 卡片列表 / 编辑器 / 交互界面 / 设置）
    src/state/            Zustand 状态（会话、导航、设置）

纪律：`src/core/` 下的四个内核不 import React；`src/ui/` 里不出现提示词拼接与 HTML 解析。

## 卡片包格式

    card.zip
      card.json           清单（spec: "dsh-card/1"）
      ui/index.html       交互界面（可选）
      prompt.template.md  提示词模板（可选）
      worldbook.json      世界书（可选）
      regex.json          正则脚本（可选）
      assets/…            封面与素材

card.json 的 prompts 分三层：pre（前置词）、prompt（主系统提示）、post（后置词）。