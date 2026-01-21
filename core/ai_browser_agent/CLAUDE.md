# AI Browser Agent

> 📍 **Breadcrumb**: [Root](../../CLAUDE.md) → [core](../CLAUDE.md) → ai_browser_agent

## Overview

基于 Gemini Vision 的通用 AI 浏览器自动化代理。通过视觉分析页面截图，智能决策并执行浏览器操作，无需维护脆弱的 CSS 选择器。

采用 OpenAI 兼容的 API 格式，默认使用 Gemini API，也支持其他兼容服务。

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│              AI Browser Agent                               │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│   ┌─────────────────────────────────────────────────────┐   │
│   │              VisionAnalyzer                          │   │
│   │  - 调用 Gemini Vision API (OpenAI 兼容)              │   │
│   │  - 分析页面截图                                       │   │
│   │  - 输出结构化动作指令                                 │   │
│   └──────────────────────┬──────────────────────────────┘   │
│                          │                                   │
│                          ▼                                   │
│   ┌─────────────────────────────────────────────────────┐   │
│   │              ActionExecutor                          │   │
│   │  - 执行 Playwright 操作                              │   │
│   │  - 智能元素定位                                       │   │
│   │  - 截图捕获                                           │   │
│   └─────────────────────────────────────────────────────┘   │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

## Module Structure

```
core/ai_browser_agent/
├── __init__.py           # 模块导出
├── types.py              # 类型定义 (ActionType, AgentAction, TaskResult, etc.)
├── prompts.py            # AI 提示词模板
├── vision_analyzer.py    # Gemini Vision API 集成 (OpenAI 兼容格式)
├── action_executor.py    # Playwright 动作执行器
└── agent.py              # AIBrowserAgent 核心类
```

## Components

### AIBrowserAgent (agent.py)

核心代理类，整合视觉分析和动作执行。

**Key Methods**:
| Method | Description |
|--------|-------------|
| `execute_task(page, goal, ...)` | 在给定页面上执行自动化任务 |
| `on_action(callback)` | 设置动作回调 |
| `on_step(callback)` | 设置步骤回调 |
| `stop()` | 请求停止执行 |

**Convenience Function**:
```python
from core.ai_browser_agent.agent import run_with_ixbrowser

result = await run_with_ixbrowser(
    browser_id="xxx",
    goal="修改 2SV 手机号",
    start_url="https://...",
    account={"email": "...", "password": "...", "secret": "..."},
    params={"new_phone": "+1234567890"},
    task_type="modify_2sv_phone",
)
```

### VisionAnalyzer (vision_analyzer.py)

Gemini Vision API 封装，使用 OpenAI 兼容格式。

**Key Methods**:
| Method | Description |
|--------|-------------|
| `analyze(screenshot, context, task_type)` | 分析截图并返回动作决策 |
| `test_connection()` | 测试 API 连接是否正常 |

**Environment Variables**:
- `GEMINI_API_KEY`: Gemini API 密钥
- `GEMINI_BASE_URL`: API Base URL（可选，默认使用 Gemini OpenAI 兼容 API）

**Default Configuration**:
- Base URL: `https://generativelanguage.googleapis.com/v1beta/openai/`
- Model: `gemini-2.5-flash`

### ActionExecutor (action_executor.py)

将 AI 决策转换为 Playwright 操作。

**Supported Actions**:
| ActionType | Description |
|------------|-------------|
| `CLICK` | 点击元素（支持坐标或描述定位） |
| `FILL` | 填写输入框 |
| `TYPE` | 逐字符输入（触发键盘事件） |
| `PRESS` | 按键 |
| `SCROLL` | 滚动页面 |
| `WAIT` | 等待指定时间 |
| `NAVIGATE` | 导航到 URL |
| `DONE` | 任务完成 |
| `ERROR` | 错误终止 |
| `NEED_VERIFICATION` | 需要验证码 |

## Usage Examples

### Basic Usage

```python
import asyncio
from playwright.async_api import async_playwright
from core.ai_browser_agent import AIBrowserAgent

async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=False)
        page = await browser.new_page()

        agent = AIBrowserAgent()
        result = await agent.execute_task(
            page=page,
            goal="登录 Google 账号",
            start_url="https://accounts.google.com",
            account={"email": "user@gmail.com", "password": "xxx"},
            max_steps=15,
        )

        print(f"Success: {result.success}, Message: {result.message}")
        await browser.close()

asyncio.run(main())
```

### With ixBrowser

```python
from core.ai_browser_agent.agent import run_with_ixbrowser

result = await run_with_ixbrowser(
    browser_id="your_browser_id",
    goal="修改辅助邮箱为 backup@example.com",
    start_url="https://myaccount.google.com/recovery/email",
    account={"email": "user@gmail.com", "password": "xxx", "secret": "2FA_SECRET"},
    params={"new_email": "backup@example.com"},
    task_type="replace_recovery_email",
    close_after=True,
)
```

## Task Types

预定义的任务类型，包含特定的提示词：

| Task Type | Description |
|-----------|-------------|
| `modify_2sv_phone` | 修改 2-Step Verification 手机号 |
| `replace_recovery_email` | 修改辅助邮箱 |
| `replace_recovery_phone` | 修改辅助手机号 |

## Cost Estimation (Gemini)

| Operation | Estimated Cost |
|-----------|----------------|
| 单次截图分析 | ~$0.001-0.003 |
| 完整任务 (10 步) | ~$0.01-0.03 |
| 100 账号批量处理 | ~$1-3 |

*Gemini Flash 价格非常低廉*

## Dependencies

- **openai**: OpenAI 兼容 API 客户端
- **playwright**: 浏览器自动化

```bash
pip install openai playwright
```

---

*Updated for Gemini Vision API*
