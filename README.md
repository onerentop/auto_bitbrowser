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
* **自动化配置**: 自动读取 `accounts.txt` 和 `proxies.txt`，批量绑定账号与代理 IP。
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

## ⚙️ 配置文件说明 (Configuration)

请在程序运行目录下创建以下文件：

### 1. `accounts.txt` (账号信息)

**📌 分隔符配置方式**

在文件**第一行**配置分隔符（取消注释即可）：

```text
# 分隔符配置（取消注释其中一行）
分隔符="----"
# 分隔符="---"
# 分隔符="|"
# 分隔符=","
```

**📋 账号格式说明**

格式（字段顺序固定）：`邮箱[分隔符]密码[分隔符]辅助邮箱[分隔符]2FA密钥`

```text
# 标准格式（使用 ---- 分隔）
分隔符="----"
example1@gmail.com----MyPassword123----backup1@email.com----ABCD1234EFGH5678
example2@gmail.com----P@ssw0rd!%%99----backup2@email.com----WXYZ9012STUV3456

# 只有邮箱和密码（辅助邮箱和2FA可选）
example3@gmail.com----ComplexP@ss#2024

# 使用竖线分隔
分隔符="|"
example4@gmail.com|AnotherPass!|QRST5678UVWX1234

# 使用三短横线
分隔符="---"
example5@gmail.com---My#Pass@456---helper@email.com---LMNO3456PQRS7890
```

**✅ 重要说明**：
- **字段顺序固定**：邮箱 → 密码 → 辅助邮箱 → 2FA密钥
- **密码支持特殊字符**：`@#$%^&*`等都可以
- **辅助邮箱和2FA是可选的**：可以只填邮箱和密码
- **注释**：以 `#` 开头的行会被忽略
- **一个文件只能用一种分隔符**

**💡 推荐分隔符**：
- `----` (四短横线) - 推荐，最清晰
- `---` (三短横线) - 也很好用
- `|` (竖线) - 简洁
- `,` (逗号) - 需注意密码中不能有逗号

### 2. `proxies.txt` (代理IP)

支持 Socks5/HTTP，一行一个：

```text
socks5://user:pass@host:port
http://user:pass@host:port
```

### 3. `cards.txt` (虚拟卡信息) 🆕

格式：`卡号 月份 年份 CVV`（空格分隔）

```text
5481087170529907 01 32 536
5481087143137903 01 32 749
```

**说明**：
- **卡号**：13-19位数字
- **月份**：01-12（两位数）
- **年份**：年份后两位，如2032年填32
- **CVV**：3-4位安全码
- 每行一张卡，用于一键绑卡订阅功能

💳 **虚拟卡推荐**：[HolyCard](https://www.holy-card.com/) - 支持Gemini订阅、GPT Team、0刀Plus，一张低至2R

### 4. 输出文件 (程序自动生成)

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
