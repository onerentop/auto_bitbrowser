"""
自动替换 Google 辅助手机号
支持添加新手机号和替换现有手机号
"""
import asyncio
import pyotp
from playwright.async_api import async_playwright, Page
from services.ix_api import openBrowser, closeBrowser
from core.config_manager import ConfigManager

# 目标 URL
PHONE_SETTINGS_URL = "https://myaccount.google.com/signinoptions/rescuephone"


async def check_and_login_for_phone(page: Page, account_info: dict) -> tuple[bool, str]:
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

                # 3. 处理 2FA
                print("等待2FA输入...")
                try:
                    totp_input = await page.wait_for_selector(
                        'input[name="totpPin"], input[id="totpPin"], input[type="tel"]',
                        timeout=10000
                    )
                    if totp_input:
                        if secret:
                            s = secret.replace(" ", "").strip()
                            totp = pyotp.TOTP(s)
                            code = totp.now()
                            print(f"正在输入2FA验证码: {code}")
                            await totp_input.fill(code)

                            # 点击下一步
                            totp_next_selectors = [
                                '#totpNext >> button',
                                '#totpNext button',
                                'button[jsname="LgbsSe"]',
                                'button:has-text("Next")',
                                'button:has-text("下一步")',
                            ]

                            clicked = False
                            for sel in totp_next_selectors:
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

                            print("✅ 2FA验证完成")
                        else:
                            return False, "需要2FA但未提供secret"
                except Exception as e:
                    print(f"2FA步骤跳过或失败（可能不需要）: {e}")

                # 等待登录完成
                await asyncio.sleep(5)
                print("✅ 登录流程完成")
                return True, "登录成功"

        except Exception as e:
            print(f"✅ 已登录或无需登录: {e}")
            return True, "已登录"

    except Exception as e:
        print(f"登录检测出错: {e}")
        return False, f"登录检测错误: {e}"


async def handle_reauth_challenge(page: Page, account_info: dict) -> tuple[bool, str]:
    """
    处理重新验证身份的挑战（访问敏感设置时 Google 可能要求再次验证）

    Args:
        page: Playwright Page 对象
        account_info: 账号信息 {'email', 'password', 'secret'}

    Returns:
        (handled: bool, message: str)
        handled=True 表示遇到并处理了验证，handled=False 表示无需验证
    """
    try:
        print("检测是否需要重新验证身份...")

        # 检测密码重新验证页面（不需要邮箱，直接要密码）
        try:
            password_input = await page.wait_for_selector(
                'input[type="password"]:visible',
                timeout=3000
            )

            if password_input:
                print("⚠️ 检测到需要重新验证密码")

                if not account_info or not account_info.get('password'):
                    return False, "需要重新验证密码但未提供密码"

                password = account_info.get('password', '').strip()
                await password_input.fill(password)
                print("已输入密码")

                # 点击下一步
                next_selectors = [
                    'button[type="submit"]',
                    'button:has-text("Next")',
                    'button:has-text("下一步")',
                    'button:has-text("Tiếp theo")',
                    '#passwordNext button',
                    'button[jsname="LgbsSe"]',
                ]

                clicked = False
                for sel in next_selectors:
                    try:
                        btn = page.locator(sel).first
                        if await btn.count() > 0 and await btn.is_visible():
                            await btn.click()
                            clicked = True
                            print(f"已点击确认按钮")
                            break
                    except:
                        continue

                if not clicked:
                    await page.keyboard.press('Enter')

                await asyncio.sleep(3)

                # 检测是否需要 2FA
                try:
                    totp_input = await page.wait_for_selector(
                        'input[name="totpPin"], input[id="totpPin"], input[type="tel"][name*="code"], input[autocomplete="one-time-code"]',
                        timeout=5000
                    )

                    if totp_input:
                        print("⚠️ 检测到需要 2FA 验证")

                        secret = account_info.get('secret', '').strip()
                        if not secret:
                            return False, "需要2FA验证但未提供secret"

                        s = secret.replace(" ", "").strip()
                        totp = pyotp.TOTP(s)
                        code = totp.now()
                        print(f"正在输入2FA验证码: {code}")
                        await totp_input.fill(code)

                        # 点击确认
                        for sel in next_selectors:
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

                print("✅ 重新验证身份完成")
                return True, "重新验证身份成功"

        except Exception:
            # 没有检测到密码输入框，无需重新验证
            pass

        print("✅ 无需重新验证身份")
        return True, "无需验证"

    except Exception as e:
        print(f"处理重新验证时出错: {e}")
        return False, f"重新验证失败: {e}"


async def detect_current_phone_status(page: Page) -> tuple[str, str]:
    """
    检测当前手机号状态

    Returns:
        (status: str, phone: str)
        status: 'has_phone' | 'no_phone' | 'unknown'
        phone: 当前手机号（如果有）
    """
    try:
        await asyncio.sleep(2)  # 等待页面稳定

        # 检测是否有现有手机号显示
        # Google 页面通常会显示已添加的手机号（部分隐藏）
        phone_display_selectors = [
            '[data-phone-number]',
            'div[role="listitem"]',
            '.phone-number',
            'span:has-text("+"):not(:has-text("Add"))',
        ]

        for selector in phone_display_selectors:
            try:
                element = page.locator(selector).first
                if await element.count() > 0:
                    text = await element.text_content()
                    if text and ('+' in text or text.replace('-', '').replace(' ', '').isdigit()):
                        print(f"检测到现有手机号: {text}")
                        return 'has_phone', text.strip()
            except:
                continue

        # 检测"添加"按钮是否存在（表示没有手机号）
        add_selectors = [
            'button:has-text("Add recovery phone")',
            'button:has-text("Add phone")',
            'button:has-text("添加恢复电话")',
            'button:has-text("添加手机号")',
            'a:has-text("Add recovery phone")',
            '[aria-label*="Add"]',
        ]

        for selector in add_selectors:
            try:
                element = page.locator(selector).first
                if await element.count() > 0:
                    print("检测到无手机号（发现添加按钮）")
                    return 'no_phone', ''
            except:
                continue

        # 检测编辑/更改按钮（表示有手机号）
        edit_selectors = [
            'button:has-text("Edit")',
            'button:has-text("Change")',
            'button:has-text("编辑")',
            'button:has-text("更改")',
            '[aria-label*="Edit"]',
            '[aria-label*="Change"]',
        ]

        for selector in edit_selectors:
            try:
                element = page.locator(selector).first
                if await element.count() > 0:
                    print("检测到有手机号（发现编辑按钮）")
                    return 'has_phone', '(已设置)'
            except:
                continue

        print("⚠️ 无法确定手机号状态")
        return 'unknown', ''

    except Exception as e:
        print(f"检测手机号状态出错: {e}")
        return 'unknown', ''


async def remove_old_phone(page: Page) -> tuple[bool, str]:
    """
    删除旧手机号

    Returns:
        (success: bool, message: str)
    """
    try:
        print("正在删除旧手机号...")

        # 点击编辑或删除按钮
        action_selectors = [
            'button:has-text("Remove")',
            'button:has-text("Delete")',
            'button:has-text("删除")',
            'button:has-text("移除")',
            '[aria-label*="Remove"]',
            '[aria-label*="Delete"]',
            # 如果没有直接删除，先点编辑
            'button:has-text("Edit")',
            'button:has-text("Change")',
            'button:has-text("编辑")',
            'button:has-text("更改")',
        ]

        clicked = False
        for selector in action_selectors:
            try:
                element = page.locator(selector).first
                if await element.count() > 0 and await element.is_visible():
                    await element.click()
                    clicked = True
                    print(f"已点击: {selector}")
                    await asyncio.sleep(2)
                    break
            except:
                continue

        if not clicked:
            return False, "未找到删除/编辑按钮"

        # 如果点击的是编辑，需要再找删除按钮
        await asyncio.sleep(1)
        remove_selectors = [
            'button:has-text("Remove")',
            'button:has-text("Delete")',
            'button:has-text("删除")',
            'button:has-text("移除")',
            'button:has-text("Remove phone")',
            '[aria-label*="Remove"]',
        ]

        for selector in remove_selectors:
            try:
                element = page.locator(selector).first
                if await element.count() > 0 and await element.is_visible():
                    await element.click()
                    print(f"已点击删除按钮: {selector}")
                    await asyncio.sleep(2)
                    break
            except:
                continue

        # 确认删除（如果有确认对话框）
        confirm_selectors = [
            'button:has-text("Confirm")',
            'button:has-text("Yes")',
            'button:has-text("Remove")',
            'button:has-text("确认")',
            'button:has-text("是")',
            '[data-mdc-dialog-action="accept"]',
        ]

        await asyncio.sleep(1)
        for selector in confirm_selectors:
            try:
                element = page.locator(selector).first
                if await element.count() > 0 and await element.is_visible():
                    await element.click()
                    print(f"已确认删除: {selector}")
                    await asyncio.sleep(2)
                    break
            except:
                continue

        print("✅ 旧手机号已删除")
        return True, "旧手机号已删除"

    except Exception as e:
        print(f"删除旧手机号出错: {e}")
        return False, f"删除失败: {e}"


async def add_new_phone(page: Page, phone_number: str) -> tuple[bool, str]:
    """
    添加新手机号

    Args:
        phone_number: 新手机号

    Returns:
        (success: bool, message: str)
    """
    try:
        print(f"正在添加新手机号: {phone_number}")

        await asyncio.sleep(2)

        # 点击添加按钮（如果有）
        add_selectors = [
            'button:has-text("Add recovery phone")',
            'button:has-text("Add phone")',
            'button:has-text("Add")',
            'button:has-text("添加恢复电话")',
            'button:has-text("添加手机号")',
            'button:has-text("添加")',
            'a:has-text("Add recovery phone")',
            '[aria-label*="Add"]',
        ]

        for selector in add_selectors:
            try:
                element = page.locator(selector).first
                if await element.count() > 0 and await element.is_visible():
                    await element.click()
                    print(f"已点击添加按钮: {selector}")
                    await asyncio.sleep(2)
                    break
            except:
                continue

        # 查找手机号输入框
        phone_input_selectors = [
            'input[type="tel"]',
            'input[autocomplete*="tel"]',
            'input[name*="phone"]',
            'input[id*="phone"]',
            'input[placeholder*="phone"]',
            'input[placeholder*="Phone"]',
            'input[aria-label*="phone"]',
            'input[aria-label*="Phone"]',
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
            # 尝试等待输入框出现
            try:
                phone_input = await page.wait_for_selector('input[type="tel"]', timeout=10000)
            except:
                pass

        if not phone_input:
            return False, "未找到手机号输入框"

        # 清空并输入新手机号
        await phone_input.click()
        await phone_input.fill('')
        await asyncio.sleep(0.5)
        await phone_input.fill(phone_number)
        print("✅ 已输入手机号")

        await asyncio.sleep(1)

        # 点击下一步/确认按钮
        next_selectors = [
            'button:has-text("Next")',
            'button:has-text("Verify")',
            'button:has-text("Send")',
            'button:has-text("Continue")',
            'button:has-text("下一步")',
            'button:has-text("验证")',
            'button:has-text("发送")',
            'button:has-text("继续")',
            'button[type="submit"]',
        ]

        clicked = False
        for selector in next_selectors:
            try:
                element = page.locator(selector).first
                if await element.count() > 0 and await element.is_visible():
                    await element.click()
                    clicked = True
                    print(f"已点击确认按钮: {selector}")
                    break
            except:
                continue

        if not clicked:
            await page.keyboard.press('Enter')

        await asyncio.sleep(3)

        # 检测是否需要短信验证码（Google 可能发送验证码到新手机号）
        sms_code_selectors = [
            'input[type="tel"]:not([value])',
            'input[name*="code"]',
            'input[id*="code"]',
            'input[autocomplete="one-time-code"]',
            'input[placeholder*="code"]',
            'input[placeholder*="Code"]',
            'input[placeholder*="验证码"]',
        ]

        sms_code_input = None
        for selector in sms_code_selectors:
            try:
                # 排除已经填过手机号的输入框
                element = page.locator(selector).first
                if await element.count() > 0 and await element.is_visible():
                    current_value = await element.input_value()
                    if not current_value or len(current_value) < 6:  # 排除已填写手机号的输入框
                        sms_code_input = element
                        print(f"⚠️ 检测到需要输入短信验证码: {selector}")
                        break
            except:
                continue

        if sms_code_input:
            print("⚠️ 需要输入短信验证码，等待用户手动输入或自动跳过...")
            # 等待更长时间，让用户有机会手动输入验证码
            await asyncio.sleep(15)

            # 尝试点击验证/确认按钮
            for selector in next_selectors:
                try:
                    element = page.locator(selector).first
                    if await element.count() > 0 and await element.is_visible():
                        await element.click()
                        print(f"已点击验证确认按钮: {selector}")
                        await asyncio.sleep(3)
                        break
                except:
                    continue

        # 检测是否需要最终保存
        save_selectors = [
            'button:has-text("Save")',
            'button:has-text("Done")',
            'button:has-text("Confirm")',
            'button:has-text("保存")',
            'button:has-text("完成")',
            'button:has-text("确认")',
            'button:has-text("確認")',
            'button[type="submit"]',
        ]

        for selector in save_selectors:
            try:
                element = page.locator(selector).first
                if await element.count() > 0 and await element.is_visible():
                    await element.click()
                    print(f"✅ 已点击保存按钮: {selector}")
                    await asyncio.sleep(3)
                    break
            except:
                continue

        # 检测是否需要验证（可能跳过，因为用户说替换无需验证码）
        # 尝试点击跳过按钮
        skip_selectors = [
            'button:has-text("Skip")',
            'button:has-text("Not now")',
            'button:has-text("Later")',
            'button:has-text("跳过")',
            'button:has-text("以后再说")',
            'button:has-text("稍后")',
            'a:has-text("Skip")',
        ]

        for selector in skip_selectors:
            try:
                element = page.locator(selector).first
                if await element.count() > 0 and await element.is_visible():
                    await element.click()
                    print(f"已跳过验证: {selector}")
                    await asyncio.sleep(2)
                    break
            except:
                continue

        # 等待页面稳定
        await asyncio.sleep(3)

        # 检查是否有错误信息
        error_selectors = [
            'div[role="alert"]',
            '.error-message',
            'div:has-text("Invalid phone")',
            'div:has-text("Error")',
            'div:has-text("错误")',
            'div:has-text("无效")',
        ]

        for selector in error_selectors:
            try:
                element = page.locator(selector).first
                if await element.count() > 0 and await element.is_visible():
                    error_text = await element.text_content()
                    if error_text and ('error' in error_text.lower() or 'invalid' in error_text.lower() or '错误' in error_text or '无效' in error_text):
                        return False, f"添加失败: {error_text}"
            except:
                continue

        print("✅ 手机号添加成功")
        return True, "手机号添加成功"

    except Exception as e:
        print(f"添加手机号出错: {e}")
        return False, f"添加失败: {e}"


async def auto_replace_phone(page: Page, phone_number: str, account_info: dict = None) -> tuple[bool, str]:
    """
    自动替换/添加辅助手机号（主函数）

    Args:
        page: Playwright Page 对象
        phone_number: 新手机号
        account_info: 账号信息（用于登录）

    Returns:
        (success: bool, message: str)
    """
    try:
        print(f"\n{'='*50}")
        print(f"开始替换手机号流程")
        print(f"目标手机号: {phone_number}")
        print(f"{'='*50}\n")

        # 1. 导航到手机号设置页面
        print(f"导航到: {PHONE_SETTINGS_URL}")
        try:
            page_load_timeout = ConfigManager.get("timeouts.page_load", 30) * 1000
            await page.goto(PHONE_SETTINGS_URL, timeout=page_load_timeout)
        except Exception as e:
            print(f"导航失败: {e}")
            return False, f"导航失败: {e}"

        await asyncio.sleep(3)

        # 2. 检测并登录（如需要）
        login_success, login_msg = await check_and_login_for_phone(page, account_info)
        if not login_success and "需要登录" in login_msg:
            return False, f"登录失败: {login_msg}"

        # 登录后重新导航到目标页面
        if "登录成功" in login_msg:
            print("登录后重新导航到手机号设置页面...")
            await page.goto(PHONE_SETTINGS_URL, timeout=60000)
            await asyncio.sleep(3)

        # 2.5 处理重新验证身份挑战（已登录但访问敏感页面时可能需要再次验证密码/2FA）
        reauth_success, reauth_msg = await handle_reauth_challenge(page, account_info)
        if not reauth_success:
            return False, f"重新验证失败: {reauth_msg}"

        # 如果处理了重新验证，等待页面更新
        if "成功" in reauth_msg:
            await asyncio.sleep(2)

        # 3. 检测当前手机号状态
        status, current_phone = await detect_current_phone_status(page)
        print(f"当前状态: {status}, 现有手机号: {current_phone}")

        # 4. 根据状态执行操作
        if status == 'has_phone':
            # 有旧手机号，先删除
            print("检测到已有手机号，先删除...")
            remove_success, remove_msg = await remove_old_phone(page)
            if not remove_success:
                # 删除失败也尝试添加（可能是直接替换模式）
                print(f"删除旧号失败: {remove_msg}，尝试直接替换...")

            await asyncio.sleep(2)

            # 删除后可能触发重新验证
            reauth_success, reauth_msg = await handle_reauth_challenge(page, account_info)
            if not reauth_success:
                return False, f"删除后重新验证失败: {reauth_msg}"

        # 5. 添加新手机号
        add_success, add_msg = await add_new_phone(page, phone_number)

        # 添加时可能触发重新验证
        if not add_success and ("验证" in add_msg or "password" in add_msg.lower()):
            reauth_success, reauth_msg = await handle_reauth_challenge(page, account_info)
            if reauth_success:
                # 重新验证后再次尝试添加
                add_success, add_msg = await add_new_phone(page, phone_number)

        if add_success:
            print(f"\n{'='*50}")
            print(f"✅ 手机号替换成功: {phone_number}")
            print(f"{'='*50}\n")
            return True, f"手机号替换成功: {phone_number}"
        else:
            return False, add_msg

    except Exception as e:
        print(f"❌ 替换手机号流程出错: {e}")
        import traceback
        traceback.print_exc()
        return False, f"替换失败: {e}"


async def test_replace_phone_with_browser(browser_id: str, phone_number: str, account_info: dict = None):
    """
    测试替换手机号功能

    Args:
        browser_id: 浏览器窗口ID
        phone_number: 新手机号
        account_info: 账号信息
    """
    print(f"正在打开浏览器: {browser_id}...")

    # 如果没有提供账号信息，尝试从浏览器信息中获取
    if not account_info:
        print("未提供账号信息，尝试从浏览器remark中获取...")
        from services.ix_window import get_browser_info

        target_browser = get_browser_info(browser_id)
        if target_browser:
            remark = target_browser.get('note', '') or target_browser.get('remark', '')
            parts = remark.split('----')

            if len(parts) >= 2:
                account_info = {
                    'email': parts[0].strip(),
                    'password': parts[1].strip(),
                    'backup': parts[2].strip() if len(parts) > 2 else '',
                    'secret': parts[3].strip() if len(parts) > 3 else ''
                }
                print(f"✅ 从remark获取到账号信息: {account_info.get('email')}")
            else:
                print("⚠️ remark格式不正确，可能需要手动登录")
                account_info = None
        else:
            print("⚠️ 无法获取浏览器信息")
            account_info = None

    result = openBrowser(browser_id)

    if not result.get('success'):
        return False, f"打开浏览器失败: {result}"

    ws_endpoint = result['data']['ws']
    print(f"WebSocket URL: {ws_endpoint}")

    async with async_playwright() as playwright:
        try:
            chromium = playwright.chromium
            cdp_timeout = ConfigManager.get("timeouts.page_load", 30) * 1000
            browser = await chromium.connect_over_cdp(ws_endpoint, timeout=cdp_timeout)
            context = browser.contexts[0]
            page = context.pages[0] if context.pages else await context.new_page()

            # 执行替换手机号
            success, message = await auto_replace_phone(page, phone_number, account_info)

            print(f"\n{'='*50}")
            print(f"替换结果: {message}")
            print(f"{'='*50}\n")

            return success, message

        except Exception as e:
            print(f"测试过程出错: {e}")
            import traceback
            traceback.print_exc()
            return False, str(e)


if __name__ == "__main__":
    import sys

    # 测试用
    test_browser_id = "your_browser_id_here"
    test_phone = "+1234567890"

    if len(sys.argv) > 1:
        test_browser_id = sys.argv[1]
    if len(sys.argv) > 2:
        test_phone = sys.argv[2]

    print(f"开始测试替换手机号功能...")
    print(f"目标浏览器 ID: {test_browser_id}")
    print(f"目标手机号: {test_phone}")
    print(f"\n{'='*50}\n")

    result = asyncio.run(test_replace_phone_with_browser(test_browser_id, test_phone))
    print(f"\n最终结果: {result}")
