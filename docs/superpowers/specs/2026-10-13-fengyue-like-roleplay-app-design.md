# 风月式 AI 角色扮演平台（纯本地 PWA）设计文档

- 日期：2026-10-13
- 状态：已由用户确认，进入实施
- 决策路径：brainstorming（架构级）→ 本 spec → 实施计划

## 1. 一句话

一个手机优先、纯本地运行（零后端）的 AI 角色扮演 PWA：用户导入或自制「卡片」，卡片自带一份 HTML 交互界面，玩家在界面上勾选偏好 / 填设定，平台自动装配多层提示词并开局；游玩时 AI 输出的 HTML 被安全解析成折叠状态栏、正文与可点选项。

## 2. 已确认的决策（不可随意推翻）

| # | 决策 | 结论 |
|---|---|---|
| 1 | 产品形态 | **纯本地单机版**：无服务器、无账号，数据全在浏览器 IndexedDB；跨端迁移靠「导出/导入全量数据包」；同一 URL 多端打开但只做手机 UI |
| 2 | 卡片格式 | **自有 JSON 为唯一真源 + 酒馆卡兼容适配器**（导入/导出 SillyTavern V2/V3 PNG 卡） |
| 3 | 卡片文件形态 | **zip 卡片包**：card.json + ui/index.html + prompt.template.md + worldbook.json + regex.json + assets/；可导出为酒馆 PNG 卡用于传播 |
| 4 | 游玩页功能 | 全做：多会话、消息级操作（重生成/编辑/删除/复制）、上下文裁剪与 token 计数、渲染管线、选项按钮、世界书、正则（全局+会话）、模型参数、两层自定义配置 |
| 5 | 砍掉的功能 | 评论区、MOD 广场、点赞评分、分享作品、热门存档、上传为 MOD、语音（TTS/麦克风）、AI 生图、群聊卡 |
| 6 | 剧情分支 / 回溯 | **做**，消息以树结构存储 |
| 7 | 记忆 | **平台托管**：解析 AI 输出中的记忆区块 → 存记忆库 → 每轮回注；解析规则可配置，默认内置 details-v1 解析器 |
| 8 | 模型协议 | **OpenAI 兼容 + 原生 Anthropic Messages** 两套适配器 |
| 9 | CORS 兜底 | 不内置代理、不做平台。用户自填 Base URL / API Key / 额外请求头；请求失败时给出明确原因提示 |
| 10 | 卡片 UI 沙箱 | **强沙箱 iframe**：sandbox="allow-scripts"、无 same-origin、CSP 断网，一切数据经 postMessage |
| 11 | 卡片 UI 写法 | **声明式（零 JS）+ postMessage JS API 两条路并存** |
| 12 | 生成提示词之后 | 平台内展示**可编辑预览** → 一键开局；同时保留「复制全文」 |
| 13 | 技术栈 | React + TypeScript + Vite + Tailwind + Radix + Zustand + Dexie + fflate + DOMPurify |
| 14 | 部署 | PWA；开发期本地 dev server，托管后置（必须 HTTPS） |
| 15 | 架构 | **四内核分层**：装配 / 渲染 / 适配 / 存储，均为纯逻辑层；ui/ 内不得出现提示词拼接与 HTML 解析 |

## 3. 非目标（YAGNI）

- 不做账号系统、云同步、社区、支付、积分。
- 不做 TTS / 语音输入 / AI 生图。
- 不做多卡群聊（多 NPC 同场由单卡提示词实现）。
- 不做服务端代理，不承诺「所有模型站都能连」。
- 不做插件 / 第三方扩展体系。

## 4. 术语

- **卡片（Card）**：一个 zip 包，等于一个虚拟文件系统 + 一份 card.json 清单。
- **卡片界面（Card UI）**：卡片包里的 ui/index.html，跑在沙箱 iframe 里的交互页。
- **条目（PromptEntry）**：提示词装配中间表示，{ role, content, position, priority, tokens, source }。
- **世界线（Branch）**：消息树中从根到 currentLeafId 的路径。

## 5. 架构总览

四个内核互不依赖、各自可单测；UI 只消费内核输出。

    ┌───────────── ui/ (React, 手机版) ─────────────┐
    │ play  card-list  card-editor  ui-host  settings │
    └───────┬───────────────┬──────────────┬─────────┘
            │               │              │
      ┌─────▼─────┐  ┌──────▼─────┐  ┌─────▼──────┐
      │ assembler │  │   render   │  │ providers  │
      │ 装配内核  │  │  渲染内核  │  │  适配内核  │
      └─────┬─────┘  └──────┬─────┘  └─────┬──────┘
            └───────┬───────┴──────────────┘
                    │
              ┌─────▼─────┐
              │  storage  │  Dexie / IndexedDB / zip / PNG
              └───────────┘

### 5.1 目录结构

    src/
      core/
        assembler/
          types.ts        PromptEntry 与位置语义
          macros.ts       {{user}} {{char}} {{persona}} {{date}} ...
          sources/        card.ts worldbook.ts memory.ts history.ts config.ts
          budget.ts       token 估算与裁剪
          assemble.ts     条目 → 排序 → 裁剪 → 逻辑消息数组
        render/
          extract.ts      思维链 / 状态栏 / 记忆 / 选项 提取
          regex.ts        正则脚本执行（global → chat 顺序）
          sanitize.ts     HTML 白名单清洗
          scopeCss.ts     卡片 CSS 作用域隔离（@scope + 降级）
          pipeline.ts     管线编排
        providers/
          types.ts        ProviderAdapter / ChatRequest / StreamEvent / Capability
          openai.ts
          anthropic.ts
          sse.ts          通用 SSE 解析
        storage/
          db.ts           Dexie schema 与版本迁移
          cardPackage.ts  zip 读写（fflate）
          stCard.ts       酒馆 PNG 卡导入导出
          backup.ts       全量导出 / 导入
      ui/
        play/ card-list/ card-editor/ ui-host/ settings/ components/
      state/              Zustand stores
      test/               Vitest 单测 + Playwright E2E + mock provider

## 6. 数据模型（Dexie）

    cards             id, name, author, version, description, tags[], coverAssetId,
                      source('local'|'imported-st'|'imported-fy'), spec, createdAt, updatedAt
    cardFiles         [cardId+path], kind('json'|'html'|'css'|'template'|'worldbook'|'regex'|'asset'),
                      text?, assetId?
    assets            id, mime, size, blob
    chats             id, cardId, title, vars, promptSnapshot, providerId, modelPresetId,
                      currentLeafId, createdAt, updatedAt, archived
    messages          id, chatId, parentId, role('user'|'assistant'), raw, status
                      ('complete'|'streaming'|'incomplete'|'error'), tokensIn, tokensOut,
                      model, createdAt
    memories          id, chatId, tier('recent'|'permanent'), text, dateLabel,
                      sourceMessageId, archivedAt, order
    worldbooks        id, name, description
    worldbookEntries  id, worldbookId, keys[], secondaryKeys[], content, constant,
                      selective, position('before-char'|'after-char'), order, depth,
                      recursive, enabled
    regexScripts      id, scope('global'|'chat'), chatId?, name, pattern, flags,
                      replacement, enabled, order, target('display'|'prompt')
    providers         id, label, protocol('openai'|'anthropic'), baseUrl, apiKey,
                      extraHeaders, createdAt
    modelPresets      id, providerId, model, params{...}, capabilities{...}
    configs           id, scope('global'|'card'|'chat'), refId?, memoryLimit,
                      prePrompt, postPrompt, prompt
    cardUiState       [cardId+key], value
    settings          key, value

### 6.1 强制约束

- **messages.raw 永不修改。** 正则、卡片 CSS、渲染规则变化只影响展示。
- **卡片正文不进 cards 表**，一律通过 cardFiles 按需读取。
- **消息是树**：parentId + chats.currentLeafId。当前世界线 = 从 currentLeafId 回溯到根。
- 所有跨版本结构变更走 Dexie version().upgrade()，不写就地迁移脚本。

## 7. 装配内核（最核心）

### 7.1 条目模型

    interface PromptEntry {
      role: 'system' | 'user' | 'assistant';
      content: string;
      position: 'pre' | 'system' | 'before-history' | 'history' | 'after-history' | 'post';
      priority: number;      // 越大越靠近生成位置
      tokens: number;        // 估算值
      source: 'card-pre' | 'card-system' | 'card-post' | 'config-pre' | 'config-post'
            | 'config-prompt' | 'worldbook' | 'memory' | 'history' | 'user';
      mutable: boolean;      // 是否允许被预算裁剪
    }

**装配内核只产出逻辑条目与位置语义；物理映射由适配器负责。** OpenAI 适配器可输出多条 role:"system"；Anthropic 适配器把多个 system 条目合并进顶层 system 数组，把 after-history 条目前插到最后一条 user 消息。这条边界保证「换协议不改装配逻辑」。

### 7.2 装配顺序（从先到后）

| 序 | 来源 | position | 可裁剪 |
|---|---|---|---|
| 1 | 卡片 prompts.pre（前置词） | pre | 否 |
| 2 | 全局配置 prompt（提示词） | system | 否 |
| 3 | 全局配置 prePrompt（前置词） | system | 否 |
| 4 | 卡片 prompts.prompt（系统提示词） | system | 否 |
| 5 | 卡片设定：description / persona / scenario | system | 否 |
| 6 | 世界书（position=before-char，角色定义前） | before-history | 是 |
| 7 | 世界书（position=after-char，角色定义后） | before-history | 是 |
| 8 | 历史消息（从新到旧填预算） | history | 是 |
| 9 | 记忆：永久记忆 → 近期记忆 | after-history | 否 |
| 10 | 会话配置 postPrompt + 全局 postPrompt | after-history | 否 |
| 11 | 卡片 prompts.post（后置词） | post | 否 |
| 12 | 本轮用户输入 | post | 否 |

第 5 步的设定顺序固定为：简介 → 主人公设定 → 世界观/前情提要。

### 7.3 世界书触发算法

1. 扫描范围：最近 depth（默认 4）条消息，匹配口径可配（区分大小写 / 整词匹配）。
2. 命中规则：keys 任一命中即激活；selective=true 时需 keys 与 secondaryKeys 同时命中。
3. constant=true 永远激活。
4. 递归扫描：被激活条目的 content 中出现其它条目的 key 时继续激活，最大 3 层防死循环。
5. 排序：order 升序，constant 优先插入。
6. token 预算：超出 worldbookTokenBudget 时按「constant → 直接命中 → 递归命中」顺序截断，被截断条目在调试面板可见。

### 7.4 记忆托管

- 卡片在 card.json 声明 memory 规则：

      { "parser": "details-v1", "recentLimit": 4, "inject": "after-history",
        "stripFromHistory": true, "archive": "concat" }

- details-v1 解析器：从 AI 输出中抓「近期记忆」「永久记忆」折叠区块，条目按 [n]（日期）内容 切分。
- 归档：recent 条数达到 recentLimit 时，最旧的 N 条合并为一条 permanent（archive:"concat" 机械合并；预留 archive:"llm" 走一次额外模型调用）。
- 回注：永久记忆（按时间序）在前、近期记忆在后，格式化为一条 after-history 条目。
- stripFromHistory=true 时，装配历史消息会**剥掉**消息里的记忆区块，避免与回注重复占用 token。

### 7.5 token 估算与预算

- 可插拔 Tokenizer；默认启发式：汉字 ≈ 0.6 token/字，其它字符 ≈ 0.25 token/字。
- 首轮响应收到 usage 后用实际值线性校准估算系数。
- budget = contextLength - maxTokens - reserve(512)；裁剪顺序：历史（从最老）→ 非恒定世界书 → 记忆（仅截断近期）→ 不可裁项永不裁剪；若仍超限，发送前报错并提示用户缩小卡片或上下文。

### 7.6 宏

{{user}} {{char}} {{persona}} {{date}} {{time}} {{weekday}}，在装配最后一步统一替换；卡片里未定义的宏原样保留（便于卡作者调试）。

## 8. 渲染内核

### 8.1 管线

    raw
    ① 思维链提取：<!--<think>…</think>--> 或 <!--…--> → 丢弃或折叠（可配）
    ② 正则脚本：global → chat 顺序执行（target=display）
    ③ DOMParser 解析整段
    ④ 结构识别：details/summary → 折叠组件；plot → 正文容器；hr.separator → 分隔线
    ⑤ 选项提取：正文尾部 A.–F. 的段落序列 → 选项按钮（点击即作为下一轮输入）
    ⑥ 记忆区块提取（托管开启时）→ 交记忆库，并从渲染树移除
    ⑦ DOMPurify 白名单清洗
    ⑧ 卡片内置 CSS 注入（作用域隔离）
    ⑨ React 渲染

### 8.2 白名单

- 标签：details, summary, p, br, hr, span, div, b, i, em, strong, u, s, h1–h6, ul, ol, li, table, thead, tbody, tr, td, th, blockquote, code, pre, img, ruby, rt, small, sub, sup, mark, del, ins
- 属性：class, style（过滤后）, src（仅 data:/blob:）, alt, colspan, rowspan, data-*
- style 允许：color, background-color, font-*, text-*, line-height, margin*, padding*, border*, border-radius, opacity, width, height, max-width, display(flex/grid 子集)
- style 禁止：position:fixed, z-index > 10, url() 非 data:/blob:, expression(), behavior

### 8.3 卡片 CSS 作用域隔离

- 首选 @scope (.dsh-card-scope[data-card="<id>"]) { ... }（Safari 17.4+ / Chrome 118+）。
- 检测失败时降级：解析 CSS，为每个选择器加前缀 .dsh-card-scope[data-card="<id>"] 。
- 卡片 CSS 只注入到该卡片会话的消息容器内，绝不进全局样式。

## 9. 卡片 HTML 界面协议

### 9.1 宿主

    <iframe sandbox="allow-scripts" srcdoc="...">
      <!-- 注入 CSP：default-src 'none'; style-src 'unsafe-inline';
           script-src 'unsafe-inline'; img-src data: blob:; connect-src 'none' -->
    </iframe>

卡片看不到 API Key、碰不到 IndexedDB，也无法发起网络请求。

### 9.2 宿主桥

平台在卡片 HTML 的 head 注入一段桥脚本，职责：
1. 扫描 data-dsh-* 声明式字段并收集值；
2. 转发 postMessage；
3. 上报内容高度用于 iframe 自适应。

平台的「生成提示词」按钮在 iframe **外面**（卡片 JS 崩了也点得动）。

### 9.3 声明式字段

    <label data-dsh-field="xp" data-dsh-type="checkbox"
           data-dsh-group="第一类：世界观" data-dsh-value="A12"
           data-dsh-label="萝莉">萝莉</label>
    <input data-dsh-field="name" data-dsh-type="text" data-dsh-label="姓名">

data-dsh-type：checkbox / radio / text / textarea / number / select / switch / group。

### 9.4 提示词模板（prompt.template.md）

| 语法 | 含义 |
|---|---|
| {{f:字段名}} | 字段值；复选多值以 、 连接 |
| {{f:字段名\|sep=,}} | 指定分隔符 |
| {{?字段名}} … {{/字段名}} | 字段非空才输出该段 |
| {{user}} {{char}} | 标准宏 |

### 9.5 postMessage API

平台 → 卡片：dsh:init（卡片名/主题/变量/持久状态）、dsh:collect、dsh:result
卡片 → 平台：dsh:ready、dsh:fields、dsh:generate、dsh:state:set、dsh:state:get、dsh:toast、dsh:resize、dsh:open

dsh:generate 的结果进入「提示词预览页」：可编辑 →「开始游玩」建会话并注入；同时提供「复制全文」。

## 10. 适配内核

    interface ProviderAdapter {
      id: 'openai' | 'anthropic';
      listModels(cfg: ProviderConfig): Promise<string[]>;
      streamChat(req: ChatRequest, signal: AbortSignal): AsyncIterable<StreamEvent>;
    }

    type StreamEvent =
      | { type: 'text'; delta: string }
      | { type: 'reasoning'; delta: string }     // Claude thinking / DeepSeek reasoning_content
      | { type: 'usage'; inputTokens: number; outputTokens: number }
      | { type: 'done'; finishReason: string }
      | { type: 'error'; error: ProviderError };

- 能力矩阵 Capabilities：temperature, topP, presencePenalty, frequencyPenalty, maxTokens, contextLength, thinkingBudget, prefill, systemRole。
- 模型参数面板按能力矩阵渲染；不支持的参数不发送，并在该行标注原因（如「Claude 不接受频率惩罚」「Grok 不接受 max_tokens」）。
- 请求头、Base URL、模型名列表全部用户可编辑；提供「测试连接」按钮。
- 不引第三方 SDK（要自定义 baseURL / headers / 能力矩阵，SDK 只会挡路）。

## 11. 卡片包格式

    card.zip
      card.json           清单（spec: "dsh-card/1"）
      ui/index.html       交互界面（可选）
      prompt.template.md  提示词模板（可选）
      worldbook.json      世界书（可选）
      regex.json          正则脚本（可选）
      assets/…            封面与素材

card.json 关键字段：

    {
      "spec": "dsh-card/1", "id": "uuid", "name": "", "author": "", "version": "1.0.0",
      "description": "", "tags": [], "cover": "assets/cover.png",
      "prompts": { "pre": "", "prompt": "", "post": "" },
      "persona": { "name": "{{user}}", "gender": "", "intro": "" },
      "scenario": "", "firstMessage": "", "mesExample": "",
      "ui": { "entry": "ui/index.html", "autoOpen": true },
      "promptTemplate": "prompt.template.md",
      "worldbook": "worldbook.json", "regex": "regex.json",
      "memory": { "parser": "details-v1", "recentLimit": 4, "inject": "after-history",
                  "stripFromHistory": true, "archive": "concat" },
      "defaults": { "providerId": null, "model": null, "params": {} }
    }

导入导出映射：
- 导入酒馆卡：PNG 的 tEXt 块 ccv3 优先、chara 兜底 → base64 → JSON → description/personality/scenario/first_mes/mes_example/system_prompt/post_history_instructions/character_book 映射到本格式。
- 导出酒馆卡：反向映射，写回 chara（并尽量写 ccv3），写入前先删除同名块。
- 导入风月式卡片：按前置词/提示词/后置词/内置 CSS 映射到 prompts.* 与 ui。

## 12. 错误处理与降级

| 场景 | 处理 |
|---|---|
| 请求失败（TypeError / Failed to fetch） | 提示三种可能：服务商不允许浏览器直连（CORS）、网络不通、Base URL 错误；给「测试连接」 |
| 401 / 402 / 429 | 分别提示 Key 无效 / 余额或额度 / 限流并自动退避重试 |
| 流式中断 | 保留已收内容为 incomplete 消息，提供「继续生成」（Anthropic 用 prefill，OpenAI 用续写指令） |
| IndexedDB 配额超限 | 明确提示 + 引导导出备份 |
| 卡片导入失败 | 区分 zip 损坏 / 缺 card.json / spec 版本不支持，逐条给出原因 |
| 单条消息渲染异常 | ErrorBoundary 降级为纯文本显示，不白屏 |
| 卡片界面 iframe 崩溃 | 显示「界面加载失败」+ 纯提示词模式兜底入口 |

## 13. 测试策略

**Vitest 单测（内核为主）**
- 装配顺序与条目排序、宏替换、token 预算裁剪边界
- 世界书：关键词命中 / 次要关键词 / constant / 递归 / depth / 预算截断
- 记忆：details-v1 解析、满 4 条归档、回注格式、历史剥离
- 正则：$1/$2 分组、global→chat 顺序、display/prompt 目标
- 渲染：思维链提取、选项提取、白名单清洗（含 XSS 用例）、CSS 作用域
- 卡片包：zip 往返、酒馆 PNG 卡导入导出往返
- SSE 解析：分片、乱序、中断
- 各适配器能力矩阵：不支持参数被剔除

**Playwright E2E（手机视口，全部打 mock provider）**
导入卡片 → 打开 HTML 界面 → 勾选 → 生成提示词 → 预览编辑 → 开局 → 流式渲染 → 折叠状态栏展开 → 点击选项 → 重新生成 → 切分支回溯 → 导出记录。

## 14. 里程碑

| 里程碑 | 内容 | 验收 |
|---|---|---|
| M0 | 工程骨架：Vite + React + TS + Tailwind + PWA + Dexie + 路由 + 设置页（provider 配置 / 测试连接）+ mock provider | npm run dev 打开是手机版空壳，能配置并「连通」mock 模型 |
| M1 | 卡片包与编辑器：zip 读写、card.json schema 校验、卡片列表、导入导出、酒馆卡互转、编辑器（分层提示词/世界书/正则） | 能导入酒馆 PNG 卡并编辑保存 |
| M2 | 装配 + 渲染 + 游玩页：全装配内核、渲染管线、流式、消息操作、上下文裁剪 | 用 mock 模型跑完一整轮，状态栏/选项渲染正确 |
| M3 | 卡片 HTML 界面：沙箱宿主、桥脚本、声明式字段、模板引擎、预览编辑、一键开局 | 用示例卡片（XP 选择器）走通「选择→生成提示词→开局」 |
| M4 | 记忆托管、分支回溯、世界书高级、正则两层、全量备份导出导入 | 12 轮对话后记忆正确归档与回注 |
| M5 | 打磨：页面设置、虚拟滚动、配额提示、性能 | 长会话（200+ 消息）流畅 |

## 15. 风险

| 风险 | 缓解 |
|---|---|
| CORS 导致部分服务商不可用 | 明确错误提示 + 自定义请求头 + 文档列出可直连服务商 |
| IndexedDB 被浏览器清理 | navigator.storage.persist() + 定期提醒导出备份 |
| @scope 兼容性 | 降级为选择器前缀化 |
| 长会话渲染性能 | 虚拟滚动 + 按需渲染 + 正则结果缓存 |
| 卡片作者门槛 | 声明式零 JS 路径 + 官方示例卡 + 模板文档 |
| 消息树导致 UI 复杂 | 默认线性视图，分支只在「重新生成/回溯」时出现提示 |

## 16. 未决（实施中决定，不阻塞开工）

- 记忆 archive:"llm" 的模型调用规格（M4 再定）。
- 卡片包是否加签名/版本兼容策略（M1 先做 spec 版本号校验）。
- 页面设置（主题/字号/背景）的具体项（M5 再定）。
