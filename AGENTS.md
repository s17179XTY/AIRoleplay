# AGENTS.md — 本项目的硬规矩与工作方式

> 给后续接手这个仓库的 AI / 人看。改任何东西之前先读这一页。

## 1. 这是什么

一个**纯本地（零后端）的手机端 AI 角色扮演 PWA**。核心玩法：

   卡片（zip 包）
     └─ ui/index.html  卡片自带的 HTML 互动页（沙箱 iframe）
          用户在里面选 XP / 填设定 → 页面生成【初始信息设定】
     → 点页面里的「复制内容并开始游戏」→ 平台接管复制到剪贴板
     → 用户粘贴到聊天输入框发送
     → AI 用卡片提示词（前置词 / 提示词 / 后置词）+ 用户贴的初始化信息生成内容

**主人公设定 / 前情提要 / 初始剧情 / 开场白全部由互动页决定**，卡片里不存这些静态字段。

**本地优先**：没登录时就是一个纯本地应用（数据全在 IndexedDB）；登录后多一层**客户端加密的云同步**作为可选加值。同步不是前提，任何时候都不许因为「没登录 / 没网络」挡住玩法。

## 2. 硬约束（违反即视为 bug）

1. **只做手机端 UI**：单一纵列、大点击区、药丸按钮。
   - **基础规则**：应用外壳必须**铺满可用宽高**（`width: 100%` + `height: 100dvh`），且**不得**有固定宽度 / `max-width`。
   - **唯一例外**：`@media (min-width: 480px)` 里可以把外壳收成 `max-width: 430px` 并 `margin-inline: auto` 置中——
     这是使用者明确要的「桌机也看手机比例」。**手机上（< 480px）必须仍然铺满**，门坎不得低于 480px。
   - 除了这个例外，**禁止**给任何页面或容器加固定宽度；卡片自带的 HTML 互动页（跑在 iframe 里）样式由卡片作者决定，不受此限。
   - 唯一允许的百分比宽度是气泡那种自适应宽度（如 `max-w-[78%]`）。
   - 见 `src/ui/layout.test.ts`：它会同时守住「基础规则没有 max-width」与「宽萤幕媒体查询存在且门坎 >= 480px」。
2. **本地优先（不是"零后端"）**：未登录时功能与纯本地版**完全一致**，数据全在浏览器 IndexedDB（Dexie）；登录后云端只作**加密同步后端**，服务器不得持有明文。跨设备仍随时可用「导出/导入全量备份」。
3. **卡片是数据，不是代码**：
   - `src/core/` 四个内核（装配 / 渲染 / 适配 / 存储）**不得 import React**。
   - `src/ui/` **不得出现提示词拼接与 HTML 解析**。
4. **`messages.raw` 一旦落库永不修改**；正则、CSS、渲染规则的变化只影响展示层（每次现算）。
5. **卡片内置页必须跑在 `<iframe sandbox="allow-scripts">`** 里：不给 same-origin、CSP 断网（`connect-src 'none'`），一切数据经 postMessage 桥。卡片拿不到 API Key，也碰不到数据库。
6. **不引第三方模型 SDK**：要自定义 baseURL / 请求头 / 参数能力矩阵，SDK 只会挡路。
7. 模型由用户自己接，**不承诺"所有服务商都能连"**；浏览器直连失败要给出「CORS / 网络 / Base URL」三种可能。
8. **服务器零知识**（登录/同步功能）：
   - `worker/` 里**不得出现任何解密代码**，日志不得输出 `ciphertext`；云端只存密文与 `kind / id / rev / 时间 / 大小`。
   - `providers.apiKey` 与 `providers.extraHeaders`（后者常被塞自定义 `Authorization`）**永不上云**，见 `src/core/sync/kinds.ts` 的 `sanitizeForSync`，有测试守着。
   - `src/core/sync/` 与 `src/core/` 同级：**不得 import React**，也不得依赖 UI 才能跑（同步引擎必须能只用 Dexie + WebCrypto 测起来）。
   - 加密参数（PBKDF2 迭代数等）一律由调用端传入，**不许读模块层常量**，否则测试没法注入低成本参数（600k 迭代会让测试跑成几分钟）。

## 3. 目录地图

    src/core/assembler/   装配内核：条目模型、宏、世界书触发、token 预算、装配顺序、
                          window.ts（上下文窗口与成对规则）、summarize.ts（摘要压缩请求）
    src/core/render/      渲染内核：思维链/记忆/选项提取、白名单清洗、渲染管线
    src/core/providers/   适配内核：OpenAI 兼容、Anthropic、SSE 解析、mock、能力矩阵
    src/core/storage/     存储内核：Dexie schema、卡片仓库(zip)、摘要库、备份、seed、
                          migrate.ts（旧记忆一次性清理）、modRepo.ts（MOD）、image.ts（图片校验）
    src/core/cards/       卡片规格、zip 打包、酒馆 PNG 卡互转、模板引擎、沙箱桥、正则
    src/core/sync/        同步内核：KDF/信封加解密、blob、表↔信封映射、outbox 收敛点、HTTP 客户端、同步引擎
    worker/               独立的 Cloudflare Worker（wrangler.jsonc + migrations + src + test）；服务器零知识
    src/ui/               手机端界面：play / cards / settings / components
    src/state/            Zustand：useSession（当前卡片与会话）、useNav、useSetting（共享快取）、useSync（账号/同步）、useData（换库广播）
    src/assets/cards/     内置卡的原始文件（ui.html 用 ?raw 打进包里）
    docs/superpowers/     设计文档与实施计划
    docs/reference/       参考素材（含从风月爬下来的原版卡片页，仅供比对）

## 4. 常用命令

    npm run dev      # 开发；已开 host，手机同 Wi-Fi 访问 http://<局域网IP>:5173
    npm run test     # vitest（必须全绿）
    npm run build    # tsc --noEmit && vite build（必须无错）

账号/同步（后端是独立的 Worker，需要 Cloudflare 账号；本机开发不需要部署）：

    npm run d1:migrate:local                      # 建本机 D1（在 .wrangler/state，已 gitignore）
    npm run worker:dev                            # 本机起 Worker（http://127.0.0.1:8787）
    node worker/smoke.mjs                         # 对 wrangler dev 打一轮端到端冒烟（31 项）
    node worker/scripts/mint-invite.mjs "给 alice" # 产生一次性邀请码
    npm run worker:deploy / d1:migrate:remote      # 上线用（blob 存储用 KV，不需要付费开 R2）

    前端指向后端：.env.local 写 VITE_SYNC_API=http://127.0.0.1:8787（本机）或线上 Worker 网址（部署用）。
    smoke.mjs 可对正式环境跑：SMOKE_BASE=https://<worker>.workers.dev ADMIN_SECRET=<secret> node worker/smoke.mjs

> **Windows 注意**：本机环境的 `node` 若是包装脚本（例如 DSH 的 `node.cmd`），`npm run worker:*`
> 会报 `Unknown arguments`——那是 npm 的 `.cmd` shim 传参问题，不是脚本写错。改从 PowerShell 直接
> 呼叫 `wrangler ...`（`.ps1` shim 内部写的是 `node.exe`，会绕开包装脚本）即可。

## 5. 每次改完必须做的四件事

1. `npm run test` —— 全绿。修 bug 要**先写一个会失败的测试**再修。
2. `npm run build` —— 类型检查 + 打包无错。
3. **UI 改动必须用无头浏览器实测**（不能只看代码）：
   - 后台启动 `npm run dev`，再起一个 Chrome headless（带 `--remote-debugging-port`、独立的 `--user-data-dir`）；
   - 用 CDP 的 `Runtime.evaluate` 驱动真实点击/输入，`Page.captureScreenshot` 截图；
   - 宽度类问题一定要量：`document.querySelector('.dsh-shell').getBoundingClientRect().width` 对比 `window.innerWidth`，
     并检查 `documentElement.scrollWidth > clientWidth`（横向溢出）。
   - 现成探针：`node scripts/cdp-ui-check.mjs <port> <url>`（走 `node.exe`，见 §4 的 Windows 注意；
     截图会写到 gitignore 掉的 `shots/`）。
     它一次验完：字级即时生效、输入框到导航的间距、记忆托管开关与说明、等待提示 + 停止钮、
     记忆区块仍在讯息里、`button button` 必须为 0、往上滑不再被拉回底部 + 「回到底部」、以及 **console 零警告**。
     `Runtime.enable` 会回放这个 target 之前的 console，所以**导航之后要先清空 logs 数组**再判定。
     退出前它会印一行 JSON，`"pass": true` 才算过。
   - 第二个探针：`node scripts/cdp-ui-check2.mjs <port> <url>`，验的是上下文 HUD（条数 + token + 分项明细）、
     设置页的上下文模式/条数/摘要开关/MOD 分节/上下文大小滑块、聊 4 轮后**真的生成摘要**、
     聊天页的 MOD 面板、右下角两个**只有图标**的滚动钮、对话列表的右侧图标与「对话N」命名，同样要求 console 零警告。
     两个探针都会用同一个浏览器 profile，所以**重复跑时断言会看到上一轮留下的资料**（例如摘要条数累加）——
     断言要写成「存在」而不是「等于某个数」。
4. `git commit`，中文提交信息，`fix:` / `feat:` / `chore:` 前缀。

## 6. 已知坑（都踩过）

| 现象 | 原因 | 处理 |
|---|---|---|
| dev server 自己崩掉，报 EBUSY watch | Windows 上 fs.watch 撞到被占用/瞬时的文件（编辑器临时目录、`.env.local`、其它进程正在写的文件）；Vite 没给 FSWatcher 挂 error 监听，Node 直接把进程干掉 | 双保险：① `vite.config.ts` 的 `server.watch.ignored` 忽略临时文件/密钥/构建产物；② 插件 `dsh-watch-error-guard` 接管 `watcher.on('error')`，忽略这类瞬时错误（已用「反复创建+删除被监视文件」压测：8 轮后 dev server 仍存活） |
| 某些页面比别的页面窄 | 曾经给外壳加过 max-width；或滚动条占位 | 外壳铺满 + 隐藏滚动条；layout.test.ts 守住 |
| 字号设置不生效 | 只改了外层 div，被内部固定 px 覆盖 | 统一走 CSS 变量 `--dsh-fs`，内部用 em |
| 「卡片不存在或已损坏」 | 早期版本只写了卡片索引行、没写 card.json | `ensureSeedCard()` 自愈；内置卡版本升级自动覆盖 |
| 点两次保存出现两张卡 | 草稿 id 为空，每次保存都当新卡 | `draftToPackage` 保留 base 的 id + 编辑器记 savedIdRef |
| 新建卡片没保存也出现 | 点新建就直接写库 | 改成草稿态：只在内存里起草，保存才落库 |
| 580KB 的卡片页塞进 textarea 卡死 | 内置页很大 | 超过 150KB 只读展示 + 「替换页面文件」 |
| 沙箱里 execCommand('copy') 可能被拦 | iframe 无 same-origin | 桥脚本拦截 `#copy-button`，文本回传宿主写剪贴板 |
| 复制后 AI 没反应 | 忘了我方不自动发送 | 流程就是「用户复制 → 自己粘贴发送」，别改成自动注入 |

同步/后端相关的坑（都实测过，细节见 `docs/superpowers/plans/2026-10-14-account-sync-core.md` 的三节「执行期间修正」）：

| 现象 | 原因 | 处理 |
|---|---|---|
| Dexie middleware 完全拦不到写入 | dbcore 堆栈在 `open()` 时定版；open 之后才 `use()` 无效（清 `_core` 也没用） | 新实例走 `onDatabaseCreated` 挂勾（建立时、还没 open）；已开的库只能 `close()` → `use()` → `open()` |
| outbox 补写喷 `NotFoundError` | IndexedDB 的交易范围在建立时就固定，塞不进别的表 | `db.ts` 包一层 `_createTransaction`，把 `syncOutbox` 并进每个读写交易；另有 `ignoreTransaction` 保底 |
| 第二次推送被误判成冲突 | 曾在记录里存 `__rev`，但 App 的正常写入是整笔覆盖，一写就抹掉 | 已同步版本改存独立表 `syncRev`（`[kind+id]`） |
| `keyOf` 算出 `"undefined"` | `settings` 是 14 张表里**唯一主键叫 `key`** 而不是 `id` 的 | `kinds.keyOf` 对它单独处理；补了「14 种 kind 都算得出非 undefined id」的测试 |
| 多装置测试 `DatabaseClosedError` | `switchDatabase` 会关掉前一个连接 | 测试里用 `openDatabase`（不关旧的），两个库同时活着 |
| `npm run worker:*` 报 `Unknown arguments` | 本机 `node` 是包装脚本，npm 的 `.cmd` shim 传参被窜改 | 从 PowerShell 直接调 `wrangler ...`；验证脚本可用 `node.exe` |
| `wrangler` 起不来：`compatibility date ... newest supported is ...` | 本机 workerd 只支援到前一天 | `compatibility_date` 用 `2026-10-13` |
| `wrangler` 报 `Unknown arguments` 且指向 config | `migrations_dir` 放错层级 | 它属于 **binding 内部**（`d1_databases[].migrations_dir`），不是顶层 |
| `wrangler r2 bucket create` 回 `code: 10042` | 账号没启用 R2（启用必须绑付款方式） | **已改用 Workers KV**：含在免费方案内（1 GB/账号、单值 25 MiB、写入 1000 次/日），不需要付款方式 |
| `import.meta.url` 在测试里喷 `The URL must be of scheme file` | vitest 的 jsdom 环境模块 URL 不是 `file:` | 用 `process.cwd()` 定位（见 `worker/test/helpers/migration.ts`） |
| 测试随机失败，断言是「密文不含 `sk-` / `18`」 | base64url 密文本来就可能凑出短字符串 | 短字符串一律不比对；要验「真的加密了」就写**解密往返断言** |
| blob 上传后另一端立刻取不到 | KV 是**最终一致**的（写入后全球生效最多 60 秒） | `GET /api/blob/:id` 一律回 404 让客户端稍后重试；引擎把这种情况当 `pending`，**不得**标记失败或删掉本地参照 |
| blob 的 key 用了内容哈希做全局去重 | 两个账号有同一个文件时，「有同一个文件」这件事会从 key 泄漏 | key 一律 `<userId>/<blobId>`，不做跨账号去重 |
| 重试后先前推上云的信封永远解不开 | 每次重新加密都会换随机的 `fileKey` | `fileKey` 存在 `blobState.fileKey` 并**重用**；`state === 'uploaded'` 就跳过重复上传 |
| 走了 blob 但服务器仍报「单笔超过 256 KiB」 | `sanitizeForSync` 会回传整列，明文（如 1.25 MB 的卡片页）跟着进信封 | 决定走 blob 后必须 `delete data.text / data.bytes`（`engine.pushPending`） |
| 前端调用新端点时服务器回「缺少必要欄位」 | store 里字段名写错（`recoveryAuthKey` vs `newRecoveryAuthKey`），测试跑得过但接口对不上 | **`npm run build` 的类型检查会抓到**——这就是「build 必须无错」不可跳过的原因 |
| 冒烟脚本后半段全部 401 | 脚本前面已经 logout 撤销了 session，后面却继续用同一个 token | 冒烟脚本自己要在 logout 之后重新登入（`session` 变量），别复用死掉的 token |
| 注册成功但用户说「没看到恢复码」 | 恢复码对话框原本写在「未登录」分支里，注册成功后组件立刻切到已登录分支 → 对话框消失 | 对话框必须挂在组件最外层（三个分支都带），否则等于永久失去救援能力；有测试守着 |
| 本机 vite dev 打本机 Worker 被 CORS 挡 | `vars.ALLOWED_ORIGINS` 只列了 Pages 域名 | 本机来源、预览部署网域 `<hash>.air-roleplay.pages.dev`、区网 IP 都由 `isAllowedOrigin()` 模式匹配放行（`worker/src/router.ts`） |
| **手机上注册/同步一律 `Load failed`，但登入正常** | **两个 bug 叠在一起**：① `blobs` 表主键只有 `blob_id`（全域唯一），逻辑却是「每使用者一份」——别人上传过同样内容（内容定址 → 同一 blobId，例如人人开局的內建卡片页）时，新使用者 INSERT 撞主键 → 500；② 最外层的 500 **没带 CORS 标头**，浏览器把整个回应丢掉，于是伺服器错误被伪装成网络错误。 | ① migration `0002_blobs_per_user.sql` 改成复合主键 `(user_id, blob_id)`，插入用 `INSERT OR IGNORE` + 变更数判断（并发安全、不重复扣配额）；② `index.ts` 的 catch 必须带 `corsHeaders(...)`。**教训：任何错误回应都要带 CORS 标头，否则你只会看到一个假的网络错误。** |
| 同一个 KV key 被并发写入 | Cloudflare KV 对**同一个 key** 限制每秒 1 次写入 | 客户端 `ensureBlobUploaded` 用 in-flight map 合并同一个 blob 的上传；服务端 blob 路径也已幂等 |
| 邀请码手抄打错就白费 | 资料库存的是 `sha256(码)`，差一个字元完全对不上 | 客户端与服务端都做 `canonicalInviteCode()`（NFKC → 大写 → 只留英数 → 每 4 字补破折号）；服务端同时试「正规范化」与「原样」两种杂湊，兼容早期或手塞的码 |
| `wrangler d1 execute --json` 报 `code: 7403 未授权` | 这台机器上的 wrangler 走 `--json` 是另一条 API 路径 | 去掉 `--json` 就正常 |

### 使用者实测回報後補上的坑（2026-10-15）

| 现象 | 原因 | 处理 |
|---|---|---|
| **同步一次，本机 API Key 就被清空** | `sanitizeForSync('provider')` 本来就不带 `apiKey` / `extraHeaders`（这是对的），但 `applyRemoteRecord` 直接 `table.put(row)` —— 一封不含秘密的信封把本地整列覆盖掉，秘密就没了。同一类错误还有 `cardFile.text` 与 `asset.bytes`（走 blob，信封只有 `__fileKey`） | 套用远端一律走 `kinds.mergeRemoteRow(kind, remote, local)`：以本地列为底、只覆盖信封真的带来的栏位；provider 还补空字串，免得 UI 拿到 `undefined`。**同步永远只能「补」，不能把本地的东西变少。** |
| 新装置同步完「卡片打开是空的、图全不见了」 | `ensureBlobLocal()` 写好了却**没有任何生产代码呼叫它**：拉到的卡片页/素材只有中继资料，明文永远补不回来（KV 最终一致，pull 当下还可能 404） | `pullChanges()` 收尾调 `fetchRemoteBlobs()`，扫 `blobState.state === 'remote'` 的条目抓回来；抓不到就留着，下次同步再试。因此 `blobState` 必须记 `kind`（否则从 refId 无法反查是哪张表） |
| 「近期记忆出现后又消失，生成完就没了」 | `extractMemories()` 解析成功后 `details.remove()`。串流途中条目还没写完 → 凑不出 `[1]…` → 不移除、看得见；生成结束 → 移除 → 消失 | **不要在渲染层移除记忆区块**。记忆要留在 AI 讯息里显示；回注提示词时另有 `stripMemoryAndThink()` 负责剥离，不会重复 |
| 整段 AI 回覆是一个**空气泡**（只有内距、没有内容） | `renderMessage()` 只走 `root.children`（元素）。回覆完全没标籤时 blocks 是空的 | 改走 `root.childNodes`：纯文字产出 `{kind:'text'}` 区块，交给 React 跳脱 + `whitespace-pre-wrap` 保留换行。**任何渲染管线都要问一句：最朴素的那一种输入会长怎样？** |
| **按下「停止」没反应、生成照样跑** | `AbortController` 在 `streamReply()` 里才建立，而 `set({streaming:true})` 到真正串流之间还有一串 await（读正则、读记忆、组提示词）。这段空窗按停止时 `currentAbort` 还是 null | `send()` / `regenerate()` **同步**建立 controller 并挂到 `currentAbort`，再交给 `streamReply`；`streamReply` 开头先检查 `signal.aborted`。有测试专门按这个时序守 |
| 「重新生成」会多插一条一模一样的**使用者**讯息 | `regenerate()` 是「把 leaf 指回去 → 再叫一次 `send()`」，而 `send()` 必定新增一列使用者讯息 | 拆出 `streamReply()`：`send` 与 `regenerate` 共用它，差别只在「挂在谁下面」与「这一轮的使用者输入是什么」 |
| **同步完 UI 没更新，看起来像资料没了** | 三个原因叠在一起：① 登入/登出会 `switchDatabase()` 换整个 IndexedDB 连线，但没有任何东西通知画面重读；② `runSync` 套用远端变更也不通知；③ 重新载入页面时连的是**预设库**，`refresh()` 没有切回帐号库 | 新增 `state/useData.ts`（`bumpData()` 广播）+ `useSession.reload()`；`switchDatabase` / `runSync(applied>0)` / `refresh()` 都要发；`AppShell` 启动就跑 `refresh()` 把连线切回帐号库 |
| 字级设定点了没反应 | `useSetting()` 每个呼叫点各有一份 `useState`——AppShell（写 `--dsh-fs`）与设定页（那排按钮）互不知情 | `useSetting` 改成模组层共享快取 + 订阅者广播；换库/恢复预设时用 `resetSettingCache()` 作废并重读 |
| 输入框下面多一大块空白 | `Composer` 与 AppShell 底部导航**都**加了 `.safe-bottom`，安全区留白叠了两份 | 只有画面最底部那一条能吃 `safe-bottom`；`Composer` 只留一般内距。量测方式：`input.bottom` 到 `nav.top`（CDP 探针会验） |
| 记忆条数栏位「删掉就自己弹回 0，打不了字」 | `<input type="number" value={number}>` + `Number(e.target.value)`：空字串变成 `0`，受控 input 立刻被写回 0 | 状态存**字串**、`type="text"`，只在按保存时验证（`1–50` 的整数）；预设 6 条 |
| `<button>` 里包 `<button>`（React 警告，点击也可能被吃错） | 气泡外层本来是 `<button>`，而内容里有折叠面板的展开钮与选项钮 | AI 气泡外层改 `div role="button"`；真按钮才用 `<button>`。CDP 探针会数 `button button` 必须为 0 |

### 上下文窗口 / 摘要库 / MOD / 图片 这一轮补上的坑（2026-10-15 第二批）

| 现象 | 原因 | 处理 |
|---|---|---|
| 「窗口少一条也不肯整个出去」 | 第一版 `computeWindow` 写成了「向内扩」：把掉出去的那半条又拉回窗口，与 spec 的「向外扩」相反 | 规则是**把整个交换都推到窗口外**（使用者举的例子就是：第 n 条用户消息出去了，第 n-1 条 AI 消息也要一起出去）。有测试按这两种语义分别守 |
| AI 把摘要当成最新资讯 | 摘要如果放在历史之后、或没有明确标注，模型会以为那是刚刚发生的事 | 摘要注入在 **before-history（紧贴历史之前）**，标题写死「以下内容发生在当前对话之前，不是最新消息」，末尾再加一行「以下是最近的原文对话」 |
| 摘要把玩家的选择写成了 AI 自己的 | 压缩时把整段揉成一段文字 | 压缩输出**必须分「用户：」「叙事：」两段**，解析失败时整段当叙事并在 UI 标注「格式未识别」；注入时也分开 |
| 摘要生成到一半使用者又发了一句 | 摘要要读当前上下文，中途改世界线就对不上 | 压缩期间 `summarizing = true`，`send()` 直接 return；取消则不写入、下次重试 |
| 模型一直失败 → 那段对话凭空消失 | 失败就只是跳过 | 连续失败 3 次退化为**本地骨架摘要**（记下第 X–Y 条与用户当时的输入）。**宁可粗糙也不能丢** |
| 旧记忆条目清不干净（换台装置又回来） | `clear()` 走 deleteRange，outbox 收敛点刻意不对它产生墓碑 | 迁移必须**逐条 `delete(id)`**；测试断言墓碑确实产生 |
| 「两边都有资料」在每次重新登录都被问一次 | 判据只看「两边非空」——同一台装置本来两边就是同一批资料 | 加判据：**这个库有没有同步游标**。有游标＝这台装置同步过，直接拉；没有游标 + 本地非空 + 云端非空，才是真的「两个来源第一次碰面」 |
| 选了「以本地为准」结果还是云端赢 | pull 会先把云端内容写进本地表 | 四步不能省：**拍快照 → 拉一遍拿 rev → 用快照盖回去 → 推上去** |
| 冲突「覆盖回去」之后又冲突一次 | 只写回本地、没动 rev，下一轮 push 的 baseRev 还是对不上 | 覆盖回去时把本地 rev **对齐到那一版**（`setRev(kind, id, item.rev)`），下一次推送才会被接受 |
| 把 HTML 改名成 `.png` 就能上传 | 只看副檔名 / 只信 `file.type` | **magic byte 白名单**（PNG/JPEG/GIF/WebP），认不出来一律拒；**SVG 单独拒绝**（可以带脚本）；再加体积与边长上限 |
| `npm run test` 里 `URL.createObjectURL is not a function` | jsdom 没实作它，而图片预览要用 | 在 `src/test/setup.ts` 补一个假的（跟 `crypto.subtle` 一样处理） |
| 设置页「点了一下又自己跳回旧值」 | `refresh()` 是异步的，使用者在它 resolve 之前点选就会被落地的旧值盖掉 | 加 `formTouchedRef`：**动过的栏位不再被 refresh 覆盖**，保存后再交还控制权。这是真的 UX bug，不是测试问题 |

## 7. 数据模型要点

- `messages` 是**树**（`parentId` + `chats.currentLeafId`）：重新生成 = 挂第二个孩子，回溯 = 把 currentLeafId 指回历史节点。
- `cardFiles` 是**虚拟文件系统**（`[cardId+path]` 复合主键）：card.json / ui/index.html / worldbook.json / assets/*，导出 zip 就是反向打包。
- **上下文窗口**：`settings` 的 `contextMode`（`recent` / `all`）与 `contextMessageLimit`（默认 6）。
  「条」= user 与 assistant 各算一条，**不含本轮输入**。窗口边界**永不切开一个交换**（向外扩）。
- **记忆库 = 摘要库**：`memories` 表，`tier: 'summary'`。掉出窗口的**交换**由模型压成摘要（分「用户 / 叙事」两段），
  注入在**历史之前**并标注「不是最新消息」。20 条上限，超出时最老 5 条本地合并。
  旧的 `recent` / `permanent` 层级只在迁移期存在（`migrate.ts` 逐条删除）。
- **MOD**：`mods` 表（`id, enabled, order`），接在卡片提示词之后（system 35）。每轮重新组装 → 天然热插拔。
- **图片**：卡片封面 / 头像存 `assets` 表，走既有的加密 blob 通道；导出卡片默认不含图（备份仍然带）。
- 全局配置（前缀词 / 后缀词 / 提示词）在 `configs` 表 `scope='global'`。
- **账号分库**：`db` 是可换的连接（`export let db` + `openDatabase/switchDatabase`）。未登录用 `dsh-roleplay`，登录账号 X 用 `dsh-roleplay@x`——两个账号的本地数据天然隔离。
- 同步用的四张表（Dexie v2，只加表）：`syncOutbox`（待推送，`[kind+id]` 去重）、`syncState`（游标 / deviceId / 配额）、`syncRev`（每笔已同步到第几版）、`syncConflicts`（被覆盖版本的本地副本）、`blobState`（素材上传状态）。v3 只加 `mods`。
- 云端的「变更日志」`changes(seq AUTOINCREMENT)` 是增量同步游标的唯一依据：**不依赖任何设备时钟**。

## 8. 测试基线

改之前先跑一遍确认基线：**60 个测试文件 / 394 个用例全绿**，构建通过。
关键回归测试：装配顺序、世界书触发、正则替换、白名单清洗（含 XSS 用例）、卡片 zip 往返、酒馆卡互转、卡片自愈、草稿态不落库、布局约束。
渲染相关的关键回归测试：**纯文字也要渲染成 `text` 区块**（不能是空气泡）、**记忆区块提取后仍留在正文里**、气泡内不得有 `<button>` 包 `<button>`（`src/core/render/pipeline.test.ts`、`src/ui/play/MessageBubble.test.tsx`）。
会话相关的关键回归测试：**「停止」在任何时刻按下都要生效**、**「重新生成」不得多插使用者讯息**、**从这里重开会自动生成**、`init()` 幂等（切页面不被截停）、换库后 `reload()`（`src/state/useSession.test.ts`）。
上下文与摘要：**窗口不切开一个交换（向外扩）**、半对不压、**摘要按对压缩且分「用户/叙事」两段**、连续失败退化为骨架、20 条上限合并（`window.test.ts`、`summarize.test.ts`、`memoryStore.test.ts`）。
同步相关的关键回归测试：加解密往返与 AAD 防搬移、恢复码 round-trip、outbox 三条写入路径都被拦到且远端套用不回灌、rev 递增与冲突副本、墓碑、**秘密字段不上云的金丝雀**、**拉取远端不得清掉本机的 apiKey / 明文**、**两边都有资料时的取舍四步**、两装置端到端一致（`src/core/sync/integration.test.ts`、`src/state/useSync.test.ts`）。
图片：**伪装的 .png 被拒、SVG 被拒、超 2 MB 被拒、导出可不含图**（`src/core/storage/image.test.ts`）。
后端逻辑用 `node:sqlite`（Node 24 内置）当 D1 替身跑**真 SQL**；workerd 特有的行为靠 `worker/smoke.mjs` 对 `wrangler dev` 冒烟。删除帐号端点另有 `worker/test/account.test.ts`（含「别人的帐号不受影响」与「KV 素材一起删」）。