import types
from unittest.mock import AsyncMock

import pytest

from core.stagehand_engine.engine import StagehandGoogleEngine


@pytest.mark.asyncio
async def test_agent_execute_should_call_session_execute_with_model_config():
    engine = StagehandGoogleEngine.__new__(StagehandGoogleEngine)
    engine._initialized = True
    engine._session = types.SimpleNamespace()
    engine._session.execute = AsyncMock(
        return_value=types.SimpleNamespace(
            success=True,
            data=types.SimpleNamespace(
                result=types.SimpleNamespace(
                    success=True,
                    completed=True,
                    message="ok",
                )
            ),
        )
    )

    engine.model_name = "anthropic/claude-sonnet-4-5-20250929"
    engine.model_api_key = "test-key"
    engine.model_base_url = "https://api.anthropic.com/v1"

    engine._get_model_options = lambda: {
        "model": {
            "model_name": engine.model_name,
            "api_key": engine.model_api_key,
            "base_url": engine.model_base_url,
            "provider": "anthropic",
        }
    }
    engine._is_page_valid = lambda: True
    engine._get_page_invalid_reason = lambda: ""
    engine._ensure_initialized = lambda: None

    result = await engine.agent_execute(
        instruction="发送家庭邀请",
        max_steps=12,
        mode="dom",
    )

    assert result.success is True
    assert "agent_execute:dom" == result.method
    engine._session.execute.assert_awaited_once()

    kwargs = engine._session.execute.await_args.kwargs
    assert kwargs["agent_config"]["mode"] == "dom"
    assert kwargs["agent_config"]["model"]["model_name"] == engine.model_name
    assert kwargs["execute_options"]["instruction"] == "发送家庭邀请"
    assert kwargs["execute_options"]["max_steps"] == 12


@pytest.mark.asyncio
async def test_agent_execute_should_retry_with_legacy_payload_on_invalid_request():
    engine = StagehandGoogleEngine.__new__(StagehandGoogleEngine)
    engine._initialized = True
    engine._async_stagehand = None
    engine._session = types.SimpleNamespace()
    engine._session.execute = AsyncMock(
        return_value=types.SimpleNamespace(
            success=True,
            data=types.SimpleNamespace(
                result=types.SimpleNamespace(
                    success=False,
                    completed=False,
                    message="Failed to execute task: Invalid request",
                )
            ),
        )
    )
    engine._session._client = types.SimpleNamespace()
    engine._session._client.post = AsyncMock(
        return_value=types.SimpleNamespace(
            success=True,
            data=types.SimpleNamespace(
                result=types.SimpleNamespace(
                    success=True,
                    completed=True,
                    message="legacy ok",
                )
            ),
        )
    )
    engine._session_id = "test-session-id"

    engine.model_name = "anthropic/claude-sonnet-4-5-20250929"
    engine.model_api_key = "test-key"
    engine.model_base_url = "https://api.anthropic.com/v1"

    engine._get_model_options = lambda: {
        "model": {
            "model_name": engine.model_name,
            "api_key": engine.model_api_key,
            "base_url": engine.model_base_url,
            "provider": "anthropic",
        }
    }
    engine._is_page_valid = lambda: True
    engine._get_page_invalid_reason = lambda: ""
    engine._ensure_initialized = lambda: None

    result = await engine.agent_execute(
        instruction="send family invite",
        max_steps=8,
        mode="dom",
    )

    assert result.success is True
    assert result.method == "agent_execute:dom:legacy"
    engine._session.execute.assert_awaited_once()
    engine._session._client.post.assert_awaited_once()

    kwargs = engine._session._client.post.await_args.kwargs
    assert kwargs["body"]["agentConfig"]["model"]["modelName"] == engine.model_name
    assert kwargs["body"]["executeOptions"]["instruction"] == "send family invite"


@pytest.mark.asyncio
async def test_agent_execute_should_use_async_stagehand_client_when_available():
    engine = StagehandGoogleEngine.__new__(StagehandGoogleEngine)
    engine._initialized = True
    engine._session = types.SimpleNamespace()
    engine._session.execute = AsyncMock(
        return_value=types.SimpleNamespace(
            success=True,
            data=types.SimpleNamespace(
                result=types.SimpleNamespace(
                    success=False,
                    completed=False,
                    message="Failed to execute task: Invalid request",
                )
            ),
        )
    )
    engine._async_stagehand = types.SimpleNamespace()
    engine._async_stagehand.post = AsyncMock(
        return_value=types.SimpleNamespace(
            success=True,
            data=types.SimpleNamespace(
                result=types.SimpleNamespace(
                    success=True,
                    completed=True,
                    message="legacy by async_stagehand ok",
                )
            ),
        )
    )
    engine._session_id = "test-session-id-2"

    engine.model_name = "anthropic/claude-sonnet-4-5-20250929"
    engine.model_api_key = "test-key"
    engine.model_base_url = "https://api.anthropic.com/v1"

    engine._get_model_options = lambda: {
        "model": {
            "model_name": engine.model_name,
            "api_key": engine.model_api_key,
            "base_url": engine.model_base_url,
            "provider": "anthropic",
        }
    }
    engine._is_page_valid = lambda: True
    engine._get_page_invalid_reason = lambda: ""
    engine._ensure_initialized = lambda: None

    result = await engine.agent_execute(
        instruction="send family invite",
        max_steps=8,
        mode="dom",
        timeout=30000,
    )

    assert result.success is True
    assert result.method == "agent_execute:dom:legacy"
    engine._session.execute.assert_awaited_once()
    engine._async_stagehand.post.assert_awaited_once()
    kwargs = engine._async_stagehand.post.await_args.kwargs
    assert kwargs["body"]["executeOptions"]["maxSteps"] == 8
    assert kwargs["options"]["timeout"] == 15


@pytest.mark.asyncio
async def test_agent_execute_should_skip_legacy_retry_on_third_party_anthropic_gateway():
    engine = StagehandGoogleEngine.__new__(StagehandGoogleEngine)
    engine._initialized = True
    engine._session = types.SimpleNamespace()
    engine._session.execute = AsyncMock(
        return_value=types.SimpleNamespace(
            success=True,
            data=types.SimpleNamespace(
                result=types.SimpleNamespace(
                    success=False,
                    completed=False,
                    message="Failed to execute task: Invalid request",
                )
            ),
        )
    )
    engine._session._client = types.SimpleNamespace()
    engine._session._client.post = AsyncMock()
    engine._async_stagehand = types.SimpleNamespace()
    engine._async_stagehand.post = AsyncMock()

    engine.model_name = "anthropic/claude-sonnet-4-5-20250929"
    engine.model_api_key = "test-key"
    engine.model_base_url = "https://sub2api.topren.top/v1"

    engine._get_model_options = lambda: {
        "model": {
            "model_name": engine.model_name,
            "api_key": engine.model_api_key,
            "base_url": engine.model_base_url,
            "provider": "anthropic",
        }
    }
    engine._is_page_valid = lambda: True
    engine._get_page_invalid_reason = lambda: ""
    engine._ensure_initialized = lambda: None

    result = await engine.agent_execute(
        instruction="send family invite",
        max_steps=8,
        mode="dom",
        timeout=30000,
    )

    assert result.success is False
    assert "Invalid request" in (result.error or "")
    engine._session.execute.assert_awaited_once()
    engine._session._client.post.assert_not_called()
    engine._async_stagehand.post.assert_not_called()
