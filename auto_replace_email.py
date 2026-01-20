"""
自动替换 Google 辅助邮箱
支持添加新辅助邮箱和替换现有辅助邮箱，自动读取验证码完成验证
"""
import asyncio
import pyotp
from playwright.async_api import async_playwright, Page
from ix_api import openBrowser, closeBrowser
from core.config_manager import ConfigManager
from email_code_reader import GmailCodeReader

# 目标 URL
RECOVERY_EMAIL_URL = "https://myaccount.google.com/signinoptions/rescueemail"


async def check_and_login_for_email(page: Page, account_info: dict) -> tuple[bool, str]:
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
    """
    try:
        print("检测是否需要重新验证身份...")

        # 首先检测是否是 2FA 验证页面（"Verify it's you" 页面）
        # 这种情况下只有 2FA 输入框，没有密码输入框
        try:
            # 检测页面标题或 2FA 输入框
            totp_selectors = [
                'input[type="tel"]',
                'input[name="totpPin"]',
                'input[id="totpPin"]',
                'input[autocomplete="one-time-code"]',
                'input[placeholder*="code"]',
                'input[placeholder*="Enter code"]',
            ]

            totp_input = None
            for selector in totp_selectors:
                try:
                    element = page.locator(selector).first
                    if await element.count() > 0 and await element.is_visible():
                        totp_input = element
                        break
                except:
                    continue

            if totp_input:
                # 检查是否是 2FA 验证页面（不是验证码输入页面）
                page_text = await page.content()
                if 'Verify it' in page_text or 'Authenticator' in page_text or '验证您的身份' in page_text:
                    print("⚠️ 检测到需要 2FA 验证（Verify it's you 页面）")

                    secret = account_info.get('secret', '').strip()
                    if not secret:
                        return False, "需要2FA验证但未提供secret"

                    s = secret.replace(" ", "").strip()
                    totp = pyotp.TOTP(s)
                    code = totp.now()
                    print(f"正在输入2FA验证码: {code}")
                    await totp_input.fill(code)

                    # 点击 Next 按钮
                    next_selectors = [
                        'button:has-text("Next")',
                        'button:has-text("下一步")',
                        'button[type="submit"]',
                        '#totpNext button',
                    ]

                    for sel in next_selectors:
                        try:
                            btn = page.locator(sel).first
                            if await btn.count() > 0 and await btn.is_visible():
                                await btn.click()
                                print("已点击 Next 按钮")
                                break
                        except:
                            continue

                    await asyncio.sleep(3)
                    print("✅ 2FA 验证完成")
                    return True, "2FA验证成功"

        except Exception as e:
            pass

        # 检测密码重新验证页面
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
                            print("已点击确认按钮")
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
            pass

        print("✅ 无需重新验证身份")
        return True, "无需验证"

    except Exception as e:
        print(f"处理重新验证时出错: {e}")
        return False, f"重新验证失败: {e}"


async def detect_current_email_status(page: Page) -> tuple[str, str]:
    """
    检测当前辅助邮箱状态

    Returns:
        (status: str, email: str)
        status: 'has_email' | 'no_email' | 'unknown'
        email: 当前辅助邮箱（如果有）
    """
    try:
        await asyncio.sleep(2)

        # 检测是否有现有辅助邮箱显示
        email_display_selectors = [
            '[data-email]',
            'div[role="listitem"]',
            '.recovery-email',
        ]

        for selector in email_display_selectors:
            try:
                element = page.locator(selector).first
                if await element.count() > 0:
                    text = await element.text_content()
                    if text and '@' in text:
                        print(f"检测到现有辅助邮箱: {text}")
                        return 'has_email', text.strip()
            except:
                continue

        # 检测"添加"按钮是否存在（表示没有辅助邮箱）
        add_selectors = [
            'button:has-text("Add recovery email")',
            'button:has-text("Add email")',
            'button:has-text("添加辅助邮箱")',
            'button:has-text("添加电子邮件")',
            'a:has-text("Add recovery email")',
            '[aria-label*="Add"]',
        ]

        for selector in add_selectors:
            try:
                element = page.locator(selector).first
                if await element.count() > 0:
                    print("检测到无辅助邮箱（发现添加按钮）")
                    return 'no_email', ''
            except:
                continue

        # 检测编辑/更改按钮（表示有辅助邮箱）
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
                    print("检测到有辅助邮箱（发现编辑按钮）")
                    return 'has_email', '(已设置)'
            except:
                continue

        print("⚠️ 无法确定辅助邮箱状态")
        return 'unknown', ''

    except Exception as e:
        print(f"检测辅助邮箱状态出错: {e}")
        return 'unknown', ''


async def remove_old_email(page: Page) -> tuple[bool, str]:
    """
    删除旧辅助邮箱

    Returns:
        (success: bool, message: str)
    """
    try:
        print("正在删除旧辅助邮箱...")

        # 点击编辑或删除按钮
        action_selectors = [
            'button:has-text("Remove")',
            'button:has-text("Delete")',
            'button:has-text("删除")',
            'button:has-text("移除")',
            '[aria-label*="Remove"]',
            '[aria-label*="Delete"]',
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
            'button:has-text("Remove email")',
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

        print("✅ 旧辅助邮箱已删除")
        return True, "旧辅助邮箱已删除"

    except Exception as e:
        print(f"删除旧辅助邮箱出错: {e}")
        return False, f"删除失败: {e}"


async def add_new_email(page: Page, new_email: str, code_reader: GmailCodeReader) -> tuple[bool, str]:
    """
    添加新辅助邮箱

    Args:
        page: Playwright Page 对象
        new_email: 新辅助邮箱地址
        code_reader: Gmail 验证码读取器

    Returns:
        (success: bool, message: str)
    """
    try:
        print(f"正在添加新辅助邮箱: {new_email}")

        await asyncio.sleep(2)

        # 点击添加按钮（如果有）
        add_selectors = [
            'button:has-text("Add recovery email")',
            'button:has-text("Add email")',
            'button:has-text("Add")',
            'button:has-text("添加辅助邮箱")',
            'button:has-text("添加电子邮件")',
            'button:has-text("添加")',
            'a:has-text("Add recovery email")',
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

        # 等待页面加载
        await asyncio.sleep(2)

        # 查找邮箱输入框 - 多次尝试
        email_input_selectors = [
            'input[type="email"]',
            'input[autocomplete*="email"]',
            'input[name*="email"]',
            'input[id*="email"]',
            'input[placeholder*="email"]',
            'input[placeholder*="Email"]',
            'input[placeholder*="recovery"]',
            'input[placeholder*="Recovery"]',
            'input[aria-label*="email"]',
            'input[aria-label*="Email"]',
            'input[aria-label*="recovery"]',
        ]

        email_input = None

        # 尝试多次查找（最多等待15秒）
        for attempt in range(5):
            for selector in email_input_selectors:
                try:
                    element = page.locator(selector).first
                    if await element.count() > 0 and await element.is_visible():
                        email_input = element
                        print(f"找到邮箱输入框: {selector}")
                        break
                except:
                    continue

            if email_input:
                break

            print(f"  等待邮箱输入框... ({attempt + 1}/5)")
            await asyncio.sleep(3)

        if not email_input:
            try:
                email_input = await page.wait_for_selector('input[type="email"]', timeout=10000)
                print("通过 wait_for_selector 找到邮箱输入框")
            except:
                pass

        if not email_input:
            # 调试：打印当前页面上所有可见 input
            try:
                all_inputs = page.locator('input:visible')
                count = await all_inputs.count()
                print(f"⚠️ 未找到邮箱输入框，页面上共有 {count} 个可见输入框:")
                for i in range(min(count, 5)):
                    inp = all_inputs.nth(i)
                    html = await inp.evaluate('el => el.outerHTML.substring(0, 100)')
                    print(f"  {i+1}: {html}")
            except:
                pass
            return False, "未找到邮箱输入框"

        # 清空并输入新邮箱
        await email_input.click()
        await email_input.fill('')
        await asyncio.sleep(0.5)
        await email_input.fill(new_email)
        print("✅ 已输入辅助邮箱")

        await asyncio.sleep(1)

        # 点击下一步/保存/验证按钮（Google 可能直接显示 Save 按钮）
        next_or_save_selectors = [
            'button:has-text("Next")',
            'button:has-text("Save")',
            'button:has-text("Verify")',
            'button:has-text("Send")',
            'button:has-text("Continue")',
            'button:has-text("下一步")',
            'button:has-text("保存")',
            'button:has-text("验证")',
            'button:has-text("发送")',
            'button:has-text("继续")',
            'button[type="submit"]',
        ]

        clicked = False
        for selector in next_or_save_selectors:
            try:
                element = page.locator(selector).first
                if await element.count() > 0 and await element.is_visible():
                    await element.click()
                    clicked = True
                    print(f"已点击按钮: {selector}")
                    break
            except:
                continue

        if not clicked:
            await page.keyboard.press('Enter')
            print("已按 Enter 键提交")

        await asyncio.sleep(3)

        # 检测是否需要输入验证码（可能在点击后才出现）
        # 策略1: 精确选择器 - 根据 Google 验证页面结构
        code_input_selectors = [
            # 最精确的匹配 - Google "Verification code" placeholder
            'input[placeholder="Verification code"]',
            'input[placeholder="验证码"]',
            'input[placeholder*="Verification"]',
            'input[placeholder*="verification"]',
            # 常规验证码选择器
            'input[type="tel"]',
            'input[type="number"]',
            'input[name*="code"]',
            'input[id*="code"]',
            'input[id*="otp"]',
            'input[name*="otp"]',
            'input[autocomplete="one-time-code"]',
            'input[placeholder*="code"]',
            'input[placeholder*="Code"]',
            'input[aria-label*="code"]',
            'input[aria-label*="Code"]',
            'input[aria-label*="verification"]',
            'input[aria-label*="Verification"]',
            'input[aria-label*="Enter"]',
            'input[data-action-name*="code"]',
            # Google Material Design 特定选择器
            'input[jsname]',
            'input.whsOnd',
            'input[dir="ltr"]',
            'input[data-initial-value]',
            'input[maxlength="6"]',  # 6位验证码
        ]

        # 等待验证码输入框出现（最多等待 20 秒）
        code_input = None
        print("开始检测验证码输入框...")

        for attempt in range(10):
            # 策略1: 尝试精确选择器
            for selector in code_input_selectors:
                try:
                    element = page.locator(selector).first
                    if await element.count() > 0 and await element.is_visible():
                        # 排除之前的邮箱输入框（检查是否已有值且包含@）
                        current_value = await element.input_value()
                        if '@' not in current_value:
                            code_input = element
                            print(f"检测到验证码输入框: {selector}")
                            break
                except:
                    continue

            if code_input:
                break

            # 策略2: 通用方法 - 查找所有可见的空输入框
            if attempt >= 3:
                try:
                    all_inputs = page.locator('input:visible')
                    count = await all_inputs.count()
                    print(f"  页面上共有 {count} 个可见输入框")

                    for i in range(count):
                        inp = all_inputs.nth(i)
                        try:
                            input_type = await inp.get_attribute('type') or ''
                            current_value = await inp.input_value()

                            # 排除邮箱输入框、隐藏类型、已填写的
                            if input_type in ('hidden', 'submit', 'button', 'checkbox', 'radio'):
                                continue
                            if '@' in current_value:  # 跳过邮箱输入框
                                continue
                            if current_value and len(current_value) > 10:  # 跳过已填写的长值
                                continue

                            # 找到可能的验证码输入框
                            if input_type in ('tel', 'number', 'text', ''):
                                code_input = inp
                                attrs = await inp.evaluate('el => el.outerHTML.substring(0, 200)')
                                print(f"  通过通用方法找到可能的验证码输入框: {attrs}")
                                break
                        except:
                            continue
                except Exception as e:
                    print(f"  通用查找失败: {e}")

            if code_input:
                break

            print(f"  等待验证码输入框... ({attempt + 1}/10)")
            await asyncio.sleep(2)

        if code_input:
            print("⚠️ 需要输入邮箱验证码，开始读取...")

            # 使用 code_reader 获取验证码（在线程池中执行阻塞操作）
            try:
                success, code = await asyncio.to_thread(
                    code_reader.fetch_verification_code,
                    timeout_seconds=90,
                    poll_interval=5
                )
            except Exception as e:
                print(f"❌ 读取验证码时发生异常: {e}")
                import traceback
                traceback.print_exc()
                return False, f"读取验证码异常: {e}"

            if not success:
                print(f"❌ 获取验证码失败: {code}")
                return False, f"获取验证码失败: {code}"

            print(f"✅ 获取到验证码: {code}")

            # 输入验证码
            await code_input.fill(code)
            print("已输入验证码")

            await asyncio.sleep(1)

            # 点击验证/确认按钮 - Google 对话框按钮可能是多种元素
            verify_selectors = [
                # Google 对话框按钮 - 可能是各种元素
                'text="Verify"',  # Playwright 文本选择器
                ':text("Verify")',
                'button >> text="Verify"',
                '*:has-text("Verify"):visible',
                # 标准按钮
                'button:has-text("Verify")',
                'button:text-is("Verify")',
                # 可能是 span/div/a 元素
                'span:text-is("Verify")',
                'a:text-is("Verify")',
                'div:text-is("Verify")',
                '[role="button"]:has-text("Verify")',
                # 其他语言
                'text="验证"',
                'text="確認"',
                'button:has-text("Next")',
                'button:has-text("Continue")',
                'button[type="submit"]',
            ]

            clicked_verify = False
            for selector in verify_selectors:
                try:
                    element = page.locator(selector).last  # 用 last 因为 Verify 在右边
                    if await element.count() > 0 and await element.is_visible():
                        await element.click()
                        print(f"✅ 已点击验证按钮: {selector}")
                        clicked_verify = True
                        break
                except Exception as e:
                    continue

            # 如果没点到按钮，尝试按 Tab+Enter
            if not clicked_verify:
                print("⚠️ 未找到验证按钮，尝试 Tab+Enter 提交...")
                await page.keyboard.press('Tab')
                await asyncio.sleep(0.3)
                await page.keyboard.press('Enter')

            await asyncio.sleep(3)

            # 验证码提交后，可能还需要点击最终保存按钮
            final_save_selectors = [
                'button:has-text("Save")',
                'button:has-text("Done")',
                'button:has-text("Confirm")',
                'button:has-text("保存")',
                'button:has-text("完成")',
                'button:has-text("确认")',
                'button:has-text("確認")',
            ]

            for selector in final_save_selectors:
                try:
                    element = page.locator(selector).first
                    if await element.count() > 0 and await element.is_visible():
                        await element.click()
                        print(f"✅ 已点击最终保存按钮: {selector}")
                        await asyncio.sleep(3)
                        break
                except:
                    continue
        else:
            # 未检测到验证码输入框 - 输出调试信息
            print("⚠️ 未检测到验证码输入框")

            # 打印页面上所有可见输入框的信息用于调试
            try:
                all_inputs = page.locator('input:visible')
                count = await all_inputs.count()
                print(f"  调试: 页面上共有 {count} 个可见输入框")

                for i in range(min(count, 10)):  # 最多显示10个
                    inp = all_inputs.nth(i)
                    try:
                        html = await inp.evaluate('el => el.outerHTML.substring(0, 150)')
                        print(f"    输入框 {i+1}: {html}")
                    except:
                        pass
            except Exception as e:
                print(f"  调试输出失败: {e}")

            # 检查当前 URL，判断是否仍在验证页面
            current_url = page.url
            print(f"  当前 URL: {current_url}")

            if 'verify' in current_url.lower() or 'challenge' in current_url.lower():
                return False, "检测到验证页面但未能找到验证码输入框，请手动完成验证"

            print("ℹ️ 可能不需要验证码，继续处理...")

        # 等待页面稳定
        await asyncio.sleep(3)

        # 检查是否有错误信息
        error_selectors = [
            'div[role="alert"]',
            '.error-message',
            'div:has-text("Invalid email")',
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

        print("✅ 辅助邮箱添加成功")
        return True, "辅助邮箱添加成功"

    except Exception as e:
        print(f"添加辅助邮箱出错: {e}")
        return False, f"添加失败: {e}"


async def auto_replace_email(page: Page, new_email: str, account_info: dict, code_reader: GmailCodeReader) -> tuple[bool, str]:
    """
    自动替换/添加辅助邮箱（主函数）

    Args:
        page: Playwright Page 对象
        new_email: 新辅助邮箱
        account_info: 账号信息（用于登录）
        code_reader: Gmail 验证码读取器

    Returns:
        (success: bool, message: str)
    """
    try:
        print(f"\n{'='*50}")
        print(f"开始替换辅助邮箱流程")
        print(f"目标辅助邮箱: {new_email}")
        print(f"{'='*50}\n")

        # 1. 导航到辅助邮箱设置页面
        print(f"导航到: {RECOVERY_EMAIL_URL}")
        try:
            page_load_timeout = ConfigManager.get("timeouts.page_load", 30) * 1000
            await page.goto(RECOVERY_EMAIL_URL, timeout=page_load_timeout)
        except Exception as e:
            print(f"导航失败: {e}")
            return False, f"导航失败: {e}"

        await asyncio.sleep(3)

        # 2. 检测并登录（如需要）
        login_success, login_msg = await check_and_login_for_email(page, account_info)
        if not login_success and "需要登录" in login_msg:
            return False, f"登录失败: {login_msg}"

        # 登录后重新导航到目标页面
        if "登录成功" in login_msg:
            print("登录后重新导航到辅助邮箱设置页面...")
            await page.goto(RECOVERY_EMAIL_URL, timeout=60000)
            await asyncio.sleep(3)

        # 2.5 处理重新验证身份挑战
        reauth_success, reauth_msg = await handle_reauth_challenge(page, account_info)
        if not reauth_success:
            return False, f"重新验证失败: {reauth_msg}"

        if "成功" in reauth_msg:
            await asyncio.sleep(2)

        # 3. 检测当前辅助邮箱状态
        status, current_email = await detect_current_email_status(page)
        print(f"当前状态: {status}, 现有辅助邮箱: {current_email}")

        # 4. 根据状态执行操作
        if status == 'has_email':
            print("检测到已有辅助邮箱，先删除...")
            remove_success, remove_msg = await remove_old_email(page)
            if not remove_success:
                print(f"删除旧邮箱失败: {remove_msg}，尝试直接替换...")

            await asyncio.sleep(2)

            # 删除后可能触发重新验证
            reauth_success, reauth_msg = await handle_reauth_challenge(page, account_info)
            if not reauth_success:
                return False, f"删除后重新验证失败: {reauth_msg}"

        # 5. 添加新辅助邮箱
        add_success, add_msg = await add_new_email(page, new_email, code_reader)

        # 添加时可能触发重新验证
        if not add_success and ("验证" in add_msg or "password" in add_msg.lower()):
            reauth_success, reauth_msg = await handle_reauth_challenge(page, account_info)
            if reauth_success:
                add_success, add_msg = await add_new_email(page, new_email, code_reader)

        if add_success:
            print(f"\n{'='*50}")
            print(f"✅ 辅助邮箱替换成功: {new_email}")
            print(f"{'='*50}\n")
            return True, f"辅助邮箱替换成功: {new_email}"
        else:
            return False, add_msg

    except Exception as e:
        print(f"❌ 替换辅助邮箱流程出错: {e}")
        import traceback
        traceback.print_exc()
        return False, f"替换失败: {e}"


async def test_replace_email_with_browser(browser_id: str, new_email: str, gmail_email: str, gmail_password: str, account_info: dict = None):
    """
    测试替换辅助邮箱功能

    Args:
        browser_id: 浏览器窗口ID
        new_email: 新辅助邮箱
        gmail_email: Gmail 邮箱（用于接收验证码）
        gmail_password: Gmail 应用密码
        account_info: 账号信息
    """
    print(f"正在打开浏览器: {browser_id}...")

    # 如果没有提供账号信息，尝试从浏览器信息中获取
    if not account_info:
        print("未提供账号信息，尝试从浏览器remark中获取...")
        from ix_window import get_browser_info

        # 确保 browser_id 是整数类型
        try:
            profile_id = int(browser_id)
        except (ValueError, TypeError):
            profile_id = browser_id

        target_browser = get_browser_info(profile_id)
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

    # 创建验证码读取器
    code_reader = GmailCodeReader(gmail_email, gmail_password)

    async with async_playwright() as playwright:
        try:
            chromium = playwright.chromium
            cdp_timeout = ConfigManager.get("timeouts.page_load", 30) * 1000
            browser = await chromium.connect_over_cdp(ws_endpoint, timeout=cdp_timeout)
            context = browser.contexts[0]
            page = context.pages[0] if context.pages else await context.new_page()

            # 执行替换辅助邮箱
            success, message = await auto_replace_email(page, new_email, account_info, code_reader)

            print(f"\n{'='*50}")
            print(f"替换结果: {message}")
            print(f"{'='*50}\n")

            return success, message

        except Exception as e:
            print(f"测试过程出错: {e}")
            import traceback
            traceback.print_exc()
            return False, str(e)
        finally:
            code_reader.disconnect()


if __name__ == "__main__":
    import sys

    print("自动替换辅助邮箱测试")
    print("用法: python auto_replace_email.py <browser_id> <new_email> <gmail_email> <gmail_password>")

    if len(sys.argv) >= 5:
        test_browser_id = sys.argv[1]
        test_new_email = sys.argv[2]
        test_gmail_email = sys.argv[3]
        test_gmail_password = sys.argv[4]

        result = asyncio.run(test_replace_email_with_browser(
            test_browser_id, test_new_email, test_gmail_email, test_gmail_password
        ))
        print(f"\n最终结果: {result}")
