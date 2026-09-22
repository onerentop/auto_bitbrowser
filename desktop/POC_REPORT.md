# services 层 Node 重写 POC 报告

> 日期：2026-09-23 · 结论：**技术可行，但引擎层不建议重写**

## 目标

验证「用 Node/TypeScript 重写 Python services 层」的可行性，为是否继续重写引擎层提供依据。

## 已完成

| 模块 | 文件 | 对标 Python |
|---|---|---|
| ixBrowser 协议层 | `src/ixbrowser/types.ts`、`client.ts` | `ixbrowser_local_api` 包 |
| ixBrowser 探针 | `src/ixbrowser/probe.ts` | — |
| SQLite 连接 | `src/db/connection.ts` | `services/database.py` |
| 账号仓储 | `src/db/account-repository.ts` | `services/repositories/account_repository.py` |
| 代理仓储 | `src/db/proxy-repository.ts` | `services/repositories/proxy_repository.py` |
| 单元测试 | `test/ixbrowser.test.mjs` | — |

## 验证结果

### 1. 单元测试 13/13 通过

覆盖信封解包的全部分支：成功取 data、成功无 data 返回 true、`code!==0` 抛错、HTTP 非 200、缺 `error` 键、缺 `error.code` 键、网络异常包装，以及 3 个参数组装陷阱。

### 2. ixBrowser 真机对拍 —— 8 项全部一致

```
Node : {"close_2007":true,"exact_hit":true,"group_count":13,"nonexistent_returns_empty":true,
        "page1_count":5,"paged_total":374,"sample_profile_id":833,"total":374}
Python: {"close_2007":true,"exact_hit":true,"group_count":13,"nonexistent_returns_empty":true,
        "page1_count":5,"paged_total":374,"sample_profile_id":833,"total":374}
```

连窗口顺序、代理地址、分组名都逐字相同。

### 3. 数据库真机对拍 —— 12 项全部一致

```
Node : {"account_count":286,"all_len":286,"email_hit":true,"next_available_proxy":null,
        "proxy_count":20,"proxy_stats_len":20,"status_error":19,"status_ineligible":68,
        "status_subscribed":193,"status_verified":6,"table_count":16,"unbound":0}
Python: 完全相同
```

包含 `LEFT JOIN + GROUP BY + HAVING` 的代理用量统计，结果一致。

### 4. 类型检查通过

`tsc --noEmit` 在 `strict: true` + `noUncheckedIndexedAccess` 下零错误。

## 过程中踩到并解决的问题

| 问题 | 原因 | 处理 |
|---|---|---|
| `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX` | Node strip-only 模式不支持构造函数参数属性 | 改为显式字段声明 |
| better-sqlite3 加载失败 | 原生模块二进制未下载，pnpm 默认不跑 build script | **改用 Node 22 内置 `node:sqlite`**，零原生依赖 |
| `no such column: id` | `accounts` 表主键是 `email`，没有 `id` 列 | 排序改 `ORDER BY email` |

`node:sqlite` 的选型收益不止于省掉编译：Electron 下用 better-sqlite3 还需 `electron-rebuild`，换成内置模块后这一整类问题消失。代价是它目前仍是 experimental，需要 `--experimental-sqlite`。

## 关键发现：协议层有多个「不可想当然」的陷阱

这些行为在 Python 源码里是隐式的，重写时若不逐行核对必然踩坑：

1. **全部接口都是 POST**，包括"查询列表"
2. **无任何认证** —— 只要本机 53200 在监听就能调
3. 传了 `profile_id` 就**只发这一个字段**，`page`/`limit` 全部丢弃
4. `keyword` 发出去的键名是 **`name`**
5. `cookie` 为空时**绝对不能发送该键**，否则服务端 cookie 加载失败
6. `proxy_port` 是**字符串**，`tag_id` 空值是**空串**而非 null
7. 成功但无 `data` 时 Python 返回 `True`，Node 必须等价处理
8. 查不存在的窗口**不报错**（返回空），但关闭不存在的窗口**报 code=2007**

## 工作量评估

| 层 | Python 行数 | POC 覆盖 | 重写难度 |
|---|---|---|---|
| ixBrowser API | ~1,500 | 协议层已完成 | **低** —— 纯 HTTP，已验证 |
| 数据库 + 仓储 | ~3,900 | 2/6 仓储完成 | **低** —— 纯 SQL，可机械翻译 |
| 其余 services | ~1,200 | 未做 | **中** —— Sub2API/SMS-Bus 是 HTTP；IMAP 需换库 |
| `automation/` | 6,056 | 未做 | **高** —— 13 个流程，含大量 Google 页面经验 |
| `core/` 双引擎 | 11,488 | 未做 | **极高** —— 见下 |

### 引擎层的硬阻碍

- **Stagehand**：Python SDK 与 Node SDK API 有差异，15 个 operation 的自然语言指令需全部重调
- **BrowserUse**：自研 agent 循环 + DOM 序列化 + LLM 适配器，纯重写
- **`pyzbar`**（二维码）：Node 侧需换 `jsQR`，识别率要重新验证
- **`pyotp`**（TOTP）：有 `otplib` 可替代，成本低
- **`imap_tools`**（收验证码）：有 `imapflow` 可替代，成本中等
- 引擎里沉淀的 Google 页面处理经验（家庭组误判、Pro 二次校验、403 解封）**重写等于重踩一遍**

## 建议

POC 证明 **services 层重写完全可行**，而且质量可验证（对拍逐字一致）。

但从收益看，建议**到此为止**：

- ixBrowser + 数据库这两块重写后，只是把「能用的 Python」换成「能用的 Node」，对最终用户零变化
- 真正的价值在前端界面，而前端调用 Python 子进程（JSON-RPC）与调用 Node 模块，**对 React 完全无差别**
- 把重写预算投在 `automation/` 和 `core/` 上，风险收益比很差

若确定继续，建议顺序：`services` 剩余 4 个仓储 → Sub2API/SMS-Bus → IMAP → 暂停，重新评估引擎层。

## 运行方式

```powershell
cd desktop
pnpm install

pnpm test          # 单元测试 13 个
pnpm typecheck     # 类型检查
pnpm probe:ix      # ixBrowser 真机探针（需 ixBrowser 运行中）
pnpm probe:db      # 数据库探针（只读，不写生产库）
```

两个探针都是**只读**的：ixBrowser 侧只调 `profile-list` / `group-list`，不打开也不创建窗口；数据库侧以 `readOnly: true` 打开。
