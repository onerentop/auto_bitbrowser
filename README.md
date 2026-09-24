# ixBrowser Automation Tool (ixBrowser 自动化管理工具)

![License](https://img.shields.io/badge/license-MIT-blue.svg) ![Electron](https://img.shields.io/badge/Electron-44-blue.svg) ![TypeScript](https://img.shields.io/badge/TypeScript-5.9-blue.svg)

批量管理 Google 账号的桌面工具：驱动 ixBrowser 指纹浏览器批量完成登录、账号信息修改与状态检测。
基于 **Electron + TypeScript + React** 重写（旧的 Python/PyQt6 实现已移除）。

使用教程文档：https://docs.qq.com/doc/DSEVnZHprV0xMR05j?no_promotion=1&is_blank_or_template=blank

---

## 📢 广告 / Advertisement

🏆 **推荐使用 ixBrowser** - 专业的指纹浏览器解决方案
👉 **[官网访问 / Visit](https://www.ixbrowser.com/)**

💳 **虚拟卡推荐 - HolyCard** - 支持Gemini订阅、GPT Team、0刀Plus，一张低至2R
👉 **[立即申请 / Apply Now](https://www.holy-card.com/)**

---

## ✨ 功能特性 (Features)

* **窗口管理（首页）**:
  * 列出 / 打开 / 关闭 / 删除 ixBrowser 窗口，支持批量操作。
  * **根据模板创建窗口**: 用官方 `profile-copy` 克隆（不是手工映射字段，避免漏字段变成默认值），
    支持自定义前缀自动编号（`店铺A_1`、`店铺A_2`…），空前缀则沿用模板窗口名。
* **账号管理**:
  * 账号增删改查、状态与 Pro / 家庭组信息一览。
  * **批量登录**: 自动填邮箱、密码、TOTP 验证码；遇「选择验证方式」页会自动选验证器。
  * **自动绑定窗口**: 导入 / 添加账号后按窗口名（= 邮箱）自动绑定；同名窗口有多个时不猜，列表标「同名×n」，
    由用户右键「绑定窗口」确认（对话框里同名窗口排最前）。
  * **健康巡检**: 批量只读判定每个账号在窗口里的会话状态（已登录 / 需要登录 / 已停用 / 窗口异常），
    并把结论写回数据库。判定过程不调用任何写操作。
* **AI 批量任务**（逐账号串行执行，每个都会留下可复盘的任务日志）:
  * **替换手机号**、**替换辅助邮箱**（辅助邮箱可留空表示移除）
  * **修改验证器**: 生成新 TOTP 密钥并写回数据库、历史表、`已修改密钥.txt` 与窗口的 `tfa_secret`
  * **修改 2SV 手机**、**踢出设备**
  * **修改密码**: 自动生成 20 位强随机密码；**确认 Google 侧改成功之后**才写回数据库与窗口 password 字段
* **导入 TOTP 密钥**:
  * 文本模式（`邮箱----密钥`、URI 等）与二维码模式（截图 / Google Authenticator 导出）。
  * 写入数据库 `secret_key` 与窗口 `tfa_secret`。**不碰窗口备注**（备注是用户自己的笔记区）。
* **设置**:
  * 账号（含批量导入 / 导出）、代理（增删改 + 绑定窗口）、配置（AI provider / 密钥、并发数）。
  * **任务历史**: 批量任务的结果会落库（含逐条目），可在界面查看并**导出 CSV**。

## 🛠️ 安装与使用 (Installation & Usage)

### 前置条件

1. **ixBrowser 必须已启动**：所有窗口操作都依赖本地服务 `127.0.0.1:53200`。
2. **AI API Key**：登录与全部 AI 任务都需要，在「设置 → 配置」里填写（敏感字段加密存储）。

### 开发运行

```bash
pnpm install
pnpm run dev
```

### 校验命令

```bash
pnpm run typecheck       # 类型检查
pnpm test                # 单元测试
pnpm run typecheck:app   # Electron 骨架（主进程 + 渲染层）类型检查
pnpm run build:app       # 构建到 out/（本项目没有打包配置）
```

架构与分层规范见 [`ARCHITECTURE.md`](./ARCHITECTURE.md)。

## ⚙️ 配置说明 (Configuration)

### 1. 数据目录

程序采用 **数据库驱动** 架构：账号、代理、历史记录统一存在 SQLite 数据库里，界面直接读写数据库。

数据根目录（`accounts.db` / `config.json` 所在处）由启动时决定；开发时默认是仓库根目录。

**账号字段说明**：
| 字段 | 说明 |
|------|------|
| 邮箱 | Google 账号邮箱（必填，AI 任务执行前会校验「窗口名 == 邮箱」） |
| 密码 | 账号密码（必填） |
| 辅助邮箱 | 备用恢复邮箱（可选） |
| 2FA 密钥 | TOTP 密钥（可选） |
| 状态 | pending / link_ready / verified / subscribed / error |

**代理格式支持**：
- Socks5: `socks5://user:pass@host:port`
- HTTP: `http://user:pass@host:port`
- 简化格式: `host:port:user:pass`

配置模板见 `data/config.example.json`。

### 2. 程序生成的文件

* **accounts.db**: SQLite 数据库（账号、代理、任务历史的唯一存储）。
* **config.json**: 配置（敏感字段加密；已被 `.gitignore` 忽略，不要提交）。
* **已修改密钥.txt**: 「修改验证器」写入的新密钥备份。
* **failed_tasks.json**: 旧版失败任务队列的遗留文件，当前版本不再读写（可删除）。

> 窗口**备注（note）字段由用户自己维护**，所有自动化任务都不会读写它。

## 🤝 联系与交流 (Community)

有问题或建议？欢迎加入我们的社区！

|           💬**Telegram 群组**           |    🐧**QQ 交流群**    |
| :--------------------------------------------: | :-------------------------: |
| [点击加入 / Join](https://t.me/+9zd3YE16NCU3N2Fl) | **QQ群号: 330544197** |
|           ![Telegram QR](Telegram.png)           |       ![QQ QR](QQ.jpg)       |

👤 **联系开发者**: QQ 2738552008

赞赏：
![赞赏](zanshang.jpg)

---

## ⚠️ 免责声明 (Disclaimer)

* 本工具仅供学习与技术交流使用，请勿用于非法用途。
* 请遵守 ixBrowser 及相关平台的使用条款。
* 开发者不对因使用本工具产生的任何账号损失或法律责任负责。

## 📄 License

This project is licensed under the [MIT License](LICENSE).
