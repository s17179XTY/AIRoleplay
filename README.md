# AI 角色扮演（纯本地 PWA）

一个手机优先、**零后端**的 AI 角色扮演 Web 应用：卡片自带 HTML 交互界面，玩家选完偏好后由平台自动装配多层提示词并开局；游玩时 AI 输出的 HTML 会被安全解析成折叠状态栏、正文与可点选项。

设计文档：[docs/superpowers/specs/2026-10-13-fengyue-like-roleplay-app-design.md](docs/superpowers/specs/2026-10-13-fengyue-like-roleplay-app-design.md)
实施计划：[docs/superpowers/plans/2026-10-13-m0-core-playable-loop.md](docs/superpowers/plans/2026-10-13-m0-core-playable-loop.md)

## 快速开始

    npm install
    npm run dev        # 打开手机视口访问 http://localhost:5173
    npm run test       # 26 个测试文件 / 93 个用例
    npm run build      # 类型检查 + 生产构建（产物在 dist/）

首次打开会自动种下一张演示卡，直接就能玩（默认用 mock 模拟模型，不花钱）。

## 部署到 Cloudflare Pages

**线上地址：https://air-roleplay.pages.dev**（Cloudflare 帐号 `<cloudflare-account>'s Account`，Pages 项目 `air-roleplay`，Direct Upload 方式）

纯静态站点，没有 Functions、没有服务端依赖，构建产物就是 `dist/`。仓库里已经放好 Pages 需要的三个文件：

| 文件 | 作用 |
|---|---|
| `public/_redirects` | SPA 回退：未命中静态资源的路径一律 `200` 返回 `index.html`，刷新 / 直达任意路径不会 404 白屏 |
| `public/_headers` | 缓存策略：`/assets/*`（带内容 hash）永久缓存，入口 HTML 与 `/` 每次回源校验；附加 `nosniff`、`no-referrer`。**故意不设 CSP**——模型接口地址由用户自定义，CSP 会误伤直连 |
| `.nvmrc` | 钉死 Node 22（Pages 构建镜像 v2 默认 22.16.0，Vite 6 要求 ≥ 22） |

### 方式一：Dashboard 连接 Git（推荐；push 一次自动发布）

1. Cloudflare Dashboard → **Workers & Pages** → Create application → **Pages** → **Import an existing Git repository**
2. 授权 GitHub，选中仓库 `s17179XTY/AIRoleplay`；**Production branch** 填 `main`
3. **Build command**：`npm run build`；**Build output directory**：`dist`（框架预设选 “React (Vite)” 就是这两个值）
4. 环境变量（可选，`.nvmrc` 已足够）：`NODE_VERSION` = `22`
5. Save and Deploy → 线上地址形如 `https://<项目名>.pages.dev`。之后每次 push 到 `main` 自动重新发布，其他分支自动出预览链接

### 方式二：本地 wrangler 直接上传（不接 Git，手动发布）—— **本项目当前用的就是这条**

线上地址：**https://air-roleplay.pages.dev**（Pages 项目 `air-roleplay`，Direct Upload；`wrangler pages project list` 可见）

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
- token 估算与预算裁剪：先裁最老历史，再裁世界书

**渲染内核**
- 思维链注释剥离、记忆区块提取、A–F 选项提取（点一下即作为下一轮输入）
- DOMPurify 白名单清洗（样式属性逐条过滤，position:fixed / z-index / url() 一律剔除）
- details→折叠面板、plot→正文块

**模型接入**
- OpenAI 兼容适配器（DeepSeek / OpenRouter / 中转站 / Ollama）+ 原生 Anthropic Messages 适配器
- 参数能力矩阵：模型不支持的参数不发送，界面直接标注
- 多服务商 + 多模型配置，测试连接，随时切回 mock
- 请求失败时给出「CORS / 网络 / Base URL」三因提示

**数据**
- IndexedDB（Dexie）14 张表；消息是树结构，支持重新生成与分支回溯
- 一键导出/导入全量备份（含素材图片）
- 阅读字号设置

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