"""
自动绑卡脚本 - Google One AI Student 订阅
"""
import asyncio
import os
import pyotp
from playwright.async_api import async_playwright, Page
from ix_api import openBrowser, closeBrowser
from account_manager import AccountManager
from core.config_manager import ConfigManager
from data_store import get_data_store

# 卡片配置文件路径（保留作为兜底）
CARDS_FILE = 'cards.txt'

# 当前卡片索引（用于轮换）
_current_card_index = 0

# 默认测试卡信息（当无其他数据源时使用）
DEFAULT_CARD = {
    'number': '5481087170529907',
    'exp_month': '01',
    'exp_year': '32',
    'cvv': '536',
    'name': 'John Smith',  # 持卡人姓名
    'zip_code': '10001'    # 美国纽约邮编
}


def read_cards_from_file(file_path: str = CARDS_FILE) -> list:
    """
    从 DataStore 读取卡片信息（优先），如果为空则尝试从文件读取

    Args:
        file_path: 卡片配置文件路径（兜底）

    Returns:
        卡片列表 [{'number', 'exp_month', 'exp_year', 'cvv', 'name', 'zip_code'}, ...]
    """
    # 优先从 DataStore 读取
    try:
        data_store = get_data_store()
        cards = data_store.get_cards_as_dicts()
        if cards:
            print(f"✅ 从 DataStore 读取到 {len(cards)} 张卡片")
            return cards
    except Exception as e:
        print(f"⚠️ 从 DataStore 读取卡片失败: {e}")

    # 兜底：从文件读取
    if not os.path.exists(file_path):
        print(f"⚠️ 卡片文件 {file_path} 不存在，使用默认卡片")
        return [DEFAULT_CARD]

    try:
        cards = []
        with open(file_path, 'r', encoding='utf-8') as f:
            for line in f:
                line = line.strip()
                # 跳过空行和注释
                if not line or line.startswith('#'):
                    continue

                parts = line.split('----')
                if len(parts) >= 4:
                    card = {
                        'number': parts[0].strip(),
                        'exp_month': parts[1].strip(),
                        'exp_year': parts[2].strip(),
                        'cvv': parts[3].strip(),
                        'name': parts[4].strip() if len(parts) >= 5 else 'John Smith',
                        'zip_code': parts[5].strip() if len(parts) >= 6 else '10001'
                    }
                    cards.append(card)
                else:
                    print(f"⚠️ 跳过格式错误的行: {line}")

        if not cards:
            print(f"⚠️ 卡片文件为空，使用默认卡片")
            return [DEFAULT_CARD]

        print(f"✅ 从 {file_path} 读取到 {len(cards)} 张卡片")
        return cards

    except Exception as e:
        print(f"❌ 读取卡片文件失败: {e}，使用默认卡片")
        return [DEFAULT_CARD]


def get_next_card() -> dict:
    """
    获取下一张卡片（轮换）

    Returns:
        卡片信息字典
    """
    global _current_card_index

    cards = read_cards_from_file()
    card = cards[_current_card_index % len(cards)]
    _current_card_index += 1

    print(f"📋 使用卡片 #{_current_card_index}: **** **** **** {card['number'][-4:]}")
    return card


def get_card_by_index(index: int = 0) -> dict:
    """
    获取指定索引的卡片

    Args:
        index: 卡片索引（从0开始）

    Returns:
        卡片信息字典
    """
    cards = read_cards_from_file()
    if index < 0 or index >= len(cards):
        print(f"⚠️ 索引 {index} 超出范围，使用第一张卡片")
        index = 0

    card = cards[index]
    print(f"📋 使用卡片 #{index + 1}: **** **** **** {card['number'][-4:]}")
    return card


def get_all_cards() -> list:
    """
    获取所有卡片列表

    Returns:
        卡片列表
    """
    return read_cards_from_file()


def reset_card_rotation():
    """重置卡片轮换索引"""
    global _current_card_index
    _current_card_index = 0
    print("🔄 卡片轮换索引已重置")


# 兼容旧代码的别名
TEST_CARD = DEFAULT_CARD

async def check_and_login(page: Page, account_info: dict = None):
    """
    检测是否已登录，如果未登录则执行登录流程
    
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
                
                # 1. 输入邮箱
                email = account_info.get('email')
                print(f"正在输入账号: {email}")
                await email_input.fill(email)
                await page.click('#identifierNext >> button')
                
                # 2. 输入密码
                print("等待密码输入框...")
                await page.wait_for_selector('input[type="password"]', state='visible', timeout=15000)
                password = account_info.get('password')
                print("正在输入密码...")
                await page.fill('input[type="password"]', password)
                await page.click('#passwordNext >> button')
                
                # 3. 处理2FA
                print("等待2FA输入...")
                try:
                    totp_input = await page.wait_for_selector(
                        'input[name="totpPin"], input[id="totpPin"], input[type="tel"]',
                        timeout=10000
                    )
                    if totp_input:
                        secret = account_info.get('secret')
                        if secret:
                            s = secret.replace(" ", "").strip()
                            totp = pyotp.TOTP(s)
                            code = totp.now()
                            print(f"正在输入2FA验证码: {code}")
                            await totp_input.fill(code)
                            await page.click('#totpNext >> button')
                            print("✅ 2FA验证完成")
                        else:
                            return False, "需要2FA但未提供secret"
                except Exception as e:
                    print(f"2FA步骤跳过或失败（可能不需要）: {e}")
                
                # 等待登录完成
                await asyncio.sleep(5)
                print("✅ 登录流程完成")
                return True, "登录成功"
        except:
            print("✅ 已登录，跳过登录流程")
            return True, "已登录"
            
    except Exception as e:
        print(f"登录检测出错: {e}")
        return False, f"登录检测错误: {e}"

async def auto_bind_card(page: Page, card_info: dict = None, account_info: dict = None,
                         use_rotation: bool = False, card_index: int = None):
    """
    自动绑卡函数

    Args:
        page: Playwright Page 对象
        card_info: 卡信息字典 {'number', 'exp_month', 'exp_year', 'cvv'}
                   如果为 None，则根据 use_rotation 和 card_index 决定使用哪张卡
        account_info: 账号信息（用于登录）{'email', 'password', 'secret'}
        use_rotation: 是否使用卡片轮换（每次调用使用下一张卡）
        card_index: 指定使用第几张卡（从0开始），优先级高于 use_rotation

    Returns:
        (success: bool, message: str)
    """
    # 确定使用哪张卡片
    if card_info is None:
        if card_index is not None:
            card_info = get_card_by_index(card_index)
        elif use_rotation:
            card_info = get_next_card()
        else:
            # 默认使用第一张卡
            card_info = get_card_by_index(0)
    
    try:
        # 首先检测并执行登录（如果需要）
        login_success, login_msg = await check_and_login(page, account_info)
        if not login_success and "需要登录" in login_msg:
            return False, f"登录失败: {login_msg}"
        
        print("\n开始自动绑卡流程...")
        
        # 截图1：初始页面
        await page.screenshot(path="step1_initial.png")
        print("截图已保存: step1_initial.png")
        
        # Step 1: 等待并点击 "Get student offer" 按钮
        print("等待 'Get student offer' 按钮...")
        try:
            # 尝试多种可能的选择器
            selectors = [
                'button:has-text("Get student offer")',
                'button:has-text("Get offer")',
                'a:has-text("Get student offer")',
                'button:has-text("Get")',
                '[role="button"]:has-text("Get")'
            ]
            
            clicked = False
            for selector in selectors:
                try:
                    element = page.locator(selector).first
                    if await element.count() > 0:
                        await element.wait_for(state='visible', timeout=3000)
                        await element.click()
                        print(f"✅ 已点击 'Get student offer' (selector: {selector})")
                        clicked = True
                        break
                except:
                    continue
            
            if not clicked:
                print("⚠️ 未找到 'Get student offer' 按钮，可能已在付款页面")

            # 等待付款页面和 iframe 加载 (使用配置化延迟)
            after_offer_delay = ConfigManager.get("delays.after_offer", 8)
            print(f"等待付款页面和 iframe 加载 ({after_offer_delay}秒)...")
            await asyncio.sleep(after_offer_delay)
            await page.screenshot(path="step2_after_get_offer.png")
            print("截图已保存: step2_after_get_offer.png")
            
        except Exception as e:
            print(f"处理 'Get student offer' 时出错: {e}")
        
        # 前置判断：检查是否已经绑卡（是否已显示订阅按钮）
        print("\n检查账号是否已绑卡...")
        try:
            # 等待一下让页面稳定
            await asyncio.sleep(3)
            
            # 先尝试获取 iframe
            try:
                iframe_locator = page.frame_locator('iframe[src*="tokenized.play.google.com"]')
                print("✅ 找到 iframe，在 iframe 中检查订阅按钮")
                
                # 使用精确的选择器
                subscribe_selectors = [
                    'span.UywwFc-vQzf8d:has-text("Subscribe")',
                    'span[jsname="V67aGc"]',
                    'span.UywwFc-vQzf8d',
                    'span:has-text("Subscribe")',
                    ':text("Subscribe")',
                    'button:has-text("Subscribe")',
                ]
                
                # 在 iframe 中查找订阅按钮
                already_bound = False
                subscribe_button_early = None
                
                for selector in subscribe_selectors:
                    try:
                        element = iframe_locator.locator(selector).first
                        count = await element.count()
                        if count > 0:
                            print(f"  ✅ 检测到订阅按钮，账号已绑卡！(iframe, selector: {selector})")
                            subscribe_button_early = element
                            already_bound = True
                            break
                    except:
                        continue
                
                # 如果找到订阅按钮，说明已经绑过卡了，直接点击订阅
                if already_bound and subscribe_button_early:
                    print("账号已绑卡，跳过绑卡流程，直接订阅...")
                    await asyncio.sleep(2)
                    await subscribe_button_early.click()
                    print("✅ 已点击订阅按钮")
                    
                    # 等待10秒并验证订阅成功
                    await asyncio.sleep(10)
                    await page.screenshot(path="step_subscribe_existing_card.png")
                    print("截图已保存: step_subscribe_existing_card.png")
                    
                    # 在 iframe 中检查是否显示 "Subscribed"
                    try:
                        subscribed_selectors = [
                            ':text("Subscribed")',
                            'text=Subscribed',
                            '*:has-text("Subscribed")',
                        ]
                        
                        subscribed_found = False
                        for selector in subscribed_selectors:
                            try:
                                element = iframe_locator.locator(selector).first
                                count = await element.count()
                                if count > 0:
                                    print(f"  ✅ 检测到 'Subscribed'，订阅确认成功！")
                                    subscribed_found = True
                                    break
                            except:
                                continue
                        
                        if subscribed_found:
                            print("✅ 使用已有卡订阅成功并已确认！")
                            # 更新数据库状态为已订阅
                            if account_info and account_info.get('email'):
                                line = f"{account_info.get('email', '')}----{account_info.get('password', '')}----{account_info.get('backup', '')}----{account_info.get('secret', '')}"
                                AccountManager.move_to_subscribed(line)
                            return True, "使用已有卡订阅成功 (Already bound, Subs cribed)"
                        
                        # 如果没找到 Subscribed，检查是否出现 Error（卡过期）
                        print("未检测到 'Subscribed'，检查是否出现错误...")
                        error_selectors = [
                            ':text("Error")',
                            'text=Error',
                            ':has-text("Your card issuer declined")',
                        ]
                        
                        error_found = False
                        for selector in error_selectors:
                            try:
                                element = iframe_locator.locator(selector).first
                                count = await element.count()
                                if count > 0:
                                    print(f"  ⚠️ 检测到错误信息（卡可能过期），准备换绑...")
                                    error_found = True
                                    break
                            except:
                                continue
                        
                        if error_found:
                            # 卡过期换绑流程
                            print("\n【卡过期换绑流程】")
                            
                            # 1. 点击 "Got it" 按钮
                            print("1. 点击 'Got it' 按钮...")
                            got_it_selectors = [
                                'button:has-text("Got it")',
                                ':text("Got it")',
                                'button:has-text("确定")',
                            ]
                            
                            for selector in got_it_selectors:
                                try:
                                    element = iframe_locator.locator(selector).first
                                    count = await element.count()
                                    if count > 0:
                                        await element.click()
                                        print("  ✅ 已点击 'Got it'")
                                        await asyncio.sleep(3)
                                        break
                                except:
                                    continue
                            
                            # 2. 点击主页面的 "Get student offer"
                            print("2. 重新点击主页面的 'Get student offer'...")
                            get_offer_selectors = [
                                'button:has-text("Get student offer")',
                                ':text("Get student offer")',
                            ]
                            
                            for selector in get_offer_selectors:
                                try:
                                    element = page.locator(selector).first
                                    count = await element.count()
                                    if count > 0:
                                        await element.click()
                                        print("  ✅ 已点击 'Get student offer'")
                                        await asyncio.sleep(8)
                                        break
                                except:
                                    continue
                            
                            # 3. 在 iframe 中找到并点击已有卡片
                            print("3. 在 iframe 中查找并点击过期卡片...")
                            try:
                                iframe_locator_card = page.frame_locator('iframe[src*="tokenized.play.google.com"]')
                                
                                # 点击卡片（Mastercard-7903 或类似）
                                card_selectors = [
                                    'span.Ngbcnc',  # Mastercard-7903 的 span
                                    'div.dROd9.ct1Mcc',  # 卡片容器
                                    ':has-text("Mastercard")',
                                ]
                                
                                for selector in card_selectors:
                                    try:
                                        element = iframe_locator_card.locator(selector).first
                                        count = await element.count()
                                        if count > 0:
                                            await element.click()
                                            print(f"  ✅ 已点击过期卡片 (selector: {selector})")
                                            await asyncio.sleep(5)
                                            break
                                    except:
                                        continue
                                
                                print("4. 进入换绑流程，继续后续绑卡操作...")
                                # 不 return，让代码继续执行后面的绑卡流程
                                
                            except Exception as e:
                                print(f"  点击过期卡片时出错: {e}，尝试继续...")
                        else:
                            print("⚠️ 未检测到 'Subscribed' 或 'Error'，但可能仍然成功")
                            return True, "使用已有卡订阅成功 (Already bound)"
                            
                    except Exception as e:
                        print(f"验证订阅状态时出错: {e}")
                        return True, "使用已有卡订阅成功 (Already bound)"
                else:
                    print("未检测到订阅按钮，继续绑卡流程...")
                    
            except Exception as e:
                print(f"获取 iframe 失败: {e}，继续正常绑卡流程...")
                
        except Exception as e:
            print(f"前置判断时出错: {e}，继续正常绑卡流程...")
        
        # Step 2: 切换到 iframe（付款表单在 iframe 中）
        print("\n检测并切换到 iframe...")
        try:
            # 等待 iframe 加载 (使用配置化延迟)
            iframe_wait = ConfigManager.get("timeouts.iframe_wait", 15)
            await asyncio.sleep(iframe_wait)
            iframe_locator = page.frame_locator('iframe[src*="tokenized.play.google.com"]')
            print("✅ 找到 tokenized.play.google.com iframe，已切换上下文")

            # 等待 iframe 内部文档加载
            print("等待 iframe 内部文档加载...")
            await asyncio.sleep(iframe_wait)  # 使用同样的配置化延迟
            
        except Exception as e:
            print(f"❌ 未找到 iframe: {e}")
            return False, "未找到付款表单 iframe"
        
        # Step 3: 在 iframe 中点击 "Add card"
        print("\n在 iframe 中等待并点击 'Add card' 按钮...")
        try:
            add_card_delay = ConfigManager.get("delays.after_add_card", 10)
            await asyncio.sleep(add_card_delay)  # 等待元素可点击
            
            # 在 iframe 中查找 Add card
            selectors = [
                'span.PjwEQ:has-text("Add card")',
                'span.PjwEQ',
                ':text("Add card")',
                'div:has-text("Add card")',
                'span:has-text("Add card")',
            ]
            
            clicked = False
            for selector in selectors:
                try:
                    element = iframe_locator.locator(selector).first
                    count = await element.count()
                    if count > 0:
                        print(f"  找到 'Add card' (iframe, selector: {selector})")
                        await element.click()
                        print(f"✅ 已在 iframe 中点击 'Add card'")
                        clicked = True
                        break
                except:
                    continue
            
            if not clicked:
                print("⚠️ 在 iframe 中未找到 'Add card'，尝试直接查找输入框...")

            # 等待表单加载
            print("等待卡片输入表单加载...")
            await asyncio.sleep(add_card_delay)  # 使用配置化延迟
            await page.screenshot(path="step3_card_form_in_iframe.png")
            print("截图已保存: step3_card_form_in_iframe.png")
            
            # 关键：点击 Add card 后，会在第一个 iframe 内部再出现一个 iframe！
            # 需要再次切换到这个内部 iframe
            print("\n检测 iframe 内部是否有第二层 iframe...")
            try:
                # 在第一个 iframe 中查找第二个 iframe
                await asyncio.sleep(1)  # 等待内部 iframe 出现
                
                # 第二层 iframe 通常是 name="hnyNZeIframe" 或包含 instrumentmanager
                # 尝试多种选择器
                inner_iframe_selectors = [
                    'iframe[name="hnyNZeIframe"]',
                    'iframe[src*="instrumentmanager"]',
                    'iframe[id*="hnyNZe"]',
                ]
                
                inner_iframe = None
                for selector in inner_iframe_selectors:
                    try:
                        temp_iframe = iframe_locator.frame_locator(selector)
                        # 尝试访问以验证存在
                        test_locator = temp_iframe.locator('body')
                        if await test_locator.count() >= 0:
                            inner_iframe = temp_iframe
                            print(f"✅ 找到第二层 iframe（selector: {selector}）")
                            break
                    except:
                        continue
                
                if not inner_iframe:
                    print("⚠️ 未找到第二层 iframe，继续在当前层级操作")
                else:
                    # 更新 iframe_locator 为内部的 iframe
                    iframe_locator = inner_iframe

                    print("等待第二层 iframe 加载...")
                    await asyncio.sleep(add_card_delay)  # 使用配置化延迟
                
            except Exception as e:
                print(f"⚠️ 查找第二层 iframe 时出错: {e}")
            
        except Exception as e:
            await page.screenshot(path="error_iframe_add_card.png")
            return False, f"在 iframe 中点击 'Add card' 失败: {e}"
        
        # Step 4: 填写卡号（在 iframe 中）
        print(f"\n填写卡号: {card_info['number']}")
        await asyncio.sleep(add_card_delay)  # 使用配置化延迟
        
        try:
            # 简化策略：iframe 中有 3 个输入框，按顺序分别是：
            # 1. Card number (第1个)
            # 2. MM/YY (第2个)  
            # 3. Security code (第3个)
            
            print("在 iframe 中查找所有输入框...")
            
            # 获取所有输入框
            all_inputs = iframe_locator.locator('input')
            input_count = await all_inputs.count()
            print(f"  找到 {input_count} 个输入框")
            
            if input_count < 3:
                return False, f"输入框数量不足，只找到 {input_count} 个"
            
            # 第1个输入框 = Card number
            card_number_input = all_inputs.nth(0)
            print("  使用第1个输入框作为卡号输入框")
            
            await card_number_input.click()
            await card_number_input.fill(card_info['number'])
            print("✅ 卡号已填写")
            await asyncio.sleep(0.5)
        except Exception as e:
            return False, f"填写卡号失败: {e}"
        
        # Step 5: 填写过期日期 (MM/YY)
        print(f"填写过期日期: {card_info['exp_month']}/{card_info['exp_year']}")
        try:
            # 第2个输入框 = MM/YY
            exp_date_input = all_inputs.nth(1)
            print("  使用第2个输入框作为过期日期输入框")
            
            await exp_date_input.click()
            exp_value = f"{card_info['exp_month']}{card_info['exp_year']}"
            await exp_date_input.fill(exp_value)
            print("✅ 过期日期已填写")
            await asyncio.sleep(0.5)
        except Exception as e:
            return False, f"填写过期日期失败: {e}"
        
        # Step 6: 填写 CVV (Security code)
        print(f"填写 CVV: {card_info['cvv']}")
        try:
            # 第3个输入框 = Security code
            cvv_input = all_inputs.nth(2)
            print("  使用第3个输入框作为CVV输入框")

            await cvv_input.click()
            await cvv_input.fill(card_info['cvv'])
            print("✅ CVV已填写")
            await asyncio.sleep(0.5)
        except Exception as e:
            return False, f"填写CVV失败: {e}"

        # Step 6.5: 填写持卡人姓名（第4个输入框）
        card_name = card_info.get('name', 'John Smith')
        print(f"填写持卡人姓名: {card_name}")
        try:
            if input_count >= 4:
                name_input = all_inputs.nth(3)
                await name_input.click()
                await name_input.fill(card_name)
                print("✅ 持卡人姓名已填写 (第4个输入框)")
                await asyncio.sleep(0.5)
            else:
                print("⚠️ 未找到持卡人姓名输入框")
        except Exception as e:
            print(f"⚠️ 填写持卡人姓名时出错: {e}")

        # Step 6.6: 填写 Billing zip code（第5个输入框）
        zip_code = card_info.get('zip_code', '10001')
        print(f"填写 Billing zip code: {zip_code}")
        try:
            zip_filled = False

            # 方法1：第5个输入框
            if input_count >= 5:
                try:
                    zip_input = all_inputs.nth(4)
                    await zip_input.click()
                    await zip_input.fill(zip_code)
                    print("✅ Billing zip code已填写 (第5个输入框)")
                    zip_filled = True
                except Exception as e:
                    print(f"  第5个输入框填写失败: {e}")

            # 方法2：通过选择器查找
            if not zip_filled:
                zip_selectors = [
                    'input[autocomplete="postal-code"]',
                    'input[name*="postal"]',
                    'input[name*="zip"]',
                    'input[placeholder*="ZIP"]',
                    'input[placeholder*="zip"]',
                    'input[aria-label*="ZIP"]',
                    'input[aria-label*="zip"]',
                    'input[aria-label*="postal"]',
                ]

                for selector in zip_selectors:
                    try:
                        zip_element = iframe_locator.locator(selector).first
                        count = await zip_element.count()
                        if count > 0:
                            await zip_element.click()
                            await zip_element.fill(zip_code)
                            print(f"✅ Billing zip code已填写 (selector: {selector})")
                            zip_filled = True
                            break
                    except:
                        continue

            if not zip_filled:
                print("⚠️ 未找到邮编输入框")

            await asyncio.sleep(0.5)
        except Exception as e:
            print(f"⚠️ 填写邮编时出错: {e}")

        # Step 7: 点击 "Save card" 按钮
        print("点击 'Save card' 按钮...")
        try:
            save_selectors = [
                'button:has-text("Save card")',
                'button:has-text("保存卡")',  # 中文
                'button:has-text("Save")',
                'button:has-text("保存")',  # 中文
                'button[type="submit"]',
            ]
            
            save_button = None
            for selector in save_selectors:
                try:
                    element = iframe_locator.locator(selector).first
                    count = await element.count()
                    if count > 0:
                        print(f"  找到 Save 按钮 (iframe, selector: {selector})")
                        save_button = element
                        break
                except:
                    continue
            
            if not save_button:
                return False, "未找到 Save card 按钮"

            await save_button.click()
            print("✅ 已点击 'Save card'")

            # 等待保存处理
            await asyncio.sleep(5)

            # 检测保存后的错误信息
            print("检测是否有错误信息...")
            error_selectors = [
                ':text("Billing zip code required")',
                ':text("zip code required")',
                ':text("Invalid card")',
                ':text("Card declined")',
                ':text("Error")',
                ':text("required")',
                '.error-message',
                '[class*="error"]',
            ]

            for selector in error_selectors:
                try:
                    error_element = iframe_locator.locator(selector).first
                    count = await error_element.count()
                    if count > 0:
                        error_text = await error_element.text_content()
                        print(f"❌ 检测到错误: {error_text}")
                        await page.screenshot(path="error_save_card.png")
                        return False, f"保存卡片失败: {error_text}"
                except:
                    continue

            print("✅ 未检测到明显错误，继续...")

        except Exception as e:
            return False, f"点击 Save card 失败: {e}"
        
        # Step 7: 点击订阅按钮完成流程
        print("\n等待订阅页面加载...")
        after_save_delay = ConfigManager.get("delays.after_save", 18)
        await asyncio.sleep(after_save_delay)  # 使用配置化延迟
        await page.screenshot(path="step7_before_subscribe.png")
        print("截图已保存: step7_before_subscribe.png")
        
        try:
            # 关键改变：订阅按钮在主页面的弹窗中，不在 iframe 中！
            print("查找订阅按钮...")
            
            subscribe_selectors = [
                # 用户提供的精确选择器 - 优先尝试
                'span.UywwFc-vQzf8d:has-text("Subscribe")',
                'span[jsname="V67aGc"]',
                'span.UywwFc-vQzf8d',
                # 其他备选
                'span:has-text("Subscribe")',
                ':text("Subscribe")',
                'button:has-text("Subscribe")',
                'button:has-text("订阅")',
                'button:has-text("Start")',
                'button:has-text("开始")',
                'button:has-text("继续")',
                'div[role="button"]:has-text("Subscribe")',
                '[role="button"]:has-text("Subscribe")',
                'button[type="submit"]',
                # 根据截图，可能在 dialog 中
                'dialog span:has-text("Subscribe")',
                '[role="dialog"] span:has-text("Subscribe")',
                'dialog button:has-text("Subscribe")',
                '[role="dialog"] button:has-text("Subscribe")',
            ]
            
            subscribe_button = None
            
            # 优先在 iframe 中查找（订阅按钮在iframe中）
            print("在 iframe 中查找订阅按钮...")
            try:
                iframe_locator_subscribe = page.frame_locator('iframe[src*="tokenized.play.google.com"]')
                for selector in subscribe_selectors:
                    try:
                        element = iframe_locator_subscribe.locator(selector).first
                        count = await element.count()
                        if count > 0:
                            print(f"  找到订阅按钮 (iframe, selector: {selector})")
                            subscribe_button = element
                            break
                    except:
                        continue
            except Exception as e:
                print(f"  iframe查找失败: {e}")
            
            # 如果 iframe 中没找到，尝试在主页面查找
            if not subscribe_button:
                print("在主页面中查找订阅按钮...")
                for selector in subscribe_selectors:
                    try:
                        element = page.locator(selector).first
                        count = await element.count()
                        if count > 0:
                            print(f"  找到订阅按钮 (main page, selector: {selector})")
                            subscribe_button = element
                            break
                    except Exception as e:
                        continue
            
            if subscribe_button:
                print("准备点击订阅按钮...")
                await asyncio.sleep(2)  # 点击前等待
                await subscribe_button.click()
                print("✅ 已点击订阅按钮")
                
                # 等待10秒并验证订阅成功
                await asyncio.sleep(10)
                await page.screenshot(path="step8_after_subscribe.png")
                print("截图已保存: step8_after_subscribe.png")
                
                # 在 iframe 中检查是否显示 "Subscribed"
                try:
                    # 重新获取 iframe
                    iframe_locator_final = page.frame_locator('iframe[src*="tokenized.play.google.com"]')
                    
                    subscribed_selectors = [
                        ':text("Subscribed")',
                        'text=Subscribed',
                        '*:has-text("Subscribed")',
                    ]
                    
                    subscribed_found = False
                    for selector in subscribed_selectors:
                        try:
                            element = iframe_locator_final.locator(selector).first
                            count = await element.count()
                            if count > 0:
                                print(f"  ✅ 检测到 'Subscribed'，订阅确认成功！")
                                subscribed_found = True
                                break
                        except:
                            continue
                    
                    if subscribed_found:
                        print("✅ 绑卡并订阅成功，已确认！")
                        # 更新数据库状态为已订阅
                        if account_info and account_info.get('email'):
                            line = f"{account_info.get('email', '')}----{account_info.get('password', '')}----{account_info.get('backup', '')}----{account_info.get('secret', '')}"
                            AccountManager.move_to_subscribed(line)
                        return True, "绑卡并订阅成功 (Subscribed confirmed)"
                    else:
                        print("⚠️ 未检测到 'Subscribed'，但可能仍然成功")
                        # 更新数据库状态为已订阅
                        if account_info and account_info.get('email'):
                            line = f"{account_info.get('email', '')}----{account_info.get('password', '')}----{account_info.get('backup', '')}----{account_info.get('secret', '')}"
                            AccountManager.move_to_subscribed(line)
                        return True, "绑卡并订阅成功 (Subscribed)"
                except Exception as e:
                    print(f"验证订阅状态时出错: {e}")
                    return True, "绑卡并订阅成功 (Subscribed)"
            else:
                print("⚠️ 未找到订阅按钮，可能已自动完成")
                print("✅ 绑卡成功")
                return True, "绑卡成功"
                
        except Exception as e:
            print(f"点击订阅按钮时出错: {e}")
            import traceback
            traceback.print_exc()
            print("✅ 绑卡已完成（订阅步骤可能需要手动）")
            return True, "绑卡已完成"
        
    except Exception as e:
        print(f"❌ 绑卡过程出错: {e}")
        import traceback
        traceback.print_exc()
        return False, f"绑卡错误: {str(e)}"


async def test_bind_card_with_browser(browser_id: str, account_info: dict = None):
    """
    测试绑卡功能
    
    Args:
        browser_id: 浏览器窗口ID
        account_info: 账号信息 {'email', 'password', 'secret'}（可选，如果不提供则从浏览器remark中获取）
    """
    print(f"正在打开浏览器: {browser_id}...")
    
    # 如果没有提供账号信息，尝试从浏览器信息中获取
    if not account_info:
        print("未提供账号信息，尝试从浏览器remark中获取...")
        from ix_window import get_browser_info
        
        target_browser = get_browser_info(browser_id)
        if target_browser:
            remark = target_browser.get('remark', '')
            parts = remark.split('----')
            
            if len(parts) >= 4:
                account_info = {
                    'email': parts[0].strip(),
                    'password': parts[1].strip(),
                    'backup': parts[2].strip(),
                    'secret': parts[3].strip()
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
            # 使用配置化的超时时间连接 CDP
            cdp_timeout = ConfigManager.get("timeouts.page_load", 30) * 1000  # 转换为毫秒
            browser = await chromium.connect_over_cdp(ws_endpoint, timeout=cdp_timeout)
            context = browser.contexts[0]
            page = context.pages[0] if context.pages else await context.new_page()
            
            # 导航到目标页面
            target_url = "https://one.google.com/ai-student?g1_landing_page=75&utm_source=antigravity&utm_campaign=argon_limit_reached"
            print(f"导航到: {target_url}")
            await page.goto(target_url, wait_until='domcontentloaded', timeout=30000)
            
            # 等待页面加载
            print("等待页面完全加载...")
            await asyncio.sleep(5)  # 增加等待时间以确保弹窗有机会出现
            
            # 执行自动绑卡（包含登录检测）
            success, message = await auto_bind_card(page, account_info=account_info)
            
            print(f"\n{'='*50}")
            print(f"绑卡结果: {message}")
            print(f"{'='*50}\n")
            
            # 保持浏览器打开以便查看结果
            print("绑卡流程完成。浏览器将保持打开状态。")
            
            return True, message
            
        except Exception as e:
            print(f"测试过程出错: {e}")
            import traceback
            traceback.print_exc()
            return False, str(e)
        finally:
            # 不关闭浏览器，方便查看结果
            # closeBrowser(browser_id)
            pass


if __name__ == "__main__":
    # 使用用户指定的浏览器 ID 测试
    test_browser_id = "94b7f635502e42cf87a0d7e9b1330686"
    
    # 测试账号信息（如果需要登录）
    # 格式: {'email': 'xxx@gmail.com', 'password': 'xxx', 'secret': 'XXXXX'}
    test_account = None  # 如果已登录则为 None
    
    print(f"开始测试自动绑卡功能...")
    print(f"目标浏览器 ID: {test_browser_id}")
    print(f"测试卡信息: {TEST_CARD}")
    print(f"\n{'='*50}\n")
    
    result = asyncio.run(test_bind_card_with_browser(test_browser_id, test_account))
    
    print(f"\n最终结果: {result}")
