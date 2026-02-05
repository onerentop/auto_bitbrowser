# CDP + AI 融合方案设计文档

> **创建日期**: 2024-02-02
> **状态**: 提案阶段
> **相关模块**: `core/ai_browser_agent/`, `automation/`

---

## 1. 背景与目标

### 1.1 当前架构

现有系统采用"串联"模式：

```
现有架构:
┌─────────────────────────────────────────────────────────┐
│                   AIBrowserAgent                         │
├────────────────┬────────────────┬───────────────────────┤
│ VisionAnalyzer │  LLM Provider  │     ActionExecutor    │
│   (截图分析)    │  (Gemini/Claude)│   (执行动作)          │
└───────┬────────┴───────┬────────┴──────────┬────────────┘
        │                │                    │
        ▼                ▼                    ▼
   [截图→Base64]    [决策引擎]         [CDP Service]
                                            │
                         ┌──────────────────┼──────────────┐
                         ▼                  ▼              ▼
                    Backend Node ID    AX Tree       Playwright
                      (精确点击)      (元素发现)     (兜底操作)
```

**问题**: AI 和 CDP 是"串联"关系，不是真正融合。每次操作都需要 AI 参与，导致：
- 延迟高（AI 调用 1-3 秒）
- 成本高（每步消耗 token）
- 依赖 AI 服务稳定性

### 1.2 目标

将 CDP 和 AI 深度融合，实现：
- **90%+ 场景** 仅用 CDP 快速完成（毫秒级）
- **复杂场景** 智能调用 AI 增强
- 统一的控制接口

---

## 2. 方案对比

### 2.1 方案 A: 增强型 CDP 智能层 (推荐 ⭐)

**核心思想**: CDP 作为主控制器，AI 仅在 CDP 无法处理时介入

```
┌───────────────────────────────────────────────────────────┐
│                 HybridBrowserController                    │
├───────────────────────────────────────────────────────────┤
│  ┌─────────────────┐    ┌──────────────────────────────┐  │
│  │  CDP Smart Core │───▶│  Rule-based Action Selector  │  │
│  │  • AX Tree解析   │    │  • 关键词匹配规则库           │  │
│  │  • 元素语义分析  │    │  • 多语言支持                 │  │
│  │  • 状态检测     │    │  • 优先级排序                 │  │
│  └────────┬────────┘    └──────────────┬───────────────┘  │
│           │                            │                   │
│           ▼                            ▼                   │
│  ┌─────────────────────────────────────────────────────┐  │
│  │              Fallback AI Analyzer                    │  │
│  │  • 仅在规则匹配失败时调用                            │  │
│  │  • 使用 CDP AX Tree 作为上下文 (非截图)              │  │
│  │  • 返回结构化操作指令                                │  │
│  └─────────────────────────────────────────────────────┘  │
└───────────────────────────────────────────────────────────┘
```

**优点**:
- 90%+ 场景不需要调用 AI，大幅降低延迟和成本
- CDP AX Tree 作为 AI 输入比截图更精准
- 保持现有代码结构，改动较小

**实现复杂度**: ⭐⭐ (中等)

---

### 2.2 方案 B: AI 优先 + CDP 执行层

**核心思想**: AI 始终参与决策，但用 AX Tree 替代截图

```
┌──────────────────────────────────────────────────────────┐
│                  AI-First Controller                      │
├──────────────────────────────────────────────────────────┤
│  输入层:                                                  │
│  ┌───────────────────────────────────────────────────┐   │
│  │  CDP AX Tree → 结构化元素描述 → LLM Prompt         │   │
│  │  (替代截图，Token更少，信息更精准)                   │   │
│  └───────────────────────────────────────────────────┘   │
│                                                          │
│  决策层:                                                  │
│  ┌───────────────────────────────────────────────────┐   │
│  │  LLM 返回: {"action": "click", "target_id": 123}   │   │
│  │  直接使用 backend_node_id，无需坐标计算            │   │
│  └───────────────────────────────────────────────────┘   │
│                                                          │
│  执行层:                                                  │
│  ┌───────────────────────────────────────────────────┐   │
│  │  CDP click_by_backend_node_id(target_id)           │   │
│  └───────────────────────────────────────────────────┘   │
└──────────────────────────────────────────────────────────┘
```

**优点**:
- AI 理解能力强，处理复杂/未知场景
- 无需维护大量规则
- 统一的控制流

**缺点**:
- 每步都调用 AI，成本高、延迟大
- 依赖 AI 服务稳定性

**实现复杂度**: ⭐⭐⭐ (较高)

---

### 2.3 方案 C: 双模态融合控制器 (最佳体验)

**核心思想**: CDP 和 AI 并行工作，智能选择最优路径

```
┌────────────────────────────────────────────────────────────┐
│                DualModeController                           │
├────────────────────────────────────────────────────────────┤
│                                                             │
│  ┌──────────────┐        ┌──────────────┐                  │
│  │  CDP 分析器   │        │  AI 分析器   │                  │
│  │  • AX Tree   │        │  • 截图/AX   │                  │
│  │  • 规则匹配   │        │  • 语义理解  │                  │
│  └──────┬───────┘        └──────┬───────┘                  │
│         │                       │                          │
│         ▼                       ▼                          │
│  ┌─────────────────────────────────────────────────────┐   │
│  │              Confidence Comparator                   │   │
│  │                                                      │   │
│  │  CDP_result = {action: "click", id: 123, conf: 0.95} │   │
│  │  AI_result  = {action: "click", id: 123, conf: 0.88} │   │
│  │                                                      │   │
│  │  → 选择置信度更高的结果执行                           │   │
│  │  → 如果结果冲突，优先 CDP (精确性更高)               │   │
│  └─────────────────────────────────────────────────────┘   │
│                                                             │
│  特性:                                                      │
│  • CDP 快速路径: 高置信度时直接执行，跳过 AI               │
│  • AI 增强路径: CDP 低置信度时，启用 AI 分析               │
│  • 学习反馈: 记录成功/失败，优化规则库                     │
└────────────────────────────────────────────────────────────┘
```

**优点**:
- 最佳平衡：速度 + 智能
- 自适应场景复杂度
- 可以逐步积累规则，减少 AI 调用

**缺点**:
- 实现最复杂
- 需要设计置信度评估机制

**实现复杂度**: ⭐⭐⭐⭐ (高)

---

## 3. 推荐方案: A + C 混合

### 3.1 分阶段实施路线

```
Phase 1 (当前可实施):
┌──────────────────────────────────────────────────┐
│  增强 CDP Smart Core                              │
│  • 扩展 AX Tree 关键词规则库                       │
│  • 增加多语言支持                                  │
│  • 增加元素类型智能匹配                            │
│  • AI 仅作为最后 fallback                         │
└──────────────────────────────────────────────────┘
                        ▼
Phase 2 (未来优化):
┌──────────────────────────────────────────────────┐
│  引入置信度机制                                   │
│  • CDP 匹配结果带置信度分数                        │
│  • 低置信度时自动启用 AI                          │
│  • 记录执行结果用于规则优化                        │
└──────────────────────────────────────────────────┘
                        ▼
Phase 3 (长期目标):
┌──────────────────────────────────────────────────┐
│  完整双模态系统                                   │
│  • AI 用 AX Tree 替代截图 (降低 token 消耗)       │
│  • 规则库自动学习                                  │
│  • 场景缓存机制                                   │
└──────────────────────────────────────────────────┘
```

---

## 4. Phase 1 实现设计

### 4.1 HybridBrowserController 类设计

```python
# core/hybrid_browser_controller.py

from typing import Optional, Dict, List, Callable
from dataclasses import dataclass
from enum import Enum

class ActionMethod(Enum):
    CDP = "cdp"
    AI = "ai"
    PLAYWRIGHT = "playwright"

@dataclass
class ActionResult:
    success: bool
    method: ActionMethod
    confidence: float
    message: str = ""
    data: Optional[Dict] = None

class HybridBrowserController:
    """CDP + AI 混合浏览器控制器"""

    def __init__(
        self,
        page,
        ai_agent=None,
        confidence_threshold: float = 0.8,
        enable_ai_fallback: bool = True,
    ):
        """
        初始化混合控制器

        Args:
            page: Playwright Page 对象
            ai_agent: 可选的 AIBrowserAgent 实例
            confidence_threshold: CDP 置信度阈值，低于此值启用 AI
            enable_ai_fallback: 是否启用 AI 兜底
        """
        self.page = page
        self.ai_agent = ai_agent
        self.confidence_threshold = confidence_threshold
        self.enable_ai_fallback = enable_ai_fallback
        self.cdp_service = None

        # 动作规则库
        self.action_rules = self._init_action_rules()

    def _init_action_rules(self) -> Dict:
        """初始化动作规则库"""
        return {
            "click_button": {
                "keywords": {
                    "en": ["create", "continue", "confirm", "next", "done", "ok", "submit", "save"],
                    "zh": ["创建", "继续", "确认", "下一步", "完成", "确定", "提交", "保存"],
                    "ja": ["作成", "続行", "確認", "次へ", "完了"],
                    "ko": ["만들기", "계속", "확인", "다음", "완료"],
                },
                "roles": ["button", "link", "menuitem"],
                "priority": 1,
            },
            "toggle_switch": {
                "keywords": {
                    "en": ["share", "enable", "turn on", "activate"],
                    "zh": ["共享", "开启", "启用", "打开"],
                },
                "roles": ["switch", "checkbox"],
                "priority": 2,
            },
            "expand_section": {
                "keywords": {
                    "en": ["manage", "settings", "expand", "show more"],
                    "zh": ["管理", "设置", "展开", "显示更多"],
                },
                "roles": ["button", "listitem", "treeitem"],
                "priority": 3,
            },
            "close_dialog": {
                "keywords": {
                    "en": ["close", "dismiss", "cancel", "got it"],
                    "zh": ["关闭", "取消", "知道了", "忽略"],
                },
                "roles": ["button"],
                "priority": 0,  # 最高优先级
            },
        }

    async def ensure_cdp_service(self):
        """确保 CDP 服务已初始化"""
        if self.cdp_service is None:
            from core.ai_browser_agent import create_cdp_service, CDP_SERVICE_AVAILABLE
            if CDP_SERVICE_AVAILABLE:
                self.cdp_service = await create_cdp_service(self.page)

    async def find_element(
        self,
        intent: str,
        action_type: str = None,
        custom_keywords: List[str] = None,
    ) -> Dict:
        """
        智能查找元素

        Args:
            intent: 意图描述，如 "find create family button"
            action_type: 动作类型，如 "click_button"
            custom_keywords: 自定义关键词列表

        Returns:
            {
                "found": bool,
                "element": {...},
                "confidence": float,
                "method": "cdp" | "ai"
            }
        """
        await self.ensure_cdp_service()

        # Step 1: CDP 关键词匹配
        cdp_result = await self._find_via_cdp(intent, action_type, custom_keywords)

        if cdp_result["found"] and cdp_result["confidence"] >= self.confidence_threshold:
            return cdp_result

        # Step 2: AI 增强（如果启用且 CDP 低置信度）
        if self.enable_ai_fallback and self.ai_agent:
            if not cdp_result["found"] or cdp_result["confidence"] < 0.5:
                ai_result = await self._find_via_ai(intent)
                if ai_result["found"]:
                    return ai_result

        # Step 3: 返回 CDP 结果（即使低置信度）
        return cdp_result

    async def find_and_click(
        self,
        intent: str,
        action_type: str = None,
        custom_keywords: List[str] = None,
        timeout: int = 5000,
    ) -> ActionResult:
        """
        智能查找并点击元素

        Args:
            intent: 意图描述
            action_type: 动作类型
            custom_keywords: 自定义关键词
            timeout: 超时时间(ms)

        Returns:
            ActionResult
        """
        find_result = await self.find_element(intent, action_type, custom_keywords)

        if not find_result["found"]:
            return ActionResult(
                success=False,
                method=ActionMethod.CDP,
                confidence=0.0,
                message=f"未找到匹配元素: {intent}"
            )

        # 执行点击
        element = find_result["element"]
        backend_node_id = element.get("backend_node_id")

        if backend_node_id and self.cdp_service:
            success, msg = await self.cdp_service.click_by_backend_node_id(backend_node_id)
            return ActionResult(
                success=success,
                method=ActionMethod(find_result["method"]),
                confidence=find_result["confidence"],
                message=msg,
                data={"element": element}
            )

        # Playwright 兜底
        # ... (省略 Playwright 实现)

        return ActionResult(
            success=False,
            method=ActionMethod.PLAYWRIGHT,
            confidence=0.0,
            message="无法执行点击操作"
        )

    async def _find_via_cdp(
        self,
        intent: str,
        action_type: str = None,
        custom_keywords: List[str] = None,
    ) -> Dict:
        """通过 CDP AX Tree 查找元素"""
        if not self.cdp_service:
            return {"found": False, "confidence": 0.0, "method": "cdp"}

        ax_elements = await self.cdp_service.get_interactive_elements_via_ax()

        # 构建关键词列表
        keywords = []
        if custom_keywords:
            keywords.extend([k.lower() for k in custom_keywords])

        if action_type and action_type in self.action_rules:
            rule = self.action_rules[action_type]
            for lang_keywords in rule["keywords"].values():
                keywords.extend([k.lower() for k in lang_keywords])
            valid_roles = rule["roles"]
        else:
            valid_roles = ["button", "link", "switch", "checkbox", "menuitem", "listitem"]

        # 从 intent 提取关键词
        intent_words = intent.lower().split()
        keywords.extend(intent_words)

        # 匹配元素
        best_match = None
        best_score = 0.0

        for elem in ax_elements:
            elem_name = (elem.get("name") or "").lower()
            elem_role = (elem.get("role") or "").lower()

            if elem_role not in valid_roles:
                continue

            # 计算匹配分数
            score = 0.0
            matched_keywords = 0

            for keyword in keywords:
                if keyword in elem_name:
                    matched_keywords += 1
                    score += 1.0 / len(keywords) if keywords else 0

            # 角色匹配加分
            if elem_role in valid_roles[:2]:  # 前两个角色优先
                score += 0.1

            if score > best_score:
                best_score = score
                best_match = elem

        if best_match:
            # 归一化置信度 (0.0 - 1.0)
            confidence = min(best_score, 1.0)
            return {
                "found": True,
                "element": best_match,
                "confidence": confidence,
                "method": "cdp"
            }

        return {"found": False, "confidence": 0.0, "method": "cdp"}

    async def _find_via_ai(self, intent: str) -> Dict:
        """通过 AI 查找元素（使用 AX Tree 而非截图）"""
        # TODO: 实现 AI 增强查找
        # 使用 AX Tree 作为 prompt 上下文，让 AI 返回目标元素
        return {"found": False, "confidence": 0.0, "method": "ai"}

    async def detect_page_state(self) -> Dict:
        """
        检测页面状态

        Returns:
            {
                "has_dialog": bool,
                "has_loading": bool,
                "detected_elements": [...],
                "suggested_action": str | None
            }
        """
        await self.ensure_cdp_service()

        if not self.cdp_service:
            return {"has_dialog": False, "has_loading": False, "detected_elements": []}

        ax_elements = await self.cdp_service.get_interactive_elements_via_ax()

        # 检测弹窗
        has_dialog = any(
            elem.get("role") == "dialog" or
            "modal" in (elem.get("name") or "").lower()
            for elem in ax_elements
        )

        # 检测加载状态
        has_loading = any(
            "loading" in (elem.get("name") or "").lower() or
            elem.get("role") == "progressbar"
            for elem in ax_elements
        )

        return {
            "has_dialog": has_dialog,
            "has_loading": has_loading,
            "detected_elements": ax_elements[:20],  # 返回前20个元素
            "suggested_action": "close_dialog" if has_dialog else None
        }

    async def close(self):
        """关闭控制器，释放资源"""
        if self.cdp_service:
            await self.cdp_service.close()
            self.cdp_service = None
```

### 4.2 使用示例

```python
from core.hybrid_browser_controller import HybridBrowserController

async def enable_family_sharing_v2(page, email: str):
    """使用混合控制器开启家庭共享"""

    controller = HybridBrowserController(page)

    try:
        # 检测页面状态
        state = await controller.detect_page_state()
        if state["has_dialog"]:
            await controller.find_and_click(
                intent="close dialog",
                action_type="close_dialog"
            )

        # 查找并展开 "Manage family settings"
        result = await controller.find_and_click(
            intent="manage family settings",
            action_type="expand_section",
            custom_keywords=["manage family", "管理家庭"]
        )

        if not result.success:
            # CDP 失败，可能需要先创建家庭组
            create_result = await controller.find_and_click(
                intent="create family group",
                action_type="click_button",
                custom_keywords=["create family", "创建家庭", "get started"]
            )
            # ... 继续创建流程

        # 开启共享开关
        toggle_result = await controller.find_and_click(
            intent="share google one with family",
            action_type="toggle_switch",
            custom_keywords=["share", "共享", "family"]
        )

        return toggle_result.success

    finally:
        await controller.close()
```

---

## 5. 方案对比总结

| 方案 | 速度 | 成本 | 智能度 | 推荐场景 |
|------|------|------|--------|----------|
| A (CDP优先) | ⭐⭐⭐⭐⭐ | ⭐⭐⭐⭐⭐ | ⭐⭐⭐ | 规则明确的自动化任务 |
| B (AI优先) | ⭐⭐ | ⭐⭐ | ⭐⭐⭐⭐⭐ | 复杂多变的场景 |
| C (双模态) | ⭐⭐⭐⭐ | ⭐⭐⭐⭐ | ⭐⭐⭐⭐⭐ | 生产环境最佳选择 |

---

## 6. 后续工作

- [ ] Phase 1: 实现 `HybridBrowserController` 基础版本
- [ ] Phase 1: 扩展多语言关键词规则库
- [ ] Phase 1: 重构 `auto_enable_family_sharing.py` 使用新控制器
- [ ] Phase 2: 添加置信度评估机制
- [ ] Phase 2: 实现执行结果记录和规则优化
- [ ] Phase 3: AI 使用 AX Tree 替代截图
- [ ] Phase 3: 实现规则库自动学习

---

*文档版本: 1.0*
