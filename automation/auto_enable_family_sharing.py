"""
自动开启家庭组共享

为普通 Pro 账户开启家庭组共享功能：
1. 导航到 Google One 设置页面
2. 展开 "Manage family settings"
3. 开启 "Share Google One with family" 开关
4. 更新数据库状态

采用 Stagehand AI 检测（observe + act 模式）
"""

import asyncio
from typing import Callable, Optional
from dataclasses import dataclass

from playwright.async_api import async_playwright, Page

from services.database import DBManager
from services.ix_api import openBrowser, closeBrowser

# 导入共享的 Stagehand AI 配置函数
from automation.pro_status_detector import get_stagehand_config

# 尝试导入 Stagehand SDK
try:
    from stagehand import AsyncStagehand
    STAGEHAND_AVAILABLE = True
except ImportError:
    STAGEHAND_AVAILABLE = False
    AsyncStagehand = None

# 尝试导入 AI Browser Agent 模块（作为备选）
try:
    from core.ai_browser_agent import AIBrowserAgent
    AI_BROWSER_AGENT_AVAILABLE = True
except ImportError:
    AI_BROWSER_AGENT_AVAILABLE = False
    AIBrowserAgent = None


@dataclass
class EnableFamilySharingResult:
    """开启家庭共享结果"""
    success: bool
    message: str
    email: str
    was_already_enabled: bool = False
    family_created: bool = False  # 是否创建了新的家庭组
    error_type: Optional[str] = None


# ==================== 提示词模板 ====================

CREATE_FAMILY_PROMPT = """
你是一个专业的浏览器自动化助手，需要在 Google One 设置页面创建家庭组。

## 当前状态
- 账号: {email}
- 目标: 创建家庭组 (Create a family group)

## 任务目标
在 Google One 设置页面，找到并点击创建家庭组功能，完成家庭组创建流程。

## 操作步骤

### 1. 检查当前页面
- 当前应该在 https://one.google.com/settings 或类似的设置页面
- 如果不是，请导航到该页面

### 2. 处理可能的弹窗遮挡
- 如果出现弹窗或遮罩层，按 Escape 键关闭
- 如果有账号选择器弹窗，关闭它

### 3. 找到 "Create a family group" 或 "Start a family group" 入口
- 在页面中找到家庭组创建入口
- 可能的按钮文本: "Create a family group", "Start a family group", "Get started", "创建家庭群组", "开始使用"
- 点击该按钮进入创建流程

### 4. 完成创建流程
- 在创建流程中点击 "Create" / "Continue" / "Next" / "创建" / "继续" 等按钮
- 可能需要确认条款，勾选同意复选框
- 完成所有步骤直到家庭组创建成功

### 5. 确认创建成功
- 创建成功后，页面应该显示 "Manage family settings" 或类似管理选项
- 如果看到管理选项，任务完成，报告 DONE

## 多语言关键词

**创建家庭组按钮:**
- "Create a family group" / "Start a family group" / "Get started"
- "创建家庭群组" / "开始使用家庭群组" / "创建家庭组"
- "ファミリーグループを作成" / "가족 그룹 만들기"

**确认/继续按钮:**
- "Create" / "Continue" / "Next" / "Done" / "Confirm"
- "创建" / "继续" / "下一步" / "完成" / "确认"

**成功标志:**
- "Manage family settings" / "管理家庭设置"
- "Family group created" / "家庭群组已创建"
- "You're the family manager" / "您是家庭管理员"

## 成功标准
- 页面显示 "Manage family settings" 或家庭管理选项
- 表明家庭组已创建

## 错误情况
- 如果账户不是 Pro 会员，可能无法创建家庭组
- 如果账户已加入其他家庭组，无法创建新的
- 如果创建过程中出现错误，报告 ERROR
"""

ENABLE_SHARING_PROMPT = """
你是一个专业的浏览器自动化助手，需要在 Google One 设置页面开启家庭共享功能。

## 当前状态
- 账号: {email}
- 目标: 开启 "Share Google One with family" 开关

## 任务目标
在 Google One 设置页面，找到并开启家庭共享开关。

## 操作步骤

### 1. 检查当前页面
- 当前应该在 https://one.google.com/settings 或类似的设置页面
- 如果不是，请导航到该页面

### 2. 处理可能的弹窗遮挡
- 如果出现弹窗或遮罩层，按 Escape 键关闭
- 如果有账号选择器弹窗，关闭它

### 3. 找到并展开 "Manage family settings"
- 在页面中找到 "Manage family settings" 选项
- 如果是折叠状态，点击展开

### 4. 找到 "Share Google One with family" 开关
- 展开后应该能看到 "Share Google One with family" 选项
- 旁边有一个 Toggle 开关

### 5. 检查开关状态
- 如果开关已经是开启状态（蓝色/右侧），任务已完成，报告 DONE
- 如果开关是关闭状态（灰色/左侧），点击开启

### 6. 处理确认弹窗（如果有）
- 开启后可能出现确认弹窗
- 点击 "Continue" / "Got it" / "确认" 等按钮

### 7. 确认开关已开启
- 确保开关变为开启状态
- 如果成功，报告 DONE

## 多语言关键词

**Manage family settings:**
- "Manage family settings" / "管理家庭设置" / "ファミリー設定を管理"

**Share toggle:**
- "Share Google One with family" / "与家庭成员共享 Google One"
- Toggle 开关通常是 role="switch" 或 input[type="checkbox"]

**确认按钮:**
- "Continue" / "Got it" / "Confirm" / "继续" / "确认" / "知道了"

## 成功标准
- 开关变为开启状态（蓝色）
- 或确认弹窗点击后开关开启

## 错误情况
- 如果找不到 "Manage family settings"，可能账户不是 Pro 会员
- 如果开关无法点击，报告 ERROR
"""


async def auto_enable_family_sharing(
    account: dict,
    browser_id: str,
    callback: Callable[[str], None] = None,
    api_key: str = None,  # 已废弃，AI 配置从 get_stagehand_config() 获取
    model: str = None,    # 已废弃
    provider: str = None, # 已废弃
    max_steps: int = None,  # 已废弃
    close_browser_on_success: bool = False,
) -> EnableFamilySharingResult:
    """
    为账户开启家庭组共享功能

    使用 Stagehand AI observe + act 模式，减少 LLM 调用次数。

    Args:
        account: 账号信息 {email, password, secret_key, browser_profile_id}
        browser_id: 浏览器窗口 ID
        callback: 进度回调函数
        api_key: 已废弃，AI 配置从 get_stagehand_config() 读取
        model: 已废弃
        provider: 已废弃
        max_steps: 已废弃
        close_browser_on_success: 成功后是否关闭浏览器窗口

    Returns:
        EnableFamilySharingResult: 开启结果
    """
    email = account.get("email", "")

    def log(msg: str):
        """日志输出"""
        print(f"[EnableSharing] {msg}")
        if callback:
            callback(msg)

    log(f"开始为 {email} 开启家庭共享...")

    try:
        # 打开浏览器
        result = openBrowser(browser_id)
        if not result.get("success"):
            return EnableFamilySharingResult(
                success=False,
                message=result.get("msg", "打开浏览器失败"),
                email=email,
                error_type="browser_error",
            )

        ws_endpoint = result.get("data", {}).get("ws", "")
        if not ws_endpoint:
            return EnableFamilySharingResult(
                success=False,
                message="无法获取浏览器 WebSocket 连接",
                email=email,
                error_type="browser_error",
            )

        # ========== 使用 Stagehand AI 开启共享 ==========
        if not STAGEHAND_AVAILABLE:
            log(f"[{email}] Stagehand SDK 不可用")
            return EnableFamilySharingResult(
                success=False,
                message="Stagehand SDK 不可用，请安装 stagehand 包",
                email=email,
                error_type="stagehand_unavailable",
            )

        log(f"[{email}] 使用 Stagehand AI 开启家庭共享...")
        family_created = False

        # 第一步：尝试开启共享
        stagehand_result = await _enable_sharing_via_stagehand(
            ws_endpoint=ws_endpoint,
            email=email,
            log=log,
        )

        # 第二步：如果需要先创建家庭组
        if stagehand_result.get("needs_create_family"):
            log(f"[{email}] 需要先创建家庭组...")
            create_result = await _create_family_via_stagehand(
                ws_endpoint=ws_endpoint,
                email=email,
                log=log,
            )

            if create_result.get("success"):
                family_created = True
                log(f"[{email}] 家庭组创建成功，继续开启共享...")
                # 更新数据库家庭成员数量（创建者算1人）
                DBManager.update_family_member_count(email, 1)

                # 再次尝试开启共享
                stagehand_result = await _enable_sharing_via_stagehand(
                    ws_endpoint=ws_endpoint,
                    email=email,
                    log=log,
                )
            else:
                error_msg = create_result.get("message", "创建家庭组失败")
                log(f"[{email}] 创建家庭组失败: {error_msg}")
                return EnableFamilySharingResult(
                    success=False,
                    message=f"创建家庭组失败: {error_msg}",
                    email=email,
                    error_type="create_family_failed",
                )

        # 处理结果
        if stagehand_result.get("success"):
            was_already = stagehand_result.get("was_already_enabled", False)
            DBManager.update_family_sharing_enabled(email, "yes")

            if close_browser_on_success:
                try:
                    closeBrowser(browser_id)
                except Exception:
                    pass

            if was_already:
                return EnableFamilySharingResult(
                    success=True,
                    message="已开启",
                    email=email,
                    was_already_enabled=True,
                    family_created=family_created,
                )
            else:
                return EnableFamilySharingResult(
                    success=True,
                    message="成功创建家庭组并开启共享" if family_created else "成功开启家庭共享",
                    email=email,
                    was_already_enabled=False,
                    family_created=family_created,
                )
        else:
            return EnableFamilySharingResult(
                success=False,
                message=stagehand_result.get("message", "开启共享失败"),
                email=email,
                error_type="stagehand_failed",
            )

    except Exception as e:
        error_msg = str(e)
        log(f"[{email}] 异常: {error_msg}")
        return EnableFamilySharingResult(
            success=False,
            message=f"开启家庭共享异常: {error_msg}",
            email=email,
            error_type="exception",
        )


# ==================== Stagehand AI 实现 ====================

async def _enable_sharing_via_stagehand(
    ws_endpoint: str,
    email: str,
    log: Callable[[str], None],
) -> dict:
    """
    使用 Stagehand AI 开启家庭共享（observe + act 模式）

    优先使用 observe 查找元素，然后用 act 执行操作，
    减少 LLM 调用次数。

    Args:
        ws_endpoint: 浏览器 WebSocket 端点
        email: 账号邮箱
        log: 日志函数

    Returns:
        dict: {
            "success": bool,
            "message": str,
            "was_already_enabled": bool,
            "needs_create_family": bool,
            "family_created": bool,
        }
    """
    if not STAGEHAND_AVAILABLE:
        log(f"[{email}] Stagehand SDK 不可用")
        return {
            "success": False,
            "message": "Stagehand SDK 不可用",
            "was_already_enabled": False,
            "needs_create_family": False,
            "family_created": False,
        }

    # 获取 AI 配置
    model_api_key, model_base_url, stagehand_model = get_stagehand_config(
        lambda msg: log(f"[{email}] {msg}")
    )

    if not model_api_key or not stagehand_model:
        log(f"[{email}] AI 配置不完整")
        return {
            "success": False,
            "message": "AI 配置不完整",
            "was_already_enabled": False,
            "needs_create_family": False,
            "family_created": False,
        }

    try:
        log(f"[{email}] 启动 Stagehand session...")

        async with AsyncStagehand(
            server="local",
            model_api_key=model_api_key,
            local_ready_timeout_s=30.0,
        ) as client:
            session = await client.sessions.start(
                model_name=stagehand_model,
                browser={
                    "type": "local",
                    "cdp_url": ws_endpoint,
                },
            )

            try:
                # 1. 导航到设置页面
                log(f"[{email}] 导航到 Google One 设置页...")
                await session.navigate(url="https://one.google.com/settings")
                await asyncio.sleep(2.0)  # 等待页面完全加载

                # 构建 model_config
                model_config = {
                    "model_name": stagehand_model,
                    "api_key": model_api_key,
                }
                if model_base_url:
                    model_config["base_url"] = model_base_url

                # 2. observe 查找关键元素（1 次 LLM 调用）
                log(f"[{email}] 使用 AI 检测家庭共享状态...")
                observe_response = await session.observe(
                    instruction="""
                    在当前 Google One 设置页面，找到以下任意元素：

                    1. "Share Google One with family" 开关/切换按钮
                       - 如果开关是开启状态（ON/蓝色/右侧），请在描述中注明 "enabled" 或 "on"
                       - 如果开关是关闭状态（OFF/灰色/左侧），请在描述中注明 "disabled" 或 "off"
                    2. "与家人共享 Google One" 开关（中文版），同样注明开关状态
                    3. "Create a family group" 或 "创建家庭群组" 按钮（表示需要先创建家庭组）
                    4. "Start a family group" 或 "开始使用家庭" 按钮
                    5. "Manage family settings" 或 "管理家庭设置" 可展开区域
                    6. "Sharing with X family members" 或 "正在与 X 位家庭成员共享"（表示已开启共享）

                    返回找到的所有相关元素，并明确描述开关的当前状态。
                    """,
                    options={"model": model_config},
                )

                results = observe_response.data.result
                if not results:
                    log(f"[{email}] observe 未找到任何元素")
                    return {
                        "success": False,
                        "message": "未找到家庭共享相关元素",
                        "was_already_enabled": False,
                        "needs_create_family": True,  # 保守策略：尝试创建家庭组
                        "family_created": False,
                    }

                log(f"[{email}] observe 找到 {len(results)} 个元素")

                # 3. 分析 observe 结果
                toggle_element = None
                create_family_element = None
                manage_family_element = None
                is_already_enabled = False

                for element in results:
                    desc = (element.description or "").lower()
                    log(f"[{email}]   - {element.description}")

                    # 检测已开启状态
                    # 1. 描述中明确包含开启状态词
                    # 2. 或者描述中包含 "sharing with" 表示正在共享
                    if ("share" in desc or "共享" in desc) and (
                        "enabled" in desc or "已开启" in desc or "checked" in desc or
                        "toggle on" in desc or "switch on" in desc or "turned on" in desc or
                        " on " in desc or " on," in desc or "(on)" in desc or
                        "sharing with" in desc or "正在共享" in desc or "共享中" in desc or
                        "is on" in desc or "状态：开" in desc or "state: on" in desc
                    ):
                        is_already_enabled = True

                    # 检测 toggle 开关
                    # 必须包含 "share" 相关词，且必须是开关类型
                    # 排除 "manage" 相关词，避免把 "Manage family settings" 误判为 toggle
                    is_share_toggle = (
                        ("share" in desc or "共享" in desc) and
                        ("toggle" in desc or "switch" in desc or "开关" in desc) and
                        ("manage" not in desc and "管理" not in desc)
                    )
                    if is_share_toggle:
                        toggle_element = element
                        # 如果 toggle 描述中包含 on/enabled，说明已开启
                        if any(kw in desc for kw in ["enabled", " on ", " on,", "(on)", "is on", "已开启"]):
                            is_already_enabled = True

                    # 检测创建家庭组按钮（排除 manage 相关词）
                    if (("create" in desc or "创建" in desc or "start" in desc or "开始" in desc) and
                        ("family" in desc or "家庭" in desc) and
                        ("manage" not in desc and "管理" not in desc)):
                        create_family_element = element

                    # 检测管理家庭设置（包含 manage 和 family）
                    if ("manage" in desc or "管理" in desc) and ("family" in desc or "家庭" in desc):
                        manage_family_element = element

                # 4. 根据状态执行操作
                if is_already_enabled:
                    log(f"[{email}] ✅ 家庭共享已开启")
                    return {
                        "success": True,
                        "message": "家庭共享已开启",
                        "was_already_enabled": True,
                        "needs_create_family": False,
                        "family_created": False,
                    }

                # 优先检测：如果存在创建家庭组按钮，说明还没有家庭组
                # 无论是否有 toggle 或 manage family，都应该先创建家庭组
                if create_family_element:
                    log(f"[{email}] 检测到需要创建家庭组...")
                    return {
                        "success": False,
                        "message": "需要先创建家庭组",
                        "was_already_enabled": False,
                        "needs_create_family": True,
                        "family_created": False,
                    }

                # 如果有 manage family，先点击展开
                if manage_family_element and not toggle_element:
                    log(f"[{email}] 点击展开家庭设置...")
                    action = manage_family_element.to_dict(exclude_none=True)
                    await session.act(input=action)

                    # 等待页面响应
                    await asyncio.sleep(2.0)  # 增加等待时间

                    # 重新 observe 查找 toggle 或 create family 按钮
                    log(f"[{email}] 重新查找共享开关...")
                    observe_response2 = await session.observe(
                        instruction="""
                        在当前页面找到以下任意元素：
                        1. "Share Google One with family" 或 "与家人共享 Google One" 开关/切换按钮
                           - 如果开关是开启状态，请注明 "enabled" 或 "on"
                        2. "Create a family group" 或 "创建家庭群组" 按钮（如果没有家庭组）
                        3. "Get started" 或 "开始使用" 按钮（创建家庭组入口）
                        4. "Sharing with X family members" 或 "正在共享"（表示已开启）
                        5. "Start a family group" 或 "开始使用家庭" 按钮
                        """,
                        options={"model": model_config},
                    )
                    results2 = observe_response2.data.result
                    if results2:
                        log(f"[{email}] 展开后找到 {len(results2)} 个元素")
                        # 先遍历所有元素，收集信息
                        found_create_family = False
                        found_toggle = None
                        found_already_enabled = False
                        for elem2 in results2:
                            desc2 = (elem2.description or "").lower()
                            log(f"[{email}]   - {elem2.description}")
                            # 检测已开启状态
                            if ("share" in desc2 or "共享" in desc2) and (
                                "enabled" in desc2 or "已开启" in desc2 or " on " in desc2 or
                                "sharing with" in desc2 or "正在共享" in desc2 or "共享中" in desc2 or
                                "is on" in desc2 or "(on)" in desc2
                            ):
                                found_already_enabled = True
                            # 展开后发现需要创建家庭组
                            # 注意：排除 "Manage family settings" 按钮（描述中包含 manage）
                            if ("create" in desc2 or "创建" in desc2 or "start" in desc2 or
                                "get started" in desc2 or "开始" in desc2) and (
                                "family" in desc2 or "家庭" in desc2
                            ) and ("manage" not in desc2 and "管理" not in desc2):
                                found_create_family = True
                            # 找到 toggle（排除 manage 相关词）
                            is_toggle = (
                                ("share" in desc2 or "共享" in desc2) and
                                ("toggle" in desc2 or "switch" in desc2 or "开关" in desc2) and
                                ("manage" not in desc2 and "管理" not in desc2)
                            )
                            if is_toggle:
                                found_toggle = elem2
                                # 如果 toggle 描述中包含 on/enabled，说明已开启
                                if any(kw in desc2 for kw in ["enabled", " on ", "(on)", "is on", "已开启"]):
                                    found_already_enabled = True

                        # 优先处理：如果已开启，直接返回
                        if found_already_enabled:
                            log(f"[{email}] ✅ 展开后检测到共享已开启")
                            return {
                                "success": True,
                                "message": "家庭共享已开启",
                                "was_already_enabled": True,
                                "needs_create_family": False,
                                "family_created": False,
                            }

                        # 如果有 create_family，先创建
                        if found_create_family:
                            log(f"[{email}] 展开后发现需要创建家庭组...")
                            return {
                                "success": False,
                                "message": "需要先创建家庭组",
                                "was_already_enabled": False,
                                "needs_create_family": True,
                                "family_created": False,
                            }

                        # 否则使用找到的 toggle
                        if found_toggle:
                            toggle_element = found_toggle
                            log(f"[{email}] 找到共享开关: {toggle_element.description}")
                        else:
                            # 展开后找到了元素，但既不是 toggle 也不是 create_family
                            # 说明可能需要去 people-and-sharing 页面创建家庭组
                            log(f"[{email}] 展开后未找到共享开关或创建按钮，尝试创建家庭组...")
                            return {
                                "success": False,
                                "message": "展开后未找到共享选项，需要创建家庭组",
                                "was_already_enabled": False,
                                "needs_create_family": True,
                                "family_created": False,
                            }
                    else:
                        # 展开后没找到任何元素，可能需要创建家庭组
                        log(f"[{email}] 展开后未找到相关元素，尝试创建家庭组...")
                        return {
                            "success": False,
                            "message": "展开后未找到共享选项，可能需要创建家庭组",
                            "was_already_enabled": False,
                            "needs_create_family": True,
                            "family_created": False,
                        }

                # 点击 toggle 开启共享
                if toggle_element:
                    log(f"[{email}] 点击开关开启共享...")
                    action = toggle_element.to_dict(exclude_none=True)
                    await session.act(input=action)

                    # 等待页面响应
                    await asyncio.sleep(1.5)

                    # 处理可能的确认弹窗
                    log(f"[{email}] 检查确认弹窗...")
                    confirm_response = await session.observe(
                        instruction="""
                        找到确认按钮，如 "Continue", "Got it", "确认", "继续", "OK"。
                        """,
                        options={"model": model_config},
                    )
                    if confirm_response.data.result:
                        confirm_btn = confirm_response.data.result[0]
                        log(f"[{email}] 点击确认按钮: {confirm_btn.description}")
                        confirm_action = confirm_btn.to_dict(exclude_none=True)
                        await session.act(input=confirm_action)
                        await asyncio.sleep(1.0)

                    # 验证开关是否真的开启了
                    log(f"[{email}] 验证共享状态...")
                    verify_response = await session.observe(
                        instruction="""
                        检查 "Share Google One with family" 或 "与家人共享 Google One" 开关的当前状态。
                        查找：
                        1. 开关是否显示为 ON/已开启/enabled/checked 状态
                        2. 或者页面显示 "Sharing with family" / "正在与家人共享"
                        """,
                        options={"model": model_config},
                    )
                    verify_results = verify_response.data.result
                    verified_success = False
                    if verify_results:
                        for vr in verify_results:
                            vr_desc = (vr.description or "").lower()
                            # 使用更精确的匹配，避免 "on" 误匹配到 "button", "one" 等
                            if any(kw in vr_desc for kw in [
                                "enabled", "已开启", "checked", "sharing", "共享中",
                                "toggle on", "switch on", "turned on", "is on",
                                " on ", " on,", " on.", "(on)"
                            ]):
                                verified_success = True
                                break

                    if verified_success:
                        log(f"[{email}] ✅ 成功开启家庭共享（已验证）")
                        return {
                            "success": True,
                            "message": "成功开启家庭共享",
                            "was_already_enabled": False,
                            "needs_create_family": False,
                            "family_created": False,
                        }
                    else:
                        # 可能点击的不是正确的元素，或者开关点击后需要创建家庭组
                        log(f"[{email}] 开关状态验证失败，可能需要创建家庭组")
                        # 再次检查是否需要创建家庭组
                        check_create_response = await session.observe(
                            instruction="""
                            查找页面上是否有 "Create a family group" 或 "创建家庭群组" 按钮。
                            """,
                            options={"model": model_config},
                        )
                        if check_create_response.data.result:
                            return {
                                "success": False,
                                "message": "需要先创建家庭组",
                                "was_already_enabled": False,
                                "needs_create_family": True,
                                "family_created": False,
                            }

                        # 返回不确定状态，但标记为可能需要创建家庭组
                        return {
                            "success": False,
                            "message": "开关状态验证失败",
                            "was_already_enabled": False,
                            "needs_create_family": True,  # 保守策略：尝试创建家庭组
                            "family_created": False,
                        }

                log(f"[{email}] 未找到可操作的元素")
                return {
                    "success": False,
                    "message": "未找到共享开关",
                    "was_already_enabled": False,
                    "needs_create_family": True,  # 保守策略：可能是因为没有家庭组
                    "family_created": False,
                }

            finally:
                try:
                    await session.end()
                except Exception:
                    pass

    except Exception as e:
        log(f"[{email}] Stagehand 异常: {e}")
        return {
            "success": False,
            "message": f"Stagehand 异常: {e}",
            "was_already_enabled": False,
            "needs_create_family": True,  # 保守策略：异常时也尝试创建家庭组
            "family_created": False,
        }


async def _create_family_via_stagehand(
    ws_endpoint: str,
    email: str,
    log: Callable[[str], None],
) -> dict:
    """
    使用 Stagehand AI 创建家庭组（observe + act 模式）

    直接导航到 myaccount.google.com/people-and-sharing 页面，
    在 "Your family on Google" 区域点击 "Get started" 按钮创建家庭组。

    Args:
        ws_endpoint: 浏览器 WebSocket 端点
        email: 账号邮箱
        log: 日志函数

    Returns:
        dict: {"success": bool, "message": str}
    """
    if not STAGEHAND_AVAILABLE:
        return {"success": False, "message": "Stagehand SDK 不可用"}

    model_api_key, model_base_url, stagehand_model = get_stagehand_config(
        lambda msg: log(f"[{email}] {msg}")
    )

    if not model_api_key or not stagehand_model:
        return {"success": False, "message": "AI 配置不完整"}

    try:
        log(f"[{email}] 启动 Stagehand 创建家庭组...")

        async with AsyncStagehand(
            server="local",
            model_api_key=model_api_key,
            local_ready_timeout_s=30.0,
        ) as client:
            session = await client.sessions.start(
                model_name=stagehand_model,
                browser={
                    "type": "local",
                    "cdp_url": ws_endpoint,
                },
            )

            try:
                model_config = {
                    "model_name": stagehand_model,
                    "api_key": model_api_key,
                }
                if model_base_url:
                    model_config["base_url"] = model_base_url

                # ========== 直接导航到 People & sharing 页面 ==========
                # 这是创建家庭组的正确入口，不要在 one.google.com/settings 尝试
                log(f"[{email}] 导航到 People & sharing 页面...")
                await session.navigate(url="https://myaccount.google.com/people-and-sharing")
                await asyncio.sleep(2.0)  # 等待页面完全加载

                # ========== 查找 "Get started" 按钮 ==========
                log(f"[{email}] 查找 'Get started' 按钮...")
                observe_response = await session.observe(
                    instruction="""
                    在 "Your family on Google" 区域查找以下按钮：
                    1. "Get started" 按钮 - 用于创建家庭组
                    2. "开始使用" 按钮 - 中文版
                    3. "Create a family group" / "创建家庭群组" 按钮

                    注意：如果页面显示 "You're a family manager" 或 "您是家庭管理员"，
                    说明家庭组已创建，请在描述中注明 "already created" 或 "已创建"。
                    """,
                    options={"model": model_config},
                )

                results = observe_response.data.result
                if not results:
                    log(f"[{email}] 未找到任何元素，可能家庭组已存在或页面加载失败")
                    return {"success": False, "message": "未找到创建家庭组入口"}

                # 分析结果
                get_started_btn = None
                already_created = False

                for elem in results:
                    desc = (elem.description or "").lower()
                    log(f"[{email}]   - {elem.description}")

                    # 检查是否已创建家庭组
                    if "already created" in desc or "已创建" in desc or "family manager" in desc or "家庭管理员" in desc:
                        already_created = True
                        break

                    # 查找 Get started 按钮
                    if ("get started" in desc or "开始使用" in desc or
                        (("create" in desc or "创建" in desc) and ("family" in desc or "家庭" in desc))):
                        get_started_btn = elem

                if already_created:
                    log(f"[{email}] ✅ 家庭组已存在")
                    return {"success": True, "message": "家庭组已存在"}

                if not get_started_btn:
                    log(f"[{email}] 未找到 'Get started' 按钮")
                    return {"success": False, "message": "未找到 'Get started' 按钮"}

                # ========== 点击 "Get started" 按钮 ==========
                log(f"[{email}] 点击: {get_started_btn.description}")
                action = get_started_btn.to_dict(exclude_none=True)
                await session.act(input=action)
                await asyncio.sleep(3.0)  # 增加等待时间，确保页面跳转到 /family/create

                # ========== 完成家庭组创建流程（可能需要多步）==========
                # 流程：Get started → /family/create 页面（Create a Family Group 按钮）
                #       → /family/createconfirmation 页面（Confirm 按钮）
                log(f"[{email}] 完成家庭组创建流程...")
                confirm_clicks = 0
                max_confirm_clicks = 5  # 最多点击5次按钮
                last_clicked_desc = ""  # 记录上一次点击的按钮描述，避免重复点击

                for attempt in range(max_confirm_clicks):
                    confirm_response = await session.observe(
                        instruction="""
                        在当前页面查找以下任意按钮（按优先级排序）：

                        1. "Create a Family Group" 蓝色按钮 - 在 /family/create 页面
                        2. "创建家庭群组" 蓝色按钮 - 中文版
                        3. "Confirm" 蓝色按钮 - 在 /family/createconfirmation 确认页面
                        4. "确认" 按钮 - 中文版
                        5. "Create" / "创建" 按钮（但不是 "Create a Family Group" 的入口）
                        6. "Continue" / "继续" 按钮
                        7. "I agree" / "同意" 复选框或按钮
                        8. "Next" / "下一步" 按钮

                        **重要：不要选择 "Get started" 或 "开始使用" 按钮！**
                        这些是创建入口，不是确认按钮。

                        注意：查找页面上的蓝色主操作按钮。
                        """,
                        options={"model": model_config},
                    )

                    if not confirm_response.data.result:
                        if confirm_clicks > 0:
                            # 已经点击过按钮，可能已完成
                            log(f"[{email}] 创建流程完成（已点击 {confirm_clicks} 次）")
                            break
                        log(f"[{email}] 尝试 {attempt + 1}: 未找到操作按钮")
                        await asyncio.sleep(1.0)
                        continue

                    confirm_btn = confirm_response.data.result[0]
                    current_desc = (confirm_btn.description or "").lower()

                    # 跳过 "Get started" 按钮（这不是确认按钮）
                    if "get started" in current_desc or "开始使用" in current_desc:
                        log(f"[{email}] 跳过入口按钮: {confirm_btn.description}")
                        # 如果只返回了 Get started，说明页面没有正确跳转
                        if len(confirm_response.data.result) == 1:
                            log(f"[{email}] ⚠️ 页面未跳转到创建确认页面")
                            await asyncio.sleep(2.0)
                            # 继续尝试，可能页面还在加载
                            continue
                        # 尝试使用返回列表中的下一个元素
                        if len(confirm_response.data.result) > 1:
                            confirm_btn = confirm_response.data.result[1]
                            current_desc = (confirm_btn.description or "").lower()
                            if "get started" in current_desc or "开始使用" in current_desc:
                                continue

                    # 检查是否与上一次点击相同（页面可能没有变化）
                    if current_desc == last_clicked_desc and confirm_clicks > 0:
                        log(f"[{email}] 检测到重复按钮，可能页面未变化，跳过...")
                        await asyncio.sleep(1.0)
                        # 再给一次机会，但如果连续两次相同则退出
                        if attempt > 0:
                            break
                        continue

                    log(f"[{email}] 点击: {confirm_btn.description}")
                    confirm_action = confirm_btn.to_dict(exclude_none=True)
                    await session.act(input=confirm_action)
                    confirm_clicks += 1
                    last_clicked_desc = current_desc
                    await asyncio.sleep(2.0)  # 增加等待时间，确保页面完全加载

                    # 检查是否还需要继续点击（至少点击2次：Create a Family Group + Confirm）
                    if confirm_clicks >= 3:
                        # 已经点击3次，应该足够了
                        await asyncio.sleep(1.0)
                        break

                # ========== 验证创建成功 ==========
                # 成功后应该不再显示 "Get started"，而是显示家庭管理选项
                log(f"[{email}] 验证创建结果...")
                await session.navigate(url="https://myaccount.google.com/people-and-sharing")
                await asyncio.sleep(2.0)

                verify_response = await session.observe(
                    instruction="""
                    检查 "Your family on Google" 区域的状态：
                    1. 如果显示 "Get started" 或 "开始使用" 按钮 → 创建失败
                    2. 如果显示 "You're a family manager" 或 "您是家庭管理员" → 创建成功
                    3. 如果显示家庭成员列表或管理选项 → 创建成功

                    请在描述中明确注明 "creation failed" 或 "creation success"。
                    """,
                    options={"model": model_config},
                )

                verify_results = verify_response.data.result
                if verify_results:
                    # 先收集所有信息，再做判断
                    has_get_started = False
                    has_success_indicator = False

                    for vr in verify_results:
                        vr_desc = (vr.description or "").lower()
                        log(f"[{email}]   验证: {vr.description}")

                        # 检查是否仍显示 Get started（创建失败指标）
                        if "get started" in vr_desc or "开始使用" in vr_desc or "creation failed" in vr_desc:
                            has_get_started = True

                        # 检查成功标志
                        if ("family manager" in vr_desc or "家庭管理员" in vr_desc or
                            "creation success" in vr_desc or "created" in vr_desc or
                            "member" in vr_desc or "成员" in vr_desc):
                            has_success_indicator = True

                    # 优先判断成功：如果有成功指标且没有 get started，则成功
                    # 如果两者都有，以成功指标为准（AI 可能在描述中提到"不再显示 get started"）
                    if has_success_indicator:
                        log(f"[{email}] ✅ 家庭组创建成功")
                        return {"success": True, "message": "家庭组创建成功"}

                    if has_get_started and not has_success_indicator:
                        log(f"[{email}] ❌ 家庭组创建失败（仍显示 Get started）")
                        return {"success": False, "message": "创建失败，仍显示 Get started"}

                # 如果无法确定，再导航到 one.google.com/settings 检查
                log(f"[{email}] 在 Google One 设置页验证...")
                await session.navigate(url="https://one.google.com/settings")
                await asyncio.sleep(2.0)

                final_response = await session.observe(
                    instruction="""
                    检查是否有以下元素表示家庭组已创建：
                    1. "Share Google One with family" 开关
                    2. "与家人共享 Google One" 开关
                    3. "Manage family settings" 可展开区域（且不是创建家庭组入口）
                    """,
                    options={"model": model_config},
                )

                if final_response.data.result:
                    for fr in final_response.data.result:
                        fr_desc = (fr.description or "").lower()
                        # 检测共享开关
                        if ("share" in fr_desc and (
                            "toggle" in fr_desc or "switch" in fr_desc or "开关" in fr_desc
                        )):
                            log(f"[{email}] ✅ 家庭组创建成功（发现共享开关）")
                            return {"success": True, "message": "家庭组创建成功"}
                        # 检测 Manage family settings（且不包含 create）
                        if (("manage" in fr_desc or "管理" in fr_desc) and
                            ("family" in fr_desc or "家庭" in fr_desc) and
                            ("create" not in fr_desc and "创建" not in fr_desc)):
                            log(f"[{email}] ✅ 家庭组创建成功（发现家庭管理选项）")
                            return {"success": True, "message": "家庭组创建成功"}

                log(f"[{email}] 家庭组创建状态不确定")
                return {"success": False, "message": "创建状态不确定"}

            finally:
                try:
                    await session.end()
                except Exception:
                    pass

    except Exception as e:
        log(f"[{email}] 创建家庭组异常: {e}")
        return {"success": False, "message": f"异常: {e}"}


async def _try_playwright_enable(page: Page, email: str, log: Callable) -> dict:
    """
    使用 Playwright 尝试开启家庭共享

    Returns:
        dict: {success: bool, was_already_enabled: bool}
    """
    try:
        # 关闭可能的弹窗
        for _ in range(3):
            await page.keyboard.press("Escape")
            await page.wait_for_timeout(200)

        # 移除遮罩层
        await page.evaluate("""
            () => {
                document.querySelectorAll('trans-layer').forEach(t => t.remove());
                document.querySelectorAll('.KL4X6e').forEach(d => d.remove());
                document.querySelectorAll('[role="dialog"]').forEach(d => {
                    if (d.querySelector('iframe')) d.remove();
                });
            }
        """)
        await page.wait_for_timeout(500)

        # ===== 步骤1: 找到并展开 "Manage family settings" =====
        log(f"[{email}] 查找 Manage family settings...")

        expand_clicked = False
        expand_keywords = [
            "Manage family settings",
            "管理家庭设置",
            "ファミリー設定を管理",
            "가족 설정 관리",
        ]

        for keyword in expand_keywords:
            try:
                # 尝试多种选择器
                selectors = [
                    f'text="{keyword}"',
                    f'[aria-label*="{keyword}" i]',
                    f'button:has-text("{keyword}")',
                    f'div:has-text("{keyword}")',
                ]

                for sel in selectors:
                    try:
                        elem = page.locator(sel).first
                        if await elem.is_visible(timeout=1500):
                            await elem.click()
                            log(f"[{email}] 点击了: {keyword}")
                            expand_clicked = True
                            await page.wait_for_timeout(1000)
                            break
                    except Exception:
                        continue

                if expand_clicked:
                    break
            except Exception:
                continue

        if not expand_clicked:
            log(f"[{email}] 未找到 Manage family settings，可能已展开或不存在")

        # ===== 步骤2: 查找 Share 开关 =====
        log(f"[{email}] 查找 Share 开关...")
        await page.wait_for_timeout(1000)

        # 检查开关状态
        toggle_selectors = [
            '[role="switch"]',
            'input[type="checkbox"]',
            '.mdc-switch',
            '[aria-label*="Share" i]',
            '[aria-label*="family" i][role="switch"]',
        ]

        share_toggle = None
        for sel in toggle_selectors:
            try:
                elem = page.locator(sel).first
                if await elem.is_visible(timeout=1500):
                    share_toggle = elem
                    log(f"[{email}] 找到开关: {sel}")
                    break
            except Exception:
                continue

        if not share_toggle:
            log(f"[{email}] 未找到开关元素")
            return {"success": False}

        # 检查是否已开启
        try:
            is_checked = await share_toggle.is_checked()
        except Exception:
            try:
                aria_checked = await share_toggle.get_attribute("aria-checked")
                is_checked = aria_checked == "true"
            except Exception:
                is_checked = False

        if is_checked:
            log(f"[{email}] ✅ 开关已经是开启状态")
            return {"success": True, "was_already_enabled": True}

        # ===== 步骤3: 点击开关开启 =====
        log(f"[{email}] 点击开关开启...")
        try:
            await share_toggle.click(force=True)
            await page.wait_for_timeout(2000)
        except Exception as e:
            log(f"[{email}] 点击开关失败: {e}")
            return {"success": False}

        # ===== 步骤4: 处理可能的确认弹窗 =====
        confirm_keywords = [
            "Continue", "Got it", "Confirm", "OK",
            "继续", "确认", "知道了", "好的",
        ]

        for keyword in confirm_keywords:
            try:
                btn = page.locator(f'button:has-text("{keyword}")').first
                if await btn.is_visible(timeout=1000):
                    await btn.click()
                    log(f"[{email}] 点击确认按钮: {keyword}")
                    await page.wait_for_timeout(1500)
                    break
            except Exception:
                continue

        # ===== 步骤5: 验证开关状态 =====
        await page.wait_for_timeout(1000)
        try:
            is_now_checked = await share_toggle.is_checked()
        except Exception:
            try:
                aria_checked = await share_toggle.get_attribute("aria-checked")
                is_now_checked = aria_checked == "true"
            except Exception:
                is_now_checked = False

        if is_now_checked:
            log(f"[{email}] ✅ 成功开启家庭共享")
            return {"success": True, "was_already_enabled": False}
        else:
            log(f"[{email}] 开关状态未改变")
            return {"success": False}

    except Exception as e:
        log(f"[{email}] Playwright 操作异常: {e}")
        return {"success": False}


async def _try_cdp_enable(page: Page, email: str, log: Callable) -> dict:
    """
    使用 CDP 尝试开启家庭共享

    Returns:
        dict: {success: bool, was_already_enabled: bool}
    """
    try:
        from core.ai_browser_agent import create_cdp_service, CDP_SERVICE_AVAILABLE

        if not CDP_SERVICE_AVAILABLE:
            log(f"[{email}] CDP 服务不可用")
            return {"success": False}

        cdp_service = await create_cdp_service(page)

        try:
            # 获取可访问性树
            ax_elements = await cdp_service.get_interactive_elements_via_ax()
            log(f"[{email}] CDP 发现 {len(ax_elements)} 个可交互元素")

            # 查找 Manage family settings 或 Share 相关元素
            target_backend_id = None
            is_toggle = False
            current_checked = False

            for elem in ax_elements:
                elem_name = (elem.get("name") or "").lower()
                elem_role = (elem.get("role") or "").lower()
                elem_checked = elem.get("checked", False)

                # 查找 switch/toggle 元素
                if elem_role in ("switch", "checkbox"):
                    if "share" in elem_name or "family" in elem_name:
                        target_backend_id = elem.get("backend_node_id")
                        is_toggle = True
                        current_checked = elem_checked
                        log(f"[{email}] CDP 找到开关: {elem.get('name')} (checked={current_checked})")
                        break

                # 查找 Manage family settings 按钮
                if "manage family" in elem_name and elem_role == "button":
                    target_backend_id = elem.get("backend_node_id")
                    log(f"[{email}] CDP 找到展开按钮: {elem.get('name')}")
                    break

            if not target_backend_id:
                log(f"[{email}] CDP 未找到目标元素")
                return {"success": False}

            # 如果是开关且已开启
            if is_toggle and current_checked:
                log(f"[{email}] ✅ CDP 检测到开关已开启")
                return {"success": True, "was_already_enabled": True}

            # 点击元素
            success, msg = await cdp_service.click_by_backend_node_id(target_backend_id)
            if not success:
                log(f"[{email}] CDP 点击失败: {msg}")
                return {"success": False}

            log(f"[{email}] CDP 点击成功")
            await page.wait_for_timeout(1500)

            # 如果点击的是展开按钮，需要再找开关
            if not is_toggle:
                # 重新获取可访问性树
                ax_elements = await cdp_service.get_interactive_elements_via_ax()

                for elem in ax_elements:
                    elem_name = (elem.get("name") or "").lower()
                    elem_role = (elem.get("role") or "").lower()
                    elem_checked = elem.get("checked", False)

                    if elem_role in ("switch", "checkbox"):
                        if "share" in elem_name or "family" in elem_name:
                            if elem_checked:
                                log(f"[{email}] ✅ CDP 展开后检测到开关已开启")
                                return {"success": True, "was_already_enabled": True}

                            target_backend_id = elem.get("backend_node_id")
                            success, msg = await cdp_service.click_by_backend_node_id(target_backend_id)
                            if success:
                                log(f"[{email}] ✅ CDP 成功点击开关")
                                await page.wait_for_timeout(2000)

                                # 处理确认弹窗
                                ax_elements2 = await cdp_service.get_interactive_elements_via_ax()
                                for elem2 in ax_elements2:
                                    elem2_name = (elem2.get("name") or "").lower()
                                    elem2_role = (elem2.get("role") or "").lower()
                                    if elem2_role == "button":
                                        if any(kw in elem2_name for kw in ["continue", "got it", "confirm", "ok", "继续", "确认"]):
                                            confirm_id = elem2.get("backend_node_id")
                                            await cdp_service.click_by_backend_node_id(confirm_id)
                                            log(f"[{email}] CDP 点击确认按钮")
                                            await page.wait_for_timeout(1000)
                                            break

                                return {"success": True, "was_already_enabled": False}
                            break

            else:
                # 直接点击的就是开关
                await page.wait_for_timeout(1500)

                # 处理确认弹窗
                ax_elements2 = await cdp_service.get_interactive_elements_via_ax()
                for elem2 in ax_elements2:
                    elem2_name = (elem2.get("name") or "").lower()
                    elem2_role = (elem2.get("role") or "").lower()
                    if elem2_role == "button":
                        if any(kw in elem2_name for kw in ["continue", "got it", "confirm", "ok", "继续", "确认"]):
                            confirm_id = elem2.get("backend_node_id")
                            await cdp_service.click_by_backend_node_id(confirm_id)
                            log(f"[{email}] CDP 点击确认按钮")
                            await page.wait_for_timeout(1000)
                            break

                return {"success": True, "was_already_enabled": False}

            return {"success": False}

        finally:
            await cdp_service.close()

    except ImportError:
        log(f"[{email}] CDP 模块导入失败")
        return {"success": False}
    except Exception as e:
        log(f"[{email}] CDP 操作异常: {e}")
        return {"success": False}


async def _detect_family_group_status(page: Page, email: str, log: Callable) -> str:
    """
    检测账户是否已创建家庭组

    使用 CDP 优先，Playwright 兜底

    Args:
        page: Playwright Page 对象
        email: 账号邮箱
        log: 日志函数

    Returns:
        str: "has_family" = 已有家庭组
             "no_family" = 尚未创建家庭组
             "unknown" = 无法确定
    """
    log(f"[{email}] 检测家庭组状态...")

    try:
        # ========== CDP 检测 ==========
        try:
            from core.ai_browser_agent import create_cdp_service, CDP_SERVICE_AVAILABLE

            if CDP_SERVICE_AVAILABLE:
                cdp_service = await create_cdp_service(page)
                try:
                    ax_elements = await cdp_service.get_interactive_elements_via_ax()
                    log(f"[{email}] CDP 发现 {len(ax_elements)} 个可交互元素")

                    # 家庭组已存在标识
                    has_family_keywords = [
                        "manage family", "管理家庭", "family settings",
                        "share google one", "share with family", "与家庭成员共享",
                    ]

                    # 家庭组未创建标识
                    no_family_keywords = [
                        "create a family", "start a family", "get started",
                        "创建家庭", "开始使用", "create family group",
                    ]

                    for elem in ax_elements:
                        elem_name = (elem.get("name") or "").lower()

                        # 先检测未创建家庭组（避免页面上有推广内容干扰）
                        for keyword in no_family_keywords:
                            if keyword in elem_name:
                                log(f"[{email}] CDP 检测到尚未创建家庭组: {keyword}")
                                return "no_family"

                    # 再检测已有家庭组
                    for elem in ax_elements:
                        elem_name = (elem.get("name") or "").lower()

                        for keyword in has_family_keywords:
                            if keyword in elem_name:
                                log(f"[{email}] CDP 检测到家庭组已存在: {keyword}")
                                return "has_family"

                finally:
                    await cdp_service.close()

        except ImportError:
            log(f"[{email}] CDP 不可用，回退到 Playwright")
        except Exception as e:
            log(f"[{email}] CDP 检测异常: {e}，回退到 Playwright")

        # ========== Playwright 文本分析兜底 ==========
        page_text = await page.inner_text("body")
        page_text_lower = page_text.lower()

        # 家庭组已存在标识
        has_family_indicators = [
            "manage family settings", "管理家庭设置",
            "share google one with family", "与家庭成员共享 google one",
            "family manager", "家庭管理员",
        ]

        # 家庭组未创建标识
        no_family_indicators = [
            "create a family group", "start a family group", "get started",
            "创建家庭群组", "开始使用家庭群组",
            "you can create a family", "可以创建家庭",
        ]

        # 先检测未创建（避免页面上有推广内容干扰）
        for indicator in no_family_indicators:
            if indicator.lower() in page_text_lower:
                log(f"[{email}] Playwright 检测到尚未创建家庭组: {indicator}")
                return "no_family"

        # 再检测已存在
        for indicator in has_family_indicators:
            if indicator.lower() in page_text_lower:
                log(f"[{email}] Playwright 检测到家庭组已存在: {indicator}")
                return "has_family"

        log(f"[{email}] 无法确定家庭组状态")
        return "unknown"

    except Exception as e:
        log(f"[{email}] 检测家庭组状态异常: {e}")
        return "unknown"


async def _create_family_group(
    page: Page,
    email: str,
    log: Callable,
    account: dict = None,
    api_key: str = None,
    base_url: str = None,
    model: str = None,
    provider: str = None,
    max_steps: int = 10,
) -> dict:
    """
    创建家庭组

    采用三阶段策略: Playwright -> CDP -> AI Agent

    Args:
        page: Playwright Page 对象
        email: 账号邮箱
        log: 日志函数
        account: 账号信息（用于 AI Agent）
        api_key: AI API Key
        base_url: AI Base URL
        model: AI 模型
        provider: AI 提供商
        max_steps: AI Agent 最大步骤数

    Returns:
        dict: {"success": bool, "message": str}
    """
    log(f"[{email}] 开始创建家庭组...")

    try:
        # ========== 阶段1: Playwright 尝试 ==========
        log(f"[{email}] 阶段1: 使用 Playwright 创建家庭组...")

        # 关闭弹窗
        for _ in range(3):
            await page.keyboard.press("Escape")
            await page.wait_for_timeout(200)

        # 查找并点击创建按钮
        create_keywords = [
            "Create a family group", "Start a family group", "Get started",
            "创建家庭群组", "开始使用", "创建家庭组",
        ]

        create_clicked = False
        for keyword in create_keywords:
            try:
                selectors = [
                    f'button:has-text("{keyword}")',
                    f'text="{keyword}"',
                    f'[aria-label*="{keyword}" i]',
                    f'a:has-text("{keyword}")',
                ]

                for sel in selectors:
                    try:
                        elem = page.locator(sel).first
                        if await elem.is_visible(timeout=1500):
                            await elem.click()
                            log(f"[{email}] Playwright 点击了: {keyword}")
                            create_clicked = True
                            await page.wait_for_timeout(2000)
                            break
                    except Exception:
                        continue

                if create_clicked:
                    break
            except Exception:
                continue

        if create_clicked:
            # 继续完成创建流程
            confirm_keywords = [
                "Create", "Continue", "Next", "Done", "Confirm",
                "创建", "继续", "下一步", "完成", "确认",
            ]

            for attempt in range(5):  # 最多点击5次确认按钮
                await page.wait_for_timeout(1000)
                clicked = False

                for keyword in confirm_keywords:
                    try:
                        btn = page.locator(f'button:has-text("{keyword}")').first
                        if await btn.is_visible(timeout=1000):
                            await btn.click()
                            log(f"[{email}] Playwright 点击确认: {keyword}")
                            clicked = True
                            await page.wait_for_timeout(1500)
                            break
                    except Exception:
                        continue

                if not clicked:
                    break

            # 验证是否创建成功
            await page.wait_for_timeout(2000)
            page_text = await page.inner_text("body")
            page_text_lower = page_text.lower()

            success_indicators = [
                "manage family settings", "管理家庭设置",
                "family manager", "家庭管理员",
                "share google one", "与家庭成员共享",
            ]

            for indicator in success_indicators:
                if indicator.lower() in page_text_lower:
                    log(f"[{email}] ✅ Playwright 成功创建家庭组")
                    return {"success": True, "message": "Playwright 创建成功"}

        # ========== 阶段2: CDP 尝试 ==========
        log(f"[{email}] 阶段2: 使用 CDP 创建家庭组...")

        try:
            from core.ai_browser_agent import create_cdp_service, CDP_SERVICE_AVAILABLE

            if CDP_SERVICE_AVAILABLE:
                cdp_service = await create_cdp_service(page)
                try:
                    ax_elements = await cdp_service.get_interactive_elements_via_ax()

                    # 查找创建按钮
                    create_keywords_lower = [
                        "create a family", "start a family", "get started",
                        "创建家庭", "开始使用",
                    ]

                    for elem in ax_elements:
                        elem_name = (elem.get("name") or "").lower()
                        elem_role = (elem.get("role") or "").lower()

                        # 扩展可点击元素类型：button, link, menuitem 等
                        if elem_role in ("button", "link", "menuitem", "listitem"):
                            for keyword in create_keywords_lower:
                                if keyword in elem_name:
                                    backend_id = elem.get("backend_node_id")
                                    success, msg = await cdp_service.click_by_backend_node_id(backend_id)
                                    if success:
                                        log(f"[{email}] CDP 点击创建按钮成功")
                                        await page.wait_for_timeout(2000)

                                        # 继续点击确认按钮
                                        for _ in range(5):
                                            ax_elements2 = await cdp_service.get_interactive_elements_via_ax()
                                            clicked = False

                                            for elem2 in ax_elements2:
                                                elem2_name = (elem2.get("name") or "").lower()
                                                elem2_role = (elem2.get("role") or "").lower()

                                                if elem2_role == "button":
                                                    confirm_kw = ["create", "continue", "next", "done", "confirm", "创建", "继续"]
                                                    if any(kw in elem2_name for kw in confirm_kw):
                                                        bid = elem2.get("backend_node_id")
                                                        await cdp_service.click_by_backend_node_id(bid)
                                                        log(f"[{email}] CDP 点击确认按钮")
                                                        clicked = True
                                                        await page.wait_for_timeout(1500)
                                                        break

                                            if not clicked:
                                                break

                                        # 验证成功
                                        ax_final = await cdp_service.get_interactive_elements_via_ax()
                                        for ef in ax_final:
                                            ef_name = (ef.get("name") or "").lower()
                                            # 更精确的成功标识
                                            if "manage family" in ef_name or "share google one" in ef_name or "与家庭成员共享" in ef_name:
                                                log(f"[{email}] ✅ CDP 成功创建家庭组")
                                                return {"success": True, "message": "CDP 创建成功"}
                                    break

                finally:
                    await cdp_service.close()

        except ImportError:
            log(f"[{email}] CDP 不可用")
        except Exception as e:
            log(f"[{email}] CDP 创建异常: {e}")

        # ========== 阶段3: AI Agent 保底 ==========
        if AI_BROWSER_AGENT_AVAILABLE and account:
            log(f"[{email}] 阶段3: 使用 AI Agent 创建家庭组...")

            agent = AIBrowserAgent(
                api_key=api_key,
                base_url=base_url,
                model=model,
                provider=provider,
            )
            agent.on_step(lambda step, action: log(f"[{email}][Agent] 步骤{step}: {action}"))

            agent_account = {
                "email": email,
                "password": account.get("password", ""),
                "secret": account.get("secret_key", ""),
                "recovery_email": account.get("recovery_email", ""),
            }

            prompt = CREATE_FAMILY_PROMPT.format(email=email)

            task_result = await agent.execute_task(
                page=page,
                goal=prompt,
                start_url="https://one.google.com/settings",
                account=agent_account,
                max_steps=max_steps,
                navigate_first=False,
            )

            if task_result.success:
                log(f"[{email}] ✅ AI Agent 成功创建家庭组")
                return {"success": True, "message": "AI Agent 创建成功"}
            else:
                log(f"[{email}] AI Agent 创建失败: {task_result.message}")
                return {"success": False, "message": task_result.message or "AI Agent 创建失败"}
        else:
            log(f"[{email}] AI Agent 不可用或缺少账号信息")
            return {"success": False, "message": "所有方法均失败"}

    except Exception as e:
        error_msg = str(e)
        log(f"[{email}] 创建家庭组异常: {error_msg}")
        return {"success": False, "message": error_msg}


async def batch_enable_family_sharing(
    accounts: list,
    browser_ids: list,
    callback: Callable[[str], None] = None,
    close_browser_on_success: bool = False,
) -> dict:
    """
    批量开启家庭共享

    Args:
        accounts: 账号列表
        browser_ids: 浏览器ID列表
        callback: 进度回调函数
        close_browser_on_success: 成功后是否关闭浏览器

    Returns:
        dict: {total, success_count, failed_count, already_enabled_count, results}
    """
    results = {
        "total": len(accounts),
        "success_count": 0,
        "failed_count": 0,
        "already_enabled_count": 0,
        "results": [],
    }

    def log(msg: str):
        print(f"[BatchEnableSharing] {msg}")
        if callback:
            callback(msg)

    for i, (account, browser_id) in enumerate(zip(accounts, browser_ids)):
        email = account.get("email", "")
        log(f"[{i+1}/{len(accounts)}] 处理: {email}")

        result = await auto_enable_family_sharing(
            account=account,
            browser_id=browser_id,
            callback=callback,
            close_browser_on_success=close_browser_on_success,
        )

        results["results"].append(result)

        if result.success:
            if result.was_already_enabled:
                results["already_enabled_count"] += 1
                log(f"[{email}] 已开启（跳过）")
            else:
                results["success_count"] += 1
                log(f"[{email}] ✅ 成功")
        else:
            results["failed_count"] += 1
            log(f"[{email}] ❌ 失败: {result.message}")

    log(f"批量完成: 成功 {results['success_count']}, 已开启 {results['already_enabled_count']}, 失败 {results['failed_count']}")
    return results


# ==================== 测试代码 ====================

if __name__ == "__main__":
    async def main():
        print("开启家庭共享测试")
        print("=" * 50)

        # 测试账号（需要替换为真实账号）
        test_account = {
            "email": "pro_account@gmail.com",
            "password": "password",
            "secret_key": "",
        }
        test_browser_id = "12345"

        result = await auto_enable_family_sharing(
            account=test_account,
            browser_id=test_browser_id,
            callback=print,
        )

        print(f"\n结果: {result}")

    asyncio.run(main())
