# Node/TypeScript 重写进度

> 最后更新：2026-09-24（三个 AI 任务真机跑通并修掉同源缺陷：「替换手机号」「替换辅助邮箱」「修改验证器」——失效的恢复手机页地址、Google「重新验证身份」被误判为未登录、不点最终保存、把可选的邮箱验证码当成失败、缺「下一页」导致输码失败、成功文案「已更改」不在词表） ｜ 分支 `dev_ai`

## 零、接续开发指引（清空上下文后先读这里）

### 第一步：让新会话恢复认知

把下面这段直接粘给新会话：

```
读 desktop/PROGRESS.md 与 desktop/ENGINE_SLICE_REPORT.md 恢复上下文。

本项目正在把 Python 的 ixBrowser 自动化工具重写成 Node/TypeScript，
代码在 desktop/ 目录。Python 侧保持原样作为对拍基准与回退方案。

当前进度：后端与全部界面已移植；账号管理的 OAuth / 检测 Pro / 刷新家庭组 / 开启共享 / 403 / Sub2API 以及
BrowserUse 引擎已按用户要求删除（见第二章第 8 节）。当前阶段：真实账号逐项测试。

注意事项：
- Stagehand 必须锁 3.7.3，不可升级（原因见 PROGRESS.md 第三章）
- 改动提示词或选择器后必须跑 pnpm verify:prompts 与 pnpm verify:selectors
- 所有移植以「与 Python 逐字对齐」为准，不要"优化"提示词或判定顺序
```

### 第二步：验证环境没坏

```powershell
cd D:\workspace\projects\auto_bitbrowser2\desktop
pnpm install            # 若 node_modules 丢失
pnpm typecheck          # 应无输出
pnpm test               # 应 394/394 通过
pnpm typecheck:app      # Electron 骨架，应无输出
pnpm verify:prompts "$env:PI_SCRATCH_DIR\ops_spec.json"   # 应 100%（49/49）
pnpm verify:selectors   # 应 0 缺失
```

四项全绿说明代码与文档一致，可以放心继续。

> ⚠️ 已知环境坑：本机某些 shell 会话里，`pnpm typecheck` / `pnpm test` 会拉起一个
> cmd.exe 横幅并吞掉脚本输出、掩盖非零退出码。拿不准时直接跑底层命令：
> `npx tsc -p tsconfig.json --noEmit` 与
> `node --test --experimental-strip-types --experimental-sqlite test/*.test.mjs`。

### 第三步：确认 Python 侧基线

```powershell
cd D:\workspace\projects\auto_bitbrowser2
.\.venv\Scripts\python.exe -m pytest -q
# 基线：70 passed, 5 failed（那 5 个是 HEAD 上既有的，不是回归）
```

### 若 scratch 已被清理

`pnpm verify:prompts` 需要一个 `ops_spec.json` 路径参数。该文件随 scratch 清理会消失，
用仓库内的脚本重建：

```powershell
# 在项目根目录执行
.\.venv\Scripts\python.exe desktop\scripts\extract-ops-spec.py "$env:PI_SCRATCH_DIR\ops_spec.json"
cd desktop
node scripts/verify-prompts.mjs "$env:PI_SCRATCH_DIR\ops_spec.json"
```

产出的 JSON 含 `stagehand` 段（Python 侧全部 op 的提示词）；校验脚本用 `REMOVED_STAGEHAND_OPS`
剔除已删除的 6 个 op（oauth / pro_status / unlock_403 / enable_sharing / join_family / family），剩 49 条。
（BrowserUse 引擎已删除，不再比对其提示词、常量与 md 文件。）

### 工作目录速查

| 位置 | 内容 |
|---|---|
| `desktop/PROGRESS.md` | 本文件——进度、决策、坑 |
| `desktop/ENGINE_SLICE_REPORT.md` | 引擎切片验证报告（Stagehand 版本约束的原始依据） |
| `desktop/src/services/` `src/db/` | services 层（已完成） |
| `desktop/src/engine/` | Stagehand 引擎层（已完成） |
| `desktop/src/automation/` | 业务流程层（进行中） |
| `desktop/scripts/` | 三个校验/提取脚本 |
| `desktop/app/` | Electron 骨架（主进程 / 后端进程 / preload / 渲染层） |
| `desktop/test/` | 394 个单测（含 `app-*.test.mjs`） |
| Python 侧（`core/` `services/` `automation/`） | **勿动**，对拍基准 |

---

## 一、当前状态速览

| 层 | 进度 | 文件 | 行数 |
|---|---|---|---|
| `core`（配置 / 重试 / 并发 / 解析） | ✅ 完成 | 5 | ~1500 |
| `services`（数据与服务） | ✅ 完成 | 13 | ~3400 |
| `engine`（Stagehand 引擎） | ✅ 完成 | 17 | ~4300 |
| `browseruse`（BrowserUse 引擎） | 🗑️ 已删除（用户要求） | — | — |
| `automation`（业务流程） | ✅ 保留登录 + 5 个 AI 任务 | 12 | ~2350 |
| 前端界面 | ✅ 骨架 + 全部页面（首页 / 5 个 AI 任务页 / 账号管理 / 导入 TOTP / 设置） | — | — |

**质量门（全绿）**：
```powershell
cd desktop
pnpm typecheck          # tsc strict 零错误
pnpm test               # 394/394 通过
pnpm typecheck:app      # Electron 骨架两套 tsconfig 零错误
pnpm verify:prompts "$env:PI_SCRATCH_DIR\ops_spec.json"
                        # 提示词 49/49 = 100%
pnpm verify:selectors   # 选择器缺失 0（197/197）
```

## 二、已完成部分

### 1. services 层（全部）

| 模块 | 说明 |
|---|---|
| `ixbrowser/client.ts` | ixBrowser HTTP 协议，含 CDP 端点获取 |
| `db/connection.ts` | 用 Node 内置 `node:sqlite`（免原生编译、免 electron-rebuild） |
| `db/*-repository.ts` × 5 | 账号 / 代理 / 历史 / 邮箱池 / IO（刷新任务仓储已随会员刷新删除） |
| `core/data-parser.ts` | 账号行解析（URL 提取 + 多分隔符探测） |
| `services/email-code-reader.ts` | Gmail 验证码（提取逻辑为纯函数） |
| `services/proxy-allocator.ts` / `data-store.ts` | 代理分配与缓存 |
| `services/recovery-email-manager.ts` | 辅助邮箱池策略 |

**对拍验证**：综合查询 8008 个字段与 Python 逐字段零差异。

### 2. engine 层（Stagehand，全部）

| 模块 | 说明 |
|---|---|
| `stagehand-engine.ts` | CDP 接管 + 四原语 + 12 个 operation 门面 |
| `constants.ts` | 35 URL / 12 超时 / 41 组关键词（**脚本自动生成**） |
| `types.ts` | 5 枚举 + 18 结果类型 + 工厂函数（自动生成） |
| `totp.ts` | RFC 6238 自研实现 |
| `playwright-compat.ts` | 把 V3 Page 适配成 Playwright 接口 |
| `operations/*.ts` × 12 | 全部 operation |

**提示词一致性**：92/92 与 Python 逐字一致。

### 3. browseruse 层 —— 🗑️ 已删除

曾完整移植 `core/browseruse_engine/`（26 文件 / 5713 行），只服务于 Pro 检测、会员刷新与家庭组加入。
这些功能按用户要求删除后已无调用方，整个 `src/browseruse/` 连同测试一并删除（见第 8 节）。

### 4. automation 层（12/15）

| 文件 | 状态 |
|---|---|
| `shared.ts` | ✅ 共享样板 |
| `auto-google-login.ts` | ✅ |
| `auto-kick-devices.ts` | ✅ |
| `auto-modify-2sv-phone.ts` | ✅ |
| `auto-modify-authenticator.ts` | ✅（含密钥三处保存） |
| `auto-replace-recovery-email.ts` / `-phone.ts` | ✅ |
| `auto-enable-family-sharing.ts` / `auto-unlock-403.ts` / `auto-antigravity-oauth.ts` / `pro-status-detector.ts` | 🗑️ 已删除（用户要求） |
| `auto-replace-email.ts` / `auto-replace-phone.ts` | ✅（Playwright 选择器直连） |
| `auto-join-family.ts` | ❌ 用户确认不需要，不移植 |
| `batch/types.ts` | ✅ 只剩 `BatchResult` |
| `batch/pro-detection.ts` / `batch/membership-detect.ts` | 🗑️ 已删除（用户要求） |
| `batch-account-processor.ts` | ✅ 只保留 `batchLogin`（其余五个 batch_* 入口已删除） |

### 5. core 层（本轮新增）

| 文件 | 说明 |
|---|---|
| `config-manager.ts` | 对标 `core/config_manager.py`；敏感字段加解密与 Python **字节级互通**（18 组对拍） |
| `retry-helper.ts` | 对标 `core/retry_helper.py`；`execute_sync` 未移植（Node 无同步阻塞） |
| `semaphore.ts` | `asyncio.Semaphore` / `gather(return_exceptions=True)` 的 Node 等价物 |
| `data-parser.ts` | 账号行解析（早先已完成） |

### 6. Electron 骨架（本轮新增，`desktop/app/`）

对标 PI-Desktop：薄壳主进程 + `utilityProcess` 后端进程 + 单表 IPC。不含业务页面。

| 目录 | 说明 |
|---|---|
| `app/shared/` | `ipc.ts` 通道表（`abb/领域/动作`）+ 白名单 + `InvokeMap` 类型；`envelope.ts` 信封与 `wrap()`。纯 TS |
| `app/main/` | 生命周期、单实例、窗口安全选项、导航守卫、IPC 注册器、后端路由、`host-client`（请求 id 配对 / 30s 超时 / 崩溃检测 / 串行生命周期） |
| `app/host/` | 后端进程入口（`parentPort` 收发）+ 纯函数分发表；`handlers/health.ts` 实现 `host/ping`、`ixbrowser/ping` |
| `app/preload/` | `contextBridge` 暴露 `window.abb`，invoke/event 通道分别校验白名单；打包为 `.cjs`（开 sandbox 必需） |
| `app/renderer/` | React 19 + antd 5 状态页：版本、后端状态（订阅事件）+ Ping / 重启、ixBrowser 可达性 |

运行：
```powershell
cd desktop
pnpm dev            # 开发（HMR）
pnpm build:app      # 产出 out/main/{index,host}.js、out/preload/index.cjs、out/renderer/index.html
pnpm preview:app    # 以生产产物启动
pnpm typecheck:app  # tsconfig.node.json + tsconfig.web.json
```

实机验证（Electron 44.4.5 / Chrome 152 / Node 24.21）：窗口「ixBrowser 窗口管理工具」打开，后端 `starting → ready`，
ping 往返 2–9 ms，ixBrowser 已连接；「重启后端」得 `stopped → starting → ready` 且 PID 更换；关窗后无残留 electron 进程。

### 7. 业务页面（第一批完成，计划见 `.pi/plan/第一批业务页面-*.md`）

**阶段 0 后端基建 ✅**

| 文件 | 说明 |
|---|---|
| `src/db/schema.ts` | `init_db` 逐字移植（5 表 + 22 列迁移）；与 Python 在临时库上对拍 `sqlite_master` **8/8 一致**。差异：只吞「列已存在」错误，其它错误照常抛 |
| `app/main/data-root.ts` | 数据根目录：`ABB_DATA_ROOT` > 打包时 exe 目录 > 开发时仓库根；经 env 传给后端进程 |
| `app/host/context.ts` | 后端单例容器，DB / 配置**惰性**打开（首次访问执行 `initDb`） |
| `app/host/task-runner.ts` | 全局单任务互斥（`TASK_BUSY`）、协作式停止钩子、日志→进度解析照搬 orchestrator.py:417-424 |
| `app/shared/ipc.ts` | 路由改为「`LOCAL_CHANNELS` 之外全部转后端」；新增 `task/getCurrent`、`task/stop` 与三个任务事件 |
| 渲染层 | 左导航外壳（首页 / 账号管理 / 设置 / 运行状态）、底部 `TaskDock`（进度 + 停止 + 日志抽屉 + 结果弹窗）、深浅色主题 store |

**阶段 1-3 页面 ✅**（三页由子代理并行实现，之后各做一轮只读审查并修复）

| 页面 | 通道（`abb/<领域>/*`） | 后台任务 |
|---|---|---|
| 设置（配置 / 代理 / 账号数据） | `settings/load·save·setDataDir·getTheme·testAi`、`proxies*`（增删改查、导入、绑定详情、解绑）、`accounts*`（增改查、导入） | `settings_delete_accounts`（逐个找窗口→删窗口→删账号） |
| 首页（ixBrowser 窗口管理） | `home/getConfig·saveConfig·listGroups·listBrowsers` | `home_open_browsers`、`home_delete_browsers` |
| 账号管理 | `accounts/list·getDefaults·precheck·start·bindCandidates·bind·unbind·deleteOne` | `login` `batch_bind` `batch_delete`（OAuth / Pro / 家庭组 / 共享 / 403 已删除） |

新增后端模块：`src/application/{settings-service,settings-data,test-ai-connection,home-tree,account-manager-service,account-task-orchestrator}.ts`、`src/ixbrowser/{window,groups}.ts`、`src/engine/stagehand-config.ts`。

**与 Python 的有意偏差**（代码里均有注释）：
- 首页「打开 / 删除选中」接上真实实现（原版 TODO 桩）；「创建窗口」「停止任务」保持禁用
- 账号管理「绑定窗口」改为下拉选择未被占用的窗口（原版总是绑第一个）
- 删除 / 登录等所有批量操作的窗口 ID **以数据库为准**，界面数据过期时跳过并提示刷新，不误删他人窗口
- 批量绑定：同一窗口一批内只绑第一个匹配账号，执行时再查一次占用；写库返回 false 计为失败
- 批量删除改为先删账号、成功后再删窗口；非数字窗口 ID 不调用 ixBrowser
- 批量操作两步走：`precheck`（候选筛选 + 确认文案）→ `start`（重新筛选后启动任务）
- 设置保存：先 `reload()` 再深拷贝、只落盘一次（不覆盖 Python 同时写入的其它键）；越界数值加载时夹紧（对标 QSpinBox）
- `data_dir` 用输入框 +「应用」（尚无文件夹对话框通道）；测试 AI 连接 HTTP 超时 25s（避开主进程 30s 转发超时）
- 代理详情显示 browser_id + 邮箱、解绑用 `unbind_window`（原版读不存在的字段 / 调不存在的方法）；同批导入按 host:port 去重
- 首页配置失焦即写回（原版关窗时写）；启动读主题走只返回 theme 的 `getTheme`，不把密钥传到渲染层
- Stagehand 模型配置补上 `get_stagehand_config` 的回落链（显式参数 → 配置 → 环境变量 → 默认模型），由后端启动时注册 ConfigManager 来源
- 页面自动加载等后端首次 ready；任务结束事件可能先于启动返回值到达，store 用已结束 id 集合防止界面卡在「运行中」

**实机验证**（`ABB_DATA_ROOT=scratch`）：运行状态页显示 scratch 路径；首页读取真实 ixBrowser 列表（15 组 / 374 窗口，只读）；设置→账号数据批量导入 2 个测试账号成功，账号管理页列出这 2 个；关窗后无残留 electron 进程。

**第二批页面 ✅**（5 个 AI 批量任务页 + 导入 TOTP）

| 页面 | 通道 | 后台任务 |
|---|---|---|
| 替换手机号 / 替换辅助邮箱 / 修改 2SV 手机 / 修改验证器 / 踢出设备（一个通用 `AiTaskPage` 按 `kind` 驱动） | `abb/aitasks/load`（分组→窗口树 + 数据库状态，只读）、`abb/aitasks/start` | `ai_replace_phone` `ai_replace_email` `ai_modify_2sv` `ai_modify_auth` `ai_kick_devices` |
| 导入 TOTP（QR / 文本） | `abb/totp/parseUris·parseText·match·import` | `import_totp` |

- 新增事件 `abb/task/event/item`（`TaskApi.item()`），对标 Python AI Worker 的 `progress(email, status, message)`，逐行更新「状态 / 消息」列
- 新增模块：`src/application/{ai-task-runner,totp-import}.ts`、`src/core/totp-extractor/*`（migration protobuf 手写解析，零依赖）；渲染层二维码识别用 `jsqr`（canvas 取像素）
- **与 Python 对拍**：`test/fixtures/totp-python-parity.json` 由 Python 生成（migration 4 组覆盖多账号 / SHA256·512 / 8 位 / HOTP / 中文名 / 未知字段号 / 去填充 base64，标准 URI 6 组），另 6 组异常输入逐条比对，全部一致

**与 Python 的有意偏差**：
- AI 任务**执行前按 profileId 重新读取窗口名，必须等于 email 才执行**，否则跳过记失败（Python 的 email 就是窗口名，二者天然绑定；这里防止界面数据过期时用 A 的密码操作 B 的窗口）
- 并发数照搬 Python：界面可调但**串行执行**（Python 5 个 Worker 从不读该值）；`modify_2sv` 照搬 `close_after=True`（任务结束关闭窗口）
- 停止后「开始」要等任务真正结束才可用（修 Python 基类立即复位的缺陷）；开始前加确认框（原版直接执行，但均为破坏性操作）；Python 从不自动加载，这里也不自动加载
- `modify_auth` 的「已修改密钥.txt」写到数据根目录
- TOTP：二维码在渲染层异步识别（Python 在 UI 线程同步识别会卡死）；jsQR 每张图只识别一个码（pyzbar 可多个）；导入支持停止（Python 无）；导入以数据库当前状态重新匹配，库中无该账号记失败；写库返回 false 计失败
- `generateTotp` 先去掉密钥中的全部空白（真机测试发现：Google 设置页显示的密钥为每 4 位空格分隔的小写形式，pyotp 对此抛 `Non-base32 digit found`，Python 版登录直接失败）

**实机验证**（`ABB_DATA_ROOT=scratch`）：导航顺序 / 文案与 Python 一致，6 个新页面均渲染；AI 页「加载数据」读到真实 ixBrowser 374 个窗口（只读，未点「开始」）；TOTP 文本模式解析 2 条 → 匹配 scratch 库测试账号 → 导入成功（密钥、密码写入，设置→账号数据可见）；关窗无残留。

> ⚠️ **实机验证一律用 `ABB_DATA_ROOT=<scratch>`**，不要让开发中的界面碰仓库根的真实 `accounts.db` / `config.json`。
> 「运行状态」页会显示当前数据目录，启动后先确认。

### 8. 按用户要求删除的功能（2026-09-23）

只删 desktop，Python 侧保持原样；数据库表结构与 `config.json` 默认配置树不变（与 Python 版共用同一份数据）。

| 删除项 | 界面 | 后端 / 底层 |
|---|---|---|
| 批量 OAuth、一键登录+OAuth、单个 OAuth（行内按钮与右键菜单）、「自动绑定代理」 | 账号管理 | `batchOauth` / `batchLoginAndOauth`、`auto-antigravity-oauth.ts`、`engine/operations/oauth.ts`、`services/proxy-smart-allocator.ts` |
| 检测 Pro、刷新家庭组 | 账号管理 | `batchDetectPro` / `batchRefreshMembershipInfo`、`pro-status-detector.ts`、`batch/{pro-detection,membership-detect}.ts`、`engine/operations/{pro-status,family}.ts`、`db/account-refresh-repository.ts`、登录后的 `detectPro` 钩子 |
| 开启共享 | 账号管理 | `auto-enable-family-sharing.ts`、`engine/operations/enable-sharing.ts` |
| 检测 403、批量解锁 403 | 账号管理 | `executeDetect403`、`auto-unlock-403.ts`、`engine/operations/unlock-403.ts`、`services/sms-bus-client.ts` |
| Sub2API 关联 | 账号管理（Sub2API 列、「已关联」统计） | `services/sub2api-client.ts` |
| Pro / Sub2API / 解锁状态三列及 10 个相关筛选项 | 账号管理（筛选只剩 全部 / 未登录 / 已登录 / 登录失败） | — |
| 家庭组加入后端 | （界面早已移除） | `src/browseruse/` 整个目录、`engine/operations/join-family.ts`、`services/invite-lock.ts` |

- 账号管理保留：批量登录 / 单个登录、批量绑定窗口、右键绑定 / 解绑 / 删除、删除选中、删除+窗口
- 已删除的操作名（`oauth` `detect_pro` `unlock_403` 等）传到 `abb/accounts/precheck|start` 一律返回 `INVALID_ARGUMENT`
- 表格「操作」列：已登录账号原本显示「OAuth」，现在留空
- `ConfigManager` 删掉 Sub2API / SMS-Bus / OAuth 超时的专用读写方法；这些键仍在默认配置树里，通用 `get/set` 照常加解密，设置页保存时原样保留
- `package.json` 里 `playwright-core` 与 `@ai-sdk/*` 已无直接引用，但它们分别是 Stagehand 3.7.3 的 peer / optional 依赖，**暂不移除**（移除前需真机确认 Stagehand 加载 Gemini provider 不受影响）

## 三、关键决策与坑（重要，勿改）

### 依赖版本必须锁死

| 依赖 | 锁定版本 | 原因 |
|---|---|---|
| `@browserbasehq/stagehand` | **3.7.3**（不带 `^`） | 4.x 改用浏览器扩展架构，连接时调 `Extensions.loadUnpacked`，而 ixBrowser 的 Chrome 142 **不支持 `Extensions.*` CDP 域**，会在 `create()` 阶段直接失败 |

已用原始 CDP 探测确认：
```
Target.getTargets            支持
Extensions.getExtensions     不支持 ('wasn't found')
Extensions.loadUnpacked      不支持 (Method not available)
```

### 早期引入的依赖

| 依赖 | 用途 |
|---|---|
| `playwright-core` | 原为 BrowserUse 的 CDP 连接（已删除）；现只作为 Stagehand 3.7.3 的 peer 依赖保留 |
| `ai` + `@ai-sdk/openai` / `@ai-sdk/anthropic` / `@ai-sdk/google` | 原为 BrowserUse LLM 适配层（已删除）；Stagehand 把 `@ai-sdk/*` 列为 optional 依赖，暂保留 |

### 自研 TOTP 而非 otplib

otplib 13.x 的导出结构与 12.x 完全不同（`TOTP` 类与 functional API 并存），且该库有跨版本破坏先例。
TOTP 是标准算法，`totp.ts` 40 行即可对齐 `pyotp`，已对拍 24 组零差异。

**当时的坑**：第一版误用 `Buffer.from(s, "base64")` 解码 base32，对拍才发现。

### Stagehand API 差异（Python 3.5.0 → Node 3.7.3）

- **没有 `sh.page`** —— act/extract/observe 在 V3 顶层，页面对象走 `sh.context.awaitActivePage()`
- **`model.clientOptions.apiKey` 不生效** —— 必须设 provider 环境变量（`GOOGLE_GENERATIVE_AI_API_KEY`）

### 行为修正：getPageContent 用 innerText 而非 HTML

关键词检测（Pro 状态、家庭组角色）依赖可见文本做子串匹配。原先用 `page.content()` 返回 HTML
会导致误命中（`class="upgrade-banner"` 让页面被判为非订阅），且跨标签文本匹配不到。
已改为 `evaluate("document.body.innerText")`，与 Python 的 `page.inner_text("body")` 语义一致。

### BrowserUse 移植的取舍（本轮）

| 决策 | 说明 |
|---|---|
| Page 抽象 | 不 import playwright 类型，声明结构化子集 `BrowserPageLike`（字段名对齐 Playwright JS API），真实 Page 可直接赋值，测试用假 Page |
| CDP 连接 | 抽成 `CdpConnector` 接口，默认实现惰性 `import("playwright-core")` |
| LLM 调用 | 抽成 `LlmTransport` 接口，默认实现惰性加载 ai-sdk；三家的**消息格式转换是导出的纯函数**，可离线断言 |
| `create_llm_from_config` | Python 依赖 `ConfigManager`；Node 侧改为注入 `LlmConfigProvider`，传 null 等价 Python 的 ImportError 分支（回退环境变量） |
| 同步 `invoke()` | 不移植（Python 是 `asyncio.run`，Node 无等价物），只保留 `ainvoke` |
| `ProDetectEngine` 接口 | `data?: T` 放宽为 `data?: T | null`，让照搬 Python `Optional` 的 BrowserUse 结果类型能被直接接纳；Stagehand 侧不受影响 |
| 计时 | Python `time.time()*1000` → `Date.now()`，字段名保持 `duration_ms` |

### 判定顺序不可调换的三处

| 位置 | 约束 |
|---|---|
| `engine/operations/unlock-403.ts` | `disabled` 必须排在 `sign in` 之前——封号页面通常也含 "sign in" |
| `engine/operations/modify-auth.ts` | 密钥解析先匹配裸 Base32，再匹配带标签形式 |
| `browseruse/types.ts` 的 `ACTION_TYPE_ORDER` | 动作类型检测顺序与 Python `get_action_type()` 的列表一致 |

### Playwright 兼容层的一个细节

Google 验证弹窗里 `Verify` 按钮在**右侧**，必须用 `clickLastVisible`（对应 Python 的 `.last`）。

### batch 移植的审查修正（3 处严重 + 2 处能力缺口）

代码审查发现「依赖注入的默认值把 Python 必走分支静默跳过」，已逐条修掉：

| 问题 | 后果 | 修法 |
|---|---|---|
| `accountRepo` / `refreshTaskRepo` 默认 null，而 Python 的 `DBManager` 是无条件调用 | `batchLoginAndOauth` 的「按 login_status 筛选」永远筛不出账号 → **阶段 2 永不执行**；「已关联则跳过」失效；Pro 与解锁状态不落库 | 新增 `deps.db` 注入口（给了就自动构造两个仓储）；两者都缺时构造函数打 `⚠️ 未注入` 告警，不再静默 |
| 三个默认适配器漏传 `accountRepo` | 下游 `auto_*` 的 `login_status` / `sub2api_status` / `unlock_status` 永远不写库 | 改成 `makeDefaultLoginFn(repo)` 等工厂，构造时绑定 |
| `AccountRepository.updateMembershipInfo` Node 侧缺失 | 会员信息刷新的写库整块被跳过 | 补齐该方法（SQL 与 Python 逐字一致），接口从可选改必需 |
| `Sub2ApiClient.testAccountConnection` Node 侧缺失 | 403 解锁的「重新检测拿最新 validation_url」整段被跳过，已解锁账号会被推进解锁流程并计入失败 | 补齐该方法及 `parseSseEvents` / `extractValidationUrlFromError`，恢复 Python 的原始控制流 |

> ⚠️ Node 侧**没有** Python 那种 `DBManager` 全局单例（打开哪个库必须由调用方决定），
> 所以仓储不能在构造函数里默认 `openDb()`。生产路径请注入 `deps.db`。

### 本轮代码审查修掉的 4 处（对照 Python 后修正）

| 位置 | 问题 | 修法 |
|---|---|---|
| `browseruse/types.ts` 的 `normalizeActionModel` | 只认严格类型，而 Python 的 pydantic 走 **lax 模式**会把 `"3"` 强制成 `3`；更糟的是 `wait.milliseconds="5000"` 会被静默换成默认值 1000 | 补 `coerceNum` / `coerceBool`，字段存在但不可转换时返回 null（等价 ValidationError） |
| `browseruse/types.ts` 的 `formatActionParams` | 用 `JSON.stringify` 输出 `{"url":"x"}`，与 Python dict repr `{'url': 'x'}` **字节不同**，而这段文本会进 `<agent_history>` 提示词 | 新增 `pythonRepr()` 复刻 dict repr |
| `browseruse/playwright-cdp.ts` 的 `connect()` | `connectOverCDP` 成功但取页面失败时，browser 句柄没交出去也没关掉 → ixBrowser 窗口被占死 | 取页面包 try/catch，失败就地 `browser.close()` 后 rethrow |
| `browseruse/engine.ts` 的 `start()` / `withEngine()` | `start()` 被写成「有 page 就不拉浏览器」，而 Python 是**无条件** launch；`withEngine` 又漏了 `__aenter__` 的初始化 | `start()` 改回无条件；新增 `enter()` 对标 `__aenter__`，`withEngine` 先调它 |

### 刻意保留的可疑行为（照搬 Python，勿"顺手修")

- `engine/operations/login.ts` 的 `enterPassword`：`act()` 成功后仍执行键盘输入，密码可能被输两次
- `browseruse/operations/join-family.ts` 的 `sendInvite`/`acceptInvite`：`timeout` 形参**未被函数体使用**
- 同文件末尾两条返回分支都设 `invite_sent: true`，「没看到已发送关键词」也算已发送
- `checkInviteSent` 把 `"pending"` 当作「邀请已发送」，无关页面可能误命中
- `browseruse/agent/service.ts` 的 `run()` 入口会复位 `_stopRequested`，因此 `run()` 之前调 `stop()` 无效
- `dom/service.ts` 的 `extractDom` 捕获异常后返回空树，但**不清空**上一次快照

### 替换手机号的真机缺陷与修复（2026-09-24）

在真实 ixBrowser 窗口 + 真实 Google 账号（profile 7）上验证「替换手机号」AI 任务时，暴露两处 **Python 同源**缺陷；
两处都只修 desktop，Python 保持原样（如需同步修 Python 请另行安排）。完整证据见
`.trellis/tasks/09-24-replace-phone-real-run/real-run-log.md`。

| 缺陷 | 真机证据 | 修法 |
|---|---|---|
| `GoogleURLs.RECOVERY_PHONE`（`myaccount.google.com/recovery/phone`）已失效 | 真机打开是 `404. That's an error.`；完成身份重新验证后再访问**仍是 404**；同会话访问 `RECOVERY_PHONE_SETTINGS` 才是真实的辅助电话号码设置页。原实现整个流程（extract / act 全部提示词）都跑在 404 页上 | `operations/replace-phone.ts` 改用 `RECOVERY_PHONE_SETTINGS`（Python 的 `auto_replace_phone.py` 与 desktop 的 Playwright 版用的都是它） |
| 该页面要求「请先验证您的身份」，其 URL 是 `accounts.google.com/v3/signin/challenge/pwd`，正好命中登录态判定 `url.includes("accounts.google.com") && url.includes("signin")` | 任务会以 `success=false / message="需要先登录账号" / error="未登录"` 直接失败——**假失败**，账号其实已登录。且该要求**每次导航都会重新出现**，而该 operation 有两次导航（开头一次、核对替换结果时一次） | 新增 `passReauthIfRequired` / `completeReauth`（`fill` 密码 → 提交 → 若出现验证码框则 `fill` TOTP → 提交 → 等回到设置页）；凭据经 `execute(..., credentials)` 由 automation 层从账号行传入，门面 `replaceRecoveryPhone` 同步加参数 |
| 点完「下一步 / 获取验证码」后从不点最终的保存 | 真机端到端运行：流程全部走到（点编辑 → 清空 → 输入新号 → 下一步），但**账号上的号码没变**、核对仍读到旧号；补上保存后一次运行即替换成功，独立复查确认页面显示新号 | 在核对之前补一次保存点击（`点击 '保存' 或 'Save' 或 '完成' 或 'Done' 或 '确认' 或 'Confirm' 按钮…`）。旁证：无调用方的 Playwright 版里有 `PHONE_SAVE_SELECTORS`（「最终保存」），Stagehand 版从未移植 |

- 凭据处理与 `login.ts` 一致：**只经 `fill` 写入，不进 AI 指令**（AI 指令里出现密码即为泄漏点），回归用例对此有断言
- 回归用例 `desktop/test/engine-replace-phone.test.mjs`（5 条）：缺陷 1/2 在修复前把 operation 换回 HEAD 版本时为 3 红 1 绿；缺陷 3 在移掉保存步骤时单独变红；修复后 **5/5 绿**
- 同类风险（本次未验证、未改动）：修改 2SV 手机 / 修改验证器的 operation 有同样的登录态判定，且「最终保存 / 提交」这一步是否完整也**未验证**（`RECOVERY_EMAIL` 的疑问已在下一节判定：地址有效）

### 替换辅助邮箱的真机缺陷与修复（2026-09-24）

在同一个测试号上验证「替换辅助邮箱」（新邮箱 `renw93606@gmail.com`）时又暴露两处 **Python 同源**缺陷，均已修复并真机跑通。
完整证据见 `.trellis/tasks/09-24-replace-email-real-run/real-run-log.md`。

| 项 | 真机证据 | 处理 |
|---|---|---|
| 页面地址 | `GoogleURLs.RECOVERY_EMAIL`（`myaccount.google.com/recovery/email`）落点**就是**辅助邮箱设置页，与手机号那个 404 常量不同 | **不需要改地址**（只读核对确认） |
| 「重新验证身份」被误判为未登录 | 真机形态是**直接要身份验证器验证码**（`/v3/signin/challenge/totp`），该 URL 命中 `url.includes("accounts.google.com") && url.includes("signin")` → 假失败「需要先登录账号」 | 新增 `passReauthIfRequired` / `completeReauth`：**有验证码框先填验证码、否则填密码**（真机形态是直接验证码），最多两轮；凭据经 `execute(..., credentials)` 由 automation 层传入，仍只经 `fill` 写入、不进 AI 指令 |
| 「请输入新邮箱验证码」被当成失败 | 点完「下一步」后 Google 弹「请输入已发送至新邮箱的 6 位数验证码」；实测点「取消」后页面**已经显示新邮箱**（带一个可选的「验证辅助邮箱」入口）——即那是可选校验，不是没做完 | 没有取码服务时不再返回失败，改由 `verifyReplacement` 的结果核对定论（真没生效仍会如实报失败） |

- 回归用例 `desktop/test/engine-replace-email.test.mjs`（6 条）：换回 HEAD 版时 3 红 2 绿；缺陷 2 的用例单独先红；修复后 6/6 绿
- 复跑结果：一次运行成功（63.4s），独立只读复查显示「您的辅助邮箱 `renw93606@gmail.com`（上次更新：6 分钟前）」
- 用户决定：**新邮箱的可选验证不做**（页面保留「验证辅助邮箱」入口）
- 已知：AI 任务只改 Google 账号、不写库（`accounts.db.recovery_email` 仍为 `NULL`，与 Python 一致）；修改 2SV 手机 / 修改验证器仍未验证

### 修改验证器的真机缺陷与修复（2026-09-24）

在 profile 14（用户指定的测试号）上验证「修改验证器」时暴露三处 **Python 同源**缺陷；均已修复并真机跑通
（第 3 次运行 42.0s 成功）。完整证据见 `.trellis/tasks/09-24-modify-auth-real-run/real-run-log.md`。

| 缺陷 | 真机证据 | 修法 |
|---|---|---|
| 重新验证身份被误判为未登录 | 验证器页要求「重新验证身份」，真机形态是**密码页**（`/v3/signin/challenge/pwd`），该 URL 命中登录态判定 → 假失败「需要先登录账号」 | 新增 `passReauthIfRequired` / `completeReauth`：有验证码框先填码、否则填密码；提交**先按 Enter**（先点外层 `#passwordNext` div 会把焦点带走、Enter 反而失效）；凭据只经 `fill` 写入、不进 AI 指令 |
| 密钥视图里没有验证码输入框 | 点「更改身份验证器应用 → 无法扫描？」后面板只显示密钥文本，**必须先点「下一页」** Google 才给出验证码框；原实现直接输码 → 真机 act `success=false`、随后核对必然失败 | 在输码前补一次「下一页」点击（Step 3.5） |
| 成功文案「身份验证器应用已更改」不在成功词表 | 第 2 次运行**真的把验证器改掉了**，但词表只有「已添加/added/成功/完成」→ 判「无法确定设置结果」；因 `saveNewSecret` 只在 success 时调用，**新密钥不落盘而账号已被改掉** → 会导致登录失败（本次已按产品同一条保存路径恢复，再复跑通过） | 成功词表补上 `已更改 / 更改 / changed` |

- 回归用例 `desktop/test/engine-modify-auth.test.mjs`（7 条）：换回 HEAD 版 → 3 红 2 绿；只保留缺陷 1 修复 → 3 红 3 绿；临时还原旧词表 → 4 红 3 绿；修复后 **7/7 绿**
- 新密钥四处落点一致：`accounts.db.secret_key` / `authenticator_modification_history` / `已修改密钥.txt` / ixBrowser 窗口备注第 4 段 + `tfa_secret`（同一指纹）
- 诚实记录：缺陷 3 的第一版回归用例**没红**——假引擎的成功标记当时写成英文 `Authenticator app added`，正好命中旧词表；改成真机文案后才成立
- 提醒：窗口备注是 fire-and-forget 异步写入，短命进程会丢（本次真机驱动就遇到，已补写）；Python 版是同步阻塞写

### Electron 骨架的架构约定与审查修正

- **主进程是薄壳**：不 import `desktop/src/` 任何模块（build 后检查 `out/main/index.js` 不含 IxBrowserClient/stagehand/playwright）
- **业务后端跑在 `utilityProcess`**（`out/main/host.js`），崩溃只影响后端，窗口不受影响；本轮无自动重启，只有手动「重启后端」
- 信封 `{ok,data} | {ok:false,error:{code,message}}`；错误码 `HOST_UNAVAILABLE` / `TIMEOUT` / `UNKNOWN_CHANNEL` / `INTERNAL` / `FORBIDDEN`
- `ixbrowser/ping` 只走 HTTP，刻意没碰 `node:sqlite`（其在 Electron 中的兼容性留到业务页面阶段验证）

代码审查后修掉的问题：

| 位置 | 问题 | 修法 |
|---|---|---|
| `main/host/host-client.ts` | 并发 stop/restart 竞态；停止中迟到的 ready 会把状态改回 ready；退出时可能被重新拉起 | 生命周期串行队列 `enqueue`、每代独立 `GenerationState`、`shutdown()` 后拒绝 start、超时 `forceKill`；`HostStatus` 新增单调 `seq` |
| `main/window.ts` 导航守卫 | `startsWith("file:")` 放行任意本地 html，该页面会拿到 `window.abb` | 新增 `navigation.ts` `isAppUrl`：dev 同源 / 生产精确匹配渲染层入口；禁 webview |
| `main/ipc/registrar.ts` | IPC 不校验来源 frame | `isTrustedSender` + `senderFrameUrl`，拒绝返回 `FORBIDDEN` |
| `main/host/spawn-utility.ts` | 子进程 `error` 事件无监听会让主进程崩溃 | 加 `child.on("error")` |
| `host/index.ts` | 返回值不可结构化克隆时 postMessage 抛错，请求永远挂起 | 捕获后回 `INTERNAL` 信封 |
| 渲染层 CSP | 含 `script-src 'unsafe-inline'` | 移除，补 `object-src/base-uri/form-action 'none'`；仅 dev 由 `devRelaxCsp()` 放宽 |
| `renderer/stores/host-status.ts` | 按 `since` 墙钟去重，时钟回拨会丢状态 | 改按 `seq` |

## 四、自动化校验工具（务必使用）

改动提示词或选择器后必须跑：

```powershell
cd desktop
pnpm verify:prompts "$env:PI_SCRATCH_DIR\ops_spec.json"
pnpm verify:selectors
```

`verify:prompts` 逐条比对 Stagehand 提示词（保留的 op 共 **49 条**），已删除的 op 由 `REMOVED_STAGEHAND_OPS` 排除。

`ops_spec.json` 由 `scripts/extract-ops-spec.py` 从 Python 侧生成（重建命令见第零章）。

## 五、下一步

1. **`auto-join-family.ts`** —— ❌ 用户确认不需要，不移植（Python 侧保留原样）
2. **`batch_account_processor.ts`** —— ✅ 已完成（本轮），见「三、batch 移植的审查修正」
3. **前端界面** —— 骨架 ✅、第一批（首页 / 账号管理 / 设置）✅、第二批（5 个 AI 任务页 / 导入 TOTP）✅，Python GUI 的全部页面已移植。后续：
   - 5 个 AI 页接入 SMS-Bus / IMAP 验证码：**用户确认不需要**，与 Python GUI 保持一致（触发验证码即判失败）
   - 家庭组加入：**用户确认不需要，不移植**（界面入口与后端代码均已删除）
   - OAuth / 检测 Pro / 刷新家庭组 / 开启共享 / 403 / Sub2API：**用户要求删除**，已从 desktop 移除（第二章第 8 节）
   - `node:sqlite` 已确认可在 Electron 主进程与 utilityProcess（Node 24.21 / SQLite 3.53.4）中直接使用
   - **真机回归进行中**：已通过 打开窗口 / 批量绑定 / 批量登录（测试号）；**替换手机号 / 替换辅助邮箱 / 修改验证器** 三个 AI 任务都已完成真机端到端验证并修掉同源缺陷（各自独立复跑成功、并与账号真实状态核对一致），详见 `.trellis/tasks/09-24-{replace-phone,replace-email,modify-auth}-real-run/real-run-log.md`；其余按 `.pi/plan/真实账号逐项测试计划-*.md` 继续

## 六、Python 侧现状（勿动）

Python 代码**保持原样可用**，是当前的对拍基准与回退方案：
- `core/` `services/` `automation/` `application/` `gui/` 全部未修改
- `pytest -q` 基线：70 passed / 5 failed（5 个失败是 HEAD 上既有的）
- ixBrowser 依赖服务端口 53200

## 七、环境备忘

| 项 | 值 |
|---|---|
| Node | 22.19（需 `--experimental-sqlite`、`--experimental-strip-types`） |
| 包管理 | pnpm 10.28 |
| 运行探针 | `pnpm probe:ix`（ixBrowser 只读）、`pnpm probe:db`（数据库只读） |
| Python 对照 | `.\.venv\Scripts\python.exe` |

**已知告警（可忽略）**：
- `node:sqlite` 与类型剥离都还是 experimental，会打警告
- Stagehand 连接 ixBrowser 时 ixBrowser 侧会打印 `Extensions.* not found` 探测日志（3.7.3 会尝试后回退，不影响功能）
- `pnpm add` 时会提示 `openai@4.104.0` 的 peer `zod@^3` 与仓库里的 zod 4 不匹配——Stagehand 自带副本，实测不影响
