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

## 2. 硬约束（违反即视为 bug）

1. **只做手机端 UI**：单一纵列、大点击区、药丸按钮。
   - 应用外壳必须**铺满可用宽高**（`width: 100%` + `height: 100dvh`）。
   - **禁止**给页面或容器加固定宽度 / `max-width`。唯一例外：卡片自带的 HTML 互动页（跑在 iframe 里，样式由卡片作者决定）。
   - 唯一允许的百分比宽度是气泡那种自适应宽度（如 `max-w-[78%]`）。
   - 见 `src/ui/layout.test.ts`，它会拦住违规写法。
2. **零后端**：不引入任何需要服务器的功能；数据全在浏览器 IndexedDB（Dexie）。跨设备靠「导出/导入全量备份」。
3. **卡片是数据，不是代码**：
   - `src/core/` 四个内核（装配 / 渲染 / 适配 / 存储）**不得 import React**。
   - `src/ui/` **不得出现提示词拼接与 HTML 解析**。
4. **`messages.raw` 一旦落库永不修改**；正则、CSS、渲染规则的变化只影响展示层（每次现算）。
5. **卡片内置页必须跑在 `<iframe sandbox="allow-scripts">`** 里：不给 same-origin、CSP 断网（`connect-src 'none'`），一切数据经 postMessage 桥。卡片拿不到 API Key，也碰不到数据库。
6. **不引第三方模型 SDK**：要自定义 baseURL / 请求头 / 参数能力矩阵，SDK 只会挡路。
7. 模型由用户自己接，**不承诺"所有服务商都能连"**；浏览器直连失败要给出「CORS / 网络 / Base URL」三种可能。

## 3. 目录地图

    src/core/assembler/   装配内核：条目模型、宏、世界书触发、token 预算、装配顺序
    src/core/render/      渲染内核：思维链/记忆/选项提取、白名单清洗、渲染管线
    src/core/providers/   适配内核：OpenAI 兼容、Anthropic、SSE 解析、mock、能力矩阵
    src/core/storage/     存储内核：Dexie schema、卡片仓库(zip)、记忆、备份、seed
    src/core/cards/       卡片规格、zip 打包、酒馆 PNG 卡互转、模板引擎、沙箱桥、正则
    src/ui/               手机端界面：play / cards / settings / components
    src/state/            Zustand：useSession（当前卡片与会话）、useNav、useSetting
    src/assets/cards/     内置卡的原始文件（ui.html 用 ?raw 打进包里）
    docs/superpowers/     设计文档与实施计划
    docs/reference/       参考素材（含从风月爬下来的原版卡片页，仅供比对）

## 4. 常用命令

    npm run dev      # 开发；已开 host，手机同 Wi-Fi 访问 http://<局域网IP>:5173
    npm run test     # vitest（必须全绿）
    npm run build    # tsc --noEmit && vite build（必须无错）

## 5. 每次改完必须做的四件事

1. `npm run test` —— 全绿。修 bug 要**先写一个会失败的测试**再修。
2. `npm run build` —— 类型检查 + 打包无错。
3. **UI 改动必须用无头浏览器实测**（不能只看代码）：
   - 后台启动 `npm run dev`，再起一个 Chrome headless（带 `--remote-debugging-port`、独立的 `--user-data-dir`）；
   - 用 CDP 的 `Runtime.evaluate` 驱动真实点击/输入，`Page.captureScreenshot` 截图；
   - 宽度类问题一定要量：`document.querySelector('.dsh-shell').getBoundingClientRect().width` 对比 `window.innerWidth`，
     并检查 `documentElement.scrollWidth > clientWidth`（横向溢出）。
4. `git commit`，中文提交信息，`fix:` / `feat:` / `chore:` 前缀。

## 6. 已知坑（都踩过）

| 现象 | 原因 | 处理 |
|---|---|---|
| dev server 自己崩掉，报 EBUSY watch | 编辑器原子写入产生的临时目录被 Vite 监视 | vite.config.ts 里已忽略 `**/.*.tmpdir/**` 等 |
| 某些页面比别的页面窄 | 曾经给外壳加过 max-width；或滚动条占位 | 外壳铺满 + 隐藏滚动条；layout.test.ts 守住 |
| 字号设置不生效 | 只改了外层 div，被内部固定 px 覆盖 | 统一走 CSS 变量 `--dsh-fs`，内部用 em |
| 「卡片不存在或已损坏」 | 早期版本只写了卡片索引行、没写 card.json | `ensureSeedCard()` 自愈；内置卡版本升级自动覆盖 |
| 点两次保存出现两张卡 | 草稿 id 为空，每次保存都当新卡 | `draftToPackage` 保留 base 的 id + 编辑器记 savedIdRef |
| 新建卡片没保存也出现 | 点新建就直接写库 | 改成草稿态：只在内存里起草，保存才落库 |
| 580KB 的卡片页塞进 textarea 卡死 | 内置页很大 | 超过 150KB 只读展示 + 「替换页面文件」 |
| 沙箱里 execCommand('copy') 可能被拦 | iframe 无 same-origin | 桥脚本拦截 `#copy-button`，文本回传宿主写剪贴板 |
| 复制后 AI 没反应 | 忘了我方不自动发送 | 流程就是「用户复制 → 自己粘贴发送」，别改成自动注入 |

## 7. 数据模型要点

- `messages` 是**树**（`parentId` + `chats.currentLeafId`）：重新生成 = 挂第二个孩子，回溯 = 把 currentLeafId 指回历史节点。
- `cardFiles` 是**虚拟文件系统**（`[cardId+path]` 复合主键）：card.json / ui/index.html / worldbook.json / assets/*，导出 zip 就是反向打包。
- 记忆托管：解析 AI 输出里的记忆区块 → `memories` 表 → 满额归档成永久记忆 → 每轮按「永久 → 近期 → 历史」回注，并从历史里剥离避免重复。
- 全局配置（记忆条数 / 前置词 / 后置词 / 提示词）在 `configs` 表 `scope='global'`。

## 8. 测试基线

改之前先跑一遍确认基线：**26 个测试文件 / 93 个用例全绿**，构建通过。
关键回归测试：装配顺序、世界书触发、记忆归档与回注、正则替换、白名单清洗（含 XSS 用例）、卡片 zip 往返、酒馆卡互转、卡片自愈、草稿态不落库、布局约束。