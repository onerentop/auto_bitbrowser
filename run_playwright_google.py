import asyncio
import time
import pyotp
import re
import os
import sys
import threading
from playwright.async_api import async_playwright, Playwright
from ix_api import openBrowser, closeBrowser
from ix_window import get_browser_list, get_browser_info
from deep_translator import GoogleTranslator
from account_manager import AccountManager

# Global lock for file writing safety
file_write_lock = threading.Lock()

def get_base_path():
    if getattr(sys, 'frozen', False):
        return os.path.dirname(sys.executable)
    return os.path.dirname(os.path.abspath(__file__))

# Helper function for automation logic
async def _automate_login_and_extract(playwright: Playwright, browser_id: str, account_info: dict, ws_endpoint: str, log_callback=None):
    chromium = playwright.chromium
    try:
        browser = await chromium.connect_over_cdp(ws_endpoint)
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

        # 1. Enter Email (if input exists)
        email = account_info.get('email')
        
        try:
             # Check if email input exists
             email_input = await page.wait_for_selector('input[type="email"]', timeout=5000)
             if email_input:
                 print(f"Entering email: {email}")
                 if log_callback: log_callback(f"正在输入账号: {email}")
                 await email_input.fill(email)
                 await page.click('#identifierNext >> button')
                 
                 # 2. Enter Password
                 print("Waiting for password input...")
                 await page.wait_for_selector('input[type="password"]', state='visible')
                 password = account_info.get('password')
                 print("Entering password...")
                 await page.fill('input[type="password"]', password)
                 await page.click('#passwordNext >> button')

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
                              await totp_input.fill(code)
                              await page.click('#totpNext >> button')
                          else:
                              print("2FA secret not found in account info!")
                 except Exception as e:
                     print(f"2FA step exception (maybe skipped or different challenge): {e}")

        except Exception as e:
             print(f"Login flow might be skipped or failed (maybe already logged in): {e}")

        # Wait briefly after login attempt
        await asyncio.sleep(3)

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
            "This offer is not available",
            "Ưu đãi này hiện không dùng được", # Vietnamese
            "Esta oferta no está disponible", # Spanish
            "Cette offre n'est pas disponible", # French
            "Esta oferta não está disponível", # Portuguese
            "Tawaran ini tidak tersedia", # Indonesian
            "此优惠目前不可用", # Chinese Simplified
            "這項優惠目前無法使用", # Chinese Traditional
            "Oferta niedostępna", # Polish
            "Oferta nu este disponibilă", # Romanian
            "Die Aktion ist nicht verfügbar", # German
            "Il'offerta non è disponibile", # Italian
            "Această ofertă nu este disponibilă", 
            "Ez az ajánlat nem áll rendelkezésre", # Hungarian
            "Tato nabídka není k dispozici", # Czech
            "Bu teklif kullanılamıyor" # Turkish
        ]
        
        # Phrases indicating the account is already subscribed/verified
        subscribed_phrases = [
            "You're already subscribed",
            "Bạn đã đăng ký",
            "已订阅", 
            "Ya estás suscrito"
        ]
        
        # Phrases indicating verified but not bound ("Get student offer")
        verified_unbound_phrases = [
            "Get student offer",
            "Nhận ưu đãi dành cho sinh viên",
            "Obtener oferta para estudiantes",
            "Obter oferta de estudante",
            "获取学生优惠",
            "獲取學生優惠",
            "Dapatkan penawaran pelajar",
        ]

        try:
            start_time = time.time()
            # Polling loop for 10 seconds (User requested strict 10s timeout)
            print("Checking for eligibility (max 10s)...")
            
            while time.time() - start_time < 10:
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
                for phrase in not_available_phrases:
                    if await page.locator(f'text="{phrase}"').is_visible():
                        print(f"Detected invalid state with phrase: {phrase}")
                        is_invalid = True
                        break
                
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
                                elif "not available" in translated_lower or "offer is invalid" in translated_lower:
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
                    reason = "Timeout (10s allowed)"
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
