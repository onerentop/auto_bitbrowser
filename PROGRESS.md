# 开发进度与真机验证记录

> 最后更新：2026-09-24 ｜ 分支 `dev_ai`

> **架构以根目录 `ARCHITECTURE.md` 为准，AI 协作准则见 `CLAUDE.md`。** 本文件只记录：关键决策与坑、各功能的真机验证记录、下一步。

## 零、接续开发指引（清空上下文后先读这里）

### 第一步：让新会话恢复认知

把下面这段直接粘给新会话：

```
读 ARCHITECTURE.md、CLAUDE.md 与 PROGRESS.md 恢复上下文。

这是 Electron + TypeScript 的 ixBrowser 自动化工具（Google 账号批量管理），代码在仓库根（`app/` + `src/`）。
当前状态：业务后端与全部界面已完成，真实账号逐项验证进行中。

注意事项：
- Stagehand 必须锁 3.7.3，不可升级（原因见第二章）
- 窗口备注（note）字段由用户自己维护，自动化任务一律不读写它
- 引擎判定必须锚定真实页面文本 / DOM / URL，不要相信 act() 的成功返回
- 改动后必须跑门禁：typecheck、typecheck:app、typecheck:test、test、build:app、check:deps（见 ARCHITECTURE.md §8）
```

### 第二步：验证环境没坏

```powershell
cd D:\workspace\projects\auto_bitbrowser2
pnpm install           # 若 node_modules 丢失
pnpm run typecheck     # 应无输出
pnpm test              # 应 587/587 通过
pnpm run typecheck:app # 应无输出
pnpm run build:app     # 应构建成功
pnpm run check:deps    # 应 0 个 error
pnpm run typecheck:test # 应无输出
```

全部通过说明代码与文档一致，可以放心继续。

### 工作目录速查

| 位置 | 内容 |
|---|---|
| `ARCHITECTURE.md` | 架构规范：进程职责、依赖规则、IPC、数据与配置、门禁（**权威依据**） |
| `CLAUDE.md` | AI 协作准则、目录速查、易踩的坑 |
| `PROGRESS.md` | 本文件 —— 进度、决策、真机验证记录 |
| `src/` | 业务库（不依赖 Electron，可单独单测） |
| `app/` | Electron：`main/`（薄壳）、`host/`（后端）、`renderer/`（React）、`shared/` |
| `test/` | 单测（558 个，含 `app-*.test.mjs`） |
| `.trellis/tasks/*/real-run-log.md` | 各项功能的真机验证记录（含证据日志） |

---

## 一、当前状态速览

| 层 | 进度 | 职责 |
|---|---|---|
| `src/core` | ✅ 完成 | 配置（敏感字段加解密）/ 重试 / 强随机密码 / TOTP 解析 |
| `src/db` | ✅ 完成 | SQLite schema、连接、各 repository（账号 / 任务历史等） |
| `src/engine` | ✅ 完成 | Stagehand 引擎门面 + `operations/`（登录 / 换号 / 改 2SV / 改验证器 / 踢设备 / 改密码） |
| `src/automation` | ✅ 完成 | 各 `auto-*` 业务流程 |
| `src/application` | ✅ 完成 | AI 任务编排 / 批量账号任务 / 健康巡检 / 导入 TOTP / 从模板建窗口 |
| `app/` | ✅ 完成 | Electron 三层（main / host / renderer）+ 全部页面 |

**质量门（全绿）**：

```powershell
pnpm run typecheck      # tsc strict 零错误
pnpm test               # 587/587 通过
pnpm run typecheck:app  # 主进程 + 渲染层两套 tsconfig 零错误
pnpm run build:app      # 构建到 out/，主进程产物不含业务模块
pnpm run check:deps     # 分层依赖规则 0 个 error
pnpm run typecheck:test # 测试代码类型检查 0 个错误（tsconfig.test.json）
```

## 二、关键决策与坑（重要，勿改）

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

### 无直接引用、但暂不移除的依赖

| 依赖 | 原因 |
|---|---|
| `playwright-core` | Stagehand 3.7.3 的 peer 依赖 |
| `ai` + `@ai-sdk/openai` / `@ai-sdk/anthropic` / `@ai-sdk/google` | Stagehand 把 `@ai-sdk/*` 列为 optional 依赖；移除前需真机确认 Stagehand 加载 Gemini provider 不受影响 |

### 自研 TOTP 而非 otplib

otplib 13.x 的导出结构与 12.x 完全不同（`TOTP` 类与 functional API 并存），且该库有跨版本破坏先例。
TOTP 是标准算法（RFC 6238），`totp.ts` 约 40 行即可实现，由 `test/engine-totp.test.mjs` 覆盖。

**当时的坑**：第一版误用 `Buffer.from(s, "base64")` 解码 base32，单测才发现。

### Stagehand 3.7.3 的 API 要点

- **没有 `sh.page`** —— act/extract/observe 在 V3 顶层，页面对象走 `sh.context.awaitActivePage()`
- **`model.clientOptions.apiKey` 不生效** —— 必须设 provider 环境变量（`GOOGLE_GENERATIVE_AI_API_KEY`）

### 行为修正：getPageContent 用 innerText 而非 HTML

关键词检测依赖可见文本做子串匹配。原先用 `page.content()` 返回 HTML
会导致误命中（class 名、属性值里的词也会被匹配到），且跨标签文本匹配不到。
已改为 `evaluate("document.body.innerText")`。

### 判定顺序不可调换

- `engine/operations/modify-auth.ts` 的 `parseSecret`：先匹配裸 Base32，再匹配带标签形式

### 界面与任务的行为约定（代码里均有注释）

- **AI 任务执行前按 profileId 重新读取窗口名，必须等于 email 才执行**，否则跳过记失败——防止界面数据过期时用 A 的密码操作 B 的窗口（`ai-task-runner.ts`）
- 删除 / 登录等批量操作的窗口 ID **以数据库为准**，与界面行不一致时跳过并提示「数据已变化，请刷新后重试」，不误删他人窗口
- 批量删除先删账号、成功后再删窗口；`deleteAccount` 返回 false 计失败且不删窗口；非数字窗口 ID 不调用 ixBrowser
- 绑定窗口：导入 / 添加后自动按窗口名绑定，只在「恰好一个未被占用的同名窗口」时绑，同名多个不猜、已绑定不动，取窗口失败不影响导入；「批量绑定窗口」按钮与「解绑」已删除（`window-binding.ts`）
- 批量登录：批处理器的逐账号回调（`onAccountDone`）同时驱动逐条目、进度与关窗——进度按账号计数（成功+失败，跳过不计）；**登录成功的账号完成即关窗，失败与跳过保留窗口**（账号页「登录后关窗」勾选，默认开，取消则都不关）；任务坞不再靠日志猜进度
- 账号列表直接带出**明文密码**（可复制）、按数据库 `secret_key` 算的 **2FA 验证码**（只回码不回密钥）、以及**窗口备注**（点击小窗编辑，只写 `note` 一个字段）；2FA 密钥与辅助邮箱原文仍只在编辑弹窗里取
- 账号页与首页共用同一套验证码取数逻辑（`components/TfaCodeCell.tsx`）：密钥在后端，界面只拿 6 位码与周期结束时间
- 批量操作两步走：`precheck`（候选筛选 + 确认文案）→ `start`（重新筛选后启动任务）；开始前有确认框
- AI 任务界面上的并发数只记录不使用，**串行执行**；`modify_2sv` 任务结束关闭窗口；停止后「开始」要等任务真正结束才可用
- 设置保存：先 `reload()` 再深拷贝、只落盘一次（不覆盖其它键）；越界数值加载时夹紧；启动读主题走只返回 theme 的 `getTheme`，不把密钥传到渲染层
- 导入 TOTP：二维码在渲染层异步识别（jsQR 每张图只识别一个码）；导入以数据库当前状态重新匹配，库中无该账号记失败
- `generateTotp` 先去掉密钥中的全部空白：Google 设置页显示的密钥是每 4 位空格分隔的小写形式
- 「已修改密钥.txt」写到数据根目录；数据根目录：`ABB_DATA_ROOT` > 打包时 exe 目录 > 开发时仓库根

> ⚠️ **实机验证界面时一律用 `ABB_DATA_ROOT=<scratch>`**，不要让开发中的界面碰仓库根的真实 `accounts.db` / `config.json`。
> 「运行状态」页会显示当前数据目录，启动后先确认。

### Electron 骨架的架构约定与审查修正

- **主进程是薄壳**：不 import `src/` 任何模块（build 后检查 `out/main/index.js` 不含 IxBrowserClient/stagehand/playwright）
- **业务后端跑在 `utilityProcess`**（`out/main/host.js`），崩溃只影响后端，窗口不受影响；目前无自动重启，只有手动「重启后端」
- 信封 `{ok,data} | {ok:false,error:{code,message}}`；错误码 `HOST_UNAVAILABLE` / `TIMEOUT` / `UNKNOWN_CHANNEL` / `INTERNAL` / `FORBIDDEN`
- `ixbrowser/ping` 只走 HTTP，不碰 `node:sqlite`（`node:sqlite` 已确认可在 Electron 主进程与 utilityProcess 中直接使用）

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

## 三、真机验证记录

各功能在真实 ixBrowser 窗口 + 真实 Google 账号上的验证结论。完整证据在本地
`.trellis/tasks/09-24-*-real-run/`（该目录不入库）。

> 下面各轮里「新增 `passReauthIfRequired` / `completeReauth`」是当时各 operation 自带的实现；
> 2026-09-24 架构整改（C4）已把 6 份合并为 `src/engine/operations/reauth.ts` 的 `GoogleReauth`，
> 各轮真机修复的写法都保留在里面（验证码优先、Enter 先提交、同窗口不重复提交验证码等），分支用例见 `test/engine-reauth.test.mjs`。

### 替换手机号的真机缺陷与修复（2026-09-24）

在真实 ixBrowser 窗口 + 真实 Google 账号（profile 7）上验证「替换手机号」AI 任务时暴露的缺陷如下，完整证据见
`.trellis/tasks/09-24-replace-phone-real-run/real-run-log.md`。

| 缺陷 | 真机证据 | 修法 |
|---|---|---|
| `GoogleURLs.RECOVERY_PHONE`（`myaccount.google.com/recovery/phone`）已失效 | 真机打开是 `404. That's an error.`；完成身份重新验证后再访问**仍是 404**；同会话访问 `RECOVERY_PHONE_SETTINGS` 才是真实的辅助电话号码设置页。原实现整个流程（extract / act 全部提示词）都跑在 404 页上 | `operations/replace-phone.ts` 改用 `RECOVERY_PHONE_SETTINGS` |
| 该页面要求「请先验证您的身份」，其 URL 是 `accounts.google.com/v3/signin/challenge/pwd`，正好命中登录态判定 `url.includes("accounts.google.com") && url.includes("signin")` | 任务会以 `success=false / message="需要先登录账号" / error="未登录"` 直接失败——**假失败**，账号其实已登录。且该要求**每次导航都会重新出现**，而该 operation 有两次导航（开头一次、核对替换结果时一次） | 新增 `passReauthIfRequired` / `completeReauth`（`fill` 密码 → 提交 → 若出现验证码框则 `fill` TOTP → 提交 → 等回到设置页）；凭据经 `execute(..., credentials)` 由 automation 层从账号行传入，门面 `replaceRecoveryPhone` 同步加参数 |
| 点完「下一步 / 获取验证码」后从不点最终的保存 | 真机端到端运行：流程全部走到（点编辑 → 清空 → 输入新号 → 下一步），但**账号上的号码没变**、核对仍读到旧号；补上保存后一次运行即替换成功，独立复查确认页面显示新号 | 在核对之前补一次保存点击（`点击 '保存' 或 'Save' 或 '完成' 或 'Done' 或 '确认' 或 'Confirm' 按钮…`） |

- 凭据处理与 `login.ts` 一致：**只经 `fill` 写入，不进 AI 指令**（AI 指令里出现密码即为泄漏点），回归用例对此有断言
- 回归用例 `test/engine-replace-phone.test.mjs`（5 条）：缺陷 1/2 在修复前把 operation 换回 HEAD 版本时为 3 红 1 绿；缺陷 3 在移掉保存步骤时单独变红；修复后 **5/5 绿**
- 同类风险（本次未验证、未改动）：修改 2SV 手机 / 修改验证器的 operation 有同样的登录态判定，且「最终保存 / 提交」这一步是否完整也**未验证**（`RECOVERY_EMAIL` 的疑问已在下一节判定：地址有效）

### 替换辅助邮箱的真机缺陷与修复（2026-09-24）

在同一个测试号上验证「替换辅助邮箱」（新邮箱 `ren***@gmail.com`）时又暴露两处缺陷，均已修复并真机跑通。
完整证据见 `.trellis/tasks/09-24-replace-email-real-run/real-run-log.md`。

| 项 | 真机证据 | 处理 |
|---|---|---|
| 页面地址 | `GoogleURLs.RECOVERY_EMAIL`（`myaccount.google.com/recovery/email`）落点**就是**辅助邮箱设置页，与手机号那个 404 常量不同 | **不需要改地址**（只读核对确认） |
| 「重新验证身份」被误判为未登录 | 真机形态是**直接要身份验证器验证码**（`/v3/signin/challenge/totp`），该 URL 命中 `url.includes("accounts.google.com") && url.includes("signin")` → 假失败「需要先登录账号」 | 新增 `passReauthIfRequired` / `completeReauth`：**有验证码框先填验证码、否则填密码**（真机形态是直接验证码），最多两轮；凭据经 `execute(..., credentials)` 由 automation 层传入，仍只经 `fill` 写入、不进 AI 指令 |
| 「请输入新邮箱验证码」被当成失败 | 点完「下一步」后 Google 弹「请输入已发送至新邮箱的 6 位数验证码」；实测点「取消」后页面**已经显示新邮箱**（带一个可选的「验证辅助邮箱」入口）——即那是可选校验，不是没做完 | 没有取码服务时不再返回失败，改由 `verifyReplacement` 的结果核对定论（真没生效仍会如实报失败） |

- 回归用例 `test/engine-replace-email.test.mjs`（6 条）：换回 HEAD 版时 3 红 2 绿；缺陷 2 的用例单独先红；修复后 6/6 绿
- 复跑结果：一次运行成功（63.4s），独立只读复查显示「您的辅助邮箱 `ren***@gmail.com`（上次更新：6 分钟前）」
- 用户决定：**新邮箱的可选验证不做**（页面保留「验证辅助邮箱」入口）
- 已知：AI 任务只改 Google 账号、不写库（`accounts.db.recovery_email` 仍为 `NULL`）

### 修改验证器的真机缺陷与修复（2026-09-24）

在 profile 14（用户指定的测试号）上验证「修改验证器」时暴露三处缺陷；均已修复并真机跑通
（第 3 次运行 42.0s 成功）。完整证据见 `.trellis/tasks/09-24-modify-auth-real-run/real-run-log.md`。

| 缺陷 | 真机证据 | 修法 |
|---|---|---|
| 重新验证身份被误判为未登录 | 验证器页要求「重新验证身份」，真机形态是**密码页**（`/v3/signin/challenge/pwd`），该 URL 命中登录态判定 → 假失败「需要先登录账号」 | 新增 `passReauthIfRequired` / `completeReauth`：有验证码框先填码、否则填密码；提交**先按 Enter**（先点外层 `#passwordNext` div 会把焦点带走、Enter 反而失效）；凭据只经 `fill` 写入、不进 AI 指令 |
| 密钥视图里没有验证码输入框 | 点「更改身份验证器应用 → 无法扫描？」后面板只显示密钥文本，**必须先点「下一页」** Google 才给出验证码框；原实现直接输码 → 真机 act `success=false`、随后核对必然失败 | 在输码前补一次「下一页」点击（Step 3.5） |
| 成功文案「身份验证器应用已更改」不在成功词表 | 第 2 次运行**真的把验证器改掉了**，但词表只有「已添加/added/成功/完成」→ 判「无法确定设置结果」；因 `saveNewSecret` 只在 success 时调用，**新密钥不落盘而账号已被改掉** → 会导致登录失败（本次已按产品同一条保存路径恢复，再复跑通过） | 成功词表补上 `已更改 / 更改 / changed` |

- 回归用例 `test/engine-modify-auth.test.mjs`（7 条）：换回 HEAD 版 → 3 红 2 绿；只保留缺陷 1 修复 → 3 红 3 绿；临时还原旧词表 → 4 红 3 绿；修复后 **7/7 绿**
- 新密钥落点一致：`accounts.db.secret_key` / `authenticator_modification_history` / `已修改密钥.txt` / 窗口 `tfa_secret`（同一指纹）；
  当时还会写窗口备注第 4 段，现已取消（见「修改账号密码」一节末尾）
- 诚实记录：缺陷 3 的第一版回归用例**没红**——假引擎的成功标记当时写成英文 `Authenticator app added`，正好命中旧词表；改成真机文案后才成立
- 提醒：当时窗口信息是 fire-and-forget 异步写入，短命进程会丢（本次真机驱动就遇到，已补写）

### 修改 2SV 手机的真机缺陷与修复（2026-09-24）

在 profile 7（`arr***@gmail.com`）上验证「修改 2SV 手机」；第二轮用只读探针拿到真实 DOM 后定位到两个
根因级缺陷，修完真机端到端跑通（`operation.success=true`，独立复核确认 2SV 电话号码列表出现新号
`****4886`）。完整证据见 `.trellis/tasks/09-24-modify-2sv-real-run/real-run-log.md`。

| 缺陷 | 真机证据 | 修法 |
|---|---|---|
| **`:has-text()` 选择器在 stagehand 下恒为 0 匹配**（引擎用的是自己的选择器引擎，不是 Playwright） | `locator(':is(a,button,[role="button"]):has-text("电话号码")').count()` = 0，`isVisible()` 抛 `StagehandElementNotFoundError`；同页 `locator('a')` = 3 正常。于是 `click()` / `jsClick()` 静默返回 false，流程退回 AI act 后「报成功但页面毫无变化」，卡死在 2SV 首页 | 引擎新增 `textClickScript()` / `clickByText()`：用 `page.evaluate` 在页面内按可见文本找元素并派发 DOM 点击（真机验证能触发导航与弹层按钮） |
| **「下一步」之后还有「确认您的电话号码」页，必须再点「保存」** | 探针 dump 到该页原文：「确认您的电话号码 / 请确认 +86 … 是您要保存的号码 / 上一步 / 保存」；不点「保存」时列表里永远没有新号 | 新增 Step 5b：`waitUntil` 等确认页出现 → `clickByText("保存")`（未命中不再盲发 AI act） |
| 结果核对只看「页面文本含新号码」且只认尾 4 位 | 复核导航失败会停在确认页，而确认页正文里本来就有完整新号 → **假成功** | 校验复核 `navigate` 成败与落点 URL；号码匹配收紧为「完整号码或尾 7 位」 |
| AI act 报成功但无效果（点条目、点下一步） | 第 6 次运行：`act → success=true`，页面 URL/文本完全没变 | 四处确定性点击全部改走 `clickByText()` + 页面状态复核 |

- 回归用例：`test/engine-modify-2sv.test.mjs`（11 条；假引擎里「新号码进列表」与「点保存」有真实因果）、
  新增 `test/engine-click-by-text.test.mjs`（11 条；用假 DOM 在 Node 里执行页面内脚本）
- 代码审查（独立上下文）指出 4 类真机后果严重的问题：确认页判定过宽会在弹层上盲点「保存」、复核导航失败假成功、
  选元素可能点到祖先 / 前缀撞名（「保存更改」抢「保存」）/ 不判 `opacity:0` 与 `disabled`、确认页只判一次。
  均已修并补「先红后绿」用例（修前 6 红 → 修后绿）
- 真机链路的坑（未修，记入待办）：`connect()` 对「窗口已打开」不容错（111003），而**关掉窗口会丢 Google 会话**
  → 端到端验证只能塞进单进程；另外 Google 对频繁登录做风控后，登录页会先要求「选择验证方式」
  （`/v3/signin/challenge/selection`），而 `LoginOperation` 只认「直接出现的验证器输入框」→ 报 `need_2fa`（后者已修，见下文「登录『选择验证方式』页的修复」）
- 账号状态：2SV 电话号码 = 旧号 `****4348` + 新号 `****4886`（仍是「添加」，未删旧号）

### 踢出设备的真机缺陷与修复（2026-09-24）

在 profile 7 上验证「踢出设备」；真机复现了**假成功**（任务报成功、其实一个设备都没踢），修完后真机端到端跑通，
账号的 2 个历史会话被真正退出（设备页显示「已退出账号」）。完整证据见
`.trellis/tasks/09-24-kick-devices-real-run/real-run-log.md`。

| 缺陷 | 真机证据 | 修法 |
|---|---|---|
| 设备页要求「重新验证身份」被误判为「需要先登录账号」 | navigate 后落在 `/v3/signin/challenge/totp`（中文页）→ 假失败 | 新增 `passReauthIfRequired` / `completeReauth`（与其它 operation 同一套写法） |
| **假成功**：设备列表按 observe 描述里的英文 `"device"` 过滤 | 中文页面 → observe 描述不含 `device` → 列表恒为空 → `success=true, "未找到其他设备"`，实际 0 操作 | 改为在页面内按**结构**读会话条目（`li.K6ZZTd`），与界面语言无关；读不到就如实报「没找到设备列表」 |
| **假成功**：`kickSingleDevice` 无条件 `return true` | 三次 act 全都没生效也照样计入「已踢出」 | 点条目 → 复核已进入详情页 → 点「退出账号」→ 复核显示「已退出」；任一步没做到如实返回 false |
| 结果判据错 + 重复踢已退出的会话 | 真机：退出后会话**条数不减少**（变成「已退出账号」）；第二轮会重复点开已退出的会话 | 判据改为「还没退出的非当前会话是否清零」；`signedOut` 的条目不再重复踢 |
| 缺确认框处理 | 点「退出账号」只弹确认框（「要在"Windows"上退出账号吗？ 取消 / 退出账号」），需**再点一次**同名按钮 | 确定性再点一次「退出账号」，AI act 仅作兜底 |

真机设备页结构（实测）：`/myaccount.google.com/device-activity` → 会话条目 `li.K6ZZTd`（当前会话的条目文本含
「您的当前会话」）→ **坐标点击**条目进入 `/device-activity/id/XXX` → 详情页「退出账号」→ 确认框 → 退出后条目变
「已退出账号」。点条目必须用坐标点击（页面内 `el.click()` 在该页面上无效）。

- 回归用例 `test/engine-kick-devices.test.mjs`（10 条；假引擎按真机页面序列建模）+ 引擎新增 `evaluateScript()`

### 导入 TOTP 密钥的修复（2026-09-24）

这个功能不驱动 Google 页面（解析密钥 → 匹配数据库 → 写库 + 更新 ixBrowser 窗口信息），所以验证方式是
「真实数据库 + 真机 ixBrowser API 上跑一次，核对密钥的三处落点」。为不破坏账号，用 profile 7 的
**当前密钥**做幂等导入。完整证据见 `.trellis/tasks/09-24-import-totp-real-run/real-run-log.md`。

| 缺陷 | 真机证据 | 修法 |
|---|---|---|
| **导入只写窗口备注、不写窗口 `tfa_secret`** → ixBrowser 侧的 2FA 密钥一直为空，与「修改验证器」「批量绑定窗口」两处落点不一致 | 导入成功（备注更新成功、`ix_update_count=1`）后 `窗口 tfa_secret = (空)`，而 DB 与备注里都有密钥 | `runTotpImport` 的 `updateProfileNote(id, note)` 改为 `updateProfile(id, { note, tfa_secret })`（后来按「自动化不碰备注」的约定收窄为只写 `tfa_secret`）；handler 装配同步改。真机复跑：`tfa_secret` 由空 → `len=32 前4=R2TQ…`，`窗口 tfa_secret == DB 密钥: true` |

- 回归用例 `test/app-totp.test.mjs`：修前 4 红 → 修后 **15/15 绿**
- 本轮**未**改动（记在任务待办）：覆盖已有密钥不写 `authenticator_modification_history`、导入密钥无格式校验、
  前端 UI 层未做真机操作（「窗口备注整条覆盖」已随「自动化不碰备注」的约定消除）

### 任务结果持久化与导出（F4，2026-09-24）

新增能力（此前批量任务结果只打在界面日志里，关掉就没了）。产品背景是第七轮评估：
「Google 账号管理系统」需要能回答「上一次批量任务哪几个账号成了、哪几个败了、为什么」。

- 新表 `task_run_history`（任务级）+ `task_run_items`（逐条目），`initDb` 由 5 张表变 7 张
- 新仓储 `src/db/task-history-repository.ts`：`record()` 按条目状态统计 total / 成功 / 失败，另有 `listRuns` / `listItems` / `exportText()`
- `TaskRunner` 收尾时用 `TaskRunnerOptions.onRecord` 把结果交出去落库（`try/catch` 兜住，写库失败不影响任务本身的结果）
- 刻意**不复用** 旧的 `account_refresh_tasks` / `_items`（语义是「刷新家庭组信息」，混用会让两边含义都变模糊）
- 通道 `abb/taskhistory/list|items|export`，渲染层 `TaskHistoryTab.tsx`（设置页新增「任务历史」页签）
  - 通道第二段必须小写（测试正则是 `abb/<小写>/...`），所以是 `taskhistory` 而不是 `taskHistory`
  - `app/shared/channels/task-history.ts` 自己声明行类型 —— 直接 import 仓储会把 `node:sqlite` 拖进 web 构建

真机暴露的缺陷与修复（先红后绿）：

| 缺陷 | 真机证据 | 修法 |
|---|---|---|
| **批量任务从不上报逐条目**（`runBrowserBatch` 只调 `log/progress/shouldStop`）→ 任务成功但历史 `total=0`、逐条目 0 条 | 库里 run 1：`outcome=succeeded, total=0 成功=0 失败=0`，同一份日志里却有 `[1/1] ✓ 窗口 7 打开成功` | `home.ts` 逐窗口上报 `api.item`；静态复核发现批量登录 / 批量绑定 / 批量删除 / 设置页删除账号 **4 处同样缺失**，一并补上（`executeBatchBind` / `executeBatchDelete` 加可选 `item` 回调，`reportAccountResultItems()` 处理并发登录收尾才成形的逐账号结果） |
| 失败条目消息只能到「窗口 N 打开失败」，底层原因（「窗口不存在」）只在任务日志里 | run 2 条目消息是 `窗口 999999 打开失败`，而日志里有 `窗口打开失败: 窗口不存在` | `BrowserOp` 签名改为 `(id, log)`，把本条目内最后一条底层日志当作失败原因；run 3 条目消息变成 `窗口打开失败: 窗口不存在` |

- 独立只读复查（code-reviewer 子代理）后又修掉 3 处**统计口径**问题（同一类：历史数字与实际不符）：
  ① 逐条目不去重 —— AI 任务每个账号发两次（「处理中」→「成功/失败」），3 个账号会写成 `总数 6`；
  改为 `TaskRunner` 内 `itemIndex: Map<key, 下标>`，同一个 key 只留**最终**一条；
  ② 批量登录被停止时条目全丢（停止分支返回 `{type:"stopped"}`，带不出逐账号结果）→ 把上报挪进
  `executeAccountWorkerTask`，在停止分支**之前**用原始 result 上报；
  ③ 界面数据过期的账号只打日志、不记条目 → 补 `api.item(email, "失败", "数据已变化，请刷新后重试")`。
  另外 `record()` 用 `BEGIN/COMMIT/ROLLBACK` 包住写入，不留「有统计、没条目」的半条运行
- 回归用例：`app-task-history.test.mjs`（含**真机缺陷回归**：端到端跑首页批量打开窗口，历史必须有
  total / 成功 / 失败与逐条目；同一个 key 只留最终状态；半写入回滚）、`app-home.test.mjs`、
  `app-accounts.test.mjs`（停止登录保留条目、过期账号条目）；先红 7 个 → 修后 **492/492 绿**
- 只读独立复验（`th-verify.py`，`mode=ro` 逐表行数 + 排序内容 sha256 比对跑前备份）：16 张既有表
  全部逐行一致，只多了两张新表 → PASS（加固后复跑再过一次）
- 遗留：「跳过」条目不计入成功 / 失败两列（页面说明已写明）；不保存任务级 `result`（「删除了几个
  窗口」这类数字不在历史里）；历史时间取本地时间而其它表是 UTC（有意不一致）；落库失败只在后端
  日志可见（`openDb` 无 `busy_timeout`，多个进程同时写库时会 `SQLITE_BUSY`，属既有全局条件）；
  批量登录 / 绑定 / 删除的条目上报目前只有单测覆盖，未上真机

### 账号健康巡检（F2，2026-09-24）

新增能力：想知道「这批号还有多少能用」，以前只能真的跑一次批量登录
（会改动会话、耗时，还容易触发风控）。本功能只读访问 `myaccount.google.com`，按落点判定：

| 结论 | 判定依据 | 写回 |
|---|---|---|
| `ok` | 域名是 myaccount 且页面（文本或 HTML）出现该邮箱 | `login_status = logged_in`（顺带清空 last_error） |
| `need_login` | 跳回 accounts.google.com / www.google.com；或 myaccount 两个页面都看不到该邮箱 | `login_status = not_logged`，先清掉旧 last_error |
| `suspended` | 地址含 `/disabled`，或页面出现停用文案（复用 `login.ts` 的 `TEXT.ACCOUNT_DISABLED`） | `login_status = login_failed` + last_error |
| `window_error` | 导航失败 / 拿不到地址 / 未绑定窗口 | **不改** login_status，只写一条 last_error（窗口坏 ≠ 账号状态坏） |

- 文件：`src/automation/auto-health-check.ts`（判定 + 写回）、`src/application/health-check.ts`（批量编排）、
  `src/db/account-repository.ts` 新增 `setLastError()`、通道动作 `health_check`、账号管理页「健康巡检」按钮
- **为什么必须单独加 `setLastError`**：`updateLoginStatus` 对 `logged_in` 会把 `last_error` 置空，
  于是「状态是已登录、但窗口有问题」根本写不进去（有专门的回归测试盯着这个坑）
- 坏账号不挡整批：未绑定窗口的账号直接判 `window_error` 且不去连引擎；单个账号抛错也只影响它自己
- 真机（窗口 7）：真实邮箱 → `ok`（依据「myaccount 页面显示了该账号邮箱」，URL `myaccount.google.com/?hl=en`）；
  同一窗口传不匹配邮箱 → `need_login`（依据「myaccount 页面未显示该邮箱」）
- **只读有硬证据**：用原型打点记录巡检期间调用过的引擎方法，两次判定分别调用 5 / 10 次，
  方法集合只有 `navigate / wait / getCurrentUrl / getPageContent / getPageHtml` —— 非只读方法为空
  （没有 `fill` / `click` / `typeText` / `pressKey` / `act`）
- 生产路径真跑：`health_check` 任务 `outcome=succeeded`、`total=1 / 正常 1`、逐条目 `成功 | 已登录`、
  `login_status` 由 `not_logged` → `logged_in`，任务历史里可查
- 只读独立复验（`hc-verify.py`，逐表 + accounts 列级白名单）：15 张既有表逐行一致，
  accounts 只有测试账号的 `updated_at` / `last_login_at` 变化，账号增删为 0 → PASS
- 未覆盖：`suspended` 与 `window_error` 没有真机验证（不会为了测试把账号搞停用 / 弄坏窗口），
  只有单测；批量多账号没上真机（真机 1 个账号）；GUI 按钮没真点

### 登录「选择验证方式」页的修复（2026-09-24，属于登录轮）

真机现象（用户反馈「没有正确填入密钥」）：账密提交后落在
`https://accounts.google.com/v3/signin/challenge/selection`，页面是「Choose how you want to sign in:
Get a verification code from the Google Authenticator app」，而 `LoginOperation` 只处理**直接出现**的
验证器输入框，于是判 `need_2fa` 结束 —— **流程压根没走到填验证码那一步**。

排查顺序与结论：

1. 先排除算码算法：用独立实现（标准 HMAC + base32 解码）对同一密钥、4 个固定时间点比对，
   全部一致；带空格 / 小写的密钥也能正确生成 → 不是 TOTP 的问题
2. 只读 DOM 探测该页：可点元素是 `<div role="link" jsname="EBHGs" tabindex="0">Get a verification code
   from the Google Authenticator app</div>`（内层），而 `clickByText("Google Authenticator app")` 返回 `null`
3. **根因**：`textClickScript` 用 `label(el).startsWith(want)` 匹配，而这一项的文本以
   「Get a verification code from the …」开头，永远匹配不上（之前的临时绕过脚本用的是「包含」匹配，所以能过）

修法：

- `stagehand-engine.ts`：`textClickScript(text, mode)` 增加 `contains` 模式（默认仍 `prefix`，
  不影响「保存 / 下一步」这类按钮的精确匹配）；命中元素打 `data-abb-text-hit="1"` 标记供坐标点击兜底
  （沿用踢出设备那轮的真机教训：Google 的 Material 列表项对 DOM `click()` 不响应）
- `operations/login.ts`：新增 `chooseAuthenticator()`，在 `verify_selection` 阶段用 contains 模式尝试
  `Google Authenticator app` / `Authenticator app` / `身份验证器` / `验证器应用`；点到后等页面进验证码页
  （跳不动就用标记选择器坐标点击重试）；都点不到仍保持原 `need_2fa` 结论，不假装成功
- 测试：`engine-click-by-text.test.mjs` 增 2 条、`engine-login.test.mjs` 增 3 条（先红 4 → 全绿）
- 真机复跑：同一账号 `execute: success=true state=logged_in`（修复前每次都停在 `need_2fa`）

### 从模板创建窗口（F3，2026-09-24）

首页「根据模板创建窗口」：选模板窗口 → 建 N 个 → 名字为「前缀_序号」→ 归入目标分组。
原先这两个按钮是 TODO 桩，本次基于 ixBrowser 官方的「复制窗口」动作把它补成可用的批量任务。

| 文件 | 作用 |
|---|---|
| `src/ixbrowser/client.ts` | `copyProfile()`——官方「复制窗口」（action `profile-copy`） |
| `src/application/create-windows.ts` | 批量编排 + 前缀回落（空前缀用模板窗口名） |
| `app/shared/channels/home.ts` | 通道 `abb/home/createBrowsers`、任务类型 `home_create_browsers`、`MAX_CREATE_COUNT = 20` |
| `app/host/handlers/home.ts` | 入参校验 + 模板存在性检查 + 后台任务 |
| `app/renderer/.../HomePage.tsx`、`home/ConfigCard.tsx` | 按钮接实现 + 个数输入 + 确认框；配置卡片新增 `onValuesChange` 上报（按钮要拿到**刚输入**的模板 ID） |

关键取舍：

- **用官方 `profile-copy` 而不是手工映射字段再 `profile-create`**：服务端自己知道一次复制要带哪些东西；
  手工映射漏掉的字段会**静默**变成默认值，产出「看着像模板、其实不一样」的窗口。我们只决定名字与分组。
- **命名**：`{前缀}_{序号}`，序号每建一个都按当前窗口列表重算（同前缀最大序号 + 1），
  因此不会撞名、中断后再跑能接着编号；前缀为空用模板窗口名。
- 模板不存在**直接拒绝**（不启动任务）；一次最多 20 个；界面上有确认框（这是真实副作用）。

真机暴露并修掉的缺陷：**`profile-copy` 的 `data` 是裸数字**（`{"data":835}`），
而 `profile-create` 是 `{"data":{"profile_id":N}}`。TS 版只按对象解包 → 新窗口 ID 变成 `undefined`
且被 `JSON.stringify` 静默丢掉，任务报成功但拿不到 ID（后续删除无从下手，测试窗口留在库里）。
修法：两种形状都认，认不出来就抛错。真机第二轮：创建 → 12 项配置与模板逐字段一致 →
列表可见 → 删除 → 窗口 id 集合与创建前完全相同、无残留。
详见 `.trellis/tasks/09-24-create-windows-real-run/real-run-log.md`。

未覆盖：没有真的打开克隆出的窗口（只核对配置与列表可见性）；一次建多个未真机（单测覆盖）；
GUI 按钮未真点；「使用默认模板创建」「停止任务」两个桩按钮仍禁用。

### 修改账号密码（F1，2026-09-24）

账号管理 / AI 任务页新增「修改密码」：勾账号 → 系统**自动生成强随机密码**（20 位、四类字符齐全、
排除易混淆的 `I O l 0 1`）→ 走 Google 改密页 → **确认 Google 侧确实改成功之后**才写回两处落点
（`accounts.password` / 窗口 `password` 字段；**窗口备注一律不碰**，见下）。这个顺序是刻意的：
反过来会留下「库里是新密码、Google 还是旧密码」，之后所有登录都会失败。

| 文件 | 作用 |
|---|---|
| `src/core/random-password.ts` | `generateStrongPassword()`（长度 < 16 直接抛错，不静默降级） |
| `src/engine/operations/change-password.ts` | `ChangePasswordOperation`：两步重新验证身份（密码 → TOTP）→ 填两次新密码 → 点「更改密码」→ 判定 |
| `src/automation/auto-change-password.ts` | 两处写回 `saveNewPassword()`、结果上报 `describeSaveOutcome()`、编排 `autoChangePassword()` |
| `src/application/ai-task-runner.ts`、`app/host/handlers/ai-tasks.ts` | AI 任务 `change_password`（`ai_change_password`）；op 日志接通任务日志 |
| `app/renderer/src/App.tsx` | 「修改密码」页 |

真机三轮（窗口 7、真实账号）：

1. **第一轮：改密其实成功了，但判定失灵 → 新密码丢失。** 真机确认文案是「密码**已成功更改**」，
   而成功词表只有「已更改」——「已成功更改」里**没有连续的「已更改」**，于是 op 报
   「无法确认密码是否已更改」→ 按约定不写本地 → 三处落点全是旧密码，账号本地凭据整体失效
   （`run-change-password-1.log`）。雪上加霜的是**那一轮完全没有记录提交后的页面文本**，事后只能靠猜。
2. **恢复**：用户找回并确认了新密码；先用它在真机上**登出再登录成功**（`verify-newpw-1.log`），
   再走生产写回函数补齐三处落点（`writeback-1.log`，`{"db":true,"note":true,"windowPassword":true}`）。
3. **第二轮：修好判定后复跑端到端通过** —— op 报成功、三处落点都是新密码、关窗后用新密码登录成功
   （`run-change-password-2.log`），并拿到真机提交后页面原文
   （`myaccount.google.com/security-checkup-welcome?rapt=…`，「账号 帮助 密码已成功更改 …」），
   反过来印证了第一轮的根因判断。

修掉的四处（每处都有真机回归测试，`test/engine-change-password.test.mjs` 12 条）：

- **成功词表缺口（根因）**：补「已成功」等变体，覆盖「已成功更改 / 已成功更新 / 已成功修改」。
- **提交后没有证据**：判定时把 `url + 页面文本` 记进任务日志，结果消息也带上判定依据（会进任务历史）。
- **兜底判据必须取正例**：「已离开密码页且密码表单消失」现在要求**确实取到了页面**、URL 非空、
  主机是 `myaccount.google.com`（且不在密码页路径上）、页面文本 ≥ 20 字 —— 引擎已死
  （`getCurrentUrl` 抛错、`isVisible` 恒 false）、`chrome-error://` 错误页、登出落地页
  `www.google.com/account/about` 都不可能再被判成成功（代码审查指出的假成功形态，逐条补了用例）。
- **静态提示词不得当拒绝**：拒绝词表原本含「至少使用 8 个字符」，而真机密码表单页**永远**写着
  「密码强度： 请至少使用 8 个字符」—— 提交后第一轮检查时页面常常还没跳走，于是「还在提交中」
  会被判成「Google 拒绝了新密码」→ 又不写本地 → 再次丢密码。已删掉静态/过宽词（连同 `invalid`/`无效`），
  并要求连续两轮命中才算拒绝。

另有一处接线缺陷（代码审查发现）：`ChangePasswordDeps` 少了 `callback` 时，op 的全部日志
（含判定依据）会被静默丢弃、到不了界面 —— handler 里已把 `api.log` 接上。两处落点**都**写失败时
不再报成功，而是报失败并在消息里给出重设指引（`describeSaveOutcome`）。

**窗口备注（note 字段）交回用户手工维护。** 真机核查时用户问「新密码记录了吗」，逐字段核对发现
备注第 2 段不是当前密码，而备注里有三个按时间排列的密码段 —— 用户确认那是**他手写的**历史记录。
根因是三条写备注的路径互相覆盖：改密替换第 2 段（会顶掉他手写的旧密码）、导入 TOTP 用
`邮箱----密码----辅助邮箱----密钥` 整条**重建**（清空手写内容）、修改验证器按段数把密钥插进备注
（还会拼出空段）。用户决定「自动化任务一律不碰备注」，于是三处全部收窄为只写该写的：
改密 → 数据库 + 窗口 `password` 字段；导入 TOTP / 修改验证器 → 只写 `tfa_secret`；
`replacePasswordInNote` / `NOTE_SEPARATOR` / `SavePasswordResult.note` 随之删除。
真机零副作用复核（写入值与现值相同，只看备注有没有被动）：改密写回与导入 TOTP 跑完，
备注 135 字符、sha256 `7feb063319cb` **一字未改**，`updateProfile` 收到的参数只剩 `tfa_secret`。

未覆盖：GUI 里没有真点按钮（任务体与界面走同一条 `change_password` 路径，但按钮本身没点过）；
「一次改多个账号」未真机（单测覆盖计数与停止语义）；`describeSaveOutcome` 四种组合只有单测；
「点击后二次确认弹层」没有任何真机证据，真机没出现过；「修改验证器不再写备注」只有代码改动 +
grep 复核，未真机跑（验证它要真的改一次验证器）。

## 四、下一步

- **仍欠真机验证**：设置页的账号与代理导入导出、批量登录的多账号 / 异常账号边界、各页 GUI 按钮的真点击；
  「重新验证身份」合并（C4）后的真机回归；修改验证器的新验证码改走 `fill`（ARCHITECTURE §9 D10，需先做真机探针）
- **已真机回归**：打开窗口 / 批量绑定 / 批量登录 / 替换手机号 / 替换辅助邮箱 / 修改验证器 / 修改 2SV 手机 /
  踢出设备 / 导入 TOTP / 任务历史（F4）/ 健康巡检（F2）/ 从模板创建窗口（F3）/ 修改密码（F1）——
  各自独立复跑成功，并与账号真实状态只读核对一致
- **用户确认不做 / 已删除**：家庭组加入；AI 页接入 SMS-Bus / IMAP 验证码（触发验证码即判失败）；
  OAuth / 检测 Pro / 刷新家庭组 / 开启共享 / 403 解锁 / Sub2API；辅助邮箱池与邮箱验证码读取（无产品入口）

## 五、环境备忘

| 项 | 值 |
|---|---|
| Node | 22.19（需 `--experimental-sqlite`、`--experimental-strip-types`） |
| 包管理 | pnpm 10.28（见 `pnpm-lock.yaml`） |
| 运行探针 | `pnpm probe:ix`（ixBrowser 只读）、`pnpm probe:db`（数据库只读） |

**已知告警（可忽略）**：
- `node:sqlite` 与类型剥离都还是 experimental，会打警告
- Stagehand 连接 ixBrowser 时 ixBrowser 侧会打印 `Extensions.* not found` 探测日志（3.7.3 会尝试后回退，不影响功能）
- `pnpm add` 时会提示 `openai@4.104.0` 的 peer `zod@^3` 与仓库里的 zod 4 不匹配——Stagehand 自带副本，实测不影响
