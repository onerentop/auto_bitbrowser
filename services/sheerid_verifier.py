import requests
import re
import json
import time
import logging

# 配置日志
logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')
logger = logging.getLogger(__name__)

BASE_URL = "https://neigui.1key.me"
DEFAULT_API_KEY = ""  # 请在GUI中输入你的SheerID API密钥


class SheerIDVerifier:
    def __init__(self, api_key=DEFAULT_API_KEY):
        self.session = requests.Session()
        self.api_key = api_key
        self.csrf_token = None
        self.headers = {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
            "Origin": BASE_URL,
            "Referer": f"{BASE_URL}/"
        }

    def _get_csrf_token(self):
        """Fetch homepage and extract CSRF token"""
        try:
            logger.info("Fetching CSRF token...")
            resp = self.session.get(BASE_URL, headers=self.headers, timeout=15)
            resp.raise_for_status()

            logger.debug(f"Response status: {resp.status_code}")
            logger.debug(f"Response length: {len(resp.text)} chars")

            # 尝试多种 CSRF token 模式
            patterns = [
                r'window\.CSRF_TOKEN\s*=\s*["\']([^"\']+)["\']',  # window.CSRF_TOKEN = "..."
                r'csrfToken["\']?\s*[:=]\s*["\']([^"\']+)["\']',  # csrfToken: "..." or csrfToken = "..."
                r'_csrf["\']?\s*[:=]\s*["\']([^"\']+)["\']',      # _csrf: "..." or _csrf = "..."
            ]

            for i, pattern in enumerate(patterns):
                match = re.search(pattern, resp.text, re.IGNORECASE)
                if match:
                    self.csrf_token = match.group(1)
                    self.headers["X-CSRF-Token"] = self.csrf_token
                    logger.info(f"✅ CSRF Token obtained (pattern {i+1}): {self.csrf_token[:10]}...")
                    return True

            # 如果都没匹配到，输出更详细的调试信息
            logger.error("❌ CSRF Token pattern not found in page.")
            logger.error(f"Page content preview (first 1000 chars):\n{resp.text[:1000]}")

            # 查找所有可能的 token 相关字符串
            token_hints = re.findall(r'(csrf|token|_token)[^"\']*["\']([^"\']{20,})["\']', resp.text, re.IGNORECASE)
            if token_hints:
                logger.info(f"Found potential token patterns: {token_hints[:3]}")

            # 尝试不使用 CSRF token 继续
            logger.warning("Attempting to proceed without CSRF token...")
            return False

        except Exception as e:
            logger.error(f"Failed to get CSRF token: {e}")
            import traceback
            logger.error(traceback.format_exc())
            return False

    def verify_batch(self, verification_ids, callback=None):
        """
        Verify a batch of IDs (list of strings).
        Returns a dict {verification_id: status_result}
        """
        # 每次批次验证前都刷新 CSRF token，确保 token 有效
        logger.info("Refreshing CSRF token before batch...")
        if not self._get_csrf_token():
            logger.warning("CSRF token refresh failed, attempting with old/no token")

        results = {}
        # Max 5 IDs per batch if API key is present
        # API requires hCaptchaToken to be the API Key for bypass

        payload = {
            "verificationIds": verification_ids,
            "hCaptchaToken": self.api_key,
            "useLucky": False,
            "programId": ""
        }

        headers = self.headers.copy()
        headers["Content-Type"] = "application/json"

        try:
            logger.info(f"Submitting batch verification for {len(verification_ids)} IDs...")
            logger.info(f"🔑 API Key: {self.api_key[:10] if self.api_key else '❌ EMPTY'}...")

            resp = self.session.post(
                f"{BASE_URL}/api/batch",
                headers=headers,
                json=payload,
                stream=True,
                timeout=30
            )

            # 如果返回 403/401，说明 token 还是过期了，再试一次
            if resp.status_code in [403, 401]:
                logger.warning(f"Token expired (status {resp.status_code}), refreshing again...")
                if self._get_csrf_token():
                    headers["X-CSRF-Token"] = self.csrf_token
                    resp = self.session.post(
                        f"{BASE_URL}/api/batch",
                        headers=headers,
                        json=payload,
                        stream=True,
                        timeout=30
                    )
                else:
                    return {vid: {"status": "error", "message": "Token expired and refresh failed"} for vid in verification_ids}

            # 检查响应状态
            if resp.status_code != 200:
                error_msg = f"HTTP {resp.status_code}: {resp.text[:200]}"
                logger.error(f"Batch request failed: {error_msg}")
                return {vid: {"status": "error", "message": error_msg} for vid in verification_ids}

            # Parse SSE Stream
            # The API returns "data: {...json...}" lines
            for line in resp.iter_lines():
                if not line:
                    continue
                decoded_line = line.decode('utf-8')
                if decoded_line.startswith("data:"):
                    json_str = decoded_line[5:].strip()
                    try:
                        data = json.loads(json_str)
                        self._handle_api_response(data, results, callback)
                    except json.JSONDecodeError:
                        pass

        except Exception as e:
            logger.error(f"Batch verify request failed: {e}")
            for vid in verification_ids:
                if vid not in results:
                    results[vid] = {"status": "error", "message": str(e)}

        return results

    def _handle_api_response(self, data, results, callback=None):
        """Handle individual data chunks from SSE or poll response"""
        vid = data.get("verificationId")
        if not vid: return

        status = data.get("currentStep")
        message = data.get("message", "")
        
        if callback:
            callback(vid, f"Step: {status} | Msg: {message}")

        if status == "pending" and "checkToken" in data:
            # Need to poll
            check_token = data["checkToken"]
            final_res = self._poll_status(check_token, vid, callback)
            results[vid] = final_res
        elif status == "success" or status == "error":
            # Done
            results[vid] = data

    def _poll_status(self, check_token, vid, callback=None):
        """Poll /api/check-status until success or error"""
        url = f"{BASE_URL}/api/check-status"
        headers = self.headers.copy()
        headers["Content-Type"] = "application/json"
        
        # Poll max 60 times (approx 120s)
        for i in range(60):
            try:
                time.sleep(2)  # Wait 2s between polls
                payload = {"checkToken": check_token}
                
                # 增加超时时间到 30 秒，避免网络慢导致超时
                resp = self.session.post(url, headers=headers, json=payload, timeout=30)
                json_data = resp.json()
                
                status = json_data.get("currentStep")
                message = json_data.get("message", "")
                
                if callback:
                    callback(vid, f"Polling: {status} ({i+1}/60) | Msg: {message}")

                if status == "success" or status == "error":
                    return json_data
                
                # If pending, update checkToken if provided
                if "checkToken" in json_data:
                    check_token = json_data["checkToken"]
                    
            except requests.exceptions.Timeout as e:
                # 网络超时，继续重试
                logger.warning(f"Polling timeout (attempt {i+1}/60), retrying...")
                if callback:
                    callback(vid, f"Polling: timeout (retrying {i+1}/60)")
                continue
                
            except Exception as e:
                logger.error(f"Polling failed: {e}")
                # 其他错误，也继续重试而不是立即失败
                if callback:
                    callback(vid, f"Polling error: {str(e)[:50]} (retrying {i+1}/60)")
                continue
        
        return {"status": "error", "message": "Polling timeout (120s)"}

    def cancel_verification(self, verification_id):
        """Cancel a verification process"""
        if not self.csrf_token:
            if not self._get_csrf_token():
                return {"status": "error", "message": "No CSRF Token"}
        
        url = f"{BASE_URL}/api/cancel"
        headers = self.headers.copy()
        headers["X-CSRF-Token"] = self.csrf_token
        headers["Content-Type"] = "application/json"
        
        try:
            resp = self.session.post(url, headers=headers, json={"verificationId": verification_id}, timeout=10)
            try:
                return resp.json()
            except:
                return {"status": "error", "message": f"Invalid JSON: {resp.text}"}
        except Exception as e:
            logger.error(f"Cancel failed: {e}")
            return {"status": "error", "message": str(e)}

if __name__ == "__main__":
    pass
