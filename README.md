# ixBrowser Automation Tool (ixBrowser 自动化管理工具)

![License](https://img.shields.io/badge/license-MIT-blue.svg) ![Python](https://img.shields.io/badge/python-3.12-blue.svg)

这是一个基于 Python/PyQt6 开发的 ixBrowser 自动化管理工具，支持批量创建窗口、自动分配代理、自动化提取 SheerID 验证链接以及账号资格检测等功能。

使用教程文档：https://docs.qq.com/doc/DSEVnZHprV0xMR05j?no_promotion=1&is_blank_or_template=blank

---

## 📢 广告 / Advertisement

🏆 **推荐使用 ixBrowser** - 专业的指纹浏览器解决方案
👉 **[官网访问 / Visit](https://www.ixbrowser.com/)**

💳 **虚拟卡推荐 - HolyCard** - 支持Gemini订阅、GPT Team、0刀Plus，一张低至2R
👉 **[立即申请 / Apply Now](https://www.holy-card.com/)**

---

## ✨ 功能特性 (Features)

* **批量窗口创建**:
  * **模板克隆**: 支持通过输入模板窗口 ID 进行克隆。
  * **默认模板**: 内置通用配置模板，一键快速创建。
* **智能命名**:
  * **自定义前缀**: 支持输入窗口名前缀 (如 "店铺A")，自动生成 "店铺A_1", "店铺A_2"。
  * **自动序号**: 若不指定前缀，自动使用模板名称或 "默认模板" 加序号。
* **数据库配置管理**: 通过配置管理界面添加账号和代理，数据存储在 SQLite 数据库中。
* **2FA 验证码管理**: 自动从浏览器备注或配置中提取密钥，批量生成并保存 2FA 验证码。
* **SheerID 链接提取**:
  * 全自动打开浏览器 -> 登录 Google -> 跳转活动页 -> 提取验证链接。
  * **精准状态识别**: 自动区分 5 种账号状态：
    1. 🔗 **有资格待验证**: 获取到 SheerID 验证链接。
    2. ✅ **已验证未绑卡**: 有资格且已验证（显示 "Get student offer"）。
    3. 💳 **已绑卡订阅**: 已订阅/已绑卡状态。
    4. ❌ **无资格**: 检测到 "此优惠目前不可用"。
    5. ⏳ **超时/错误**: 检测超时 (10s) 或其他提取异常。
  * **多语言支持**: 内置多语言关键词库及自动翻译兜底，支持全球各种语言界面的账号检测。
* **🎯 自动绑卡功能** (NEW!):
  * **智能 iframe 识别**: 自动处理 Google Payments 的复杂嵌套 iframe 结构。
  * **一键绑卡**: 自动填写卡号、过期日期、CVV 并提交。
  * **订阅激活**: 自动点击订阅按钮完成整个流程。
  * **容错机制**: 支持多种页面结构，适配不同账号状态。
* **📊 Web 管理界面** (NEW!):
  * **数据库管理**: SQLite 数据库作为单一数据源，自动同步文本文件。
  * **实时查看**: 浏览器访问 `http://localhost:8080` 查看所有账号状态。
  * **筛选搜索**: 支持按状态筛选、关键词搜索。
  * **批量导出**: 一键导出符合条件的账号数据。
  * **点击复制**: 所有字段一键点击复制，提升操作效率。
  * **自动启动**: GUI 启动时自动在后台启动 Web 服务。
* **批量操作**: 支持批量打开、关闭、删除窗口。

## 🛠️ 安装与使用 (Installation & Usage)

### 方式一：直接运行 (推荐)

无需安装 Python 环境，直接下载 Release 中的 `.exe` 文件运行即可。

1. 下载 `ixBrowserAutoManager.exe`。
2. 在同级目录下准备好配置文件 (见下文)。
3. 双击运行程序。

### 方式二：源码运行

1. 克隆仓库:
   ```bash
   git clone https://github.com/yourusername/ixbrowser-auto-manager.git
   ```
2. 安装依赖:
   ```bash
   pip install -r requirements.txt
   ```
3. 安装 Playwright 浏览器驱动:
   ```bash
   playwright install chromium
   ```
4. 运行:
   ```bash
   python create_window_gui.py
   ```

## ⚙️ 配置说明 (Configuration)

### 1. 配置管理界面（推荐）

程序采用 **数据库驱动** 架构，账号和代理数据统一存储在 SQLite 数据库中。

**使用方法**：
1. 启动程序后，点击 **「工具箱」** 按钮展开左侧面板
2. 在 **「配置管理」** 分区中点击 **「打开配置管理」**
3. 在配置管理界面中：
   - **账号管理**：添加、编辑、删除账号信息
   - **代理管理**：添加、编辑、删除代理配置
   - **卡片管理**：管理绑卡用的虚拟卡信息
   - **全局设置**：配置 AI API 密钥、并发数等

**账号字段说明**：
| 字段 | 说明 |
|------|------|
| 邮箱 | Google 账号邮箱（必填） |
| 密码 | 账号密码（必填） |
| 辅助邮箱 | 备用恢复邮箱（可选） |
| 2FA 密钥 | TOTP 密钥（可选） |
| 状态 | pending/link_ready/verified/subscribed/error |

**代理格式支持**：
- Socks5: `socks5://user:pass@host:port`
- HTTP: `http://user:pass@host:port`
- 简化格式: `host:port:user:pass`

### 2. 卡片管理

在配置管理界面的「卡片管理」标签页中添加虚拟卡信息。

**卡片字段说明**：
| 字段 | 说明 |
|------|------|
| 卡号 | 13-19位数字 |
| 月份 | 01-12（两位数） |
| 年份 | 年份后两位，如2032年填32 |
| CVV | 3-4位安全码 |
| 姓名 | 持卡人姓名（默认 John Smith） |
| 邮编 | 账单邮编（默认 10001） |

💳 **虚拟卡推荐**：[HolyCard](https://www.holy-card.com/) - 支持Gemini订阅、GPT Team、0刀Plus，一张低至2R

### 3. 输出文件 (程序自动生成)

* **accounts.db**: SQLite 数据库文件（所有账号信息的核心存储）。
* **sheerIDlink.txt**: 成功提取的验证链接 (有资格待验证已提取链接)。
* **有资格待验证号.txt**: 有资格但还未提取验证链接的账号。
* **已验证未绑卡.txt**: 已通过学生验证但未绑卡的账号。
* **已绑卡号.txt**: 已完成绑卡订阅的账号。
* **无资格号.txt**: 检测到无资格 (不可用) 的账号。
* **超时或其他错误.txt**: 提取超时或发生错误的账号。
* **sheerID_verified_success.txt**: 验证成功的 SheerID 链接。
* **sheerID_verified_failed.txt**: 验证失败的链接及原因。
* **2fa_codes.txt**: 生成的 2FA 验证码。

### 5. Web 管理界面

程序启动后，自动在后台启动 Web 服务器（端口 8080）。

1. 打开浏览器访问: `http://localhost:8080`
2. 即可查看所有账号状态、搜索筛选、批量导出等。

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
