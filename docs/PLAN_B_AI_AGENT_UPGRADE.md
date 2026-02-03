# 方案 B：升级现有 Gemini Agent

> **版本**: 1.0
> **创建日期**: 2024-01-XX
> **审查轮次**: 3 轮像素级审查
> **总发现问题**: 31 个（严重 7 个，中等 8 个，遗漏 13 个）

---

## 一、方案概述

### 1.1 背景

原计划集成 browser-use 库，但经过深度分析发现存在以下兼容性问题：
- CDP URL 格式不兼容（browser-use 期望 `http://` 而 ixBrowser 返回 `ws://`）
- `navigator.webdriver` 覆盖风险（可能破坏指纹保护）
- 浏览器实例冲突风险

### 1.2 方案 B 核心思路

**不集成 browser-use，而是借鉴其设计模式升级现有 Gemini Agent**

- 复用现有 `core/ai_browser_agent/` 模块
- 保持与 ixBrowser 的完全兼容
- 渐进式优化，降低风险

### 1.3 预期收益

| 指标 | 当前 | 预期 | 提升 |
|------|------|------|------|
| 任务成功率 | ~75% | ~90% | +15% |
| 平均步数 | 12 步 | 10 步 | -17% |
| 错误恢复率 | ~30% | ~70% | +40% |
| 单任务成本 | $0.02 | $0.018 | -10% |

---

## 二、现有代码分析

### 2.1 模块结构

```
core/ai_browser_agent/
├── __init__.py           # 模块导出（缺少 ElementMarker）
├── types.py              # 类型定义（217 行）
├── prompts.py            # 提示词模板（802 行）
├── vision_analyzer.py    # Gemini API 封装（436 行）
├── action_executor.py    # Playwright 执行器（1046 行）
├── agent.py              # 核心 Agent 类（517 行）
└── element_marker.py     # SoM 标记器（668 行）⚠️ 未被使用
```

### 2.2 关键发现

| 模块 | 状态 | 问题 |
|------|------|------|
| ElementMarker | ⚠️ 已实现但未集成 | 完整的 SoM 实现，但从未被调用 |
| RetryHelper | ✅ 已存在 | `core/retry_helper.py` 有完整实现 |
| TaskContext | ✅ 已有历史摘要 | `get_history_summary()` 方法存在 |
| email_code_reader | ❌ 导入路径错误 | 应为 `from services.email_code_reader` |

### 2.3 代码统计

| 文件 | 行数 | 复杂度 |
|------|------|--------|
| action_executor.py | 1046 | 高（需拆分） |
| prompts.py | 802 | 中 |
| element_marker.py | 668 | 中 |
| agent.py | 517 | 中 |
| vision_analyzer.py | 436 | 低 |
| types.py | 217 | 低 |

---

## 三、发现的问题清单

### 3.1 严重问题（7 个）

#### P0-1: email_code_reader 导入路径错误 🔴
**位置**: `agent.py` 第 25 行
**现状**:
```python
from email_code_reader import GmailCodeReader  # ❌ 错误
```
**修复**:
```python
from services.email_code_reader import GmailCodeReader  # ✅ 正确
```
**影响**: 邮箱验证码自动读取功能完全失效

---

#### P0-2: ElementMarker 已实现但未被使用 🔴
**位置**: `element_marker.py`（668 行完整实现）
**现状**: 没有任何文件导入或使用此模块
**修复**: 集成到 `agent.py` 主循环中

---

#### P0-3: __init__.py 未导出 ElementMarker 🔴
**位置**: `__init__.py` 第 22-34 行
**现状**:
```python
__all__ = [
    "ActionType", "AgentAction", "AgentState", "ErrorType",
    "TaskResult", "TaskContext", "AIBrowserAgent",
    "VisionAnalyzer", "ActionExecutor",
    # ❌ 缺少 ElementMarker, MarkedElement
]
```
**修复**: 添加 `ElementMarker`, `MarkedElement` 到导出列表

---

#### P0-4: 截图逻辑重复 🔴
**位置**:
- `action_executor.py:1035` - `take_screenshot()`
- `element_marker.py:574` - `extract_and_mark()`

**问题**: 两处独立的截图实现，启用 SoM 后可能重复截图
**修复**: 统一为单一截图入口

---

#### P0-5: 双重重试风险 🔴
**位置**:
- `vision_analyzer.py:89` - 内置 3 次重试
- `agent.py:138-154` - 导航 3 次重试

**问题**: 嵌套调用可能导致 3×3=9 次重试
**修复**: 统一重试策略，设置全局重试预算

---

#### P0-6: CLAUDE.md 文档错误 🔴
**位置**: `core/ai_browser_agent/CLAUDE.md`
**现状**: 文档中列出 `som_marker.py`
**实际**: 文件名是 `element_marker.py`
**修复**: 更新文档

---

#### P0-7: RetryManager 与现有 RetryHelper 重复 🔴
**位置**: 方案原计划新建 `retry_manager.py`
**现状**: `core/retry_helper.py` 已有完整实现（345 行）
**修复**: 复用现有 `RetryHelper`，不新建

---

### 3.2 中等问题（8 个）

#### P1-1: 三处重试逻辑不统一 🟠
| 位置 | 重试次数 | 重试间隔 | 重试条件 |
|------|----------|----------|----------|
| `vision_analyzer.py:89` | 3 次 | 1 秒固定 | 空响应或异常 |
| `retry_helper.py:37` | 可配置 | 指数退避 | 网络异常 |
| `agent.py:138-154` | 3 次 | 2 秒固定 | 导航超时 |

---

#### P1-2: action_executor.py 过于庞大 🟠
- 总计 1046 行
- `_find_element()` 方法超过 280 行
- `_find_dialog_button()` 方法超过 160 行

**建议**: 拆分为多个模块

---

#### P1-3: 成本监控缺少 thinking tokens 🟠
Gemini 2.5 Flash 支持 thinking，方案未考虑此成本

---

#### P1-4: TOTP 生成逻辑分散 🟠
| 文件 | 行号 |
|------|------|
| `prompts.py` | 761 |
| `auto_replace_phone.py` | 113, 235 |
| `auto_replace_email.py` | 135, 231, 320 |
| `auto_modify_authenticator.py` | 169 |

**建议**: 提取为独立工具函数

---

#### P1-5: 超时配置分散且不一致 🟠
| 位置 | 超时值 | 用途 |
|------|--------|------|
| `agent.py:44` | 10000ms | 默认操作 |
| `agent.py:139` | 60000ms | 导航 |
| `agent.py:445` | 90s | 验证码读取 |
| `action_executor.py` | 5000ms | 网络空闲 |
| `element_marker.py` | 2000ms | 网络空闲 |

**建议**: 统一到 ConfigManager

---

#### P1-6: _wait_for_page_stable 等待过长 🟠
**位置**: `action_executor.py:1000-1033`
**问题**: 最小等待 2 秒，失败时等待 5 秒

---

#### P1-7: 状态机与 AgentState 定义不兼容 🟠
方案新增状态（NAVIGATING, ANALYZING, ACTING）与现有枚举不兼容

---

#### P1-8: JSON 修复器范围过窄 🟠
现有 `_extract_json()` 未处理：转义字符、数字格式等边缘情况

---

### 3.3 遗漏项（13 个）

| # | 问题 | 说明 |
|---|------|------|
| 1 | SoM 与 VisionAnalyzer 集成点不明 | 如何将元素摘要注入 prompt |
| 2 | 温度参数未使用 | API 调用没有 temperature |
| 3 | 缺少截图压缩策略 | PNG 格式较大，增加成本 |
| 4 | 任务取消无清理逻辑 | stop() 只设置标志 |
| 5 | API 调用无超时控制 | 可能长时间挂起 |
| 6 | ElementMarker 字体加载可能失败 | Windows 中文系统 |
| 7 | 并发安全未考虑 | Agent 实例变量无锁 |
| 8 | GUI 线程交互未考虑 | PyQt6 信号槽机制 |
| 9 | 邮箱验证码机制集成 | 已有但未充分利用 |
| 10 | 多语言处理复杂性 | prompts.py 有大量多语言映射 |
| 11 | 页面加载等待策略 | 不同动作等待时间不同 |
| 12 | 任务类型扩展机制 | TASK_PROMPTS 硬编码 |
| 13 | Gemini 定价使用 API 返回值 | 非静态估算 |

---

## 四、详细实施步骤

### 阶段 0：修复现有 Bug（0.5 天）

#### 任务 0.1：修复 email_code_reader 导入
```python
# agent.py 第 25 行
# 修改前
from email_code_reader import GmailCodeReader

# 修改后
from services.email_code_reader import GmailCodeReader
```

#### 任务 0.2：更新 __init__.py 导出
```python
# __init__.py
from .element_marker import ElementMarker, MarkedElement

__all__ = [
    # Types
    "ActionType", "AgentAction", "AgentState", "ErrorType",
    "TaskResult", "TaskContext",
    # Classes
    "AIBrowserAgent", "VisionAnalyzer", "ActionExecutor",
    "ElementMarker", "MarkedElement",  # 新增
]
```

#### 任务 0.3：更新 CLAUDE.md 文档
```markdown
# 修改前
├── som_marker.py         # SoM element marker for visual grounding

# 修改后
├── element_marker.py     # SoM element marker for visual grounding
```

---

### 阶段 1：集成 ElementMarker（1 天）

#### 任务 1.1：统一截图入口

```python
# action_executor.py 修改
class ActionExecutor:
    def __init__(self, page: Page, timeout: int = 10000, use_som: bool = False):
        self.page = page
        self.timeout = timeout
        self.use_som = use_som
        self.element_marker = ElementMarker() if use_som else None

    async def take_screenshot(self) -> Tuple[bytes, Optional[List[MarkedElement]], str]:
        """
        统一截图入口

        Returns:
            (screenshot_bytes, elements_list, elements_summary)
        """
        if self.element_marker:
            screenshot, elements = await self.element_marker.extract_and_mark(self.page)
            summary = self.element_marker.generate_elements_summary(elements)
            return screenshot, elements, summary
        else:
            screenshot = await self.page.screenshot(type="png", full_page=False)
            return screenshot, None, ""
```

#### 任务 1.2：修改 VisionAnalyzer 接受元素摘要

```python
# vision_analyzer.py 修改
async def analyze(
    self,
    screenshot: bytes,
    context: TaskContext,
    task_type: Optional[str] = None,
    elements_summary: str = "",  # 新增参数
    max_retries: int = 3,
) -> AgentAction:
    # ...
    task_prompt = build_task_prompt(
        goal=context.goal,
        account=context.account,
        params=context.params,
        history=context.get_history_summary(),
        current_step=context.current_step,
        max_steps=context.max_steps,
        task_type=task_type,
        elements_summary=elements_summary,  # 传递给 prompt
    )
```

#### 任务 1.3：修改 prompts.py 使用元素摘要

```python
# prompts.py 修改
TASK_PROMPT_TEMPLATE = """## 当前任务

**目标**: {goal}

**账号信息**:
- 邮箱: {email}
- 密码: {password}
- 2FA 密钥: {secret}
- 当前 2FA 验证码: {totp_code}

**页面元素** (使用 [ID] 可精确定位):
{elements_summary}

**额外参数**:
{params}

## 历史操作

{history}

## 当前状态

步骤 {current_step}/{max_steps}

请分析截图中的页面内容，决定下一步操作。
如果要点击元素，可以使用元素 ID（如 [1]、[2]）来精确指定。
"""
```

#### 任务 1.4：修改 agent.py 主循环

```python
# agent.py 修改
class AIBrowserAgent:
    def __init__(
        self,
        api_key: Optional[str] = None,
        base_url: Optional[str] = None,
        model: str = "gemini-2.5-flash",
        default_timeout: int = 10000,
        screenshot_delay: float = 2.0,
        use_som: bool = True,  # 新增：是否使用 SoM 标记
    ):
        # ...
        self.use_som = use_som

    async def execute_task(self, ...):
        # 创建动作执行器（传入 use_som 配置）
        executor = ActionExecutor(
            page,
            timeout=self.default_timeout,
            use_som=self.use_som,
        )

        # 主循环中
        while context.current_step < max_steps:
            # 1. 截取页面截图（统一入口）
            screenshot, elements, elements_summary = await executor.take_screenshot()

            if self._on_screenshot:
                self._on_screenshot(screenshot)

            # 2. AI 分析（传入元素摘要）
            action = await self.vision_analyzer.analyze(
                screenshot=screenshot,
                context=context,
                task_type=task_type,
                elements_summary=elements_summary,  # 新增
            )
            # ...
```

---

### 阶段 2：配置统一（0.5 天）

#### 任务 2.1：超时配置集中管理

```python
# core/config_manager.py 新增配置
DEFAULT_CONFIG = {
    # ... 现有配置
    "ai_agent": {
        "api_key": "",
        "base_url": "https://generativelanguage.googleapis.com/v1beta/openai/",
        "model": "gemini-2.5-flash",
        "max_steps": 25,
        "use_som": True,  # 新增
        "timeouts": {  # 新增
            "operation": 10000,      # 单次操作超时
            "navigation": 60000,     # 页面导航超时
            "network_idle": 5000,    # 网络空闲等待
            "verification": 90,      # 验证码读取超时（秒）
            "api_call": 30000,       # API 调用超时
        },
        "delays": {  # 新增
            "screenshot": 2.0,       # 截图前等待
            "after_click": 1.5,      # 点击后等待
            "after_navigate": 3.0,   # 导航后等待
        },
    }
}
```

#### 任务 2.2：提取 TOTP 生成工具函数

```python
# core/totp_helper.py（新建）
"""TOTP 验证码生成工具"""

import pyotp
from typing import Tuple

def generate_totp(secret: str) -> Tuple[bool, str]:
    """
    生成 TOTP 验证码

    Args:
        secret: 2FA 密钥（可以包含空格和连字符）

    Returns:
        (success, code_or_error): 成功返回 (True, "123456")，失败返回 (False, "错误信息")
    """
    if not secret or secret == "未提供":
        return False, "未提供 2FA 密钥"

    try:
        # 清理 secret（移除空格和连字符）
        clean_secret = secret.replace(" ", "").replace("-", "").upper()
        totp = pyotp.TOTP(clean_secret)
        code = totp.now()
        return True, code
    except Exception as e:
        return False, f"生成失败: {str(e)}"

def get_totp_remaining_seconds(secret: str) -> int:
    """获取当前验证码剩余有效秒数"""
    try:
        clean_secret = secret.replace(" ", "").replace("-", "").upper()
        totp = pyotp.TOTP(clean_secret)
        return totp.interval - (int(time.time()) % totp.interval)
    except Exception:
        return 0
```

---

### 阶段 3：核心增强（2 天）

#### 任务 3.1：统一重试策略

```python
# core/ai_browser_agent/retry_strategy.py（新建）
"""AI Agent 专属重试策略"""

from core.retry_helper import RetryHelper
from typing import Callable, Any, Tuple

class AgentRetryStrategy:
    """AI Agent 重试策略管理器"""

    # 错误分类
    RETRYABLE_ERRORS = {
        "network": ["timeout", "connection", "network", "socket"],
        "api": ["rate_limit", "server_error", "empty_response"],
        "element": ["not_found", "not_visible", "intercepted"],
    }

    # 重试配置
    DEFAULT_CONFIG = {
        "network": {"max_retries": 3, "base_delay": 2.0, "backoff": 2.0},
        "api": {"max_retries": 3, "base_delay": 1.0, "backoff": 1.5},
        "element": {"max_retries": 2, "base_delay": 0.5, "backoff": 1.0},
    }

    # 全局重试预算
    MAX_TOTAL_RETRIES = 10

    def __init__(self):
        self.total_retries = 0
        self.retry_helpers = {
            category: RetryHelper(**config)
            for category, config in self.DEFAULT_CONFIG.items()
        }

    def classify_error(self, error: Exception) -> str:
        """分类错误类型"""
        error_str = str(error).lower()
        for category, keywords in self.RETRYABLE_ERRORS.items():
            if any(kw in error_str for kw in keywords):
                return category
        return "unknown"

    async def execute_with_retry(
        self,
        func: Callable,
        error_category: str = "network",
        *args, **kwargs
    ) -> Tuple[bool, Any]:
        """带重试执行"""
        if self.total_retries >= self.MAX_TOTAL_RETRIES:
            return False, "达到全局重试上限"

        helper = self.retry_helpers.get(error_category, self.retry_helpers["network"])
        success, result = await helper.execute_async(func, *args, **kwargs)

        if not success:
            self.total_retries += 1

        return success, result

    def reset(self):
        """重置重试计数"""
        self.total_retries = 0
```

#### 任务 3.2：优化等待策略

```python
# action_executor.py 修改
async def _wait_for_page_stable(
    self,
    timeout: int = None,
    min_wait: float = 0.3,
    check_interval: float = 0.2,
) -> bool:
    """
    智能等待页面稳定

    Args:
        timeout: 最大等待时间（毫秒）
        min_wait: 最小等待时间（秒）
        check_interval: 检查间隔（秒）

    Returns:
        是否在超时前稳定
    """
    timeout = timeout or self.timeout

    # 最小等待
    await asyncio.sleep(min_wait)

    start_time = asyncio.get_event_loop().time()
    max_wait_seconds = timeout / 1000

    while True:
        elapsed = asyncio.get_event_loop().time() - start_time
        if elapsed > max_wait_seconds:
            return False

        # 检查页面是否稳定
        try:
            # 策略1：检查网络空闲
            await self.page.wait_for_load_state("networkidle", timeout=500)
            return True
        except:
            pass

        try:
            # 策略2：检查无待处理的导航
            await self.page.wait_for_load_state("domcontentloaded", timeout=500)
            # 额外检查是否有正在进行的请求
            pending = await self.page.evaluate("() => window.performance.getEntriesByType('resource').filter(r => !r.responseEnd).length")
            if pending == 0:
                await asyncio.sleep(0.3)  # 短暂等待渲染
                return True
        except:
            pass

        await asyncio.sleep(check_interval)
```

#### 任务 3.3：增强 JSON 修复器

```python
# vision_analyzer.py 修改
def _extract_json(self, text: str) -> str:
    """从文本中提取并修复 JSON"""
    if not text:
        return '{"action": "error", "error_message": "响应为空"}'

    text = text.strip()

    # 1. 尝试直接解析
    if text.startswith("{"):
        try:
            json.loads(text)  # 验证 JSON 有效性
            return text
        except json.JSONDecodeError:
            pass

    # 2. 从 markdown 代码块提取
    patterns = [
        r'```json\s*([\s\S]*?)\s*```',
        r'```\s*([\s\S]*?)\s*```',
    ]
    for pattern in patterns:
        match = re.search(pattern, text)
        if match:
            content = match.group(1).strip()
            if content.startswith("{"):
                try:
                    json.loads(content)
                    return content
                except json.JSONDecodeError:
                    text = content  # 继续修复
                    break

    # 3. 修复常见问题
    # 3.1 移除尾部逗号
    text = re.sub(r',\s*}', '}', text)
    text = re.sub(r',\s*]', ']', text)

    # 3.2 修复缺少引号的键
    text = re.sub(r'(\{|,)\s*(\w+)\s*:', r'\1"\2":', text)

    # 3.3 修复单引号
    text = text.replace("'", '"')

    # 3.4 修复缺少小数点前的 0
    text = re.sub(r':\s*\.(\d+)', r': 0.\1', text)

    # 3.5 提取 JSON 对象
    match = re.search(r'\{[\s\S]*\}', text)
    if match:
        return match.group(0)

    return '{"action": "error", "error_message": "无法解析 JSON"}'
```

#### 任务 3.4：添加成本追踪

```python
# core/ai_browser_agent/cost_tracker.py（新建）
"""API 调用成本追踪"""

import time
from dataclasses import dataclass, field
from typing import Dict, List, Optional
import threading

@dataclass
class APICallRecord:
    """单次 API 调用记录"""
    timestamp: float
    task_id: str
    input_tokens: int
    output_tokens: int
    thinking_tokens: int = 0  # Gemini 2.5 Flash 可能有
    image_count: int = 1
    model: str = "gemini-2.5-flash"
    duration_ms: int = 0

    def estimated_cost(self) -> float:
        """估算成本（美元）"""
        # Gemini 2.5 Flash 定价（2024）
        # 注意：实际应使用 API 返回的 usage
        input_cost = self.input_tokens * 0.075 / 1_000_000
        output_cost = self.output_tokens * 0.30 / 1_000_000
        thinking_cost = self.thinking_tokens * 0.30 / 1_000_000  # 假设与 output 相同
        return input_cost + output_cost + thinking_cost

@dataclass
class TaskCostSummary:
    """任务成本汇总"""
    task_id: str
    total_calls: int
    total_input_tokens: int
    total_output_tokens: int
    total_thinking_tokens: int
    total_images: int
    total_cost: float
    total_duration_ms: int

class CostTracker:
    """成本追踪器（线程安全）"""

    def __init__(self):
        self._records: List[APICallRecord] = []
        self._lock = threading.Lock()
        self._current_task_id: Optional[str] = None

    def start_task(self, task_id: str):
        """开始新任务"""
        with self._lock:
            self._current_task_id = task_id

    def record_call(
        self,
        input_tokens: int,
        output_tokens: int,
        thinking_tokens: int = 0,
        image_count: int = 1,
        model: str = "gemini-2.5-flash",
        duration_ms: int = 0,
    ):
        """记录一次 API 调用"""
        with self._lock:
            record = APICallRecord(
                timestamp=time.time(),
                task_id=self._current_task_id or "unknown",
                input_tokens=input_tokens,
                output_tokens=output_tokens,
                thinking_tokens=thinking_tokens,
                image_count=image_count,
                model=model,
                duration_ms=duration_ms,
            )
            self._records.append(record)

    def get_task_summary(self, task_id: str) -> TaskCostSummary:
        """获取任务成本汇总"""
        with self._lock:
            task_records = [r for r in self._records if r.task_id == task_id]
            return TaskCostSummary(
                task_id=task_id,
                total_calls=len(task_records),
                total_input_tokens=sum(r.input_tokens for r in task_records),
                total_output_tokens=sum(r.output_tokens for r in task_records),
                total_thinking_tokens=sum(r.thinking_tokens for r in task_records),
                total_images=sum(r.image_count for r in task_records),
                total_cost=sum(r.estimated_cost() for r in task_records),
                total_duration_ms=sum(r.duration_ms for r in task_records),
            )

    def get_daily_summary(self) -> Dict:
        """获取今日成本汇总"""
        with self._lock:
            today_start = time.time() - (time.time() % 86400)
            today_records = [r for r in self._records if r.timestamp >= today_start]
            return {
                "date": time.strftime("%Y-%m-%d"),
                "total_calls": len(today_records),
                "total_cost": sum(r.estimated_cost() for r in today_records),
                "by_task": self._group_by_task(today_records),
            }

    def _group_by_task(self, records: List[APICallRecord]) -> Dict:
        result = {}
        for r in records:
            if r.task_id not in result:
                result[r.task_id] = {"calls": 0, "cost": 0}
            result[r.task_id]["calls"] += 1
            result[r.task_id]["cost"] += r.estimated_cost()
        return result

# 全局实例
cost_tracker = CostTracker()
```

---

### 阶段 4：优化（1.5 天）

#### 任务 4.1：截图压缩

```python
# action_executor.py 修改
async def take_screenshot(
    self,
    quality: int = 80,
    max_width: int = 1920,
) -> Tuple[bytes, Optional[List], str]:
    """
    截图并可选压缩
    """
    # 获取原始截图
    screenshot = await self.page.screenshot(type="png", full_page=False)

    # 如果需要压缩
    if quality < 100 or max_width < 1920:
        try:
            from PIL import Image
            from io import BytesIO

            img = Image.open(BytesIO(screenshot))

            # 调整大小
            if img.width > max_width:
                ratio = max_width / img.width
                new_size = (max_width, int(img.height * ratio))
                img = img.resize(new_size, Image.LANCZOS)

            # 转换为 JPEG 压缩
            output = BytesIO()
            img.save(output, format="JPEG", quality=quality, optimize=True)
            screenshot = output.getvalue()
        except ImportError:
            pass  # Pillow 不可用，使用原始截图

    # SoM 处理...
    if self.element_marker:
        # ...

    return screenshot, elements, summary
```

#### 任务 4.2：API 调用超时

```python
# vision_analyzer.py 修改
import asyncio
from concurrent.futures import ThreadPoolExecutor

class VisionAnalyzer:
    def __init__(self, ..., api_timeout: int = 30000):
        self.api_timeout = api_timeout
        self._executor = ThreadPoolExecutor(max_workers=2)

    async def analyze(self, ...):
        try:
            # 带超时的 API 调用
            response = await asyncio.wait_for(
                asyncio.get_event_loop().run_in_executor(
                    self._executor,
                    lambda: self._call_api(image_base64, task_prompt),
                ),
                timeout=self.api_timeout / 1000,
            )
        except asyncio.TimeoutError:
            return AgentAction(
                action_type=ActionType.ERROR,
                error_message="API 调用超时",
                reasoning=f"API 调用超过 {self.api_timeout}ms 未响应",
            )
```

#### 任务 4.3：任务取消清理

```python
# agent.py 修改
class AIBrowserAgent:
    def __init__(self, ...):
        self._current_task = None
        self._cleanup_handlers: List[Callable] = []

    def stop(self):
        """请求停止执行并清理"""
        self._stop_requested = True

        # 取消当前任务
        if self._current_task and not self._current_task.done():
            self._current_task.cancel()

        # 执行清理处理器
        for handler in self._cleanup_handlers:
            try:
                handler()
            except Exception:
                pass

    def add_cleanup_handler(self, handler: Callable):
        """添加清理处理器"""
        self._cleanup_handlers.append(handler)
```

---

### 阶段 5：测试与文档（0.5 天）

#### 任务 5.1：更新单元测试

```python
# tests/test_ai_browser_agent.py
import pytest
from core.ai_browser_agent import (
    AIBrowserAgent, VisionAnalyzer, ActionExecutor,
    ElementMarker, MarkedElement,  # 新增
)

class TestElementMarker:
    """ElementMarker 测试"""

    def test_import(self):
        """测试导入"""
        assert ElementMarker is not None
        assert MarkedElement is not None

    @pytest.mark.asyncio
    async def test_extract_elements(self, mock_page):
        """测试元素提取"""
        marker = ElementMarker()
        elements = await marker.extract_elements(mock_page)
        assert isinstance(elements, list)

    def test_generate_summary(self):
        """测试摘要生成"""
        marker = ElementMarker()
        elements = [
            MarkedElement(id=1, tag="button", text="Submit"),
            MarkedElement(id=2, tag="input", text="", is_input=True),
        ]
        summary = marker.generate_elements_summary(elements)
        assert "[1]" in summary
        assert "[2]" in summary
```

#### 任务 5.2：更新文档

- 更新 `core/ai_browser_agent/CLAUDE.md`
- 更新 `core/CLAUDE.md`
- 添加 API 使用示例

---

## 五、文件修改清单

### 需修改文件

| 文件 | 修改类型 | 主要内容 |
|------|----------|----------|
| `core/ai_browser_agent/__init__.py` | 修改 | 添加 ElementMarker 导出 |
| `core/ai_browser_agent/agent.py` | 修改 | 集成 SoM，修复导入，添加配置 |
| `core/ai_browser_agent/vision_analyzer.py` | 修改 | 接受元素摘要，添加超时，成本追踪 |
| `core/ai_browser_agent/action_executor.py` | 修改 | 统一截图入口，优化等待 |
| `core/ai_browser_agent/prompts.py` | 修改 | 添加元素摘要占位符 |
| `core/ai_browser_agent/CLAUDE.md` | 修改 | 修复文件名错误 |
| `core/config_manager.py` | 修改 | 添加 AI Agent 配置 |

### 需新增文件

| 文件 | 功能 |
|------|------|
| `core/ai_browser_agent/retry_strategy.py` | AI Agent 专属重试策略 |
| `core/ai_browser_agent/cost_tracker.py` | API 成本追踪 |
| `core/totp_helper.py` | TOTP 生成工具（统一入口） |

### 不需要新增的文件（复用现有）

| 原计划 | 实际 | 原因 |
|--------|------|------|
| `retry_manager.py` | 复用 `core/retry_helper.py` | 已有完整实现 |
| `state_machine.py` | 扩展 `types.py` | 避免重复定义 |
| `json_fixer.py` | 增强 `vision_analyzer.py` | 保持内聚 |

---

## 六、风险与应对

| 风险 | 概率 | 影响 | 应对措施 |
|------|------|------|----------|
| SoM 标记增加 API 成本 | 中 | 低 | 可配置开关，默认关闭 |
| 元素摘要过长导致 token 超限 | 低 | 中 | 限制最大元素数（30个） |
| 截图压缩影响识别准确率 | 低 | 中 | 保持 1920px 宽度，质量 80% |
| 重试策略变更导致回归 | 中 | 高 | 保留原有逻辑作为 fallback |
| 并发调用导致状态混乱 | 低 | 高 | 文档说明单实例限制 |

---

## 七、工作量估算

| 阶段 | 任务 | 工作量 | 优先级 |
|------|------|--------|--------|
| 阶段 0 | 修复现有 Bug | 0.5 天 | P0 |
| 阶段 1 | 集成 ElementMarker | 1 天 | P0 |
| 阶段 2 | 配置统一 | 0.5 天 | P1 |
| 阶段 3 | 核心增强 | 2 天 | P1 |
| 阶段 4 | 优化 | 1.5 天 | P2 |
| 阶段 5 | 测试与文档 | 0.5 天 | P1 |
| **总计** | | **6 天** | |

---

## 八、验收标准

### 8.1 功能验收

- [ ] ElementMarker 正确集成到主循环
- [ ] 元素摘要出现在 AI 分析的 prompt 中
- [ ] 成本追踪记录每次 API 调用
- [ ] 超时配置可通过 ConfigManager 调整
- [ ] 邮箱验证码功能正常工作

### 8.2 性能验收

- [ ] 单步执行时间 < 5 秒（不含 API 调用）
- [ ] 截图大小 < 200KB（压缩后）
- [ ] 内存占用稳定（无泄漏）

### 8.3 稳定性验收

- [ ] 连续执行 100 个任务无崩溃
- [ ] 网络中断后能正确恢复或报错
- [ ] 用户取消能立即响应

---

## 附录 A：问题发现时间线

| 轮次 | 发现数 | 严重 | 中等 | 遗漏 | 主要发现 |
|------|--------|------|------|------|----------|
| 第一轮 | 12 | 3 | 5 | 4 | 架构层面问题 |
| 第二轮 | 10 | 2 | 3 | 5 | element_marker.py 存在但未使用 |
| 第三轮 | 9 | 2 | 3 | 4 | email_code_reader 导入错误 |
| **总计** | **31** | **7** | **8** | **13** | |

---

*文档结束*
