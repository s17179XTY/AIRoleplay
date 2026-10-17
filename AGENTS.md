# AGENTS.md — 本项目的硬规矩与工作方式

> 给后续接手这个仓库的 AI / 人看。改任何东西之前先读这一页。
> **正在修 bug 的话，直接跳到 §9「接手须知」**，那里写了现在的状态、怎么验、以及还没做的事。

## 1. 这是什么

一个**手机端 AI 角色扮演 PWA**（未登录＝纯本地，登录＝多一层加密云同步）。核心玩法：

   卡片（zip 包）
     └─ ui/index.html  卡片自带的 HTML 互动页（沙箱 iframe）
          用户在里面选 XP / 填设定 → 页面生成【初始信息设定】
     → 点页面里的「复制内容并开始游戏」→ 平台接管复制到剪贴板
     → 用户粘贴到聊天输入框发送
     → AI 用卡片提示词 + 用户贴的初始化信息生成内容

**主人公设定 / 前情提要 / 初始剧情 / 开场白全部由互动页决定**，卡片里不存这些静态字段，
也**不进提示词**（JSON 字段保留只是为了让导入的卡不坏）。

**本地优先**：没登录时功能与纯本地版完全一致，数据全在 IndexedDB；登录后云端只作**加密同步后端**。
任何时候都不许因为「没登录 / 没网络」挡住玩法。

## 2. 硬约束（违反即视为 bug）

1. **只做手机端 UI**：单一纵列、大点击区、药丸按钮。
   - **基础规则**：外壳必须铺满可用宽高（`width: 100%` + `height: 100dvh`），**不得**有固定宽度 / `max-width`。
   - **唯一例外**：`@media (min-width: 480px)` 里可收成 `max-width: 430px` 并置中。
     手机上（< 480px）必须仍然铺满，门坎不得低于 480px。
   - 卡片自带的 HTML 互动页（跑在 iframe 里）样式由卡片作者决定，不受此限。
   - 唯一允许的百分比宽度是气泡那种自适应宽度（如 `max-w-[78%]`）。
   - `src/ui/layout.test.ts` 同时守住「基础规则没有 max-width」与「宽萤幕媒体查询门坎 >= 480px」。
2. **本地优先**：云端只存密文，服务器不得持有明文。
3. **卡片是数据，不是代码**：`src/core/` 四个内核不得 import React；`src/ui/` 不得出现提示词拼接与 HTML 解析。
4. **`messages.raw` 一旦落库永不修改**；正则 / CSS / 渲染规则的变化只影响展示层（每次现算）。
5. **卡片内置页必须跑在 `<iframe sandbox="allow-scripts">`**：不给 same-origin、CSP 断网，一切经 postMessage 桥。
6. **不引第三方模型 SDK**。
7. 模型由用户自己接；直连失败要给出「CORS / 网络 / Base URL」三种可能。
8. **服务器零知识**：`worker/` 不得有解密代码、日志不得输出 `ciphertext`；
   `providers.apiKey` 与 `extraHeaders` 永不上云（`kinds.ts` 的 `sanitizeForSync`，有金丝雀测试）；
   加密参数一律由调用端传入（测试要注入低成本 KDF）。
9. **严格一对 + 生成期间锁输入**（使用者 2026-10-15 定稿，见 §7）：
   使用者发一句 → AI 回一句，AI 没回完之前**不能发第二句**，也不许出现两条连续的使用者讯息。

## 3. 目录地图

    src/core/assembler/   装配内核：条目模型、宏、世界书触发、token 预算、装配顺序（assemble.ts）、
                          window.ts（窗口/成对规则/摘要覆盖前缀）、summaryPlan.ts（压哪几对、怎么分组）、
                          summarize.ts（摘要压缩请求与解析）
    src/core/render/      渲染内核：思维链/记忆/选项提取、白名单清洗、渲染管线
    src/core/providers/   适配内核：OpenAI 兼容、Anthropic、SSE 解析、mock、能力矩阵、默认参数
    src/core/storage/     存储内核：Dexie schema、卡片仓库(zip)、摘要库(memoryStore)、备份、seed、
                          migrate.ts（旧记忆一次性清理）、modRepo.ts（MOD）、image.ts（图片校验与压缩）
    src/core/cards/       卡片规格(spec.ts)、zip 打包(package.ts)、酒馆 PNG 卡互转、模板引擎、沙箱桥、正则
    src/core/sync/        同步内核：KDF/信封加解密、blob、表↔信封映射(kinds)、outbox 收敛点、HTTP 客户端、引擎(engine)
    worker/               独立的 Cloudflare Worker（wrangler.jsonc + migrations + src + test）；服务器零知识
    src/ui/play/          PlayScreen（聊天）、Composer（输入列 + 上下文图标）、MessageBubble、CardPagePanel
    src/ui/cards/         CardListScreen、CardEditorScreen、ImageSlots、draft.ts（草稿↔卡包）、useAssetUrl
    src/ui/settings/      SettingsScreen、AccountSection、ModSection、DevicesPanel、ConflictPanel
    src/state/            Zustand：useSession（会话/上下文/摘要）、useNav、useSetting、useSync（账号/同步）、
                          useComposer（输入框草稿，切页不丢）、useData（换库广播）
    src/assets/cards/     内置卡的原始文件（ui.html 用 ?raw 打进包里）
    scripts/              真实浏览器验收探针（cdp-ui-check.mjs / cdp-ui-check2.mjs）
    docs/superpowers/     设计文档与实施计划
    docs/reference/       参考素材（从风月爬下来的原版卡片页，仅供比对）

## 4. 常用命令

    npm run dev      # 开发；已开 host，手机同 Wi-Fi 访问 http://<局域网IP>:5173
    npm run test     # vitest（必须全绿）
    npm run build    # tsc --noEmit && vite build（必须无错）

账号/同步（后端是独立的 Worker，需要 Cloudflare 账号；本机开发不需要部署）：

    npm run d1:migrate:local                       # 建本机 D1（在 .wrangler/state，已 gitignore）
    npm run worker:dev                             # 本机起 Worker（http://127.0.0.1:8787）
    node worker/smoke.mjs                          # 对 wrangler dev 打端到端冒烟（31 项）
    node worker/scripts/mint-invite.mjs "给 alice"  # 产生一次性邀请码

    前端指向后端：.env.local 写 VITE_SYNC_API=http://127.0.0.1:8787（本机）或线上 Worker 网址（部署用）。

> **Windows 注意**：本机 `node` 若是包装脚本（DSH 的 `node.cmd`），`npm run worker:*` 会报
> `Unknown arguments`——那是 npm 的 `.cmd` shim 传参问题，不是脚本写错。改从 PowerShell 直接
> 呼叫 `wrangler ...`，或验证脚本用 `node.exe`。

### 部署（两个都做，顺序不能反）

    # 1) Worker（改了 worker/ 才需要）
    $env:CLOUDFLARE_ACCOUNT_ID='1e97aa4de19bc68f8a56272117616e6b'
    wrangler deploy --config worker/wrangler.jsonc
    $env:SMOKE_BASE='https://dsh-sync-api.s17179xty.workers.dev'; $env:ADMIN_SECRET=(Get-Content shots\admin-secret.txt).Trim()
    & "C:\Program Files\nodejs\node.exe" worker/smoke.mjs        # 31 项，必须全过

    # 2) 前端（Pages）
    # 先确认 .env.local 的 VITE_SYNC_API 指向正式 Worker，再 build，否则线上会连本机
    Set-Content .env.local "VITE_SYNC_API=https://dsh-sync-api.s17179xty.workers.dev`nADMIN_SECRET=<secret>" -NoNewline
    npm run build
    wrangler pages deploy dist --project-name air-roleplay --branch main --commit-dirty=true
    # 收工：把 .env.local 改回 http://127.0.0.1:8787（.env.local 已 gitignore，不会进提交）

    线上：https://air-roleplay.pages.dev （每次部署会给一个新的 <hash>.air-roleplay.pages.dev）
    Worker：https://dsh-sync-api.s17179xty.workers.dev
    admin secret：`shots/admin-secret.txt`（shots/ 已 gitignore）

## 5. 每次改完必须做的四件事

1. `npm run test` —— 全绿。**修 bug 要先写一个会失败的测试再修。**
2. `npm run build` —— 类型检查 + 打包无错。
3. **UI 改动必须用无头浏览器实测**（不能只看代码）：
   - 后台起 `npm run dev`；再起一个 Chrome headless（`--headless=new --remote-debugging-port=<port>`
     + 独立的 `--user-data-dir`，窗口 390×844）；
   - 用 CDP 的 `Runtime.evaluate` 驱动真实点击/输入，`Page.captureScreenshot` 截图；
   - 宽度类问题一定要量：`.dsh-shell` 的 `getBoundingClientRect().width` 对比 `window.innerWidth`，
     并检查 `documentElement.scrollWidth > clientWidth`。
   - 探针一：`node scripts/cdp-ui-check.mjs <port> <url>`（走 `node.exe`；截图写到 gitignore 的 `shots/`）。
     验：字级即时生效、输入框到导航的间距、等待提示 + 停止钮、记忆区块仍在讯息里、
     `button button` 必须为 0、往上滑不再被拉回底部、**单颗方向滚动钮**（上滚=回顶/下滚=回底）、**console 零警告**。
   - 探针二：`node scripts/cdp-ui-check2.mjs <port> <url>`。验：
     `body` 底色是白的、底部导航按钮 ≥ 56px、顶栏**不含**「上下文」二字、
     上下文图标在输入框与发送键**之间**且显示数字、按下才出明细（分项 + 合计 + 百分比）、
     ⋮ 菜单按下才展开（含 对话/MOD/记忆）、右上角 **+ 新对话**、图标无边框、菜单宽度适配文字、
     设置页的上下文模式/条数/摘要开关/压缩阈值/MOD 分节/上下文大小滑块、
     聊 4 轮后**真的生成摘要**、MOD 面板、单颗方向滚动钮、对话列表右侧图标与「对话N」命名。
   - 两个探针都会用同一个浏览器 profile，**重复跑会看到上一轮留下的资料**（摘要条数会累加）——
     断言要写成「存在」而不是「等于某个数」。
   - 账号/同步有第三支端到端探针 `shots/e2e-account.mjs`（gitignore；需要本机 Worker 8787 在跑）：
     注册 → 首次同步 → 用 token 直接 pull → 重新载入 → 错密码不能进面板 → 正确密码解锁。
   - `Runtime.enable` 会回放这个 target 之前的 console，所以**导航之后要先清空 logs 数组**再判定。
     退出前会印一行 JSON，`"pass": true` 才算过。**本地和线上各跑一次。**
4. `git commit`（中文提交信息，`fix:` / `feat:` / `chore:` 前缀）。提交信息写**为什么**，不只写改了什么。

## 6. 已知坑（都踩过）

| 现象 | 原因 | 处理 |
|---|---|---|
| dev server 自己崩掉，报 EBUSY watch | Windows 上 fs.watch 撞到被占用/瞬时的文件；Vite 没给 FSWatcher 挂 error 监听 | ① `vite.config.ts` 的 `server.watch.ignored`；② 插件 `dsh-watch-error-guard` 接管 `watcher.on('error')` |
| 某些页面比别的页面窄 | 曾经给外壳加过 max-width；或滚动条占位 | 外壳铺满 + 隐藏滚动条；layout.test.ts 守住 |
| 字号设置不生效 | 只改了外层 div，被内部固定 px 覆盖 | 统一走 CSS 变量 `--dsh-fs`，内部用 em |
| 「卡片不存在或已损坏」 | 早期版本只写了卡片索引行、没写 card.json | `ensureSeedCard()` 自愈；内置卡版本升级自动覆盖 |
| 点两次保存出现两张卡 | 草稿 id 为空，每次保存都当新卡 | `draftToPackage` 保留 base 的 id + 编辑器记 savedIdRef |
| 新建卡片没保存也出现 | 点新建就直接写库 | 改成草稿态：只在内存里起草，保存才落库 |
| 580KB 的卡片页塞进 textarea 卡死 | 内置页很大 | 超过 150KB 只读展示 + 「替换页面文件」 |
| 沙箱里 execCommand('copy') 可能被拦 | iframe 无 same-origin | 桥脚本拦截 `#copy-button`，文本回传宿主写剪贴板 |
| 复制后 AI 没反应 | 忘了我方不自动发送 | 流程就是「用户复制 → 自己粘贴发送」，别改成自动注入 |

同步/后端相关的坑（细节见 `docs/superpowers/plans/2026-10-14-account-sync-core.md` 的「执行期间修正」）：

| 现象 | 原因 | 处理 |
|---|---|---|
| Dexie middleware 完全拦不到写入 | dbcore 堆栈在 `open()` 时定版 | 新实例走 `onDatabaseCreated`；已开的库只能 `close()` → `use()` → `open()` |
| outbox 补写喷 `NotFoundError` | IndexedDB 交易范围在建立时就固定 | `db.ts` 包一层 `_createTransaction`，把 `syncOutbox` 并进每个读写交易 |
| 第二次推送被误判成冲突 | 曾在记录里存 `__rev`，一写就抹掉 | 已同步版本改存独立表 `syncRev`（`[kind+id]`） |
| `keyOf` 算出 `"undefined"` | `settings` 是唯一主键叫 `key` 而不是 `id` 的表 | `kinds.keyOf` 对它单独处理；有测试守 |
| 多装置测试 `DatabaseClosedError` | `switchDatabase` 会关掉前一个连接 | 测试里用 `openDatabase`（不关旧的） |
| `wrangler` 起不来：`newest supported is ...` | 本机 workerd 只支援到前一天 | `compatibility_date` 用 `2026-10-13` |
| `wrangler` 报 `Unknown arguments` 且指向 config | `migrations_dir` 放错层级 | 它属于 **binding 内部**（`d1_databases[].migrations_dir`） |
| 账号没启用 R2 → `code: 10042` | 启用 R2 必须绑付款方式 | **已改用 Workers KV**（免费额度够用） |
| `import.meta.url` 在测试里喷 `The URL must be of scheme file` | vitest 的 jsdom 模块 URL 不是 `file:` | 用 `process.cwd()` 定位 |
| 测试断言「密文不含 `sk-`」随机失败 | base64url 密文本来就可能凑出短字符串 | 短字符串一律不比对；要验加密就写**解密往返断言** |
| blob 上传后另一端立刻取不到 | KV 最终一致（最多 60 秒） | `GET /api/blob/:id` 一律回 404；引擎当 `pending`，**不得**标失败或删本地参照 |
| blob key 用内容哈希做全局去重会泄漏「两个账号有同一文件」 | — | key 一律 `<userId>/<blobId>` |
| 重试后先前推上云的信封永远解不开 | 每次重新加密会换随机 `fileKey` | `fileKey` 存 `blobState.fileKey` 并**重用** |
| 走了 blob 但仍报「单笔超过 256 KiB」 | `sanitizeForSync` 回传整列，明文跟着进信封 | 决定走 blob 后必须 `delete data.text / data.bytes` |
| 前端调新端点回「缺少必要欄位」 | store 字段名写错，测试跑得过但接口对不上 | **`npm run build` 的类型检查会抓到**——这就是 build 必须无错的原因 |
| 冒烟脚本后半段全 401 | 脚本前面 logout 撤销了 session，后面继续用同一个 token | 冒烟脚本在 logout 之后要重新登入 |
| 注册成功但「没看到恢复码」 | 对话框写在「未登录」分支里，注册成功后组件立刻切到已登录分支 | 对话框必须挂在组件最外层（三分支都带） |
| 本机 dev 打本机 Worker 被 CORS 挡 | `ALLOWED_ORIGINS` 只列了 Pages 域名 | `isAllowedOrigin()` 模式匹配放行本机/预览网域/区网 IP |
| **手机上注册/同步一律 `Load failed`，但登入正常** | 两个 bug 叠加：① `blobs` 主键只有 `blob_id`，别人传过同样内容 → 撞主键 → 500；② 最外层 500 **没带 CORS 标头**，浏览器把整个回应丢掉，伺服器错误被伪装成网络错误 | ① migration `0002_blobs_per_user.sql` 复合主键 `(user_id, blob_id)` + `INSERT OR IGNORE`；② catch 必须带 `corsHeaders(...)`。**任何错误回应都要带 CORS 标头。** |
| 同一个 KV key 被并发写入 | KV 对同一个 key 限制每秒 1 次写入 | `ensureBlobUploaded` 用 in-flight map 合并 |
| 邀请码手抄打错就白费 | 库里存的是 `sha256(码)` | 两端都做 `canonicalInviteCode()`；服务端同时试正规范化与原样 |
| `wrangler d1 execute --json` 报 `code: 7403 未授权` | 这台机器的 wrangler 走 `--json` 是另一条 API 路径 | 去掉 `--json` |
| `npm run test` 偶发 `ERR_IPC_CHANNEL_CLOSED`（用例全过但退出码 1） | Windows 上 tinypool 的 worker 收尾竞态 | `vite.config.ts` 用 `pool: 'forks'` + `singleFork: true` + `fileParallelism: false`。**不要改回去。** |

### 使用者实测回報後補上的坑（第一批）

| 现象 | 原因 | 处理 |
|---|---|---|
| **同步一次，本机 API Key 就被清空** | `sanitizeForSync('provider')` 本来就不带秘密（对的），但 `applyRemoteRecord` 直接 `table.put(row)` —— 一封不含秘密的信封把本地整列覆盖掉。同类还有 `cardFile.text`、`asset.bytes` | 套用远端一律走 `kinds.mergeRemoteRow()`：以本地列为底、只覆盖信封真的带来的栏位。**同步只能「补」，不能把本地的东西变少。** |
| 新装置同步完「卡片打开是空的、图全不见」 | `ensureBlobLocal()` 写好了却没有生产代码呼叫它 | `pullChanges()` 收尾调 `fetchRemoteBlobs()`；抓不到就留着下次再试。因此 `blobState` 必须记 `kind` |
| 「近期记忆出现后又消失」 | 渲染层 `details.remove()` 把记忆区块移除了 | **不要在渲染层移除记忆区块**；回注时另有 `stripThink()` 剥离 |
| 整段 AI 回覆是一个**空气泡** | `renderMessage()` 只走 `root.children`，纯文字输入 blocks 为空 | 改走 `root.childNodes`，纯文字产出 `{kind:'text'}`。**任何渲染管线都要问：最朴素的那种输入会长怎样？** |
| **按下「停止」没反应** | `AbortController` 在 `streamReply()` 里才建立，而 `set({streaming:true})` 到真正串流之间还有一串 await | `send()` / `regenerate()` **同步**建立 controller 挂到 `currentAbort`；`streamReply` 开头先检查 `signal.aborted` |
| 「重新生成」会多插一条一模一样的**使用者**讯息 | 旧做法是「把 leaf 指回去 → 再叫一次 `send()`」 | 拆出 `streamReply()` / `runTurn()`：send / regenerate / branchTo 共用，差别只在「挂在谁下面」与「这轮输入是什么」 |
| **同步完 UI 没更新，看起来像资料没了** | 换库 / 套用远端都没有通知画面重读；重新载入页面连的是预设库 | `state/useData.ts`（`bumpData()`）+ `useSession.reload()`；`switchDatabase` / `runSync(applied>0)` / `refresh()` 都要发 |
| 字级设定点了没反应 | `useSetting()` 每个呼叫点各有一份 `useState` | 改成模组层共享快取 + 订阅者广播；换库时 `resetSettingCache()` |
| 输入框下面多一大块空白 | `Composer` 与底部导航**都**加了 `.safe-bottom` | 只有画面最底部那一条能吃 `safe-bottom` |
| 记忆条数栏位「删掉就自己弹回 0」 | `<input type="number" value={number}>` + `Number('')` = 0，受控 input 立刻被写回 | 状态存**字串**、`type="text"`，只在按保存时验证 |
| `<button>` 里包 `<button>` | 气泡外层本来是 `<button>` | AI 气泡外层改 `div role="button"`；探针会数 `button button` 必须为 0 |
| 设置页「点了一下又自己跳回旧值」 | `refresh()` 是异步的，使用者在它 resolve 之前点选就会被旧值盖掉 | `formTouchedRef`：**动过的栏位不再被 refresh 覆盖**，保存后交还控制权。这是真 UX bug |

### 上下文窗口 / 摘要 / MOD / 图片 这一轮补上的坑

| 现象 | 原因 | 处理 |
|---|---|---|
| 「窗口少一条也不肯整个出去」 | 第一版 `computeWindow` 写成「向内扩」，与定稿的「向外扩」相反 | 规则是**把整个交换推到窗口外**。两种语义各有测试 |
| AI 把摘要当成最新资讯 | 摘要位置不对 / 没标注 | 注入在 **before-history（紧贴历史之前）**，标题写死「不是最新消息」，末尾加「以下是最近的原文对话」 |
| 摘要把玩家的选择写成 AI 自己的 | 压缩时揉成一段 | 输出**必须分「用户：」「叙事：」两段**；注入时也分开 |
| 摘要生成到一半使用者又发一句 | 摘要要读当前上下文 | 压缩期间 `summarizing = true`，`send()` 直接 return；取消则不写入、下次重试 |
| 模型一直失败 → 那段对话凭空消失 | 失败只是跳过 | 连续失败 3 次退化为**本地骨架摘要**。**宁可粗糙也不能丢。** |
| 旧记忆条目清不干净（换台装置又回来） | `clear()` 走 deleteRange，outbox 收敛点刻意不对它产生墓碑 | 迁移必须**逐条 `delete(id)`**，测试断言墓碑产生 |
| 「两边都有资料」每次重新登入都被问 | 判据只看「两边非空」 | 加判据：**这个库有没有同步游标**。有游标＝这台装置同步过，直接拉 |
| 选了「以本地为准」结果还是云端赢 | pull 会先把云端写进本地表 | 四步不能省：**拍快照 → 拉一遍拿 rev → 用快照盖回去 → 推上去** |
| 冲突「覆盖回去」之后又冲突一次 | 只写回本地、没动 rev | 覆盖回去时把本地 rev **对齐到那一版**（`setRev`），下一次推送才会被接受 |
| 把 HTML 改名成 `.png` 就能上传 | 只看副檔名 / 只信 `file.type` | **magic byte 白名单**，认不出来一律拒；**SVG 单独拒绝**；再加体积与边长上限 |
| jsdom 没有 `URL.createObjectURL` | 图片预览要用 | `src/test/setup.ts` 补假的（跟 `crypto.subtle` 一样处理） |

### 第二轮使用者实测回報後補上的坑（2026-10-15 第三批，全是真 bug）

| 现象 | 原因 | 处理 |
|---|---|---|
| **上传封面/头像「没有成功应用」** | `ImageSlots` 把新图写进 `base.json`，但保存走 `draftToPackage(draft, base)`，而 **`draft.json` 是打开编辑器那一刻的快照** —— `cover` / `avatar` 根本没进 `card.json`。文件存进库了却没人引用它 | 上传时必须**同时**更新 `base` 与 `draft.json`（见 `CardEditorScreen` 的 `onChange`）。**教训：一个组件有两份状态源时，问一句「保存时读的是哪一份」。** |
| 封面「传不上去」 | 原图上限被我定成 2 MB，手机照片动辄 3–8 MB，直接被拒（只弹了个 toast） | 上限放到 **10 MB**，先解码再压到 512px（压完通常 50–100 KB），尺寸检查放解码之后 |
| **上下文占用「打不开、文字被吞」** | 明细层用 `position: fixed`，却渲染在 `<header class="dsh-header">` 里面，而 header 有 `backdrop-filter: blur(14px)` —— **`backdrop-filter` 会让该元素成为 fixed 定位的包含块**，「全屏遮罩」被关进顶栏那个小盒子 | 明细层挂在 PlayScreen 根节点（跟「对话 / 记忆 / MOD」同一套 `absolute inset-0`）。**教训：`position: fixed` 的祖先里不许有 transform / filter / backdrop-filter / contain。** |
| 状态栏那一条比顶栏灰 | 状态栏显示的是**页面底色**，而 `body` 是 `#f2f2f7` | `body` 底色改白；顶栏加 `padding-top: calc(env(safe-area-inset-top) + 0.875rem)` 让白色延伸到状态栏底下 |
| 顶栏的上下文文字被挤掉 | 一行里塞了卡片名 + 模型 + 上下文 + 四个按钮 | 顶栏只留「卡片名 + 模型」；四个入口收成 ⋮ 菜单；上下文改成输入框旁的环形图标，按下才看明细 |
| 底部导航按钮太小 | `.dsh-chip` 自带 padding，`py-*` 被它盖掉（同权重、声明顺序在后） | 用 `min-h-[64px]` 控制高度（min-height 不会被 padding 规则盖）。**`.dsh-chip` 上不要用 py-\*，会被吃掉。** |
| 占用百分比永远是 0% | 默认 `contextLength` 是 **100 万**，几千 token 就是 0% | 默认改成 **12.8 万**（真实模型量级），阈值压缩才有意义 |

### 第三轮使用者实测回報後補上的坑（2026-10-18，全是真 bug）

| 现象 | 原因 | 处理 |
|---|---|---|
| **注册/登录成功，但同步永远失败、云端空间 0 B、跳出「伺服器內部錯誤」** | Cloudflare D1 每个 prepared statement **最多 100 个绑定参数**。`handlePull` 用 50 组 `(kind,id)` 拼 OR，参数是 1 个 userId + 50×2 = **101** → 真 D1 抛错 → worker 顶层 catch 成 500；首次同步 initialPush >50 笔后第一页 pull 必踩。单元测试用的 `node:sqlite` 上限 32766，所以一直没抓到 | `PAIR_CHUNK = floor((100-1)/2) = 49`；回归测试包一层 D1 代理统计 `bind` 参数数，>100 直接 throw。**任何按「组」拼占位符的查询都要先扣掉固定参数。** |
| **密码错误仍看起来「登入成功」**（直接进账号面板、云端空间 0 B / 1 B、同步失败） | AccountSection 的已登录分支条件只有 `username && status !== signed-out/locked`，而密码错只是把 status 设成 `error` —— 「DEK 到底解出来没有」从来没有被表达 | useSync 新增显式 `unlocked`（只有本次页面成功解出 DEK 才 true）；login 失败回到 `locked`/`signed-out`；面板判据改成 `username && unlocked`。**登录态的 UI 判据不能靠「错误状态之外的状态」。** |
| **摘要越压越大：原文 + 摘要双份注入、每轮都在压同一批** | 窗口 `computeWindow` 不知道摘要覆盖了哪些消息；压完的交换仍留在 `history` 里，于是「压了也不省」，阈值一触发就再压下一批 | `window.ts` 加 `coveredEndIndex()`：**已压成摘要的消息前缀不再进提示词**，窗口从覆盖点之后算起；all 模式用 assemble 的 `dropped` 按**整对**回退（`trimHistoryToExchanges`）。「压哪几对」抽成纯函数 `summaryPlan.ts`，有单测。 |
| **「攒够 2 对再压缩」实际压成 2 条摘要** | 旧实现一次请求压多对、回来拆成多条存储 | `summaryBatchPairs` 现在的语义 = **攒够 N 对 → 合成 1 条摘要**（`planSummaryGroups` 分组）；字数上限按 N 放大（`maxChars = SUMMARY_MAX_CHARS × N`），否则 200 字装不下多条对话。 |
| **压缩后的内容比原文还长**（1 个字压成一整句） | 提示词只要求「文学笔法、保留细节」，没要求比原文短 | 摘要提示词加硬规则「必须比原文更短」；存储前在**模型摘要 / 本地骨架 / 原文保留**三者里取最短（新增 `origin: verbatim`），都不更短就保留原文；界面标「原文保留（已是最短）」。 |
| **聊天头像不生效** | 三层叠加：① `saveCardPackage` 整笔覆盖 record 时只沿用 `coverAssetId`，漏掉 `avatarAssetId`；② `loadCardPackage` 从不拿 record 的图片引用核对 card.json；③ 界面只做 path 全等匹配、头像缺失时不回退封面 | record 沿用两栏 + `backfillImageRefs()`（只回填内存、不写库）；新建 `ui/cards/cardAssets.ts`：path 全等 → basename → 大小写兜底，**头像缺失回退封面**。 |
| **卡片图被塞进 48×48 小方块** | 列表把封面当「行内小图标」用 | 卡片列表改成「整张卡」：封面通栏 16:10 大图，名字/简介/按钮在图下方。 |
| **切去别的 tab 再回来，输入框里的字没了** | 草稿是 Composer 的 `useState`，PlayScreen 卸载就丢 | 草稿移到模组层 `state/useComposer.ts`（按 chatId 分），发送成功才清。**任何「组件卸载后还要留着」的输入状态都不该放组件 state。** |
| 上下滚动按钮方向看反了、两个按钮同时出现 | 旧实现只要 `follow === false` 就同时给「回顶/回底」 | 单颗浮钮 + 方向感：往上滚＝向上三角「回到顶部」、往下滚＝三角**向左旋转**成向下「回到底部」；渐入渐出、有阴影、到顶/到底淡出。 |
| 菜单右上一堆空位、图标带边框 | 菜单写死 `w-44`；⋮ 与上下文图标套了 `.dsh-chip`（自带 border+shadow） | 菜单 `w-max min-w-[6.5rem] whitespace-nowrap`；两个图标按钮改成无边框圆形纯图标；顶部新增 **+ 新对话**（生成中禁用）。 |

## 7. 数据模型与关键规则

- `messages` 是**树**（`parentId` + `chats.currentLeafId`）：重新生成 = 挂第二个孩子，回溯 = 把 currentLeafId 指回历史节点。
- `cardFiles` 是**虚拟文件系统**（`[cardId+path]` 复合主键）：card.json / ui/index.html / worldbook.json / assets/*，导出 zip 就是反向打包。

### 7.1 注入顺序（使用者 2026-10-15 定稿，改之前先问）

```
 1  卡片提示词   card.prompts.prompt      system 10
 2  MOD          mods（enabled，按 order） system 20
 3  卡片前缀词   card.prompts.pre         system 30
 4  全局前缀词   config.prePrompt         system 40
 5  全局提示词   config.prompt            system 50
 6  互动页初始设定 setup（chat.promptSnapshot） system 60
 7  世界书                                 before-history 50+/100+
 8  更早的对话摘要                          before-history 200
 9  历史消息                               history
10  全局后置词   config.postPrompt         post 10
11  卡片后置词   card.prompts.post         post 20
12  本轮输入                              post 30
```

- **不注入**：卡片简介（`description`）、主人公设定（`persona.intro`）、前情提要（`scenario`）。
  JSON 字段保留（导入的卡不坏），只是不进提示词。
- 摘要块的标题写死「**以下内容发生在当前对话之前，不是最新消息**」，末尾加「以下是最近的原文对话」。
- 有 `assemble.test.ts` 逐位断言整条顺序，改动顺序一定会红。

### 7.2 上下文窗口与摘要库

- `settings.contextMode`：`recent`（默认）/ `all`；`settings.contextMessageLimit`：默认 6。
  「条」= user 与 assistant 各算一条，**不含本轮输入**；窗口边界**永不切开一个交换**（向外扩）。
- **记忆库 = 摘要库**（`memories` 表，`tier: 'summary'`）。旧的 `recent` / `permanent` 只在迁移期存在
  （`migrate.ts` 逐条删除 + `memorySchema` 标记，只跑一次）。
- **已压成摘要的消息不再进提示词**：窗口从「最后一条摘要覆盖的消息」之后算起（`coveredEndIndex`）。
  这是第三轮最关键的一条——否则「原文 + 摘要」双份注入、越压越大。
- **什么时候压**（两个触发取先到者）：
  ① 交换掉出窗口（`recent` 模式必须压，否则那段直接丢失）；
  ② **上下文占用 ≥ `settings.summaryTriggerPercent`**（默认 90，可设 50–92）。
- **压哪几对 / 怎么分组**：纯函数 `assembler/summaryPlan.ts` 的 `planSummaryGroups()`（有单测）。
  没到阈值时只压窗口外的、且**攒够 `summaryBatchPairs` 对才动手**（余数留到下一轮）；达到阈值时从最老的开始压，
  压到约 `SUMMARY_TARGET_PERCENT`（75%）停手，一次最多 `SUMMARY_MAX_PAIRS_PER_RUN`（6）对。
- **攒够 N 对 → 合成 1 条摘要**（`summaryBatchPairs` 的语义，不是每对一条）。字数上限按 N 放大
  （`maxChars = SUMMARY_MAX_CHARS × N`）。
- all 模式靠 assemble 预算裁剪，裁完按**整对**回退（`trimHistoryToExchanges`），被裁的那段进摘要库，
  不能出现「没进提示词、也没进摘要」的黑洞。
- **压缩结果不能比原文长**：模型摘要 / 本地骨架 / 原文保留（`origin: 'verbatim'`）三者取最短；
  都不更短就保留原文。**绝不为了「压成一句」而把 1 个字膨胀成一整句。**
- `SUMMARY_MAX_CHARS=200`（单对）/ `SUMMARY_KEEP=100` / `SUMMARY_MERGE_BATCH=10`（超上限时最老 10 条本地合并；
  合并条目上限是 `200×10`，**不能按单对的 200 字截断**——它是唯一的历史载体）。
- 失败：连续 `SUMMARY_FAIL_LIMIT`（3）次 → 退化为本地骨架摘要（`origin: 'local-skeleton'`），UI 会标出来。
- `settings.summaryEnabled`（默认开）；压缩期间 `summarizing = true`，**禁止发送**。

### 7.3 严格一对 + 生成期间锁输入

- `Composer`：`streaming || summarizing` 时**输入框与发送键一起禁用**，placeholder 变
  「AI 正在回复…／正在整理之前的记忆…」，**只留「停止」**（不能连停止都没有，否则卡住只能刷新）。
- **在第一个字之前按停止** → 撤回那条使用者讯息（`db.messages.delete`）、`currentLeafId` 指回它的 parent、
  把文字放进 `useSession.restoreInput`，`Composer` 收到后填回输入框并 `consumeRestoreInput()`。
  为什么必须这样：否则会留下一条没人回覆的使用者讯息，下次发送就变成两条使用者讯息连着。
- 已经吐了字之后按停止 → 保留那半条（`status: 'incomplete'`），这一对仍然成立。
- `send()` 若发现叶子已经是使用者讯息（例如 AI 回覆被删掉）→ **拒绝发送**并提示先按「重新生成」。

### 7.4 MOD / 图片 / 同步

- **MOD**：`mods` 表（`id, enabled, order`），位置在**卡片提示词之后**（system 20）。每轮重新组装 → 天然热插拔。
  设置页「MOD」分节管理；聊天页 ⋮ 菜单里能当场开关。
- **图片**：卡片封面 / 头像存 `assets` 表（`cardFiles` kind='asset'），走既有的加密 blob 通道。
  `card.json.cover` / `card.json.avatar` 是 assets 里的路径，`cardRepo` 会映射成
  `record.coverAssetId` / `record.avatarAssetId`（**保存时两栏都要沿用**，否则整笔覆盖会丢）。
  `loadCardPackage` 会用 record 引用回填 card.json 里缺失/失效的图片字段（只改内存、不写库）。
  界面解析走 `ui/cards/cardAssets.ts`：path 全等 → basename → 大小写兜底，**头像缺失回退封面**。
  卡片列表的封面是**整卡通栏大图**（16:10），不是小方块。导出卡片**默认不含图**（询问后可含）；「导出全部数据」的备份一定带图。
  校验在 `src/core/storage/image.ts`：magic byte 白名单（PNG/JPEG/GIF/WebP）、**拒绝 SVG**、
  原图 ≤10 MB、最长边 ≤4096，再压到封面 512 / 头像 128。
- **账号分库**：`db` 是可换的连接（`export let db` + `openDatabase/switchDatabase`）。未登录 `dsh-roleplay`，
  账号 X 用 `dsh-roleplay@x` —— 天然隔离。
- 同步用的表（Dexie v2 只加表，v3 加 `mods`）：`syncOutbox` / `syncState` / `syncRev` / `syncConflicts` / `blobState`。
  云端 `changes(seq AUTOINCREMENT)` 是增量游标的唯一依据，**不依赖设备时钟**。
- **「两边都有资料」的取舍**：
  - 登入时：本库**没有同步游标** + 本地非空 + 云端非空 → 先问（`status: 'needs-choice'`）。
  - 手动点「立即同步」时：本地**有待推内容**（outbox 非空）+ 云端非空 → 先问。自动同步不打扰。
  - 「以本机为准」= **拍快照 → 归零游标拉一遍（拿 rev）→ 用快照盖回去 → 推上去**（四步，少了第三步就白做）。
  - 冲突面板（`ConflictPanel`）能解密查看被覆盖的那一版，也能「用这一版覆盖回去」（会同步对齐 rev）。

## 8. 测试基线

改之前先跑一遍确认基线：**62 个测试文件 / 436 个用例全绿**，构建通过。

关键回归测试：
- 装配顺序 / 世界书触发 / 正则替换 / 白名单清洗（含 XSS）/ 卡片 zip 往返 / 酒馆卡互转 / 卡片自愈 / 草稿态不落库 / 布局约束。
- 渲染：**纯文字也要渲染成 `text` 区块**、**记忆区块提取后仍留在正文里**、气泡内不得有 `button button`。
- 会话：**「停止」在任何时刻按下都要生效**、**第一个字之前停止要撤回讯息并回填输入框**、
  **「重新生成」不得多插使用者讯息**、**「从这里重开」会自动生成**、生成期间输入框锁住、
  `init()` 幂等（切页面不被截停）、换库后 `reload()`。
- 上下文与摘要：**窗口不切开一个交换（向外扩）**、半对不压、**已压摘要的前缀不再进提示词**、
  **攒够 N 对合成 1 条**（`summaryPlan.test.ts`：没到阈值只压窗口外、余数留到下一轮、达阈值从最老开始压）、
  **多段输出能按 `### n` 拆开**、**压缩结果不比原文长（verbatim 兜底）**、连续失败退化为骨架、库上限 100 与合并 10。
- 后端：**D1 单语句绑定参数 ≤100**（`withD1ParamLimit` 代理 + 60 笔 pull 回归）。
- 同步：加解密往返与 AAD 防搬移、恢复码 round-trip、outbox 三条写入路径、rev 递增与冲突副本、墓碑、
  **秘密字段不上云的金丝雀**、**拉取远端不得清掉本机的 apiKey / 明文**、**两边都有资料的取舍四步**、两装置端到端一致。
- 图片：**伪装的 .png 被拒、SVG 被拒、超限被拒、导出可不含图**、**保存后 avatarAssetId 不丢**、
  头像解析 path 全等/basename 兜底/回退封面。
- 账号：**解锁密码错不能显示已登录面板**（`unlocked` 判据）、错密码保留 locked + 错误信息、正确密码才出账号面板。

后端逻辑用 `node:sqlite`（Node 24 内置）当 D1 替身跑**真 SQL**；workerd 特有的行为靠 `worker/smoke.mjs`。
删除帐号端点另有 `worker/test/account.test.ts`。

## 9. 接手须知（下一步修 bug 从这里开始）

### 现在的状态

- 第三轮实测修复后的提交：见 `git log`（本轮含 D1 参数上限、摘要窗口/语义、账号 unlocked、卡片图/头像、UI 三处）。
- 线上：前端 https://601f15e4.air-roleplay.pages.dev （别名 `air-roleplay.pages.dev`）；
  Worker https://dsh-sync-api.s17179xty.workers.dev （version `72730f34-655d-4102-a630-a4deaf914bd7`）。
- 测试 62 档 / 436 例全绿；build 无错；两个浏览器探针在**本地与线上**都是 `pass: true`、console 零警告；
  账号/同步端到端探针 `shots/e2e-account.mjs` 本地与线上都全过（注册→同步→重载锁定→错密码被挡→正确密码解锁）。
- 规格与计划：
  `docs/superpowers/specs/2026-10-15-context-summary-mod-images-design.md`、
  `docs/superpowers/plans/2026-10-15-context-summary-mod-images.md`
  （**注意：第二轮实测后又改了注入顺序、压缩触发方式、严格一对，这三处以本文件 §7 为准，spec 里是旧版**）。

### 已知还没做 / 可能被投诉的地方

1. **内置卡的提示词措辞没动**，卡片版本也没再升 —— 因为再升一次会**第二次强制覆盖**使用者手改过的内置卡。
   如果使用者抱怨内置卡的「记忆结构定义」和现在的摘要库对不上，先问他要不要覆盖。
2. **「以云端为准」时本地被覆盖的那一版没有留档**。现在 `syncConflicts` 里存的只有「推送被拒、服务器赢」的那一版。
   要做的话：在 pull 覆盖前把本地行抓成副本塞进 `syncConflicts`。
3. **摘要质量只靠提示词**，没有评估集：`verbatim` 兜底只保证「不膨胀」，不代表摘要一定记得好。
   如果使用者说「摘要记得不对」，先看 `summarize.ts` 的提示词与 `SUMMARY_MAX_CHARS`，再看
   `summaryBatchPairs`（攒得越多、一条摘要越难写全）与窗口是不是太小（`contextMessageLimit`）。
4. **图片压缩走 canvas**，jsdom 里没有 canvas，所以单元测试只覆盖校验逻辑；真实压缩只在浏览器有效。
5. `docs/superpowers/` 里的旧 spec / plan 没有随第二、三轮改动更新（以本文件 §7 为准）。
6. 探针脚本的 CDP 截图在 `shots/`（已 gitignore）；重跑同一 profile 会累积资料，断言都写成「存在」。

### 修 bug 的标准流程

1. 先复现：能写测试就**先写一个会失败的测试**（`npm run test -- <file>`）。
2. 改最小的那一处；改完 `npm run test` + `npm run build`。
3. UI 改动 → 起 dev + headless Chrome，跑 `scripts/cdp-ui-check2.mjs`（本地），必要时也跑线上。
4. 提交（中文、说明「为什么」）→ 部署两个（见 §4）→ 再对线上跑一次探针。
5. 把新踩到的坑补进 §6。