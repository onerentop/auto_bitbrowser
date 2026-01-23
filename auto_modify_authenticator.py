"""
自动修改 Google 身份验证器 (Authenticator App)

使用 Gemini Vision AI Agent 自动完成操作
支持提取新密钥、生成 TOTP 验证码并保存到数据库
"""

import asyncio
import traceback
from typing import Optional, Tuple

import pyotp

from core.ai_browser_agent import AIBrowserAgent, TaskResult
from core.ai_browser_agent.types import AgentState
from database import DBManager

# 目标 URL - 身份验证器设置页面
AUTHENTICATOR_URL = "https://myaccount.google.com/two-step-verification/authenticator"

# 常量定义
MIN_REMAINING_STEPS = 15  # 提取密钥后最少保留的步骤数


async def auto_modify_authenticator(
    browser_id: str,
    account_info: dict,
    close_after: bool = False,
    max_steps: int = 30,
    api_key: Optional[str] = None,
    base_url: Optional[str] = None,
    model: str = "gemini-2.5-flash",
    save_to_file: bool = True,
    output_file: str = "已修改密钥.txt",
) -> Tuple[bool, str, Optional[str]]:
    """
    修改 Google 身份验证器并提取新密钥

    Args:
        browser_id: ixBrowser 窗口 ID
        account_info: 账号信息 {'email', 'password', 'secret'}
        close_after: 完成后是否关闭浏览器
        max_steps: 最大执行步骤数
        api_key: API Key（可选，默认从环境变量 GEMINI_API_KEY 读取）
        base_url: API Base URL（可选，默认使用 Gemini OpenAI 兼容 API）
        model: 使用的模型（默认 gemini-2.5-flash）
        save_to_file: 是否保存到文件
        output_file: 输出文件名

    Returns:
        (success: bool, message: str, new_secret: Optional[str])
        - success: 是否成功
        - message: 结果消息
        - new_secret: 提取的新密钥（成功时返回）

    Environment Variables:
        GEMINI_API_KEY: Gemini API 密钥
    """
    email = account_info.get("email", "Unknown")
    print(f"\n{'='*50}")
    print(f"修改身份验证器 (Authenticator App)")
    print(f"账号: {email}")
    print(f"{'='*50}")

    # 导入 ixBrowser API
    try:
        from ix_api import openBrowser, closeBrowser
    except ImportError:
        return False, "无法导入 ix_api 模块", None

    browser = None
    playwright = None
    new_secret = None

    try:
        from playwright.async_api import async_playwright

        # 1. 打开 ixBrowser 窗口
        print(f"打开浏览器窗口: {browser_id}")
        result = openBrowser(browser_id)

        if not result or "data" not in result:
            return False, "无法打开浏览器窗口", None

        ws_endpoint = result["data"].get("ws", "")
        if not ws_endpoint:
            return False, "获取 WebSocket endpoint 失败", None

        # 2. 连接 Playwright
        playwright = await async_playwright().start()
        browser = await playwright.chromium.connect_over_cdp(ws_endpoint)

        # 获取页面
        context = browser.contexts[0] if browser.contexts else await browser.new_context()
        page = context.pages[0] if context.pages else await context.new_page()

        # 3. 创建并运行 Agent
        agent = AIBrowserAgent(
            api_key=api_key,
            base_url=base_url,
            model=model,
        )

        # 第一阶段：导航到页面并提取密钥
        remaining_steps = max_steps
        navigate_first = True
        params = {}

        # 主循环：执行直到成功、失败或被中断
        # 注意：remaining_steps 由 max() 保证 >= MIN_REMAINING_STEPS，循环通过 return 退出
        while remaining_steps > 0:
            task_result = await agent.execute_task(
                page=page,
                goal=f"修改 Google 账号 {email} 的身份验证器并提取新密钥",
                start_url=AUTHENTICATOR_URL,
                account=account_info,
                params=params,
                task_type="modify_authenticator",
                max_steps=remaining_steps,
                navigate_first=navigate_first,
            )

            # 任务成功完成
            if task_result.success:
                print(f"\n✅ 身份验证器修改成功!")
                print(f"总步骤数: {task_result.total_steps}")

                # 如果有新密钥，保存到数据库和文件
                if new_secret and len(new_secret.strip()) > 0:
                    _save_new_secret(
                        email=email,
                        password=account_info.get("password", ""),
                        new_secret=new_secret,
                        browser_id=browser_id,
                        save_to_file=save_to_file,
                        output_file=output_file,
                    )
                    return True, f"身份验证器修改成功，新密钥已保存", new_secret

                # 任务成功但无密钥（异常情况）
                if not new_secret:
                    print("⚠️ 任务成功但未提取到密钥，可能是 AI 流程异常")
                return True, "身份验证器修改成功", new_secret

            # 检查是否提取到密钥
            if (
                task_result.state == AgentState.WAITING_INPUT
                and task_result.data.get("action_type") == "extract_secret"
            ):
                new_secret = task_result.data.get("extracted_secret", "")
                if new_secret:
                    print(f"🔑 提取到新密钥: {new_secret}")

                    # 清理密钥（移除空格）
                    clean_secret = new_secret.replace(" ", "").replace("-", "").upper()

                    # 生成 TOTP 验证码
                    try:
                        totp = pyotp.TOTP(clean_secret)
                        verification_code = totp.now()
                        print(f"🔐 生成 TOTP 验证码: {verification_code}")

                        # 将验证码添加到 params 供 AI 使用
                        params["new_secret_raw"] = new_secret  # 原始版本（供显示）
                        params["new_secret"] = clean_secret    # 清理版本（供使用）
                        params["verification_code"] = verification_code
                        params["new_totp_code"] = verification_code

                        # 创建 account_info 副本，避免修改原始字典
                        account_info = {**account_info, "secret": clean_secret}

                        # 更新剩余步骤数
                        remaining_steps = max(MIN_REMAINING_STEPS, max_steps - task_result.total_steps)

                        # 下次不需要导航
                        navigate_first = False

                        print(f"🔄 继续执行任务（剩余步骤: {remaining_steps}）...")
                        continue

                    except Exception as e:
                        print(f"❌ 生成 TOTP 验证码失败: {e}")
                        return False, f"生成 TOTP 验证码失败: {e}", None  # 密钥格式无效，不返回

            # 任务失败
            print(f"\n❌ 身份验证器修改失败")
            print(f"原因: {task_result.message}")
            if task_result.error_details:
                print(f"详情: {task_result.error_details[:500]}")

            return False, task_result.message, None  # 失败时不返回未确认的密钥

        # 超过最大步骤数
        return False, f"达到最大步骤数限制 ({max_steps})", None  # 未确认的密钥不返回

    except Exception as e:
        traceback.print_exc()
        return False, f"运行失败: {str(e)}", None  # 异常时不返回未确认的密钥

    finally:
        # 清理资源
        if close_after:
            try:
                if browser:
                    await browser.close()
            except Exception:
                pass

            try:
                if playwright:
                    await playwright.stop()
            except Exception:
                pass

            try:
                closeBrowser(browser_id)
                print("浏览器已关闭")
            except Exception:
                pass


def _save_new_secret(
    email: str,
    password: str,
    new_secret: str,
    browser_id: str = None,
    save_to_file: bool = True,
    output_file: str = "已修改密钥.txt",
) -> bool:
    """
    保存新密钥到数据库、文件和 ixBrowser 窗口备注

    Args:
        email: 邮箱
        password: 密码
        new_secret: 新密钥
        browser_id: ixBrowser 窗口 ID（用于更新备注）
        save_to_file: 是否保存到文件
        output_file: 输出文件名

    Returns:
        bool: 数据库是否保存成功
    """
    # 清理密钥（移除空格）
    clean_secret = new_secret.replace(" ", "").replace("-", "").upper()
    db_success = False

    # 1. 更新数据库（最重要，优先执行）
    try:
        DBManager.upsert_account(
            email=email,
            password=password,
            secret_key=clean_secret,
        )
        print(f"✅ 数据库已更新: {email} -> {clean_secret[:8]}...")
        db_success = True

        # 记录修改历史（用于显示修改时间和筛选）
        try:
            DBManager.add_authenticator_modification(email, clean_secret)
        except Exception as history_err:
            print(f"⚠️ 记录修改历史失败（不影响主功能）: {history_err}")
    except Exception as e:
        print(f"❌ 更新数据库失败: {e}")
        import traceback
        traceback.print_exc()

    # 2. 保存到文件（仅在数据库保存成功后才保存，保持一致性）
    if save_to_file:
        if db_success:
            try:
                # 格式: 邮箱----密码----新密钥
                line = f"{email}----{password}----{clean_secret}\n"
                with open(output_file, "a", encoding="utf-8") as f:
                    f.write(line)
                print(f"✅ 已保存到文件: {output_file}")
            except Exception as e:
                print(f"❌ 保存到文件失败: {e}")
        else:
            print(f"⚠️ 数据库保存失败，跳过文件保存以保持一致性")

    # 3. 更新 ixBrowser 窗口备注
    if browser_id:
        # 检查 browser_id 是否是有效的数字字符串
        if not str(browser_id).isdigit():
            print(f"⚠️ browser_id 格式无效，跳过窗口备注更新: {browser_id}")
        else:
            try:
                from ix_api import update_profile, get_profile_info

                # 获取当前窗口信息
                profile = get_profile_info(int(browser_id))
                if profile:
                    current_note = profile.get("note", "") or ""

                    # 解析备注格式：邮箱----密码----辅助邮箱----2FA密钥
                    parts = current_note.split("----")
                    if len(parts) >= 4:
                        # 更新第4段（2FA密钥）
                        parts[3] = clean_secret
                        new_note = "----".join(parts)
                    elif len(parts) == 3:
                        # 只有3段，添加2FA密钥
                        new_note = f"{current_note}----{clean_secret}"
                    elif len(parts) == 2:
                        # 只有2段（邮箱----密码），添加空辅助邮箱和2FA密钥
                        new_note = f"{current_note}--------{clean_secret}"
                    else:
                        # 备注格式不标准，重新构建完整4段格式
                        new_note = f"{email}----{password}--------{clean_secret}"

                    # 更新窗口备注和 tfa_secret 字段
                    success = update_profile(
                        int(browser_id),
                        note=new_note,
                        tfa_secret=clean_secret
                    )
                    if success:
                        print(f"✅ ixBrowser 窗口备注已更新: {browser_id}")
                    else:
                        print(f"❌ ixBrowser 窗口备注更新失败: {browser_id}")
                else:
                    print(f"⚠️ 未找到 ixBrowser 窗口: {browser_id}")
            except Exception as e:
                print(f"❌ 更新 ixBrowser 窗口备注失败: {e}")

    return db_success


# 测试入口
if __name__ == "__main__":
    async def test():
        # 测试用参数
        test_browser_id = "test_id"
        test_account = {
            "email": "test@gmail.com",
            "password": "test_password",
            "secret": "test_secret",
        }

        success, msg, new_secret = await auto_modify_authenticator(
            test_browser_id,
            test_account,
            close_after=False,
        )
        print(f"\nResult: {success}, {msg}")
        if new_secret:
            print(f"New Secret: {new_secret}")

    asyncio.run(test())
