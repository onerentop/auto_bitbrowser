"""
自动修改 Google 2-Step Verification 手机号
支持删除旧手机号和添加新手机号
"""
import asyncio
import pyotp
from playwright.async_api import async_playwright, Page
from ix_api import openBrowser, closeBrowser

# 从 auto_replace_email 导入公共函数
from auto_replace_email import handle_reauth_challenge

# 目标 URL - 2-Step Verification 手机号设置页面
TWO_STEP_PHONE_URL = "https://myaccount.google.com/signinoptions/two-step-verification/phone-numbers"


async def check_and_login_for_2sv(page: Page, account_info: dict) -> tuple[bool, str]:
    """
    检测登录状态，必要时执行登录

    Args:
        page: Playwright Page 对象
        account_info: 账号信息 {'email', 'password', 'secret'}

    Returns:
        (success: bool, message: str)
    """
    try:
        print("\n检测登录状态...")

        # 首先检测是否有 "Sign in" 按钮（介绍页面的情况）
        sign_in_selectors = [
            'button:has-text("Sign in")',
            'a:has-text("Sign in")',
            'text="Sign in"',
            'button:has-text("登录")',
            'a:has-text("登录")',
        ]

        for selector in sign_in_selectors:
            try:
                btn = page.locator(selector).first
                if await btn.count() > 0 and await btn.is_visible():
                    print("❌ 检测到 Sign in 按钮，当前未登录")
                    await btn.click()
                    print("已点击 Sign in 按钮，等待登录页面加载...")
                    await asyncio.sleep(3)
                    break
            except:
                continue

        # 检测是否有登录输入框
        try:
            email_input = await page.wait_for_selector('input[type="email"]', timeout=5000)

            if email_input:
                print("❌ 未登录，开始登录流程...")

                if not account_info:
                    return False, "需要登录但未提供账号信息"

                email = account_info.get('email', '').strip()
                password = account_info.get('password', '').strip()
                secret = account_info.get('secret', '').strip()

                if not email or not password:
                    return False, "账号信息不完整（缺少邮箱或密码）"

                # 1. 输入邮箱
                print(f"正在输入账号: {email}")
                await email_input.fill(email)

                # 点击下一步
                next_selectors = [
                    '#identifierNext >> button',
                    '#identifierNext button',
                    'button[jsname="LgbsSe"]',
                    'button:has-text("Next")',
                    'button:has-text("下一步")',
                    'button:has-text("Tiếp theo")',
                ]

                clicked = False
                for sel in next_selectors:
                    try:
                        btn = page.locator(sel).first
                        if await btn.count() > 0 and await btn.is_visible():
                            await btn.click()
                            clicked = True
                            break
                    except:
                        continue

                if not clicked:
                    await page.keyboard.press('Enter')

                # 2. 输入密码
                print("等待密码输入框...")
                await page.wait_for_selector('input[type="password"]', state='visible', timeout=15000)
                print("正在输入密码...")
                await page.fill('input[type="password"]', password)

                # 点击下一步
                pwd_next_selectors = [
                    '#passwordNext >> button',
                    '#passwordNext button',
                    'button[jsname="LgbsSe"]',
                    'button:has-text("Next")',
                    'button:has-text("下一步")',
                ]

                clicked = False
                for sel in pwd_next_selectors:
                    try:
                        btn = page.locator(sel).first
                        if await btn.count() > 0 and await btn.is_visible():
                            await btn.click()
                            clicked = True
                            break
                    except:
                        continue

                if not clicked:
                    await page.keyboard.press('Enter')

                await asyncio.sleep(3)

                # 3. 检测是否需要 2FA
                try:
                    totp_input = await page.wait_for_selector(
                        'input[name="totpPin"], input[id="totpPin"], input[type="tel"]',
                        timeout=5000
                    )

                    if totp_input:
                        print("⚠️ 需要 2FA 验证")

                        if not secret:
                            return False, "需要2FA验证但未提供secret"

                        s = secret.replace(" ", "").strip()
                        totp = pyotp.TOTP(s)
                        code = totp.now()
                        print(f"正在输入2FA验证码: {code}")
                        await totp_input.fill(code)

                        # 点击确认
                        for sel in pwd_next_selectors:
                            try:
                                btn = page.locator(sel).first
                                if await btn.count() > 0 and await btn.is_visible():
                                    await btn.click()
                                    break
                            except:
                                continue

                        await asyncio.sleep(3)
                        print("✅ 2FA 验证完成")

                except Exception:
                    print("无需 2FA 或已跳过")

                print("✅ 登录成功")
                return True, "登录成功"

        except Exception:
            print("✅ 已登录")
            return True, "已登录"

    except Exception as e:
        return False, f"登录检测失败: {e}"

    return True, "登录状态正常"


async def detect_current_2sv_phone(page: Page) -> tuple[str, str]:
    """
    检测当前 2-Step Verification 手机号状态

    Returns:
        (status: str, phone: str)
        status: 'has_phone' | 'no_phone' | 'unknown'
        phone: 当前手机号（如果有）
    """
    try:
        await asyncio.sleep(2)

        # 检测是否有添加按钮（说明没有手机号）
        add_button_selectors = [
            'button:has-text("Add phone")',
            'button:has-text("添加电话")',
            'button:has-text("Add a phone")',
            '[aria-label*="Add"]',
        ]

        for selector in add_button_selectors:
            try:
                btn = page.locator(selector).first
                if await btn.count() > 0 and await btn.is_visible():
                    print("检测到没有 2SV 手机号（发现添加按钮）")
                    return 'no_phone', ''
            except:
                continue

        # 检测是否有编辑/删除按钮（说明有手机号）
        edit_selectors = [
            '[aria-label*="Edit"]',
            '[aria-label*="编辑"]',
            'button:has-text("Edit")',
            'button:has-text("Change")',
            '[aria-label*="Remove"]',
            '[aria-label*="Delete"]',
        ]

        for selector in edit_selectors:
            try:
                btn = page.locator(selector).first
                if await btn.count() > 0 and await btn.is_visible():
                    print("检测到有 2SV 手机号（发现编辑/删除按钮）")
                    return 'has_phone', '(已设置)'
            except:
                continue

        # 检测页面内容
        page_content = await page.content()
        if 'No phone' in page_content or '没有电话' in page_content:
            return 'no_phone', ''

        return 'unknown', ''

    except Exception as e:
        print(f"检测 2SV 手机号状态时出错: {e}")
        return 'unknown', ''


async def remove_2sv_phone(page: Page) -> tuple[bool, str]:
    """
    删除现有的 2-Step Verification 手机号

    Returns:
        (success: bool, message: str)
    """
    try:
        print("正在删除旧 2SV 手机号...")

        # 点击删除按钮
        remove_selectors = [
            '[aria-label*="Remove"]',
            '[aria-label*="Delete"]',
            '[aria-label*="删除"]',
            'button:has-text("Remove")',
            'button:has-text("Delete")',
            'button:has-text("删除")',
        ]

        clicked = False
        for selector in remove_selectors:
            try:
                btn = page.locator(selector).first
                if await btn.count() > 0 and await btn.is_visible():
                    await btn.click()
                    print(f"已点击: {selector}")
                    clicked = True
                    break
            except:
                continue

        if not clicked:
            return False, "未找到删除按钮"

        await asyncio.sleep(2)

        # 确认删除对话框
        confirm_selectors = [
            'button:has-text("Remove")',
            'button:has-text("Delete")',
            'button:has-text("确认")',
            'button:has-text("Confirm")',
            'button:has-text("Yes")',
        ]

        for selector in confirm_selectors:
            try:
                btn = page.locator(selector).last
                if await btn.count() > 0 and await btn.is_visible():
                    await btn.click()
                    print(f"已点击确认按钮: {selector}")
                    break
            except:
                continue

        await asyncio.sleep(2)
        print("✅ 旧 2SV 手机号已删除")
        return True, "删除成功"

    except Exception as e:
        print(f"删除 2SV 手机号时出错: {e}")
        return False, f"删除失败: {e}"


async def add_2sv_phone(page: Page, new_phone: str) -> tuple[bool, str]:
    """
    添加新的 2-Step Verification 手机号

    Args:
        page: Playwright Page 对象
        new_phone: 新手机号

    Returns:
        (success: bool, message: str)
    """
    try:
        print(f"正在添加新 2SV 手机号: {new_phone}")

        # 点击添加按钮
        add_selectors = [
            'button:has-text("Add phone")',
            'button:has-text("添加电话")',
            'button:has-text("Add a phone")',
            'button:has-text("Add")',
            '[aria-label*="Add"]',
        ]

        clicked = False
        for selector in add_selectors:
            try:
                btn = page.locator(selector).first
                if await btn.count() > 0 and await btn.is_visible():
                    await btn.click()
                    print(f"已点击添加按钮: {selector}")
                    clicked = True
                    break
            except:
                continue

        if not clicked:
            # 可能已经在编辑模式，尝试直接找输入框
            pass

        await asyncio.sleep(2)

        # 查找手机号输入框
        phone_input_selectors = [
            'input[type="tel"]',
            'input[name="phoneNumber"]',
            'input[aria-label*="phone"]',
            'input[aria-label*="Phone"]',
            'input[placeholder*="phone"]',
            'input[placeholder*="Phone"]',
        ]

        phone_input = None
        for selector in phone_input_selectors:
            try:
                element = page.locator(selector).first
                if await element.count() > 0 and await element.is_visible():
                    phone_input = element
                    print(f"找到手机号输入框: {selector}")
                    break
            except:
                continue

        if not phone_input:
            return False, "未找到手机号输入框"

        # 输入手机号
        await phone_input.fill(new_phone)
        print("✅ 已输入手机号")

        await asyncio.sleep(1)

        # 点击保存/下一步按钮
        save_selectors = [
            'button:has-text("Next")',
            'button:has-text("下一步")',
            'button:has-text("Save")',
            'button:has-text("保存")',
            'button:has-text("Verify")',
            'button:has-text("验证")',
            'button[type="submit"]',
        ]

        for selector in save_selectors:
            try:
                btn = page.locator(selector).first
                if await btn.count() > 0 and await btn.is_visible():
                    await btn.click()
                    print(f"已点击按钮: {selector}")
                    break
            except:
                continue

        await asyncio.sleep(3)
        print("✅ 新 2SV 手机号添加完成")
        return True, "添加成功"

    except Exception as e:
        print(f"添加 2SV 手机号时出错: {e}")
        return False, f"添加失败: {e}"


async def auto_modify_2sv_phone(
    browser_id: str,
    account_info: dict,
    new_phone: str,
    close_after: bool = True,
) -> tuple[bool, str]:
    """
    自动修改 2-Step Verification 手机号的主函数

    Args:
        browser_id: ixBrowser 窗口 ID
        account_info: 账号信息 {'email', 'password', 'secret'}
        new_phone: 新手机号
        close_after: 完成后是否关闭浏览器

    Returns:
        (success: bool, message: str)
    """
    browser = None
    playwright = None

    try:
        # 1. 打开浏览器
        print(f"\n{'='*50}")
        print(f"开始修改 2SV 手机号: {account_info.get('email', 'Unknown')}")
        print(f"新手机号: {new_phone}")
        print(f"{'='*50}")

        result = openBrowser(browser_id)
        if not result or 'data' not in result:
            return False, "无法打开浏览器"

        ws_endpoint = result['data'].get('ws', '')
        if not ws_endpoint:
            return False, "获取 WebSocket endpoint 失败"

        print(f"浏览器已打开，正在连接...")

        # 2. 连接浏览器
        playwright = await async_playwright().start()
        browser = await playwright.chromium.connect_over_cdp(ws_endpoint)
        context = browser.contexts[0] if browser.contexts else await browser.new_context()
        page = context.pages[0] if context.pages else await context.new_page()

        # 3. 导航到 2SV 手机号设置页面
        print(f"导航到 2SV 设置页面...")
        await page.goto(TWO_STEP_PHONE_URL, wait_until='domcontentloaded', timeout=30000)
        await asyncio.sleep(3)

        # 4. 检测并处理登录
        login_success, login_msg = await check_and_login_for_2sv(page, account_info)
        if not login_success:
            return False, login_msg

        # 如果进行了登录，需要重新导航
        if "登录成功" in login_msg:
            print("重新导航到 2SV 设置页面...")
            await page.goto(TWO_STEP_PHONE_URL, wait_until='domcontentloaded', timeout=30000)
            await asyncio.sleep(3)

        # 5. 处理重新验证
        reauth_success, reauth_msg = await handle_reauth_challenge(page, account_info)
        if not reauth_success:
            return False, reauth_msg

        await asyncio.sleep(2)

        # 6. 检测当前 2SV 手机号状态
        status, current_phone = await detect_current_2sv_phone(page)
        print(f"当前状态: {status}, 现有手机号: {current_phone}")

        # 7. 如果有现有手机号，先删除
        if status == 'has_phone':
            print("检测到已有 2SV 手机号，先删除...")
            remove_success, remove_msg = await remove_2sv_phone(page)
            if not remove_success:
                print(f"⚠️ 删除失败: {remove_msg}，尝试继续添加...")

            # 处理可能的重新验证
            await handle_reauth_challenge(page, account_info)
            await asyncio.sleep(2)

        # 8. 添加新手机号
        add_success, add_msg = await add_2sv_phone(page, new_phone)
        if not add_success:
            return False, add_msg

        print(f"\n✅ 2SV 手机号修改成功!")
        return True, "修改成功"

    except Exception as e:
        print(f"❌ 修改 2SV 手机号时出错: {e}")
        import traceback
        traceback.print_exc()
        return False, f"修改失败: {e}"

    finally:
        if close_after:
            try:
                if browser:
                    await browser.close()
            except:
                pass
            try:
                if playwright:
                    await playwright.stop()
            except:
                pass
            try:
                closeBrowser(browser_id)
                print("浏览器已关闭")
            except:
                pass


# 测试入口
if __name__ == "__main__":
    import sys

    async def test():
        # 测试用
        test_browser_id = "test_id"
        test_account = {
            'email': 'test@gmail.com',
            'password': 'test_password',
            'secret': 'test_secret',
        }
        test_phone = "+1234567890"

        success, msg = await auto_modify_2sv_phone(
            test_browser_id,
            test_account,
            test_phone,
            close_after=True
        )
        print(f"Result: {success}, {msg}")

    asyncio.run(test())
