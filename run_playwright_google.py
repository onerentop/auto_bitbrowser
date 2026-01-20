import asyncio
import time
import pyotp
import re
import os
import sys
import threading
import random
from playwright.async_api import async_playwright, Playwright
from ix_api import openBrowser, closeBrowser
from ix_window import get_browser_list, get_browser_info
from deep_translator import GoogleTranslator
from account_manager import AccountManager
from core.config_manager import ConfigManager

# Global lock for file writing safety
file_write_lock = threading.Lock()

def get_base_path():
    if getattr(sys, 'frozen', False):
        return os.path.dirname(sys.executable)
    return os.path.dirname(os.path.abspath(__file__))


# ============ 人类行为模拟函数 ============

async def human_delay(min_ms=500, max_ms=2000):
    """随机延迟，模拟人类思考时间"""
    delay = random.randint(min_ms, max_ms) / 1000
    await asyncio.sleep(delay)


async def human_type(page, selector, text, min_delay=50, max_delay=150):
    """模拟人类打字，逐字符输入带随机延迟"""
    element = await page.wait_for_selector(selector, state='visible', timeout=10000)
    await element.click()
    await human_delay(200, 500)

    for char in text:
        await page.keyboard.type(char, delay=random.randint(min_delay, max_delay))
        # 偶尔暂停一下，模拟思考
        if random.random() < 0.1:
            await human_delay(200, 500)


async def human_move_and_click(page, selector):
    """模拟人类移动鼠标并点击"""
    try:
        element = await page.wait_for_selector(selector, state='visible', timeout=5000)
        if element:
            # 获取元素位置
            box = await element.bounding_box()
            if box:
                # 添加随机偏移，不要总是点击正中心
                x = box['x'] + box['width'] / 2 + random.randint(-5, 5)
                y = box['y'] + box['height'] / 2 + random.randint(-3, 3)

                # 移动鼠标（模拟真实轨迹）
                await page.mouse.move(x, y, steps=random.randint(5, 15))
                await human_delay(100, 300)
                await page.mouse.click(x, y)
                return True
    except Exception:
        pass
    return False


async def random_mouse_movement(page):
    """随机移动鼠标，模拟人类浏览行为"""
    try:
        viewport = page.viewport_size
        if viewport:
            for _ in range(random.randint(2, 4)):
                x = random.randint(100, viewport['width'] - 100)
                y = random.randint(100, viewport['height'] - 100)
                await page.mouse.move(x, y, steps=random.randint(10, 25))
                await human_delay(200, 600)
    except Exception:
        pass


async def random_scroll(page):
    """随机滚动页面"""
    try:
        scroll_amount = random.randint(100, 300)
        direction = random.choice([1, -1])
        await page.mouse.wheel(0, scroll_amount * direction)
        await human_delay(300, 800)
    except Exception:
        pass


# ============ 主要自动化逻辑 ============

# Helper function for automation logic
async def _automate_login_and_extract(playwright: Playwright, browser_id: str, account_info: dict, ws_endpoint: str, log_callback=None):
    chromium = playwright.chromium
    try:
        # 使用配置化的超时时间连接 CDP
        cdp_timeout = ConfigManager.get("timeouts.page_load", 30) * 1000  # 转换为毫秒
        browser = await chromium.connect_over_cdp(ws_endpoint, timeout=cdp_timeout)
        default_context = browser.contexts[0]
        page = default_context.pages[0] if default_context.pages else await default_context.new_page()

        print("Proxy warmup: Waiting for 2 seconds...")
        if log_callback: log_callback("正在打开浏览器预热...")
        await asyncio.sleep(2)

        print('Navigating to accounts.google.com...')
        # Retry logic for poor network
        max_retries = 3

        # Check if we need to login or if we are already logged in
        # We try to go to accounts.google.com first.
        try:
            await page.goto('https://accounts.google.com', timeout=60000)
        except Exception as e:
            print(f"Initial navigation failed: {e}")

        # === 人类行为模拟：页面加载后随机等待和移动 ===
        await human_delay(1000, 2500)
        await random_mouse_movement(page)

        # 1. Enter Email (if input exists)
        email = account_info.get('email')

        try:
             # Check if email input exists
             email_input = await page.wait_for_selector('input[type="email"]', timeout=5000)
             if email_input:
                 print(f"Entering email: {email}")
                 if log_callback: log_callback(f"正在输入账号: {email}")

                 # === 人类行为模拟：使用逐字符输入 ===
                 await human_type(page, 'input[type="email"]', email)
                 await human_delay(500, 1200)

                 # 改进选择器稳定性：使用多候选选择器
                 next_selectors = [
                     '#identifierNext >> button',
                     '#identifierNext button',
                     'button[jsname="LgbsSe"]',
                     '[data-idom-class="nCP5yc"] button',
                     'button:has-text("Next")',
                     'button:has-text("下一步")',
                     'button:has-text("Tiếp theo")',
                 ]

                 # === 人类行为模拟：点击前移动鼠标 ===
                 clicked = False
                 for sel in next_selectors:
                     try:
                         if await human_move_and_click(page, sel):
                             clicked = True
                             break
                     except:
                         continue

                 if not clicked:
                     await human_delay(300, 600)
                     await page.keyboard.press('Enter')  # 兜底方案

                 # === 人类行为模拟：等待页面加载 ===
                 await human_delay(1500, 3000)

                 # 2. Enter Password
                 print("Waiting for password input...")
                 await page.wait_for_selector('input[type="password"]', state='visible')
                 password = account_info.get('password')
                 print("Entering password...")

                 # === 人类行为模拟：使用逐字符输入密码 ===
                 await human_type(page, 'input[type="password"]', password)
                 await human_delay(500, 1200)

                 # 改进选择器稳定性：密码下一步按钮
                 pwd_next_selectors = [
                     '#passwordNext >> button',
                     '#passwordNext button',
                     'button[jsname="LgbsSe"]',
                     '[data-idom-class="nCP5yc"] button',
                     'button:has-text("Next")',
                     'button:has-text("下一步")',
                 ]

                 # === 人类行为模拟：点击前移动鼠标 ===
                 clicked = False
                 for sel in pwd_next_selectors:
                     try:
                         if await human_move_and_click(page, sel):
                             clicked = True
                             break
                     except:
                         continue

                 if not clicked:
                     await human_delay(300, 600)
                     await page.keyboard.press('Enter')

                 # === 人类行为模拟：登录后等待 ===
                 await human_delay(2000, 4000)

                 # 3. Handle 2FA (TOTP)
                 print("Waiting for 2FA input...")
                 try:
                      totp_input = await page.wait_for_selector('input[name="totpPin"], input[id="totpPin"], input[type="tel"]', timeout=10000)
                      if totp_input:
                          secret = account_info.get('secret')
                          if secret:
                              s = secret.replace(" ", "").strip()
                              totp = pyotp.TOTP(s)
                              code = totp.now()
                              print(f"Generating 2FA code: {code}")

                              # === 人类行为模拟：逐字符输入2FA码 ===
                              await human_delay(500, 1000)
                              await human_type(page, 'input[name="totpPin"], input[id="totpPin"], input[type="tel"]', code, min_delay=80, max_delay=200)
                              await human_delay(500, 1200)

                              # 改进选择器稳定性：2FA 下一步按钮
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
                                      if await human_move_and_click(page, sel):
                                          clicked = True
                                          break
                                  except:
                                      continue

                              if not clicked:
                                  await human_delay(300, 600)
                                  await page.keyboard.press('Enter')
                          else:
                              print("2FA secret not found in account info!")
                 except Exception as e:
                     print(f"2FA step exception (maybe skipped or different challenge): {e}")

        except Exception as e:
             print(f"Login flow might be skipped or failed (maybe already logged in): {e}")

        # Wait briefly after login attempt
        await human_delay(2000, 4000)

        # 4. Navigate to Google One AI page
        target_url = "https://one.google.com/ai-student?g1_landing_page=75&utm_source=antigravity&utm_campaign=argon_limit_reached"
        
        print("Opening a new page for target URL...")
        # Open new page first to ensure browser doesn't close
        new_page = await default_context.new_page()
        page = new_page # Switch to new page
        
        print(f"Navigating to {target_url}...")
        
        nav_success = False
        for attempt in range(max_retries):
            try:
                await page.goto(target_url, timeout=60000)
                print("Target navigation successful.")
                nav_success = True
                break
            except Exception as e:
                print(f"Target navigation failed (attempt {attempt+1}/{max_retries}): {e}")
                if attempt < max_retries - 1:
                    print("Retrying in 5 seconds...")
                    await asyncio.sleep(5)
        
        if not nav_success:
            print("Failed to navigate to target URL after retries.")
            return False

        # 5. Extract "Verify eligibility" link or check for non-eligibility
        print("Checking for eligibility...")
        if log_callback: log_callback("正在检测学生资格...")

        found_link = False
        is_invalid = False

        # Phrases indicating the offer is not available in various languages
        not_available_phrases = [
            # English - Primary phrases
            "This offer is not available",
            "This offer isn't available",
            "offer is not available",
            "offer isn't available",
            "not eligible",
            "You're not eligible",
            "You are not eligible",
            "aren't eligible",
            "ineligible",
            "Sorry, this offer",
            "Sorry, you're not",
            "Sorry, you are not",
            "This offer is unavailable",
            "offer is unavailable",
            "Offer unavailable",
            "not available in your",
            "not available for your",
            "isn't available in your",
            "isn't available for your",
            "This offer cannot be used",
            "cannot be redeemed",
            "can't be redeemed",
            "doesn't qualify",
            "does not qualify",
            "don't qualify",
            "do not qualify",
            "You don't qualify",
            "You do not qualify",
            "not applicable",
            "This promotion is not available",
            "promotion is not available",
            "This deal is not available",
            "Unfortunately, this offer",
            "Unfortunately, you",
            "We're sorry, this offer",
            "We are sorry, this offer",
            "offer has expired",
            "offer is expired",
            "offer not valid",
            "not valid for",
            "Your account doesn't qualify",
            "Your account does not qualify",
            "account is not eligible",
            "account isn't eligible",
            "region is not supported",
            "country is not supported",
            "location is not supported",
            "not supported in your",
            "isn't supported in your",
            # Vietnamese
            "Ưu đãi này hiện không dùng được",
            "không đủ điều kiện",
            # Spanish
            "Esta oferta no está disponible",
            "No eres elegible",
            # French
            "Cette offre n'est pas disponible",
            "Vous n'êtes pas éligible",
            # Portuguese
            "Esta oferta não está disponível",
            "Você não é elegível",
            # Indonesian
            "Tawaran ini tidak tersedia",
            "Tidak memenuhi syarat",
            # Chinese Simplified
            "此优惠目前不可用",
            "您不符合条件",
            "此优惠不适用于您",
            "此优惠在您所在的地区不可用",
            "您没有资格",
            "无法享受此优惠",
            "您不符合资格",
            "此优惠无法使用",
            "优惠不可用",
            "不符合享受资格",
            "您目前不符合",
            "此促销活动不可用",
            "很抱歉，此优惠",
            "此优惠已不可用",
            "无法使用此优惠",
            "您的帐号不符合",
            "此优惠不适用",
            "无资格",
            # Chinese Traditional
            "這項優惠目前無法使用",
            "您不符合資格",
            "此優惠不適用於您",
            "此優惠在您所在的地區不可用",
            "您沒有資格",
            "無法享受此優惠",
            "無法使用此優惠",
            "此優惠已無法使用",
            # Polish
            "Oferta niedostępna",
            "Nie kwalifikujesz się",
            # Romanian
            "Oferta nu este disponibilă",
            "Nu ești eligibil",
            "Această ofertă nu este disponibilă",
            # German
            "Die Aktion ist nicht verfügbar",
            "Dieses Angebot ist nicht verfügbar",
            "Sie sind nicht berechtigt",
            # Italian
            "L'offerta non è disponibile",
            "Non sei idoneo",
            # Hungarian
            "Ez az ajánlat nem áll rendelkezésre",
            "Nem jogosult",
            # Czech
            "Tato nabídka není k dispozici",
            "Nemáte nárok",
            # Turkish
            "Bu teklif kullanılamıyor",
            "Uygun değilsiniz",
            # Japanese
            "このオファーは利用できません",
            "対象外です",
            # Korean
            "이 혜택은 이용할 수 없습니다",
            "자격이 없습니다",
            # Thai
            "ข้อเสนอนี้ไม่พร้อมใช้งาน",
            # Russian
            "Это предложение недоступно",
            # Arabic
            "هذا العرض غير متاح",
        ]

        # Phrases indicating the account is already subscribed/verified
        subscribed_phrases = [
            # English
            "You're already subscribed",
            "Already subscribed",
            "manage your plan",
            "Your plan",
            # Vietnamese
            "Bạn đã đăng ký",
            "Đã đăng ký",
            # Chinese
            "已订阅",
            "您已訂閱",
            "管理方案",
            # Spanish
            "Ya estás suscrito",
            "Administrar tu plan",
            # French
            "Vous êtes déjà abonné",
            # Portuguese
            "Você já está inscrito",
            # Indonesian
            "Anda sudah berlangganan",
            # German
            "Sie haben bereits ein Abo",
            # Japanese
            "すでに登録されています",
            # Korean
            "이미 구독 중입니다",
            # Thai
            "คุณสมัครสมาชิกแล้ว",
            # Russian
            "Вы уже подписаны",
        ]

        # Phrases indicating verified but not bound ("Get student offer")
        verified_unbound_phrases = [
            # English
            "Get student offer",
            "Claim your offer",
            "Start your free trial",
            # Vietnamese
            "Nhận ưu đãi dành cho sinh viên",
            "Nhận ưu đãi sinh viên",
            # Spanish
            "Obtener oferta para estudiantes",
            "Obtén la oferta de estudiante",
            # Portuguese
            "Obter oferta de estudante",
            # French
            "Obtenir l'offre étudiante",
            # Chinese Simplified
            "获取学生优惠",
            "领取学生优惠",
            # Chinese Traditional
            "獲取學生優惠",
            "領取學生優惠",
            # Indonesian
            "Dapatkan penawaran pelajar",
            # German
            "Studentenangebot nutzen",
            # Japanese
            "学生向け特典を利用",
            # Korean
            "학생 혜택 받기",
            # Thai
            "รับข้อเสนอสำหรับนักศึกษา",
            # Russian
            "Получить студенческое предложение",
            # Italian
            "Ottieni offerta studenti",
            # Polish
            "Skorzystaj z oferty dla studentów",
            # Turkish
            "Öğrenci teklifini al",
        ]

        try:
            start_time = time.time()
            # 使用配置化的超时时间
            status_check_timeout = ConfigManager.get("timeouts.status_check", 20)
            print(f"Checking for eligibility (max {status_check_timeout}s)...")

            while time.time() - start_time < status_check_timeout:
                # 1. Check for "Already Subscribed" phrases
                is_subscribed = False
                for phrase in subscribed_phrases:
                    if await page.locator(f'text="{phrase}"').is_visible():
                        print(f"Detected subscribed state with phrase: {phrase}")
                        is_subscribed = True
                        break
                
                if is_subscribed:
                    # Save "Subscribed/Bound" accounts
                    save_path_subscribed = os.path.join(get_base_path(), "已绑卡号.txt")
                    
                    # Reconstruct account line
                    acc_line = account_info.get('email', '')
                    if 'password' in account_info:
                        acc_line += f"----{account_info['password']}"
                    if 'backup' in account_info:
                        acc_line += f"----{account_info['backup']}"
                    if 'secret' in account_info:
                        acc_line += f"----{account_info['secret']}"
                        
                    AccountManager.move_to_subscribed(acc_line)
                    print(f"Saved subscribed account to {save_path_subscribed}")
                    return True, "已绑卡 (Subscribed)"

                # 1.5 Check for "Verified Unbound" (Get Offer)
                is_verified_unbound = False
                unbound_href = ""
                for phrase in verified_unbound_phrases:
                    element = page.locator(f'text="{phrase}"')
                    if await element.is_visible():
                        print(f"Detected verified unbound state with phrase: {phrase}")
                        is_verified_unbound = True
                        # Try to extract href if it's a link
                        try:
                             if await element.evaluate("el => el.tagName === 'A'"):
                                 unbound_href = await element.get_attribute("href")
                             else:
                                 parent = element.locator("xpath=..")
                                 if await parent.count() > 0 and await parent.evaluate("el => el.tagName === 'A'"):
                                      unbound_href = await parent.get_attribute("href")
                        except: pass
                        break
                
                if is_verified_unbound:
                    save_path_verified = os.path.join(get_base_path(), "已验证未绑卡.txt")
                    acc_line = account_info.get('email', '')
                    if 'password' in account_info: acc_line += f"----{account_info['password']}"
                    if 'backup' in account_info: acc_line += f"----{account_info['backup']}"
                    if 'secret' in account_info: acc_line += f"----{account_info['secret']}"
                    if unbound_href: acc_line = f"{unbound_href}----{acc_line}"
                    
                    AccountManager.move_to_verified(acc_line)
                    print(f"Saved verified unbound account to {save_path_verified}")
                    return True, "已过验证未绑卡 (Get Offer)"

                # 2. Check for "This offer is not available" phrases
                # 先用 locator 精确匹配
                for phrase in not_available_phrases:
                    if await page.locator(f'text="{phrase}"').is_visible():
                        print(f"Detected invalid state with phrase: {phrase}")
                        is_invalid = True
                        break

                # 如果精确匹配失败，尝试检查页面文本中是否包含关键短语
                if not is_invalid:
                    try:
                        page_text = await page.inner_text('body')
                        if page_text:
                            for phrase in not_available_phrases:
                                if phrase in page_text:
                                    print(f"Detected invalid state (body text) with phrase: {phrase}")
                                    is_invalid = True
                                    break
                    except Exception:
                        pass

                if is_invalid:
                    break

                # 3. Check for Verify Link (Moved here)
                link_element = page.locator('a[href*="sheerid.com"]').first
                if await link_element.count() > 0:
                    found_link = True
                    
                    # Fallback: Translate button text to capture languages missed by verified_unbound_phrases
                    try:
                        text_content = await link_element.inner_text()
                        if text_content:
                            translated_text = GoogleTranslator(source='auto', target='en').translate(text_content).lower()
                            print(f"Translating link text: '{text_content}' -> '{translated_text}'")
                            
                            if "student offer" in translated_text or "get offer" in translated_text:
                                save_path_verified = os.path.join(get_base_path(), "已验证未绑卡.txt")
                                acc_line = account_info.get('email', '')
                                if 'password' in account_info: acc_line += f"----{account_info['password']}"
                                if 'backup' in account_info: acc_line += f"----{account_info['backup']}"
                                if 'secret' in account_info: acc_line += f"----{account_info['secret']}"
                                
                                href = await link_element.get_attribute("href")
                                if href: acc_line = f"{href}----{acc_line}"

                                AccountManager.move_to_verified(acc_line)
                                print(f"Saved verified unbound account (via translation) to {save_path_verified}")
                                return True, "已过验证未绑卡 (Get Offer Translated)"
                    except Exception as e:
                        print(f"Translation logic error during link check: {e}")
                        
                    break
                
                # Advanced Semantic Check (using Translation) if no direct match yet
                if not found_link and not is_subscribed and not is_invalid:
                    try:
                        # Extract headings/main text (h1, h2, or role=heading)
                        headings_loc = page.locator('h1, h2, [role="heading"]')
                        if await headings_loc.count() > 0:
                            headings = await headings_loc.all_inner_texts()
                            full_text = " ".join(headings).strip()
                            
                            if full_text and len(full_text) < 500:
                                # Translate to English
                                translated = GoogleTranslator(source='auto', target='en').translate(full_text)
                                translated_lower = translated.lower()
                                
                                # Semantic checks
                                if "already subscribed" in translated_lower or "manage plan" in translated_lower:
                                    print(f"Detected subscribed state via translation: {translated}")
                                    is_subscribed = True
                                elif any(phrase in translated_lower for phrase in [
                                    "not available", "offer is invalid", "not eligible",
                                    "ineligible", "unavailable", "cannot use", "can't use",
                                    "doesn't qualify", "does not qualify", "not qualify",
                                    "not applicable", "is not available", "isn't available"
                                ]):
                                    print(f"Detected invalid state via translation: {translated}")
                                    is_invalid = True
                    except Exception as e:
                        pass # Ignore translation errors

                # Handle Late Subscribed Detection
                if is_subscribed:
                    # Save "Subscribed/Bound" accounts
                    save_path_subscribed = os.path.join(get_base_path(), "已绑卡号.txt")
                    acc_line = account_info.get('email', '')
                    if 'password' in account_info: acc_line += f"----{account_info['password']}"
                    if 'backup' in account_info: acc_line += f"----{account_info['backup']}"
                    if 'secret' in account_info: acc_line += f"----{account_info['secret']}"
                        
                    AccountManager.move_to_subscribed(acc_line)
                    print(f"Saved subscribed account to {save_path_subscribed}")
                    return True, "已绑卡 (Subscribed-Trans)"

                if is_invalid:
                    break
                
                await asyncio.sleep(0.5) # Check more frequently

            if found_link:
                # Target the <a> tag directly using href substring logic
                link = page.locator('a[href*="sheerid.com"]').first
                print("Found 'Verify eligibility' link element (by href).")
                
                # Get href attribute
                href = await link.get_attribute("href")

                if href:
                    print(f"Extracted Link: {href}")
                    
                    full_acc = account_info.get('email', '')
                    if 'password' in account_info: full_acc += f"----{account_info['password']}"
                    if 'backup' in account_info: full_acc += f"----{account_info['backup']}"
                    if 'secret' in account_info: full_acc += f"----{account_info['secret']}"
                    
                    line = f"{href}----{full_acc}"
                    
                    # Save to DB (via AccountManager)
                    AccountManager.save_link(line)
                    print("Saved link and account info to DB")
                    return True, "提取成功 (Link Found)"
                else:
                    print("Link element found but has no href.")
                    # fallback to invalid if link has no href? Or just return False.
                    # Let's return False for now, but maybe user wants to see this.
                    await page.screenshot(path="debug_link_extraction_error.png")
            else:
                if is_invalid:
                    reason = "Offer not available"
                    print(f"Account marked as NOT eligible: {reason}")
                    full_acc = account_info.get('email', '')
                    if 'password' in account_info: full_acc += f"----{account_info['password']}"
                    if 'backup' in account_info: full_acc += f"----{account_info['backup']}"
                    if 'secret' in account_info: full_acc += f"----{account_info['secret']}"

                    AccountManager.move_to_ineligible(full_acc)
                    print(f"Saved to ineligible file")
                    return False, f"无资格 ({reason})"
                else:
                    reason = f"Timeout ({status_check_timeout}s allowed)"
                    print(f"Account timed out: {reason}")
                    full_acc = account_info.get('email', '')
                    if 'password' in account_info: full_acc += f"----{account_info['password']}"
                    if 'backup' in account_info: full_acc += f"----{account_info['backup']}"
                    if 'secret' in account_info: full_acc += f"----{account_info['secret']}"

                    AccountManager.move_to_error(full_acc)
                    print(f"Saved to error file")
                    await page.screenshot(path="debug_eligibility_timeout.png")
                    return False, f"超时 ({reason})" 

        except Exception as e:
            print(f"Failed to extract check eligibility: {e}")
            await page.screenshot(path="debug_eligibility_error.png")
            return False, f"错误: {str(e)}"

        # Brief wait before closing
        await asyncio.sleep(2)
        
    except Exception as e:
        print(f"An error occurred in automation: {e}")
        import traceback
        traceback.print_exc()
        return False
    
    return False

async def _async_process_wrapper(browser_id, account_info, ws_endpoint, log_callback=None):
    async with async_playwright() as playwright:
        return await _automate_login_and_extract(playwright, browser_id, account_info, ws_endpoint, log_callback)

def process_browser(profile_id, log_callback=None):
    """
    Synchronous entry point for processing a single browser.
    Returns (success, message)

    Args:
        profile_id: ixBrowser profile ID (integer)
    """
    print(f"Fetching info for profile ID: {profile_id}")

    target_browser = get_browser_info(profile_id)
    if not target_browser:
        # Fallback search
        print(f"Direct info fetch failed for {profile_id}, attempting list search...")
        browsers = get_browser_list(page=1, limit=1000)
        for b in browsers:
             if b.get('profile_id') == profile_id:
                 target_browser = b
                 break

    if not target_browser:
        return False, f"Profile {profile_id} not found."

    account_info = {}
    # ixBrowser uses 'note' instead of 'remark'
    remark = target_browser.get('note', '') or target_browser.get('remark', '')
    parts = remark.split('----')
    if len(parts) >= 4:
        account_info = {
            'email': parts[0].strip(),
            'password': parts[1].strip(),
            'backup': parts[2].strip(),
            'secret': parts[3].strip()
        }
    else:
        # Try to get credentials from profile fields directly
        account_info['email'] = target_browser.get('username') or target_browser.get('name', 'unknown')
        account_info['password'] = target_browser.get('password', '')
        account_info['secret'] = target_browser.get('tfa_secret', '')
        if len(parts) >= 1 and parts[0].strip():
             account_info['email'] = parts[0].strip()
        print("Note format invalid or empty, using profile fields for credentials.")

    print(f"Opening browser {profile_id}...")
    res = openBrowser(profile_id)
    if not res or not res.get('success', False):
        return False, f"Failed to open browser: {res}"

    ws_endpoint = res.get('data', {}).get('ws')
    if not ws_endpoint:
        closeBrowser(profile_id)
        return False, "No WebSocket endpoint returned."

    try:
        # Run automation
        result = asyncio.run(_async_process_wrapper(profile_id, account_info, ws_endpoint, log_callback))

        # Handle tuple return or boolean for backward compatibility
        if isinstance(result, tuple):
            success, msg = result
            return success, msg
        else:
            if result:
                return True, "Successfully extracted and saved link."
            else:
                return False, "Automation finished but link not found or error occurred."
    finally:
        print(f"Closing browser {profile_id}...")
        closeBrowser(profile_id)

if __name__ == "__main__":
    # Test with specific ID
    target_id = 1  # ixBrowser profile_id is integer
    success, msg = process_browser(target_id)
    print(f"Result: {success} - {msg}")
