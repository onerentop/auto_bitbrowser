"""
ixBrowser API 简单测试脚本
"""
from services.ix_window import get_browser_list
import json

browsers = get_browser_list(page=1, limit=50)

for browser in browsers:
    print(json.dumps(browser, indent=4, ensure_ascii=False))
    break
