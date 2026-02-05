"""
自动加入家庭组

自动完成家庭组加入流程：
1. 在普通 Pro 账户窗口发送家庭邀请
2. 在被邀请账户窗口接受邀请（通过 Gmail）
3. 更新数据库状态
"""

import asyncio
from typing import Callable, Optional
from dataclasses import dataclass

from playwright.async_api import async_playwright

from core.config_manager import ConfigManager
# 尝试导入 AI Browser Agent 模块
try:
    from core.ai_browser_agent import AIBrowserAgent
    AI_BROWSER_AGENT_AVAILABLE = True
except ImportError:
    AI_BROWSER_AGENT_AVAILABLE = False
    AIBrowserAgent = None
from services.database import DBManager
from services.ix_api import openBrowser, closeBrowser


@dataclass
class JoinFamilyResult:
    """加入家庭组结果"""
    success: bool
    message: str
    inviter_email: str
    invitee_email: str
    error_type: Optional[str] = None
    total_steps: int = 0


# ==================== 家庭组已满检测关键词 ====================

FAMILY_FULL_KEYWORDS = [
    # 英文
    "family group is full", "family is full", "group is full",
    "can't add more", "cannot add more", "maximum number",
    "6 members", "six members", "limit reached", "no more members",
    # 中文
    "家庭组已满", "已达上限", "无法添加更多", "成员已满", "6位成员",
    "家庭群组已满", "无法添加成员",
    # 日文
    "ファミリーグループがいっぱい", "上限に達", "メンバーが上限",
    "これ以上追加できません",
    # 韩文
    "가족 그룹이 가득", "최대 인원", "더 이상 추가할 수 없",
    # AI Agent 报告的错误消息（页面无邀请按钮时）
    "no invite button", "invite button not found", "cannot find invite",
    "找不到邀请按钮", "没有邀请按钮", "无法找到邀请", "邀请按钮不存在",
    "family is already full", "already has 6 members", "已有6位成员",
]


def _is_family_full_error(error_msg: str) -> bool:
    """
    检测错误消息是否表示家庭组已满

    Args:
        error_msg: 错误消息字符串

    Returns:
        bool: 如果错误表示家庭组已满返回 True
    """
    if not error_msg:
        return False
    error_lower = error_msg.lower()
    return any(keyword.lower() in error_lower for keyword in FAMILY_FULL_KEYWORDS)


# ==================== 提示词模板 ====================

SEND_INVITE_PROMPT = """
你是一个专业的浏览器自动化助手，需要完成发送 Google 家庭组邀请的任务。

## 当前状态
- 邀请人账号: {inviter_email}
- 被邀请人: {invitee_email}
- 目标: 向被邀请人发送家庭组邀请

## 任务目标
在 Google 家庭管理页面，向 {invitee_email} 发送家庭组邀请。

## 操作步骤

### 1. 检查当前页面
- 当前应该在 https://myaccount.google.com/family 或类似的家庭管理页面
- 如果不是，请导航到该页面

### 2. 处理可能的弹窗遮挡（重要！）
- **首先检查右上角**：如果出现 Google 账号选择器弹窗（深色背景，显示账号信息），**必须先关闭它**
- 关闭方法：点击弹窗外的空白区域，或按 Escape 键
- 如果有任何弹窗遮挡页面，先关闭弹窗再继续

### 3. 点击邀请按钮
- 找到"邀请家庭成员"/"Invite family member"/"Send invitations"/"招待"/"メンバーを招待"按钮并点击
- 等待邀请对话框出现

### 4. 输入被邀请人邮箱
- 在输入框中输入: {invitee_email}
- **输入后等待 1-2 秒**，让建议列表出现

### 5. 【关键步骤】选中邮箱建议
**这一步非常重要，必须正确执行！**

输入邮箱后，输入框**下方**会出现一个建议列表，外观如下：
```
┌──────────────────────────────────┐
│  🔵  gorosaura803@gmail.com      │  ← 点击这整行！
│      gorosaura803@gmail.com      │
└──────────────────────────────────┘
```

**你必须点击这个建议条目**：
- 它位于输入框的**正下方**
- 左侧有一个**蓝色/灰色圆形头像图标**
- 右侧显示**邮箱地址**（可能显示两行）
- **点击整个建议行**（不仅仅是文字部分）

**验证选中成功**：
- 选中后，输入框中的邮箱文字会变成一个**带 X 的标签/chip**
- **Send 按钮会从灰色变为可点击状态（蓝色文字）**

**如果 Send 按钮仍然是灰色**：
- 说明没有正确选中邮箱
- 需要重新点击建议列表中的邮箱条目

### 6. 点击 Send 发送邀请
- 确认 Send 按钮**不是灰色**（是蓝色可点击状态）
- 点击 "Send" / "发送" / "送信" / "보내기" 按钮

### 7. 确认邀请已发送
- 等待确认消息出现（如"邀请已发送"/"Invitation sent"）
- 如果看到成功消息，任务完成

## 常见问题处理

### Send 按钮是灰色无法点击？
→ 邮箱没有被选中！必须点击输入框下方的建议列表

### 建议列表被遮挡？
→ 先按 Escape 关闭弹窗，然后重新点击输入框，等待建议列表出现

### 看不到建议列表？
→ 在输入框中重新输入邮箱，等待 2 秒让建议列表加载

## 注意事项
- 如果家庭组已满（6人），报告错误
- 如果被邀请人已在家庭组中，报告错误
- **Send 按钮灰色 = 邮箱未选中，必须点击建议列表**
- **绝对不要点击右上角的账号头像区域**（那是账号选择器，不是邮箱建议）
- 邮箱建议列表在输入框**正下方**，不在页面右侧

## 【重要】家庭组已满的判断
**如果页面上没有找到邀请按钮，说明家庭组已满！**

具体表现：
- 页面显示 5-6 个家庭成员（Member）+ 1 个 Family manager
- 页面只有 "Stop sharing"、"Storage" 等选项，没有 "Invite" 或 "Send invitations" 按钮
- 滚动整个页面后仍找不到邀请按钮

**如果确认没有邀请按钮，立即报告 ERROR: 家庭组已满，找不到邀请按钮**

不要继续滚动寻找！发现以下任一情况即可判定已满：
1. 页面显示 6 个成员且无邀请按钮
2. 滚动 2 次后仍未找到邀请按钮
3. 页面显示 "Your family group is full" 或类似消息

## 成功标准
看到"邀请已发送"或类似的成功消息时，报告 DONE。
"""

# 注意：以下 ACCEPT_INVITE_PROMPT 是遗留代码，已被 _accept_family_invite 中的两阶段提示词替代
# 保留作为参考，实际不再使用
ACCEPT_INVITE_PROMPT = """
你是一个专业的浏览器自动化助手，需要完成接受 Google 家庭组邀请的任务。

## 当前状态
- 被邀请人账号: {invitee_email}
{totp_info}
- 邀请来自: {inviter_email}
- 目标: 接受家庭组邀请

## 任务目标
在 Gmail 中找到家庭组邀请邮件，并完成整个加入家庭组的流程。
**注意**：根据账号不同，可能会遇到两种不同的加入流程，都需要能够处理。

## 操作步骤

### 1. 检查 Gmail
- 当前应该在 https://mail.google.com
- 在搜索框中搜索: "Google One family" 或 "加入家庭群组" 或 "family invitation"
- 或者直接在收件箱中找到来自 Google 的邀请邮件

### 2. 处理 2FA 验证（如果需要）
{totp_instructions}

### 3. 打开邀请邮件
- 找到标题包含 "family" 或 "家庭" 的邮件
- 点击打开邮件

### 4. 点击邮件中的接受链接
- 在邮件中找到"接受邀请"/"Accept invitation"/"招待を承諾"/"초대 수락"按钮或链接
- 点击该按钮/链接
- **重要**：点击后会在**新标签页**中打开 Google 家庭组加入页面

### 5. 切换到新标签页（关键步骤）
- **重要**：点击邀请链接后，会打开一个新的浏览器标签页
- **必须切换到新打开的标签页**才能继续操作
- 新标签页的 URL 会包含 "myaccount.google.com/family/join" 或 "families.google.com"
- 如果当前页面仍然是 Gmail 邮件页面，说明没有切换成功，需要点击浏览器顶部的新标签页
- **不要在 Gmail 页面重复点击 Accept invitation**，应该切换到已打开的加入页面

### 6. 完成加入流程（重要：有两种可能的流程）

**首先判断当前页面类型**：
- 如果页面 URL 包含 "mail.google.com" = 仍在 Gmail，需要切换标签页
- 如果页面 URL 包含 "myaccount.google.com/family/join" = 流程B
- 如果页面 URL 包含 "families.google.com" = 流程A
- 如果页面显示 "Join Family Group" 蓝色按钮 = 流程B
- 如果页面显示 "GET STARTED" 按钮 = 流程A

**根据跳转页面的不同，需要处理以下两种情况之一：**

---

#### 【流程A】families.google.com 页面（多步骤）

**第一步：欢迎页面**
- URL 包含: families.google.com/join/promo
- 页面显示邀请人姓名和"invited you to join"等信息
- 点击以下任一按钮:
  - "GET STARTED" / "开始使用" / "開始" / "始める" / "시작하기"

**第二步：确认加入页面**
- URL 包含: families.google.com/join/profile
- 页面显示"Join [name]'s family on Google"等信息
- 点击以下任一按钮:
  - "JOIN FAMILY" / "加入家庭" / "参加する" / "가족 가입"
  - 或 "JOIN" / "加入" / "参加"

**第三步：成功页面**
- 显示 "Already in a family" 或 "You're in!" 或类似成功消息

---

#### 【流程B】myaccount.google.com/family/join 页面（单步骤）

**第一步：邀请确认页面**
- URL 包含: myaccount.google.com/family/join
- 页面标题: "Join a Family Group"
- 显示 "You're invited to join [name]'s Family Group"
- 点击蓝色按钮:
  - "Join Family Group" / "加入家庭群组" / "ファミリーグループに参加" / "가족 그룹 가입"

**第二步：成功页面**
- URL 包含: myaccount.google.com/family/join/success
- 显示 "Welcome to the family!" / "欢迎加入家庭！"
- 显示 "You joined [name]'s Family Group"
- 可能有 "View Family Group" 按钮（无需点击，已成功）

---

### 6. 确认加入成功
- 确认页面显示已成功加入家庭组的消息
- 如果看到上述任一成功标志，任务完成

## 多语言按钮关键词汇总

**邮件中的接受按钮:**
- "Accept invitation" / "接受邀请" / "招待を承諾" / "초대 수락"

**流程A - GET STARTED 按钮:**
- "GET STARTED" / "开始使用" / "開始" / "始める" / "시작하기"

**流程A - JOIN FAMILY 按钮:**
- "JOIN FAMILY" / "加入家庭" / "家族に参加" / "가족 가입"
- "JOIN" / "加入" / "参加" / "가입"

**流程B - Join Family Group 按钮:**
- "Join Family Group" / "加入家庭群组" / "ファミリーグループに参加" / "가족 그룹 가입"

**成功页面关键词:**
- "Welcome to the family" / "欢迎加入家庭" / "ファミリーへようこそ"
- "Already in a family" / "已加入家庭" / "すでに家族グループに参加"
- "You're in!" / "加入成功" / "You joined [name]'s Family Group"
- "View Family Group" / "查看家庭群组"（出现此按钮表示已成功）

## 邮件搜索关键词
- "Google One family"
- "family group invitation"
- "Join your family"
- "加入家庭群组"
- "家庭邀请"
- 发件人: "Google" 或 "no-reply@google.com"

## 注意事项
- 邮件可能需要几分钟才能到达，如果没找到请稍等
- 如果需要登录确认，完成登录
- **重要**：点击邮件中的接受链接后，还需要在 Google 页面上点击确认按钮
- **关键**：点击邀请链接后会打开新标签页，必须切换到新标签页操作
- **避免重复点击**：如果已经点击过 Accept invitation 且新标签页已打开，不要再次点击
- 根据跳转的页面类型（families.google.com 或 myaccount.google.com），选择对应的流程
- 如果看到"已加入"或已在家庭组中的提示，也算成功

## 如何判断是否需要切换标签页
- 如果页面显示 Gmail 邮件内容（看到邮件正文、收件箱等） = 需要切换
- 如果页面显示 "Join a Family Group" 或 "Join Family Group" 按钮 = 已在正确页面
- 如果页面标题/内容包含 "Welcome to the family" = 已成功，任务完成

## 成功标准
看到以下任一情况时，报告 DONE：
1. 页面显示 "Welcome to the family!" 或 "欢迎加入家庭"
2. 页面显示 "Already in a family" 或类似的已加入确认
3. 页面显示 "You joined [name]'s Family Group"
4. 页面显示 "View Family Group" 按钮（表示已成功加入）
5. 页面显示家庭成员列表且包含当前账号
"""


async def auto_join_family(
    inviter_account: dict,
    invitee_account: dict,
    inviter_browser_id: str,
    invitee_browser_id: str,
    callback: Callable[[str], None] = None,
    api_key: str = None,
    model: str = None,
    provider: str = None,
    max_steps: int = None,
    close_browser_on_success: bool = True,
) -> JoinFamilyResult:
    """
    执行家庭组加入流程

    Args:
        inviter_account: 邀请人账号（普通 Pro）{email, password, secret_key, recovery_email, browser_profile_id}
        invitee_account: 被邀请人账号（待加入）{email, password, secret_key, recovery_email, browser_profile_id}
        inviter_browser_id: 邀请人的浏览器窗口 ID
        invitee_browser_id: 被邀请人的浏览器窗口 ID
        callback: 进度回调函数
        api_key: AI API Key（可选）
        model: AI 模型名称（可选）
        provider: AI 提供商（可选）
        max_steps: 最大步骤数（可选）
        close_browser_on_success: 成功后是否关闭浏览器窗口

    Returns:
        JoinFamilyResult: 加入结果
    """
    inviter_email = inviter_account.get("email", "")
    invitee_email = invitee_account.get("email", "")

    def log(msg: str):
        """日志输出"""
        print(f"[JoinFamily] {msg}")
        if callback:
            callback(msg)

    log(f"开始家庭组加入流程: {invitee_email} -> {inviter_email} 的家庭组")

    # 检查 AI Browser Agent 是否可用
    if not AI_BROWSER_AGENT_AVAILABLE:
        log("❌ AI Browser Agent 不可用")
        return JoinFamilyResult(
            success=False,
            message="AI Browser Agent 不可用",
            inviter_email=inviter_email,
            invitee_email=invitee_email,
            error_type="agent_unavailable",
        )

    # 获取 AI 配置
    if not provider:
        provider = ConfigManager.get_ai_default_provider()
    if not api_key:
        api_key = ConfigManager.get_ai_provider_api_key(provider)
    if not model:
        model = ConfigManager.get_ai_provider_model(provider)
    if not max_steps:
        max_steps = 20  # 家庭组流程可能需要更多步骤

    base_url = ConfigManager.get_ai_provider_base_url(provider)

    total_steps = 0

    try:
        # ==================== Step 1: 发送邀请 ====================
        log("=" * 50)
        log(f"Step 1: 在 {inviter_email} 窗口发送邀请...")
        log("=" * 50)

        invite_result = await _send_family_invite(
            browser_id=inviter_browser_id,
            inviter_account=inviter_account,
            invitee_email=invitee_email,
            api_key=api_key,
            base_url=base_url,
            model=model,
            provider=provider,
            max_steps=max_steps,
            log_func=log,
        )

        total_steps += invite_result.get("steps", 0)

        if not invite_result.get("success"):
            error_msg = invite_result.get("message", "发送邀请失败")
            log(f"❌ {error_msg}")

            # 检测是否为家庭组已满错误，如果是则更新数据库
            if _is_family_full_error(error_msg):
                log(f"⚠️ 检测到家庭组已满，更新 {inviter_email} 的成员数量为 6")
                DBManager.update_family_member_count(inviter_email, 6)

            return JoinFamilyResult(
                success=False,
                message=error_msg,
                inviter_email=inviter_email,
                invitee_email=invitee_email,
                error_type="invite_failed",
                total_steps=total_steps,
            )

        log("✅ 邀请发送成功，等待邮件送达...")

        # 等待邮件送达（Google 内部邮件通常很快）
        await asyncio.sleep(5)

        # ==================== Step 2: 接受邀请 ====================
        log("=" * 50)
        log(f"Step 2: 在 {invitee_email} 窗口接受邀请...")
        log("=" * 50)

        accept_result = await _accept_family_invite(
            browser_id=invitee_browser_id,
            invitee_account=invitee_account,
            inviter_email=inviter_email,
            api_key=api_key,
            base_url=base_url,
            model=model,
            provider=provider,
            max_steps=max_steps,
            log_func=log,
        )

        total_steps += accept_result.get("steps", 0)

        if not accept_result.get("success"):
            error_msg = accept_result.get("message", "接受邀请失败")
            log(f"❌ {error_msg}")

            # 检测是否为家庭组已满错误（边界情况：邀请发送后家庭组被填满）
            if _is_family_full_error(error_msg):
                log(f"⚠️ 检测到家庭组已满，更新 {inviter_email} 的成员数量为 6")
                DBManager.update_family_member_count(inviter_email, 6)

            return JoinFamilyResult(
                success=False,
                message=error_msg,
                inviter_email=inviter_email,
                invitee_email=invitee_email,
                error_type="accept_failed",
                total_steps=total_steps,
            )

        log("✅ 成功接受邀请!")

        # ==================== Step 3: 更新数据库 ====================
        log("更新数据库状态...")

        # 更新被邀请人状态为 family_yes（已通过家庭组获得 Pro）
        DBManager.update_pro_status(invitee_email, "family_yes")

        # 更新邀请人的家庭成员数量（+1）
        inviter_db = DBManager.get_account_by_email(inviter_email)
        if inviter_db:
            # family_member_count: 0=未检测, 1-6=实际成员数(包括管理员)
            # Pro账户至少有管理员自己，所以最小值为1
            raw_count = inviter_db.get("family_member_count", 0) or 0
            current_count = max(raw_count, 1)  # 至少1人(管理员)
            new_count = min(current_count + 1, 6)
            DBManager.update_family_member_count(inviter_email, new_count)
            log(f"邀请人 {inviter_email} 家庭成员数量: {current_count} -> {new_count}")

        # 关闭浏览器窗口
        if close_browser_on_success:
            try:
                closeBrowser(inviter_browser_id)
                log(f"已关闭邀请人浏览器窗口")
            except Exception as e:
                log(f"关闭邀请人窗口失败: {e}")

            try:
                closeBrowser(invitee_browser_id)
                log(f"已关闭被邀请人浏览器窗口")
            except Exception as e:
                log(f"关闭被邀请人窗口失败: {e}")

        log(f"✅ 家庭组加入完成! {invitee_email} 已加入 {inviter_email} 的家庭组")

        return JoinFamilyResult(
            success=True,
            message="成功加入家庭组",
            inviter_email=inviter_email,
            invitee_email=invitee_email,
            total_steps=total_steps,
        )

    except Exception as e:
        error_msg = str(e)
        log(f"❌ 异常: {error_msg}")
        return JoinFamilyResult(
            success=False,
            message=f"加入家庭组异常: {error_msg}",
            inviter_email=inviter_email,
            invitee_email=invitee_email,
            error_type="exception",
            total_steps=total_steps,
        )


async def _send_family_invite(
    browser_id: str,
    inviter_account: dict,
    invitee_email: str,
    api_key: str,
    base_url: str,
    model: str,
    provider: str,
    max_steps: int,
    log_func: Callable,
) -> dict:
    """
    在邀请人窗口发送家庭邀请

    采用 Playwright 优先策略：
    1. 首先尝试用 Playwright 直接完成整个流程
    2. 如果失败，再使用 AI Agent 作为备选

    Returns:
        dict: {success: bool, message: str, steps: int}
    """
    log = log_func
    inviter_email = inviter_account.get("email", "")
    inviter_secret = inviter_account.get("secret_key", "")

    try:
        # 打开浏览器
        result = openBrowser(browser_id)
        if not result.get("success"):
            return {"success": False, "message": result.get("msg", "打开浏览器失败"), "steps": 0}

        ws_endpoint = result.get("data", {}).get("ws", "")
        if not ws_endpoint:
            return {"success": False, "message": "无法获取浏览器 WebSocket 连接", "steps": 0}

        async with async_playwright() as playwright:
            browser = await playwright.chromium.connect_over_cdp(ws_endpoint)
            contexts = browser.contexts
            if not contexts:
                return {"success": False, "message": "没有浏览器上下文", "steps": 0}

            context = contexts[0]
            pages = context.pages
            page = pages[0] if pages else await context.new_page()

            # 导航到家庭管理页面
            log(f"[{inviter_email}] 导航到家庭管理页面...")
            try:
                await page.goto("https://myaccount.google.com/family", wait_until="domcontentloaded", timeout=30000)
                await page.wait_for_timeout(2000)
            except Exception as e:
                log(f"[{inviter_email}] ⚠️ 导航到家庭管理页面超时: {e}")

            # ========== 使用纯 Playwright 完成整个流程 ==========
            log(f"[{inviter_email}] 使用 Playwright 直接操作...")
            playwright_success = False

            try:
                # ===== 步骤1: 关闭所有弹窗、遮罩层和 iframe =====
                log(f"[{inviter_email}] 步骤1: 关闭弹窗和遮罩层...")

                # 多次按 Escape 关闭弹窗
                for _ in range(5):
                    await page.keyboard.press("Escape")
                    await page.wait_for_timeout(200)

                # 移除所有遮罩层和 iframe（关键修复！）
                await page.evaluate("""
                    () => {
                        // 1. 移除 trans-layer 遮罩层（这是导致点击被拦截的元素）
                        document.querySelectorAll('trans-layer').forEach(t => t.remove());

                        // 2. 移除 KL4X6e 类的遮罩 div
                        document.querySelectorAll('.KL4X6e').forEach(d => d.remove());
                        document.querySelectorAll('.TuA45b').forEach(d => d.remove());

                        // 3. 移除所有 ogs.google.com iframe
                        document.querySelectorAll('iframe[src*="ogs.google.com"]').forEach(f => f.remove());

                        // 4. 移除可能的弹窗对话框
                        document.querySelectorAll('[role="dialog"]').forEach(d => {
                            if (d.querySelector('iframe') || d.classList.contains('ogs')) {
                                d.remove();
                            }
                        });

                        // 5. 移除 Google One Button 相关的遮罩
                        document.querySelectorAll('[jscontroller*="gob"]').forEach(el => {
                            if (el.querySelector('iframe')) el.remove();
                        });
                    }
                """)
                await page.wait_for_timeout(500)

                # 再次按 Escape 确保弹窗关闭
                await page.keyboard.press("Escape")
                await page.wait_for_timeout(300)

                # ===== 步骤2: 点击邀请按钮 =====
                log(f"[{inviter_email}] 步骤2: 查找并点击邀请按钮...")
                invite_clicked = False

                # 方法1: 用文本匹配
                invite_texts = [
                    "Send invitations", "Invite family member", "Invite member",
                    "邀请家庭成员", "发送邀请", "メンバーを招待", "招待を送信"
                ]
                for text in invite_texts:
                    try:
                        btn = page.locator(f'button:has-text("{text}")').first
                        if await btn.is_visible(timeout=1000):
                            await btn.click()
                            log(f"[{inviter_email}] 点击了邀请按钮: {text}")
                            invite_clicked = True
                            break
                    except Exception:
                        continue

                # 方法2: 用选择器
                if not invite_clicked:
                    selectors = [
                        '[data-action="invite"]',
                        'button[aria-label*="invite" i]',
                        'a[href*="invite"]',
                    ]
                    for sel in selectors:
                        try:
                            btn = page.locator(sel).first
                            if await btn.is_visible(timeout=1000):
                                await btn.click()
                                log(f"[{inviter_email}] 点击了邀请按钮 (选择器)")
                                invite_clicked = True
                                break
                        except Exception:
                            continue

                if not invite_clicked:
                    log(f"[{inviter_email}] ⚠️ 未找到邀请按钮，将使用 AI Agent")
                else:
                    await page.wait_for_timeout(1500)

                    # 再次关闭可能出现的弹窗
                    await page.keyboard.press("Escape")
                    await page.wait_for_timeout(300)

                    # ===== 步骤3: 输入邮箱 =====
                    log(f"[{inviter_email}] 步骤3: 输入被邀请人邮箱...")
                    email_input = None
                    input_selectors = [
                        'input[type="email"]',
                        'input[aria-label*="email" i]',
                        'input[aria-label*="name" i]',
                        'input[placeholder*="email" i]',
                        'input[placeholder*="name" i]',
                        'input[type="text"]',
                    ]

                    for sel in input_selectors:
                        try:
                            inp = page.locator(sel).first
                            if await inp.is_visible(timeout=1500):
                                email_input = inp
                                break
                        except Exception:
                            continue

                    if email_input:
                        # 再次移除可能重新出现的遮罩层
                        await page.evaluate("""
                            () => {
                                document.querySelectorAll('trans-layer').forEach(t => t.remove());
                                document.querySelectorAll('.KL4X6e').forEach(d => d.remove());
                            }
                        """)

                        # 使用 force=True 强制点击，绕过遮罩检测
                        await email_input.click(force=True)
                        await page.wait_for_timeout(200)

                        # 清空并输入
                        await email_input.fill("")
                        await email_input.type(invitee_email, delay=30)
                        log(f"[{inviter_email}] 已输入邮箱: {invitee_email}")

                        # 等待建议列表出现
                        await page.wait_for_timeout(2000)

                        # 关闭右上角弹窗（如果有）
                        await page.keyboard.press("Escape")
                        await page.wait_for_timeout(300)

                        # ===== 步骤4: 选择邮箱建议 =====
                        log(f"[{inviter_email}] 步骤4: 选择邮箱建议...")
                        email_selected = False

                        # 获取输入框位置，用于计算建议列表位置
                        input_box = await email_input.bounding_box()

                        # 方法1: 尝试各种选择器点击建议
                        suggestion_selectors = [
                            f'[data-email="{invitee_email.lower()}"]',
                            f'[data-value="{invitee_email.lower()}"]',
                            '[role="option"]',
                            '[role="listbox"] div[tabindex]',
                            'div[data-email]',
                        ]

                        for sel in suggestion_selectors:
                            try:
                                sugg = page.locator(sel).first
                                if await sugg.is_visible(timeout=800):
                                    box = await sugg.bounding_box()
                                    if box:
                                        # 确保不是 iframe 里的元素（检查 y 坐标在输入框附近）
                                        if input_box and abs(box['y'] - input_box['y']) < 200:
                                            await page.mouse.click(
                                                box['x'] + box['width'] / 2,
                                                box['y'] + box['height'] / 2
                                            )
                                            log(f"[{inviter_email}] 点击了邮箱建议 (选择器: {sel})")
                                            email_selected = True
                                            await page.wait_for_timeout(500)
                                            break
                            except Exception:
                                continue

                        # 方法2: 坐标点击（建议列表在输入框正下方）
                        if not email_selected and input_box:
                            log(f"[{inviter_email}] 尝试坐标点击邮箱建议...")
                            # 建议列表第一项通常在输入框下方 50-80 像素
                            for offset_y in [50, 70, 90]:
                                try:
                                    click_x = input_box['x'] + 150  # 偏右避开头像
                                    click_y = input_box['y'] + input_box['height'] + offset_y
                                    await page.mouse.click(click_x, click_y)
                                    log(f"[{inviter_email}] 坐标点击: ({click_x:.0f}, {click_y:.0f})")
                                    await page.wait_for_timeout(500)

                                    # 检查 Send 按钮是否变为可用
                                    send_btn = page.locator('button:has-text("Send")').first
                                    try:
                                        if await send_btn.is_enabled(timeout=500):
                                            email_selected = True
                                            log(f"[{inviter_email}] Send 按钮已启用，邮箱选择成功")
                                            break
                                    except Exception:
                                        pass
                                except Exception:
                                    continue

                        # 方法3: 按键盘方向键选择
                        if not email_selected:
                            log(f"[{inviter_email}] 尝试键盘选择...")
                            try:
                                await page.keyboard.press("ArrowDown")
                                await page.wait_for_timeout(200)
                                await page.keyboard.press("Enter")
                                await page.wait_for_timeout(500)

                                # 检查是否成功
                                send_btn = page.locator('button:has-text("Send")').first
                                if await send_btn.is_enabled(timeout=500):
                                    email_selected = True
                                    log(f"[{inviter_email}] 键盘选择成功")
                            except Exception:
                                pass

                        # ===== 步骤5: 点击 Send 按钮 =====
                        if email_selected:
                            log(f"[{inviter_email}] 步骤5: 点击 Send 按钮...")

                            # 再次关闭弹窗
                            await page.keyboard.press("Escape")
                            await page.wait_for_timeout(200)

                            send_clicked = False
                            send_texts = ["Send", "发送", "送信", "보내기"]
                            for text in send_texts:
                                try:
                                    btn = page.locator(f'button:has-text("{text}")').first
                                    if await btn.is_visible(timeout=1000) and await btn.is_enabled(timeout=500):
                                        await btn.click()
                                        log(f"[{inviter_email}] 点击了 Send 按钮")
                                        send_clicked = True
                                        break
                                except Exception:
                                    continue

                            if send_clicked:
                                # 等待成功消息
                                await page.wait_for_timeout(3000)

                                # 检查成功消息
                                success_texts = [
                                    "Invitation sent", "sent", "发送成功", "已发送",
                                    "招待を送信しました", "邀请已发送"
                                ]
                                for text in success_texts:
                                    try:
                                        if await page.locator(f'text="{text}"').first.is_visible(timeout=500):
                                            log(f"[{inviter_email}] ✅ 邀请发送成功!")
                                            playwright_success = True
                                            break
                                    except Exception:
                                        continue

                                # 即使没检测到成功消息，如果流程走完也可能成功
                                if not playwright_success:
                                    log(f"[{inviter_email}] 未检测到明确成功消息，假定成功")
                                    playwright_success = True

            except Exception as e:
                log(f"[{inviter_email}] Playwright 操作异常: {e}")

            # ========== 如果 Playwright 成功，直接返回 ==========
            if playwright_success:
                return {"success": True, "message": "邀请发送成功 (Playwright)", "steps": 0}

            # ========== Playwright 失败，使用混合策略 ==========
            # 策略：AI Agent 负责点击邀请按钮 -> 检测到邀请页面后用 CDP 完成
            log(f"[{inviter_email}] Playwright 未能完成，启用混合策略...")

            # 创建 AI Agent（只用于点击邀请按钮）
            agent = AIBrowserAgent(
                api_key=api_key,
                base_url=base_url,
                model=model,
                provider=provider,
            )

            agent.on_step(lambda step, action: log(f"[{inviter_email}][Agent] 步骤{step}: {action}"))

            # 构建 account 参数
            agent_account = {
                "email": inviter_email,
                "password": inviter_account.get("password", ""),
                "secret": inviter_secret,
                "recovery_email": inviter_account.get("recovery_email", ""),
            }

            # ===== 阶段1：用 AI Agent 点击邀请按钮 =====
            # 简化提示词，只负责点击邀请按钮
            phase1_prompt = f"""
你是一个专业的浏览器自动化助手。

## 任务
在 Google 家庭管理页面找到并点击"邀请家庭成员"按钮。

## 操作步骤
1. 先按 Escape 关闭可能的弹窗
2. 找到并点击以下任一按钮：
   - "Send invitations" / "Invite family member" / "Invite member"
   - "邀请家庭成员" / "发送邀请"
   - "メンバーを招待" / "招待を送信"

## 家庭组已满判断
**重要**：如果页面显示 6 个家庭成员且找不到邀请按钮，说明家庭组已满！
立即报告 ERROR: 家庭组已满，找不到邀请按钮

## 成功标准
点击邀请按钮后，页面跳转到"Invite your family"页面（显示邮箱输入框），报告 DONE。
"""

            # 执行阶段1：点击邀请按钮
            task_result = await agent.execute_task(
                page=page,
                goal=phase1_prompt,
                start_url="https://myaccount.google.com/family",
                account=agent_account,
                max_steps=8,  # 限制步骤数，只需点击一个按钮
                navigate_first=False,
            )

            if not task_result.success:
                return {"success": False, "message": task_result.message or "点击邀请按钮失败", "steps": task_result.total_steps}

            # ===== 阶段2：检测是否进入邀请页面，用 CDP 完成邮箱选择 =====
            log(f"[{inviter_email}] 阶段1完成，检测页面状态...")
            await page.wait_for_timeout(1500)

            # 检测是否在邀请页面
            current_url = page.url
            page_text = ""
            try:
                page_text = await page.inner_text("body")
            except Exception:
                pass

            is_invite_page = (
                "invite" in current_url.lower() or
                "Invite your family" in page_text or
                "You can invite" in page_text
            )

            if not is_invite_page:
                # 可能 AI Agent 已经完成了整个流程
                if "sent" in page_text.lower() or "已发送" in page_text or "invitation sent" in page_text.lower():
                    log(f"[{inviter_email}] ✅ AI Agent 已完成邀请发送")
                    return {"success": True, "message": "邀请发送成功 (AI Agent)", "steps": task_result.total_steps}
                else:
                    log(f"[{inviter_email}] ⚠️ 未检测到邀请页面，继续用 AI Agent")
                    # 继续使用 AI Agent 完成
                    full_prompt = SEND_INVITE_PROMPT.format(
                        inviter_email=inviter_email,
                        invitee_email=invitee_email,
                    )
                    task_result2 = await agent.execute_task(
                        page=page,
                        goal=full_prompt,
                        start_url=current_url,
                        account=agent_account,
                        max_steps=max_steps - 8,
                        navigate_first=False,
                    )
                    if task_result2.success:
                        return {"success": True, "message": "邀请发送成功 (AI Agent)", "steps": task_result.total_steps + task_result2.total_steps}
                    else:
                        return {"success": False, "message": task_result2.message or "发送邀请失败", "steps": task_result.total_steps + task_result2.total_steps}

            # ===== 在邀请页面，使用 CDP/Playwright 精确操作 =====
            log(f"[{inviter_email}] 检测到邀请页面，使用 CDP 精确操作...")

            cdp_success = False
            try:
                # 关闭右上角弹窗
                for _ in range(3):
                    await page.keyboard.press("Escape")
                    await page.wait_for_timeout(200)

                # 查找邮箱输入框
                email_input = None
                input_selectors = [
                    'input[type="email"]',
                    'input[aria-label*="email" i]',
                    'input[aria-label*="name" i]',
                    'input[placeholder*="email" i]',
                    'input[type="text"]',
                ]

                for sel in input_selectors:
                    try:
                        inp = page.locator(sel).first
                        if await inp.is_visible(timeout=1000):
                            email_input = inp
                            log(f"[{inviter_email}] 找到邮箱输入框: {sel}")
                            break
                    except Exception:
                        continue

                if email_input:
                    # 点击并输入邮箱
                    await email_input.click(force=True)
                    await page.wait_for_timeout(200)
                    await email_input.fill("")
                    await email_input.type(invitee_email, delay=30)
                    log(f"[{inviter_email}] 已输入邮箱: {invitee_email}")

                    # 等待建议列表出现
                    await page.wait_for_timeout(2000)

                    # 关闭右上角弹窗
                    await page.keyboard.press("Escape")
                    await page.wait_for_timeout(300)

                    # ===== 使用 CDP 点击邮箱建议 =====
                    log(f"[{inviter_email}] 使用 CDP 点击邮箱建议...")

                    from core.ai_browser_agent import create_cdp_service, CDP_SERVICE_AVAILABLE

                    if CDP_SERVICE_AVAILABLE:
                        cdp_service = await create_cdp_service(page)

                        try:
                            # 使用可访问性树查找邮箱建议
                            ax_elements = await cdp_service.get_interactive_elements_via_ax()

                            # 查找包含邮箱的建议元素
                            target_backend_id = None
                            invitee_email_lower = invitee_email.lower()

                            for elem in ax_elements:
                                elem_name = (elem.get("name") or "").lower()
                                elem_role = (elem.get("role") or "").lower()

                                # 查找包含邮箱的元素（通常是 listitem, option, 或 generic）
                                if invitee_email_lower in elem_name:
                                    # 排除输入框本身
                                    if elem_role not in ("textbox", "searchbox", "combobox"):
                                        target_backend_id = elem.get("backend_node_id")
                                        log(f"[{inviter_email}] CDP 找到邮箱建议: {elem.get('name')} (role={elem_role}, id={target_backend_id})")
                                        break

                            if target_backend_id:
                                success, msg = await cdp_service.click_by_backend_node_id(target_backend_id)
                                if success:
                                    log(f"[{inviter_email}] ✅ CDP 点击邮箱建议成功")
                                    await page.wait_for_timeout(500)

                                    # 检查 Send 按钮是否可用
                                    send_btn = page.locator('button:has-text("Send")').first
                                    try:
                                        if await send_btn.is_enabled(timeout=1000):
                                            log(f"[{inviter_email}] Send 按钮已启用，点击发送...")
                                            await send_btn.click()
                                            await page.wait_for_timeout(2000)
                                            cdp_success = True
                                    except Exception:
                                        pass
                        finally:
                            await cdp_service.close()

                    # 如果 CDP 失败，尝试 Playwright 方法
                    if not cdp_success:
                        log(f"[{inviter_email}] CDP 未能选中，尝试 Playwright 方法...")

                        # 方法1: 键盘选择
                        await page.keyboard.press("ArrowDown")
                        await page.wait_for_timeout(200)
                        await page.keyboard.press("Enter")
                        await page.wait_for_timeout(500)

                        # 检查 Send 按钮
                        send_btn = page.locator('button:has-text("Send")').first
                        try:
                            if await send_btn.is_enabled(timeout=1000):
                                log(f"[{inviter_email}] 键盘选择成功，点击发送...")
                                await send_btn.click()
                                await page.wait_for_timeout(2000)
                                cdp_success = True
                        except Exception:
                            pass

                        # 方法2: 坐标点击
                        if not cdp_success:
                            input_box = await email_input.bounding_box()
                            if input_box:
                                for offset_y in [60, 80, 100]:
                                    click_x = input_box['x'] + 200
                                    click_y = input_box['y'] + input_box['height'] + offset_y
                                    await page.mouse.click(click_x, click_y)
                                    log(f"[{inviter_email}] 坐标点击: ({click_x:.0f}, {click_y:.0f})")
                                    await page.wait_for_timeout(500)

                                    try:
                                        if await send_btn.is_enabled(timeout=500):
                                            log(f"[{inviter_email}] 坐标选择成功，点击发送...")
                                            await send_btn.click()
                                            await page.wait_for_timeout(2000)
                                            cdp_success = True
                                            break
                                    except Exception:
                                        pass

            except ImportError:
                log(f"[{inviter_email}] CDP 服务不可用")
            except Exception as e:
                log(f"[{inviter_email}] CDP 操作异常: {e}")

            if cdp_success:
                # 检查是否发送成功
                try:
                    page_text = await page.inner_text("body")
                    if any(kw in page_text.lower() for kw in ["sent", "已发送", "invitation sent"]):
                        return {"success": True, "message": "邀请发送成功 (CDP)", "steps": task_result.total_steps}
                except Exception:
                    pass
                # 即使没检测到成功消息，也假定成功
                return {"success": True, "message": "邀请发送成功 (CDP)", "steps": task_result.total_steps}

            # ===== CDP 失败，用 AI Agent 作为最后保底 =====
            log(f"[{inviter_email}] CDP 未能完成，使用 AI Agent 保底...")

            full_prompt = SEND_INVITE_PROMPT.format(
                inviter_email=inviter_email,
                invitee_email=invitee_email,
            )
            task_result2 = await agent.execute_task(
                page=page,
                goal=full_prompt,
                start_url=page.url,
                account=agent_account,
                max_steps=max_steps - 8,
                navigate_first=False,
            )

            if task_result2.success:
                return {"success": True, "message": "邀请发送成功 (AI Agent)", "steps": task_result.total_steps + task_result2.total_steps}
            else:
                return {"success": False, "message": task_result2.message or "发送邀请失败", "steps": task_result.total_steps + task_result2.total_steps}

    except Exception as e:
        return {"success": False, "message": str(e), "steps": 0}


async def _accept_family_invite(
    browser_id: str,
    invitee_account: dict,
    inviter_email: str,
    api_key: str,
    base_url: str,
    model: str,
    provider: str,
    max_steps: int,
    log_func: Callable,
) -> dict:
    """
    在被邀请人窗口接受家庭邀请

    采用两阶段策略解决新标签页切换问题：
    1. 阶段1：在 Gmail 中找到并点击接受邀请链接
    2. 检测新标签页并切换
    3. 阶段2：在新标签页完成加入流程

    Returns:
        dict: {success: bool, message: str, steps: int}
    """
    log = log_func
    invitee_email = invitee_account.get("email", "")
    secret_key = invitee_account.get("secret_key", "")
    total_steps = 0

    try:
        # 打开浏览器
        result = openBrowser(browser_id)
        if not result.get("success"):
            return {"success": False, "message": result.get("msg", "打开浏览器失败"), "steps": 0}

        ws_endpoint = result.get("data", {}).get("ws", "")
        if not ws_endpoint:
            return {"success": False, "message": "无法获取浏览器 WebSocket 连接", "steps": 0}

        async with async_playwright() as playwright:
            browser = await playwright.chromium.connect_over_cdp(ws_endpoint)
            contexts = browser.contexts
            if not contexts:
                return {"success": False, "message": "没有浏览器上下文", "steps": 0}

            context = contexts[0]
            pages = context.pages
            page = pages[0] if pages else await context.new_page()

            # 导航到 Gmail
            log(f"[{invitee_email}] 导航到 Gmail...")
            try:
                await page.goto("https://mail.google.com", wait_until="domcontentloaded", timeout=30000)
                await page.wait_for_timeout(3000)
            except Exception as e:
                log(f"[{invitee_email}] ⚠️ 导航到 Gmail 超时: {e}")
                # 尝试继续执行，让 AI Agent 处理当前页面

            # 构建 account 参数（AI Agent 使用 'secret' 字段名）
            agent_account = {
                "email": invitee_email,
                "password": invitee_account.get("password", ""),
                "secret": secret_key,
                "recovery_email": invitee_account.get("recovery_email", ""),
            }

            # ==================== 阶段1：在 Gmail 点击接受邀请 ====================
            log(f"[{invitee_email}] 阶段1: 在 Gmail 中查找并点击接受邀请...")

            # 记录当前页面数量，用于检测新标签页
            initial_page_count = len(context.pages)

            # 阶段1的简化提示词 - 只需要点击接受邀请
            phase1_prompt = f"""
你是一个专业的浏览器自动化助手，需要在 Gmail 中找到并点击家庭组邀请链接。

## 当前状态
- 被邀请人账号: {invitee_email}
- 邀请来自: {inviter_email}

## 任务目标
在 Gmail 收件箱中找到家庭组邀请邮件，并点击"Accept invitation"链接。

## 操作步骤

1. 刷新 Gmail 收件箱（重要）
   - 按 F5 或点击刷新按钮确保获取最新邮件
   - 等待收件箱加载完成

2. 在 Gmail 中查找邀请邮件
   - 首先查看收件箱顶部是否有来自 Google 的新邮件
   - 邮件标题通常包含 "family" 或 "You've been invited"
   - 如果没看到，可以搜索: "Google One family" 或 "family invitation"

3. 打开邀请邮件
   - 点击邮件打开查看内容
   - 邮件内容会包含邀请人信息和接受按钮

4. 点击接受邀请链接
   - 在邮件中找到 "Accept invitation" / "接受邀请" / "招待を承諾" / "초대 수락" 按钮
   - **只点击一次**，点击后立即报告 DONE
   - 不需要等待或验证新标签页是否打开

## 成功标准
- 成功点击 "Accept invitation" 链接后，立即报告 DONE
- 不需要切换标签页，不需要后续操作

## 失败情况
- 如果在收件箱和搜索结果中都找不到邀请邮件，报告 ERROR: 未找到邀请邮件
- 如果邮件中没有接受按钮，报告 ERROR: 邮件中未找到接受按钮

## 重要提醒
- **严禁重复点击** - 如果已经点击过接受链接，直接报告 DONE
- 如果页面显示已经点击过或链接已失效，报告 DONE
"""

            # 创建阶段1的 AI Agent
            agent1 = AIBrowserAgent(
                api_key=api_key,
                base_url=base_url,
                model=model,
                provider=provider,
            )
            agent1.on_step(lambda step, action: log(f"[{invitee_email}][阶段1] 步骤{step}: {action}"))

            # 执行阶段1
            phase1_result = await agent1.execute_task(
                page=page,
                goal=phase1_prompt,
                start_url="https://mail.google.com",
                account=agent_account,
                max_steps=12,  # 阶段1: 刷新+搜索+打开+点击，需要足够步骤
                navigate_first=False,
            )

            total_steps += phase1_result.total_steps

            if not phase1_result.success:
                return {"success": False, "message": f"阶段1失败: {phase1_result.message}", "steps": total_steps}

            log(f"[{invitee_email}] 阶段1完成，等待新标签页...")

            # ==================== 检测并切换到新标签页 ====================
            # 等待新标签页打开
            new_page = None
            for attempt in range(15):  # 最多等待15秒（新页面可能加载较慢）
                await asyncio.sleep(1)
                current_pages = context.pages

                # 查找新打开的家庭组加入页面
                for p in current_pages:
                    try:
                        url = p.url
                        # 跳过空白页和正在加载的页面
                        if not url or url == "about:blank" or url.startswith("chrome"):
                            continue
                        if "myaccount.google.com/family/join" in url or "families.google.com" in url:
                            new_page = p
                            log(f"[{invitee_email}] 检测到新标签页: {url}")
                            break
                    except Exception:
                        continue

                if new_page:
                    break

                # 如果页面数量增加了，检查最后一个页面
                if len(current_pages) > initial_page_count:
                    last_page = current_pages[-1]
                    try:
                        url = last_page.url
                        # 跳过空白页，等待其加载
                        if url and url != "about:blank" and not url.startswith("chrome"):
                            if "mail.google.com" not in url:
                                new_page = last_page
                                log(f"[{invitee_email}] 检测到新标签页 (第{attempt+1}次): {url}")
                                break
                    except Exception:
                        continue

            if not new_page:
                # 没有检测到新标签页，可能链接在当前页面打开
                # 检查当前页面是否已经跳转
                try:
                    current_url = page.url
                except Exception:
                    current_url = ""

                if "myaccount.google.com/family/join" in current_url or "families.google.com" in current_url:
                    new_page = page
                    log(f"[{invitee_email}] 当前页面已跳转到: {current_url}")
                else:
                    log(f"[{invitee_email}] ⚠️ 未检测到新标签页，当前页面: {current_url}")
                    # 尝试手动检查所有页面
                    for p in context.pages:
                        try:
                            url = p.url
                            if not url or url == "about:blank":
                                continue
                            log(f"[{invitee_email}] 页面: {url}")
                            if "family" in url and "mail" not in url:
                                new_page = p
                                break
                        except Exception:
                            continue

            if not new_page:
                return {"success": False, "message": "未能检测到家庭组加入页面", "steps": total_steps}

            # 将新页面带到前台并等待加载
            new_page_url = ""
            try:
                await new_page.bring_to_front()
                # 等待页面加载完成
                await new_page.wait_for_load_state("domcontentloaded", timeout=10000)
                await new_page.wait_for_timeout(2000)
                # 安全获取 URL
                new_page_url = new_page.url
            except Exception as e:
                log(f"[{invitee_email}] ⚠️ 切换到新标签页时出错: {e}")
                # 尝试继续执行，使用默认 URL
                new_page_url = "https://myaccount.google.com/family/join"

            # ==================== 阶段2：在新标签页完成加入流程 ====================
            log(f"[{invitee_email}] 阶段2: 在新标签页完成加入流程...")

            # ========== 优先使用 CDP 方式点击 ==========
            cdp_success = False
            try:
                from core.ai_browser_agent import create_cdp_service, CDP_SERVICE_AVAILABLE

                if CDP_SERVICE_AVAILABLE:
                    log(f"[{invitee_email}] 尝试 CDP 方式点击 Join Family Group 按钮...")

                    cdp_service = await create_cdp_service(new_page)

                    try:
                        # 等待页面加载
                        await new_page.wait_for_timeout(1500)

                        # 使用可访问性树查找 "Join Family Group" 按钮
                        ax_elements = await cdp_service.get_interactive_elements_via_ax()
                        log(f"[{invitee_email}] CDP 发现 {len(ax_elements)} 个可交互元素")

                        # 查找目标按钮
                        target_backend_id = None
                        join_keywords = [
                            "join family group", "加入家庭群组", "加入家庭组",
                            "ファミリーグループに参加", "가족 그룹 가입"
                        ]

                        for elem in ax_elements:
                            elem_name = (elem.get("name") or "").lower()
                            elem_role = (elem.get("role") or "").lower()

                            # 检查是否是按钮且名称匹配
                            if elem_role == "button":
                                for keyword in join_keywords:
                                    if keyword in elem_name:
                                        target_backend_id = elem.get("backend_node_id")
                                        log(f"[{invitee_email}] CDP 找到目标按钮: {elem.get('name')} (id={target_backend_id})")
                                        break
                                if target_backend_id:
                                    break

                        if target_backend_id:
                            # 使用 CDP 点击
                            success, msg = await cdp_service.click_by_backend_node_id(target_backend_id)
                            if success:
                                log(f"[{invitee_email}] ✅ CDP 点击成功!")
                                cdp_success = True

                                # 等待页面跳转
                                await new_page.wait_for_timeout(3000)

                                # 检查是否成功
                                try:
                                    current_url = new_page.url
                                    if "success" in current_url:
                                        log(f"[{invitee_email}] ✅ URL 包含 success，加入成功!")
                                        return {"success": True, "message": "成功接受邀请 (CDP)", "steps": total_steps}

                                    # 检查页面内容
                                    page_text = await new_page.inner_text("body")
                                    success_keywords = ["welcome to the family", "you joined", "已加入", "view family group"]
                                    if any(kw in page_text.lower() for kw in success_keywords):
                                        log(f"[{invitee_email}] ✅ 检测到成功关键词!")
                                        return {"success": True, "message": "成功接受邀请 (CDP)", "steps": total_steps}
                                except Exception as e:
                                    log(f"[{invitee_email}] 检查成功状态失败: {e}")
                            else:
                                log(f"[{invitee_email}] CDP 点击失败: {msg}")
                        else:
                            log(f"[{invitee_email}] CDP 未找到目标按钮，尝试 CSS 选择器...")

                            # 备选：使用 CSS 选择器查找
                            button_selectors = [
                                'button[data-idom-class*="join"]',
                                'button:has-text("Join Family Group")',
                                'button:has-text("加入家庭群组")',
                            ]

                            for selector in button_selectors:
                                try:
                                    node_ids = await cdp_service.query_selector_all(selector.split(":has-text")[0] if ":has-text" in selector else selector)
                                    if node_ids:
                                        # 获取第一个按钮的中心坐标并点击
                                        center = await cdp_service.get_node_center(node_ids[0])
                                        if center:
                                            click_ok = await cdp_service.click_at_coordinates(center[0], center[1])
                                            if click_ok:
                                                log(f"[{invitee_email}] ✅ CDP 坐标点击成功!")
                                                cdp_success = True
                                                await new_page.wait_for_timeout(3000)
                                                break
                                except Exception:
                                    continue
                    finally:
                        await cdp_service.close()

            except ImportError:
                log(f"[{invitee_email}] CDP 服务不可用，使用 AI Agent")
            except Exception as e:
                log(f"[{invitee_email}] CDP 操作异常: {e}")

            # 如果 CDP 成功，检查最终状态
            if cdp_success:
                try:
                    current_url = new_page.url
                    page_text = await new_page.inner_text("body")
                    success_keywords = ["welcome to the family", "you joined", "已加入", "view family group", "success"]

                    if "success" in current_url or any(kw in page_text.lower() for kw in success_keywords):
                        return {"success": True, "message": "成功接受邀请 (CDP)", "steps": total_steps}
                except Exception:
                    pass

            # ========== CDP 失败，使用 AI Agent 作为备选 ==========
            log(f"[{invitee_email}] CDP 未能完成，启用 AI Agent...")

            # 阶段2的提示词 - 完成加入流程
            phase2_prompt = f"""
你是一个专业的浏览器自动化助手，需要完成 Google 家庭组加入流程。

## 当前状态
- 被邀请人账号: {invitee_email}
- 邀请来自: {inviter_email}
- 当前页面: 家庭组加入页面（myaccount.google.com/family/join）

## 【最重要】你的唯一任务：点击蓝色的 "Join Family Group" 按钮

### 页面外观描述
当前页面应该显示：
- 页面标题: "Join a Family Group"
- 内容: "You're invited to join [name]'s Family Group"
- 页面中央偏左有一个**蓝色的圆角大按钮**
- 按钮文字: "Join Family Group"

### 如何识别正确的按钮
✅ 正确的按钮特征:
- **蓝色背景，白色文字**
- 位于页面**中央偏左**位置
- 文字为 "Join Family Group"（或其他语言的翻译）
- 是页面上**最显眼的蓝色按钮**

❌ 不要点击:
- 右上角的头像图标
- "Learn more" 链接
- 页面顶部的导航
- 任何灰色或非蓝色的按钮

### 操作步骤
1. 在页面中找到蓝色的 "Join Family Group" 按钮
2. 直接点击这个蓝色按钮
3. 等待跳转到成功页面

## 成功标准
看到以下任一情况时，报告 DONE：
- 页面显示 "Welcome to the family!"
- 页面显示 "You joined [name]'s Family Group"
- 页面显示 "View Family Group" 按钮
- URL 包含 "success"
- 页面显示 "Already in a family"（表示已加入）

## 如果页面已经是成功页面
- 直接报告 DONE，不需要再点击任何按钮

## 失败情况
- "invitation expired" / "邀请已过期" → 报告 ERROR
- "You can't join this family" → 报告 ERROR

## 多语言按钮关键词
- "Join Family Group" / "加入家庭群组" / "ファミリーグループに参加" / "가족 그룹 가입"
"""

            # 创建阶段2的 AI Agent
            agent2 = AIBrowserAgent(
                api_key=api_key,
                base_url=base_url,
                model=model,
                provider=provider,
            )
            agent2.on_step(lambda step, action: log(f"[{invitee_email}][阶段2] 步骤{step}: {action}"))

            # 计算阶段2可用步骤数（确保至少有5步，阶段1用了12步）
            phase2_max_steps = max(5, max_steps - 12)

            # 执行阶段2
            phase2_result = await agent2.execute_task(
                page=new_page,
                goal=phase2_prompt,
                start_url=new_page_url,  # 使用安全获取的 URL
                account=agent_account,
                max_steps=phase2_max_steps,
                navigate_first=False,
            )

            total_steps += phase2_result.total_steps

            if phase2_result.success:
                return {"success": True, "message": "成功接受邀请", "steps": total_steps}
            else:
                return {"success": False, "message": f"阶段2失败: {phase2_result.message}", "steps": total_steps}

    except Exception as e:
        return {"success": False, "message": str(e), "steps": total_steps}


# ==================== 测试代码 ====================

if __name__ == "__main__":
    async def main():
        print("家庭组加入测试")
        print("=" * 50)

        # 测试账号（需要替换为真实账号）
        inviter_account = {
            "email": "pro_account@gmail.com",
            "password": "password",
            "secret_key": "",
        }

        invitee_account = {
            "email": "family_pro@gmail.com",
            "password": "password",
            "secret_key": "",
        }

        # 测试浏览器 ID（需要替换为真实 ID）
        inviter_browser_id = "12345"
        invitee_browser_id = "67890"

        result = await auto_join_family(
            inviter_account=inviter_account,
            invitee_account=invitee_account,
            inviter_browser_id=inviter_browser_id,
            invitee_browser_id=invitee_browser_id,
            callback=print,
        )

        print(f"\n结果: {result}")

    asyncio.run(main())
