# 引擎层垂直切片验证报告

> 目标：在投入 11,488 行引擎重写之前，验证 Node 版 Stagehand 能否复现 Python 版的核心能力。
> 结论：**技术可行**，但有一个必须固定的版本约束。

## 验证方式

挑最简单的 operation（kick_devices）所依赖的四个原语做真机切片，
只做只读探测，不调用 `act()`，不点击、不登出任何设备。

目标窗口：ixBrowser #370 / AbdellaScholin@gmail.com

## 结果：5 步全通

| 步骤 | 结果 |
|---|---|
| 1. ixBrowser 开窗拿 CDP 端点 | ✅ `ws://127.0.0.1:39986/devtools/browser/...` |
| 2. Stagehand 经 CDP 接管 | ✅ 连接成功 |
| 3. navigate 到 Google 页面 | ✅ 真实跳转 |
| 4. observe 识别元素 | ✅ 调用成功（该页 0 个设备条目，符合页面实际） |
| 5. extract 结构化抽取 | ✅ 真实调用 Gemini，抽出账号名 |

## 关键发现：必须锁 3.x，不能用 4.x

**Node 侧最新是 4.1.0，但它与 ixBrowser 架构级不兼容。**

4.x 改用浏览器扩展架构，连接时必须调用 `Extensions.loadUnpacked` 注入扩展。
用原始 CDP 直接探测 ixBrowser 的 Chrome：

```
浏览器: Chrome/142.0.7444.93 | CDP协议: 1.3
Target.getTargets            支持
Extensions.getExtensions     不支持  ('Extensions.getExtensions' wasn't found)
Extensions.loadUnpacked      不支持  (Method not available.)
```

ixBrowser 的 Chromium 禁用了 `Extensions.*` CDP 域，
所以 4.x 在 `Stagehand.create()` 阶段就报 `Method not available` 直接失败。

**降级到 3.7.3 后全部打通** —— 3.x 仍是 Playwright/CDP 架构，与 Python 侧 3.5.0 同代。

> 这意味着 `package.json` 必须锁 `"@browserbasehq/stagehand": "3.7.3"`，
> 且**不能**随手升级到 4.x。建议在依赖里写死版本并加注释。

## API 差异对照（Python 3.5.0 → Node 3.7.3）

| 能力 | Python | Node |
|---|---|---|
| 实例化 | `AsyncStagehand(server="local", ...)` | `new Stagehand({ env: "LOCAL", localBrowserLaunchOptions: { cdpUrl } })` |
| 会话 | `stagehand.sessions.start(model_name=...)` | `await sh.init()` |
| 页面对象 | `session` 自身即 page | `await sh.context.awaitActivePage()` |
| act/extract/observe | `session.act(input=..., options=...)` | **V3 顶层**：`sh.act(instruction, options)` |
| extract 传 schema | pydantic BaseModel | zod schema |

注意两个坑：

1. **没有 `sh.page`** —— V3 把 act/extract/observe 提到了顶层，
   页面对象要走 `sh.context.awaitActivePage()`。
2. **`model.clientOptions.apiKey` 不生效** ——
   实测必须设环境变量 `GOOGLE_GENERATIVE_AI_API_KEY`，
   否则底层 ai-sdk 报 `AI_LoadAPIKeyError`。
   移植时要在启动子进程前注入对应 provider 的环境变量
   （Python 侧的 `_setup_provider_env_vars()` 做的是同一件事）。

## 迁移成本重估

切片证明了「能连上、能跑」，但这只覆盖了引擎的**管道层**。真正的成本在别处：

| 部分 | 行数 | 切片覆盖 | 说明 |
|---|---|---|---|
| 引擎管道（连接/导航/四原语） | ~1,400 | ✅ 已验证 | 机械翻译，风险低 |
| 15 个 operation 的提示词 | ~9,000 | ❌ 未覆盖 | 每个都要真实账号逐一回归 |
| BrowserUse 自研引擎 | ~4,500 | ❌ 未覆盖 | 纯重写 |

15 个 operation 里沉淀的是对 Google 页面的经验（家庭组误判、Pro 二次校验、
403 解封流程），这些没有规格可对照，正确性只能靠真实跑账号验证——
而每验证一次就要消耗一个账号的状态。

## 建议

管道层可以放心移植。但在动 operation 之前，建议先明确：

1. **准备多少个可消耗的测试账号**？每个 operation 至少要 2-3 次真实回归。
2. **失败了怎么回滚**？Python 版仍可用，是否保留双轨并行一段时间。
3. **要不要全量迁**？也可以只迁 Pro 检测、家庭组这类高频操作，
   低频的（OAuth、解封 403）继续走 Python 子进程。

## 复现方式

```powershell
cd desktop
$env:GOOGLE_GENERATIVE_AI_API_KEY = "<gemini key>"
$env:ABB_API_KEY = "<gemini key>"
node --experimental-strip-types src/engine/probe-stagehand.ts <profileId>
```

脚本是只读的：只做 navigate / observe / extract，绝不调用 `act()`。