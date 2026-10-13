# AI 角色扮演（纯本地 PWA）

一个手机优先、**零后端**的 AI 角色扮演 Web 应用：卡片自带 HTML 交互界面，玩家选完偏好后由平台自动装配多层提示词并开局；游玩时 AI 输出的 HTML 会被安全解析成折叠状态栏、正文与可点选项。

设计文档：[docs/superpowers/specs/2026-10-13-fengyue-like-roleplay-app-design.md](docs/superpowers/specs/2026-10-13-fengyue-like-roleplay-app-design.md)
实施计划：[docs/superpowers/plans/2026-10-13-m0-core-playable-loop.md](docs/superpowers/plans/2026-10-13-m0-core-playable-loop.md)

## 快速开始

    npm install
    npm run dev        # 打开手机视口访问 http://localhost:5173
    npm run test       # 82 个测试
    npm run build      # 类型检查 + 生产构建

首次打开会自动种下一张演示卡，直接就能玩（默认用 mock 模拟模型，不花钱）。

## 已实现

**卡片体系**
- zip 卡片包（card.json + ui/index.html + prompt.template.md + worldbook.json + regex.json + assets/）
- 导入/导出酒馆（SillyTavern）PNG 角色卡：解析 tEXt 块里的 base64 JSON，V2/V3 都吃
- 卡片编辑器：基本 / 提示词（前置词·提示词·后置词）/ 世界书 / 正则 / 交互界面 + 模板
- 卡片列表：新建、导入、导出、删除、开始游玩

**卡片交互界面（沙箱）**
- sandbox="allow-scripts" 的 iframe，CSP 掐断网络，卡片拿不到 API Key、碰不到数据库
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
