"""
自动修改 Google 身份验证器 (Authenticator App) - StagehandGoogleEngine 版

使用 StagehandGoogleEngine 自动完成操作
支持提取新密钥、生成 TOTP 验证码并保存到数据库
"""

import asyncio
import os
import sys
import traceback
from typing import Optional, Tuple

from core.stagehand_engine import StagehandGoogleEngine
from services.database import DBManager


def _get_project_root():
    """获取项目根目录"""
    if getattr(sys, 'frozen', False):
        return os.path.dirname(sys.executable)
    return os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


async def auto_modify_authenticator(
    browser_id: str,
    account_info: dict,
    close_after: bool = False,
    max_steps: int = 30,
    api_key: Optional[str] = None,
    base_url: Optional[str] = None,
    model: Optional[str] = None,
    provider: Optional[str] = None,
    save_to_file: bool = True,
    output_file: str = "已修改密钥.txt",
) -> Tuple[bool, str, Optional[str]]:
    """
    修改 Google 身份验证器并提取新密钥

    Args:
        browser_id: ixBrowser 窗口 ID
        account_info: 账号信息 {'email', 'password', 'secret'}
        close_after: 完成后是否关闭浏览器
        max_steps: 最大执行步骤数（保留兼容）
        api_key: API Key（可选，默认从配置读取）
        base_url: API Base URL（可选）
        model: 使用的模型（可选）
        provider: LLM 提供商（已废弃）
        save_to_file: 是否保存到文件
        output_file: 输出文件名

    Returns:
        (success: bool, message: str, new_secret: Optional[str])
    """
    email = account_info.get("email", "Unknown")
    print(f"\n{'='*50}")
    print(f"修改身份验证器 (StagehandGoogleEngine)")
    print(f"账号: {email}")
    print(f"{'='*50}")

    engine = None

    try:
        # 构建模型名称
        model_name = None
        if model:
            if provider:
                provider_map = {"gemini": "google", "anthropic": "anthropic"}
                stagehand_provider = provider_map.get(provider, provider)
                model_name = f"{stagehand_provider}/{model}"
            else:
                model_name = model

        # 1. 连接到 ixBrowser 窗口
        print(f"连接 ixBrowser 窗口: {browser_id}")
        engine = await StagehandGoogleEngine.connect_to_ixbrowser(
            browser_id=browser_id,
            model_name=model_name,
            model_api_key=api_key,
            close_browser_on_exit=close_after,
        )

        # 2. 执行修改 Authenticator 操作
        print("执行修改 Authenticator 操作...")
        result = await engine.modify_authenticator()

        # 3. 处理结果
        if result.success:
            new_secret = result.new_secret
            print(f"\n✅ 身份验证器修改成功!")
            print(f"耗时: {result.duration_ms:.0f}ms")

            if new_secret and len(new_secret.strip()) > 0:
                print(f"🔑 提取到新密钥: {new_secret[:8]}...")

                # 保存到数据库和文件
                _save_new_secret(
                    email=email,
                    password=account_info.get("password", ""),
                    new_secret=new_secret,
                    browser_id=browser_id,
                    save_to_file=save_to_file,
                    output_file=output_file,
                )
                return True, "身份验证器修改成功，新密钥已保存", new_secret

            return True, "身份验证器修改成功", new_secret

        # 任务失败
        print(f"\n❌ 身份验证器修改失败")
        print(f"原因: {result.message}")
        if result.error:
            print(f"详情: {result.error[:500]}")

        return False, result.message, None

    except Exception as e:
        traceback.print_exc()
        return False, f"运行失败: {str(e)}", None

    finally:
        # 清理资源
        if engine:
            try:
                await engine.stop(close_browser=close_after)
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

        # 记录修改历史
        try:
            DBManager.add_authenticator_modification(email, clean_secret)
        except Exception as history_err:
            print(f"⚠️ 记录修改历史失败（不影响主功能）: {history_err}")
    except Exception as e:
        print(f"❌ 更新数据库失败: {e}")
        traceback.print_exc()

    # 2. 保存到文件（仅在数据库保存成功后）
    if save_to_file and db_success:
        try:
            full_output_path = os.path.join(_get_project_root(), output_file)
            line = f"{email}----{password}----{clean_secret}\n"
            with open(full_output_path, "a", encoding="utf-8") as f:
                f.write(line)
            print(f"✅ 已保存到文件: {full_output_path}")
        except Exception as e:
            print(f"❌ 保存到文件失败: {e}")

    # 3. 更新 ixBrowser 窗口备注
    if browser_id and str(browser_id).isdigit():
        try:
            from services.ix_api import update_profile, get_profile_info

            profile = get_profile_info(int(browser_id))
            if profile:
                current_note = profile.get("note", "") or ""
                parts = current_note.split("----")

                if len(parts) >= 4:
                    parts[3] = clean_secret
                    new_note = "----".join(parts)
                elif len(parts) == 3:
                    new_note = f"{current_note}----{clean_secret}"
                elif len(parts) == 2:
                    new_note = f"{current_note}--------{clean_secret}"
                else:
                    new_note = f"{email}----{password}--------{clean_secret}"

                success = update_profile(
                    int(browser_id),
                    note=new_note,
                    tfa_secret=clean_secret
                )
                if success:
                    print(f"✅ ixBrowser 窗口备注已更新: {browser_id}")
                else:
                    print(f"❌ ixBrowser 窗口备注更新失败: {browser_id}")
        except Exception as e:
            print(f"❌ 更新 ixBrowser 窗口备注失败: {e}")

    return db_success


# 测试入口
if __name__ == "__main__":
    async def test():
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
