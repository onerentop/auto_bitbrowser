# CLAUDE.md

> **Last Updated**: 2026-09-24

本文件为 Claude Code (claude.ai/code) 在本仓库工作时提供指引。

## Changelog

| Date | Changes |
| ---- | --------- |
| 2026-09-24 | **架构规范化**：新增根目录 `ARCHITECTURE.md` 作为架构唯一权威依据（进程职责与安全基线、依赖规则、各层职责、IPC、数据与配置、引擎、测试与门禁、当前偏差）；本文件的架构章节改为摘要 + 链接 |
| 2026-09-24 | **清理无用代码**：删除 17 个产品里没有任何入口的源文件（迁移期对拍 / 切片探针脚本、`operations/index.ts` 汇总导出、无调用方的 Playwright 选择器版替换流程、账号文本解析与导入导出仓储、邮箱验证码读取、辅助邮箱池）及对应 16 个单测；删除迁移期报告 `POC_REPORT.md` / `ENGINE_SLICE_REPORT.md`；`PROGRESS.md` 删去移植期历史章节 |
| 2026-09-24 | **移除 Python 侧**：`core/` `services/` `automation/` `application/` `gui/` `web_admin/` `tests/`、`main.py`、`pytest.ini`、`requirements*.txt`、`.venv/`、`dist/` 全部删除；随之删掉 `verify:prompts` / `verify:selectors` 两个以 Python 源码为基准的校验脚本；本文件重写为桌面端（Electron + TypeScript）架构 |
| 2026-09-24 | 桌面端承接全部功能：窗口管理、账号管理（批量登录 / 绑定 / 健康巡检）、6 个 AI 批量任务、导入 TOTP、设置与任务历史 |
| 2026-02-02 | AI context 初始化（**此版本描述的架构已不存在**） |

---

## 项目概述

**ixBrowser 自动化管理工具** —— 基于 **Electron + TypeScript + React** 的桌面应用，
驱动 ixBrowser 指纹浏览器批量管理 Google 账号：批量登录、账号信息修改（手机号 / 辅助邮箱 /
2SV 手机 / 验证器 / 密码）、踢出设备、会话状态巡检、TOTP 密钥导入、任务结果持久化与导出。

- 入口：`app/main/index.ts`（Electron 主进程）
- 界面：`app/renderer/src/App.tsx`
- 业务后端：`app/host/`（跑在 `utilityProcess` 里）
- 业务库：`src/`（不依赖 Electron，可单独测试）

> 旧版本（Python 3.13 + PyQt6）已于 2026-09-24 整体移除，不再是本项目的对拍基准或回退方案。

### 技术栈

| 分类 | 技术 |
| ------ | ------ |
| 运行时 | Node.js ≥ 22.19 |
| 桌面框架 | Electron 44（薄主进程 + `utilityProcess` 后端） |
| 界面 | React 19 + Ant Design 5 + Vite（electron-vite） |
| 浏览器自动化 | Stagehand SDK 3.7.3（`@browserbasehq/stagehand`）+ playwright-core（CDP 连接 ixBrowser） |
| LLM | OpenAI / Anthropic / Google Gemini（`ai` SDK，经统一适配层） |
| 数据库 | SQLite（`node:sqlite`） |
| 浏览器服务 | ixBrowser 本地 API（`127.0.0.1:53200`） |

---

## 快速开始

```powershell
pnpm install
pnpm run dev                        # 启动应用（需 ixBrowser 已运行在 :53200）

# 校验
pnpm run typecheck                  # 业务库类型检查
pnpm run typecheck:app              # 主进程 + 渲染层类型检查
pnpm run typecheck:test             # 测试代码类型检查（tsconfig.test.json）
pnpm test                           # 单元测试（node:test）
pnpm run build:app                  # 构建到 out/（本项目没有打包配置）
```

真机诊断（需 ixBrowser 已启动）：

```powershell
pnpm run probe:ix                   # ixBrowser 连接探针
pnpm run probe:db                   # 数据库探针
```

---

## 架构

**完整规范见 [`ARCHITECTURE.md`](./ARCHITECTURE.md)**（唯一权威依据；本节只是速记）。

- 进程：`app/main`（主进程，只转发）→ `app/host`（业务后端，跑在 `utilityProcess`）→ `src/`（业务库，不依赖 Electron）；界面 `app/renderer` 只经 IPC 与后端通信。
- `app/shared` 是三端共用的**共享内核**：IPC 契约（`channels/`）与两端共用的纯函数（`logic/`），不依赖任何其它目录。
- 依赖只能向内：`application → automation → engine`，旁路 `db` / `ixbrowser` / `services` / `core`；逐条规则与规则名见 `ARCHITECTURE.md` §3。
- 通道名 `abb/<域>/<动作>`，**第二段必须小写**；信封 `{ok, data} | {ok:false, error:{code,message}}`（`ARCHITECTURE.md` §5）。
- 现有代码与规范不符之处登记在 `ARCHITECTURE.md` §9「当前偏差」，改动涉及其中条目时顺手核对。

---

## 目录结构

```text
auto_bitbrowser2/
├── app/
│   ├── main/                         # Electron 主进程（薄壳、生命周期、IPC 注册）
│   ├── host/
│   │   ├── index.ts                  # utilityProcess 入口
│   │   ├── context.ts                # 数据根 / 数据库 / 配置 / ixBrowser 客户端
│   │   ├── dispatch.ts               # 通道分发
│   │   ├── task-runner.ts            # 任务坞：进度、停止、逐条目、任务历史落库
│   │   └── handlers/                 # accounts / ai-tasks / home / settings / totp …
│   ├── preload/                      # 预加载脚本（CJS）
│   ├── renderer/src/
│   │   ├── App.tsx                   # 导航与页面注册
│   │   ├── pages/                    # HomePage / AccountsPage / AiTaskPage / TotpImportPage / SettingsPage / StatusPage
│   │   └── stores/                   # 后端状态、任务坞
│   └── shared/                       # channels（通道 + 类型）、ipc（通道常量）
├── src/
│   ├── engine/
│   │   ├── stagehand-engine.ts       # StagehandGoogleEngine（引擎门面）
│   │   ├── operations/               # login / replace-* / modify-* / kick-devices / change-password …
│   │   └── constants.ts types.ts totp.ts
│   ├── automation/                   # auto-*.ts（各业务流程）+ shared.ts（引擎连接包装）
│   ├── application/                  # ai-task-runner / account-task-orchestrator / health-check / totp-import / create-windows
│   ├── db/                           # schema.ts connection.ts account-repository.ts task-history-repository.ts …
│   ├── ixbrowser/                    # client.ts（ixBrowser 本地 API 客户端）/ window / groups / probe
│   ├── services/                     # data-store（代理数据）/ proxy-allocator（代理分配）
│   └── core/                         # config-manager / retry-helper / random-password / totp-extractor
├── test/                             # node:test 用例（*.test.mjs）
├── out/                              # electron-vite 构建产物（gitignore）
├── package.json  pnpm-lock.yaml  tsconfig*.json  electron.vite.config.ts
├── PROGRESS.md                       # 开发进度 + 真机验证记录
├── assets/                           # README 用的图片
├── data/config.example.json          # 配置模板
├── accounts.db                       # 运行时数据（gitignore）
├── config.json                       # 配置，敏感字段加密（gitignore）
├── ARCHITECTURE.md                   # 架构规范（唯一权威依据）
├── CLAUDE.md  README.md  LICENSE
└── .trellis/  .pi/                   # AI 协作工具目录（gitignore）
```

---

## 引擎（src/engine/）

`StagehandGoogleEngine` 封装 Stagehand SDK，通过 CDP 连上 ixBrowser 窗口，对外提供：

- 基础动作：`navigate` / `wait` / `getCurrentUrl` / `getPageContent` / `getPageHtml` / `isVisible` /
  `fill` / `click` / `clickByText` / `jsClick` / `pressKey` / `act` / `evaluateScript`
- 业务操作（`operations/`）：`login` / `replace-phone` / `replace-email` / `replace-recovery-*` /
  `modify-2sv` / `modify-auth` / `kick-devices` / `change-password`

**易踩的坑（都踩过）**：

- `act()` 是自然语言指令，**它的成功返回不代表页面真的如你所愿** —— 判定必须锚定真实页面文本 / DOM / URL。
- Stagehand 的 `isVisible` 会把 `display:none` 容器里的 0×0 元素判成可见（真机在 Google 密码页
  被 `#captchaimg` 误导过），因此引擎额外做了「渲染可见性复核」。
- `clickByText` 的 `contains` 模式 + `data-abb-text-hit` 标记是为 Google 的 Material 列表项准备的
  （它们的文本不以关键词开头，且对 DOM `click()` 不响应，需要坐标点击兜底）。

---

## 数据与文件

- **数据库优先**：账号状态改动走 `src/db/` 的 repository，不要直接写文本文件。
- **运行时数据**（`accounts.db` / `config.json` / `已修改密钥.txt`）都在数据根目录（见 `ARCHITECTURE.md` §6），
  开发时是仓库根目录；均已在 `.gitignore` 中，**不要提交**。数据目录只由 `app/main/data-root.ts` 决定，
  不要按源码位置（`import.meta.url`）推算。`failed_tasks.json` 是旧版失败任务队列的遗留文件，已无代码读写。
- 工作目录里的 `accounts.db`、`已修改密钥.txt` 是**明文真实数据**，不要外泄到日志或输出。

### ⚠️ 窗口备注（note）字段的约定

**窗口备注由用户自己维护，所有自动化任务都不读写它。**

真机教训（2026-09-24）：用户会在备注里手写历史密码等笔记，而当时有三条路径会写备注
（改密替换第 2 段、导入 TOTP 整条重建、修改验证器按段数插密钥），互相覆盖，吃掉过用户手写的内容。
现在：改密只写数据库 + 窗口 `password` 字段；导入 TOTP / 修改验证器只写 `tfa_secret`。
**新增功能时不要碰 `note`。**

---

## 测试与门禁

```powershell
pnpm run typecheck          # 业务库 tsc --noEmit，零错误
pnpm test                   # 全量单测（当前基线 580 通过 / 0 失败）
pnpm run typecheck:app      # 主进程 + 渲染层两套 tsconfig，零错误
pnpm run build:app          # 构建
pnpm run check:deps         # 分层依赖规则（ARCHITECTURE.md §3），0 个 error
pnpm run typecheck:test     # 测试代码类型检查（tsconfig.test.json），零错误
```

> **已移除**：`verify:prompts` 与 `verify:selectors` —— 它们的比对基准是 Python 源码（提示词逐条对拍、
> 选择器提取），Python 侧删除后一个会直接报错、另一个会退化成「0 个选择器」的**假绿**，因此一并删除。
> 新增/修改 `operations/` 的选择器与提示词时，改为靠 `test/engine-*.test.mjs` 的真机回归用例兜底。

单测用 `node:test` + 假引擎（`test/engine-*.test.mjs` 里有现成的状态机式 fake engine 写法），
**不需要真实浏览器**；需要真机的验证走 `.trellis/tasks/*/real-run-log.md` 记录的流程。

---

## AI 协作准则

1. **遵循分层**：依赖方向与逐条规则见 `ARCHITECTURE.md` §3；renderer → main(IPC) → host/handlers → application → automation/engine，不要跨层直连。
2. **新增通道**走 `app/shared/channels/`，动作名第二段小写；handler 里不要塞业务逻辑，放 `src/application/`。
3. **数据访问**写 `src/db/` 的 repository，不要绕过它直接写 SQL 或写文本文件。
4. **配置读写**一律经 `src/core/config-manager.ts`（敏感字段依赖它的加解密）。
5. **易失败操作**用 `src/core/retry-helper.ts`。
6. **不要碰窗口备注**（见上文约定）。
7. **改动后必须跑门禁**：见上文「测试与门禁」（`typecheck` + `typecheck:app` + `typecheck:test` + `pnpm test` + `build:app` + `check:deps`），全部通过再提交。
8. **真机验证的规矩**（本项目一直在用）：
   - 先只读探针确认真实页面形态，再写代码；
   - **先红后绿**：先写能复现缺陷的测试，再修；
   - 判定标准锚定真实页面文本 / DOM / URL，**绝不相信 `act()` 或 AI 抽取的成功返回**；
   - 凭据（密码 / 密钥）不进日志、不进任务历史、不进提交；记录里一律掩码；
   - 只操作用户指定的测试账号与窗口，跑完关窗，跑前备份 `accounts.db`。

## 安全

- `config.json`、`*.db`、`已修改密钥.txt`、`failed_tasks.json` 均已 gitignore，**不要提交**。
- 新密码 / TOTP 密钥只在必要时经 `fill()` 写入页面，不打印、不放进返回值（任务历史会落库并可导出 CSV）。
