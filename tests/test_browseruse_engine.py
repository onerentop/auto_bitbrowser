"""
BrowserUseEngine 测试

测试 BrowserUseEngine 的核心功能。
"""

import pytest
import asyncio
from unittest.mock import AsyncMock, MagicMock, patch


class TestBrowserUseEngineImports:
    """测试模块导入"""

    def test_import_main_class(self):
        """测试导入主类"""
        from core.browseruse_engine import BrowserUseEngine
        assert BrowserUseEngine is not None

    def test_import_protocol(self):
        """测试导入协议"""
        from core.browseruse_engine import EngineProtocol, is_engine
        assert EngineProtocol is not None
        assert is_engine is not None

    def test_import_result_types(self):
        """测试导入结果类型"""
        from core.browseruse_engine import (
            NavigationResult,
            ActionResult,
            ExtractResult,
            ObserveResult,
            AgentResult,
        )
        assert NavigationResult is not None
        assert ActionResult is not None
        assert ExtractResult is not None
        assert ObserveResult is not None
        assert AgentResult is not None

    def test_import_action_models(self):
        """测试导入动作模型"""
        from core.browseruse_engine import (
            ActionModel,
            NavigateAction,
            ClickAction,
            InputAction,
            DoneAction,
        )
        assert ActionModel is not None
        assert NavigateAction is not None
        assert ClickAction is not None
        assert InputAction is not None
        assert DoneAction is not None

    def test_import_llm_adapters(self):
        """测试导入 LLM 适配器"""
        from core.browseruse_engine import (
            BaseChatModel,
            create_llm_adapter,
            create_llm_from_config,
        )
        assert BaseChatModel is not None
        assert create_llm_adapter is not None
        assert create_llm_from_config is not None


class TestActionModels:
    """测试动作模型"""

    def test_navigate_action(self):
        """测试导航动作"""
        from core.browseruse_engine import NavigateAction
        action = NavigateAction(url="https://google.com")
        assert action.url == "https://google.com"

    def test_click_action(self):
        """测试点击动作"""
        from core.browseruse_engine import ClickAction
        action = ClickAction(index=5)
        assert action.index == 5

    def test_input_action(self):
        """测试输入动作"""
        from core.browseruse_engine import InputAction
        action = InputAction(index=3, text="hello")
        assert action.index == 3
        assert action.text == "hello"

    def test_done_action(self):
        """测试完成动作"""
        from core.browseruse_engine import DoneAction
        action = DoneAction(message="Task completed")
        assert action.message == "Task completed"


class TestAgentOutput:
    """测试 Agent 输出模型"""

    def test_agent_output_basic(self):
        """测试基本 Agent 输出"""
        from core.browseruse_engine import AgentOutput, ClickAction
        from core.browseruse_engine.types import ActionModel

        output = AgentOutput(
            thinking="I need to click the button",
            next_goal="Click the login button",
            action=[ActionModel(click=ClickAction(index=1))],
        )
        assert output.thinking == "I need to click the button"
        assert output.next_goal == "Click the login button"
        assert len(output.action) == 1

    def test_agent_output_with_memory(self):
        """测试带记忆的 Agent 输出"""
        from core.browseruse_engine import AgentOutput, DoneAction
        from core.browseruse_engine.types import ActionModel

        output = AgentOutput(
            thinking="Task is complete",
            next_goal="Finish",
            memory="User logged in successfully",
            action=[ActionModel(done=DoneAction(message="Login complete"))],
        )
        assert output.memory == "User logged in successfully"


class TestResultTypes:
    """测试结果类型"""

    def test_navigation_result_success(self):
        """测试成功的导航结果"""
        from core.browseruse_engine import NavigationResult
        result = NavigationResult(
            success=True,
            url="https://google.com",
            final_url="https://www.google.com",
            duration_ms=500.0,
        )
        assert result.success
        assert bool(result)  # __bool__ 方法

    def test_navigation_result_failure(self):
        """测试失败的导航结果"""
        from core.browseruse_engine import NavigationResult
        result = NavigationResult(
            success=False,
            url="https://invalid.url",
            error="Connection timeout",
            duration_ms=30000.0,
        )
        assert not result.success
        assert not bool(result)
        assert result.error == "Connection timeout"

    def test_action_result(self):
        """测试动作结果"""
        from core.browseruse_engine import ActionResult
        result = ActionResult(
            success=True,
            message="Clicked button",
            duration_ms=100.0,
        )
        assert result.success
        assert result.message == "Clicked button"

    def test_extract_result(self):
        """测试提取结果"""
        from core.browseruse_engine import ExtractResult
        result = ExtractResult(
            success=True,
            data={"title": "Page Title", "items": [1, 2, 3]},
            duration_ms=200.0,
        )
        assert result.success
        assert result.data["title"] == "Page Title"

    def test_agent_result(self):
        """测试 Agent 结果"""
        from core.browseruse_engine import AgentResult
        result = AgentResult(
            success=True,
            message="Task completed",
            extracted_content="Found 5 items",
            total_steps=3,
            duration_ms=5000.0,
        )
        assert result.success
        assert result.total_steps == 3


class TestDOMModels:
    """测试 DOM 模型"""

    def test_dom_element(self):
        """测试 DOM 元素"""
        from core.browseruse_engine import DOMElement, Rect

        element = DOMElement(
            index=1,
            tag_name="button",
            text="Click me",
            attributes={"class": "btn", "id": "submit"},
            is_visible=True,
            is_interactive=True,
            bounding_box=Rect(x=100, y=200, width=80, height=30),
        )
        assert element.index == 1
        assert element.tag_name == "button"
        assert element.text == "Click me"
        assert element.is_visible
        assert element.bounding_box.width == 80

    def test_dom_tree(self):
        """测试 DOM 树"""
        from core.browseruse_engine import DOMTree, DOMElement

        tree = DOMTree(
            page_url="https://example.com",
            page_title="Example",
            elements=[
                DOMElement(index=0, tag_name="input", text=""),
                DOMElement(index=1, tag_name="button", text="Submit"),
            ],
        )
        assert tree.page_url == "https://example.com"
        assert len(tree.elements) == 2


class TestBrowserState:
    """测试浏览器状态"""

    def test_browser_state(self):
        """测试浏览器状态模型"""
        from core.browseruse_engine import BrowserState, DOMTree

        state = BrowserState(
            url="https://example.com",
            title="Example Page",
            dom_tree=DOMTree(url="https://example.com", title="Example Page"),
        )
        assert state.url == "https://example.com"
        assert state.title == "Example Page"


class TestProtocol:
    """测试协议检查"""

    def test_is_engine(self):
        """测试 is_engine 函数"""
        from core.browseruse_engine import is_engine

        # 普通对象不是引擎
        assert not is_engine({})
        assert not is_engine("string")
        assert not is_engine(None)


class TestLLMAdapters:
    """测试 LLM 适配器"""

    def test_create_adapter_openai(self):
        """测试创建 OpenAI 适配器"""
        from core.browseruse_engine import create_llm_adapter

        adapter = create_llm_adapter(
            provider="openai",
            api_key="test-key",
            model="gpt-4o",
        )
        assert adapter is not None
        assert adapter.model == "gpt-4o"

    def test_create_adapter_anthropic(self):
        """测试创建 Anthropic 适配器"""
        from core.browseruse_engine import create_llm_adapter

        adapter = create_llm_adapter(
            provider="anthropic",
            api_key="test-key",
            model="claude-3-sonnet",
        )
        assert adapter is not None
        assert adapter.model == "claude-3-sonnet"

    def test_create_adapter_google(self):
        """测试创建 Google 适配器"""
        from core.browseruse_engine import create_llm_adapter

        adapter = create_llm_adapter(
            provider="google",
            api_key="test-key",
            model="gemini-2.0-flash",
        )
        assert adapter is not None
        assert adapter.model == "gemini-2.0-flash"

    def test_create_adapter_invalid_provider(self):
        """测试无效提供商"""
        from core.browseruse_engine import create_llm_adapter

        with pytest.raises(ValueError):
            create_llm_adapter(
                provider="invalid",
                api_key="test-key",
            )


# 以下测试需要实际环境，标记为集成测试
@pytest.mark.integration
class TestBrowserUseEngineIntegration:
    """集成测试 (需要实际浏览器)"""

    @pytest.mark.asyncio
    async def test_engine_initialization(self):
        """测试引擎初始化"""
        from core.browseruse_engine import BrowserUseEngine

        # 创建引擎但不连接
        engine = BrowserUseEngine(
            llm_provider="openai",
            llm_api_key="test-key",
        )
        assert not engine.is_initialized

    @pytest.mark.asyncio
    async def test_engine_properties(self):
        """测试引擎属性"""
        from core.browseruse_engine import BrowserUseEngine

        engine = BrowserUseEngine(
            llm_provider="openai",
            llm_api_key="test-key",
        )
        assert not engine.is_cdp_mode
        assert engine.browser_id is None


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
