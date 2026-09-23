# Node/TypeScript 重写进度

> 最后更新：2026-09-23 ｜ 分支 `dev_ai` ｜ 全部已提交推送

## 零、接续开发指引（清空上下文后先读这里）

### 第一步：让新会话恢复认知

把下面这段直接粘给新会话：

```
读 desktop/PROGRESS.md 与 desktop/ENGINE_SLICE_REPORT.md 恢复上下文。

本项目正在把 Python 的 ixBrowser 自动化工具重写成 Node/TypeScript，
代码在 desktop/ 目录。Python 侧保持原样作为对拍基准与回退方案。

当前进度：services 层与 engine 层已完成，automation 层 12/15。
下一步按 PROGRESS.md 第五章的依赖顺序继续（首先 BrowserUse 引擎）。

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
pnpm test               # 应 111/111 通过
pnpm verify:prompts     # 应 100%（依赖 scratch 里的 ops_spec.json，见下方说明）
pnpm verify:selectors   # 应 0 缺失
```

四项全绿说明代码与文档一致，可以放心继续。

### 第三步：确认 Python 侧基线

```powershell
cd D:\workspace\projects\auto_bitbrowser2
.\.venv\Scripts\python.exe -m pytest -q
# 基线：70 passed, 5 failed（那 5 个是 HEAD 上既有的，不是回归）
```

### 若 scratch 已被清理

`pnpm verify:prompts` 依赖 `$env:PI_SCRATCH_DIR/ops_spec.json`。
该文件随 scratch 清理会消失，用仓库内的脚本重建：

```powershell
# 在项目根目录执行
.\.venv\Scripts\python.exe desktop\scripts\extract-ops-spec.py <输出路径>
cd desktop
node scripts/verify-prompts.mjs <输出路径>
```

### 工作目录速查

| 位置 | 内容 |
|---|---|
| `desktop/PROGRESS.md` | 本文件——进度、决策、坑 |
| `desktop/ENGINE_SLICE_REPORT.md` | 引擎切片验证报告（Stagehand 版本约束的原始依据） |
| `desktop/src/services/` | services 层（已完成） |
| `desktop/src/engine/` | 引擎层（已完成） |
| `desktop/src/automation/` | 业务流程层（进行中） |
| `desktop/scripts/` | 三个校验/提取脚本 |
| `desktop/test/` | 111 个单测 |
| Python 侧（`core/` `services/` `automation/`） | **勿动**，对拍基准 |

---

## 一、当前状态速览

| 层 | 进度 | 文件 | 行数 |
|---|---|---|---|
| `services`（数据与服务） | ✅ 完成 | 12 | ~3000 |
| `engine`（Stagehand 引擎） | ✅ 完成 | 17 | ~4300 |
| `automation`（业务流程） | 🟡 12/15 | 14 | ~2900 |
| `browseruse_engine` | ❌ 未开始 | — | (4303 行待移植) |
| 前端界面 | ❌ 未开始 | — | — |

**质量门（全绿）**：
```powershell
cd desktop
pnpm typecheck          # tsc strict 零错误
pnpm test               # 111/111 通过
pnpm verify:prompts     # 引擎提示词覆盖率 100%（92/92）
pnpm verify:selectors   # 选择器缺失 0（197/197）
```

## 二、已完成部分

### 1. services 层（全部）

| 模块 | 说明 |
|---|---|
| `ixbrowser/client.ts` | ixBrowser HTTP 协议，含 CDP 端点获取 |
| `db/connection.ts` | 用 Node 内置 `node:sqlite`（免原生编译、免 electron-rebuild） |
| `db/*-repository.ts` × 6 | 账号 / 代理 / 历史 / 邮箱池 / 刷新任务 / IO |
| `core/data-parser.ts` | 账号行解析（URL 提取 + 多分隔符探测） |
| `services/sms-bus-client.ts` | 接码平台 |
| `services/sub2api-client.ts` | Sub2API |
| `services/email-code-reader.ts` | Gmail 验证码（提取逻辑为纯函数） |
| `services/invite-lock.ts` | 邀请锁 |
| `services/proxy-allocator.ts` / `data-store.ts` | 代理分配与缓存 |
| `services/recovery-email-manager.ts` | 辅助邮箱池策略 |

**对拍验证**：综合查询 8008 个字段与 Python 逐字段零差异。

### 2. engine 层（全部）

| 模块 | 说明 |
|---|---|
| `stagehand-engine.ts` | CDP 接管 + 四原语 + 12 个 operation 门面 |
| `constants.ts` | 35 URL / 12 超时 / 41 组关键词（**脚本自动生成**） |
| `types.ts` | 5 枚举 + 18 结果类型 + 工厂函数（自动生成） |
| `totp.ts` | RFC 6238 自研实现 |
| `playwright-compat.ts` | 把 V3 Page 适配成 Playwright 接口 |
| `operations/*.ts` × 12 | 全部 operation |

**提示词一致性**：92/92 与 Python 逐字一致（`verify:prompts` 校验）。

### 3. automation 层（12/15）

| 文件 | 状态 |
|---|---|
| `shared.ts` | ✅ 共享样板 |
| `auto-google-login.ts` | ✅ |
| `auto-kick-devices.ts` | ✅ |
| `auto-modify-2sv-phone.ts` | ✅ |
| `auto-modify-authenticator.ts` | ✅（含密钥三处保存） |
| `auto-replace-recovery-email.ts` / `-phone.ts` | ✅ |
| `auto-enable-family-sharing.ts` | ✅（含批量） |
| `auto-unlock-403.ts` | ✅（带重试循环） |
| `auto-antigravity-oauth.ts` | ✅（含批量） |
| `pro-status-detector.ts` | ✅（含二次验证 4 分支） |
| `auto-replace-email.ts` / `auto-replace-phone.ts` | ✅（Playwright 选择器直连） |
| `auto-join-family.ts` | ❌ 待 BrowserUse |
| `batch_account_processor.ts` | ❌ 依赖汇聚点，最后做 |

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

### 自研 TOTP 而非 otplib

otplib 13.x 的导出结构与 12.x 完全不同（`TOTP` 类与 functional API 并存），且该库有跨版本破坏先例。TOTP 是标准算法，`totp.ts` 40 行即可对齐 `pyotp`，已对拍 24 组零差异。

**当时的坑**：第一版误用 `Buffer.from(s, "base64")` 解码 base32，对拍才发现。

### Stagehand API 差异（Python 3.5.0 → Node 3.7.3）

- **没有 `sh.page`** —— act/extract/observe 在 V3 顶层，页面对象走 `sh.context.awaitActivePage()`
- **`model.clientOptions.apiKey` 不生效** —— 必须设 provider 环境变量（`GOOGLE_GENERATIVE_AI_API_KEY`），等价于 Python 的 `_setup_provider_env_vars()`

### 行为修正：getPageContent 用 innerText 而非 HTML

关键词检测（Pro 状态、家庭组角色）依赖可见文本做子串匹配。原先用 `page.content()` 返回 HTML 会导致误命中（`class="upgrade-banner"` 让页面被判为非订阅），且跨标签文本匹配不到。

已改为 `evaluate("document.body.innerText")`，与 Python 的 `page.inner_text("body")` 语义一致。

### 刻意保留的可疑行为

`operations/login.ts` 的 `enterPassword` 中，`act()` 成功后**仍会执行键盘输入**，密码可能被输两次。这是照搬 Python 的（指令里不含密码值，AI 无从输入，该分支实际不会触发）。已加注释，真机验证后可安全移除。

### 判定顺序不可调换的两处

| 位置 | 约束 |
|---|---|
| `operations/unlock-403.ts` | `disabled` 必须排在 `sign in` 之前——封号页面通常也含 "sign in"，顺序颠倒会把封号误判为「无需解锁」 |
| `operations/modify-auth.ts` | 密钥解析先匹配裸 Base32，再匹配带标签形式 |

### Playwright 兼容层的一个细节

Google 验证弹窗里 `Verify` 按钮在**右侧**，必须用 `clickLastVisible`（对应 Python 的 `.last`）。用 `first` 会点到左侧无关元素。

## 四、自动化校验工具（新增，务必使用）

这两个脚本是防回归的核心，改动提示词或选择器后必须跑：

```powershell
cd desktop
pnpm verify:prompts     # 引擎 92 条提示词与 Python 逐字比对
pnpm verify:selectors   # auto_replace_* 的 197 个选择器比对
```

生成这两个脚本用的中间产物在 `$env:PI_SCRATCH_DIR`：
- `ops_spec.json` —— 由 `extract_ops.py` 从 Python 提取的提示词清单
- 若 scratch 被清理，需重新提取（脚本已提交在 `desktop/scripts/`）

> ⚠️ `verify:prompts` 依赖 `ops_spec.json`，该文件在 scratch 目录。若丢失，
> 需重新从 Python 侧提取（见 `scripts/verify-prompts.mjs` 的用法说明）。

## 五、下一步（按依赖顺序）

1. **BrowserUse 引擎**（4303 行）→ 解锁 `auto_join_family`
   - 结构：`engine.py` 934 行 + `agent/` `dom/` `llm/` `tools/` 四层
   - 入口是 `send_family_invite` 与 `join_family` 两个 operation
   - `pro-status-detector.ts` 已预留引擎无关接口（`ProDetectEngine`），可无缝接入
2. **`batch_account_processor.ts`**（2261 行）—— 依赖全部就绪后再做
3. **前端界面** —— 接口形状取决于上面全部定型后的样子

## 六、Python 侧现状（勿动）

Python 代码**保持原样可用**，是当前的对拍基准与回退方案：
- `core/` `services/` `automation/` 全部未修改
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