"""
Stagehand Google Engine - 测试用例

测试 StagehandGoogleEngine 的基本功能
"""

import asyncio
import os
import pytest
from unittest.mock import AsyncMock, MagicMock, patch

# 测试导入
def test_import():
    """测试模块导入"""
    from core.stagehand_engine import (
        StagehandGoogleEngine,
        create_engine,
        OperationStatus,
        LoginState,
        ProStatus,
        FamilyRole,
        LoginResult,
        ProStatusResult,
        FamilyStatusResult,
        GoogleURLs,
    )

    assert StagehandGoogleEngine is not None
    assert create_engine is not None
    assert OperationStatus.SUCCESS.value == "success"
    assert LoginState.LOGGED_IN.value == "logged_in"
    assert ProStatus.ACTIVE.value == "active"
    assert FamilyRole.MANAGER.value == "manager"


def test_types():
    """测试类型定义"""
    from core.stagehand_engine.types import (
        LoginResult,
        ProStatusResult,
        FamilyStatusResult,
        FamilyMember,
        OperationStatus,
        LoginState,
        ProStatus,
        FamilyRole,
    )

    # 测试 LoginResult
    result = LoginResult(
        success=True,
        status=OperationStatus.SUCCESS,
        login_state=LoginState.LOGGED_IN,
        message="登录成功",
        account_email="test@gmail.com",
    )
    assert result.success is True
    assert result.status == OperationStatus.SUCCESS
    assert bool(result) is True

    # 测试 ProStatusResult
    pro_result = ProStatusResult(
        status=ProStatus.ACTIVE,
        is_pro=True,
        plan_name="2 TB",
    )
    assert pro_result.is_pro is True
    assert bool(pro_result) is True

    # 测试 FamilyStatusResult
    family_result = FamilyStatusResult(
        has_family=True,
        role=FamilyRole.MANAGER,
        is_manager=True,
        member_count=3,
    )
    assert family_result.has_family is True
    assert family_result.is_manager is True

    # 测试 FamilyMember
    member = FamilyMember(
        email="member@gmail.com",
        name="Test Member",
        role=FamilyRole.MEMBER,
    )
    assert member.email == "member@gmail.com"


def test_constants():
    """测试常量定义"""
    from core.stagehand_engine.constants import (
        GoogleURLs,
        Timeouts,
        LoginKeywords,
        ProKeywords,
        FamilyKeywords,
    )

    # 测试 Google URLs
    assert "accounts.google.com" in GoogleURLs.LOGIN
    assert "one.google.com" in GoogleURLs.GOOGLE_ONE
    assert "families.google.com" in GoogleURLs.FAMILY

    # 测试超时
    assert Timeouts.NAVIGATION > 0
    assert Timeouts.LOGIN_TOTAL > Timeouts.LOGIN_STEP

    # 测试关键词
    assert len(LoginKeywords.EMAIL_PAGE) > 0
    assert len(ProKeywords.POSITIVE) > 0
    assert len(FamilyKeywords.HAS_FAMILY) > 0


class TestStagehandGoogleEngine:
    """StagehandGoogleEngine 测试类"""

    @pytest.fixture
    def mock_stagehand(self):
        """创建 mock Stagehand"""
        with patch('core.stagehand_engine.engine.STAGEHAND_AVAILABLE', True):
            with patch('core.stagehand_engine.engine.Stagehand') as mock_class:
                mock_instance = AsyncMock()
                mock_instance.page = MagicMock()
                mock_instance.page.url = "https://accounts.google.com"
                mock_instance.page.goto = AsyncMock()
                mock_instance.page.inner_text = AsyncMock(return_value="test content")
                mock_instance.page.act = AsyncMock()
                mock_instance.page.observe = AsyncMock(return_value=[])
                mock_instance.page.extract = AsyncMock(return_value={})

                mock_class.return_value = mock_instance
                yield mock_class

    @pytest.mark.asyncio
    async def test_engine_initialization(self, mock_stagehand):
        """测试引擎初始化"""
        from core.stagehand_engine import StagehandGoogleEngine

        engine = StagehandGoogleEngine(
            model_name="google/gemini-2.0-flash",
            model_api_key="test-key",
        )

        assert engine.model_name == "google/gemini-2.0-flash"
        assert engine.is_initialized is False

    @pytest.mark.asyncio
    async def test_engine_context_manager(self, mock_stagehand):
        """测试上下文管理器"""
        from core.stagehand_engine import StagehandGoogleEngine

        with patch.object(StagehandGoogleEngine, 'start', new_callable=AsyncMock):
            with patch.object(StagehandGoogleEngine, 'stop', new_callable=AsyncMock):
                async with StagehandGoogleEngine(
                    model_name="google/gemini-2.0-flash",
                    model_api_key="test-key",
                ) as engine:
                    # 引擎应该调用 start
                    engine.start.assert_called_once()

                # 退出后应该调用 stop
                engine.stop.assert_called_once()

    @pytest.mark.asyncio
    async def test_navigate(self, mock_stagehand):
        """测试导航功能"""
        from core.stagehand_engine import StagehandGoogleEngine

        engine = StagehandGoogleEngine(
            model_name="google/gemini-2.0-flash",
            model_api_key="test-key",
        )

        # 模拟初始化
        engine._initialized = True
        engine._page = mock_stagehand.return_value.page
        engine._stagehand = mock_stagehand.return_value

        result = await engine.navigate("https://google.com")

        assert result.url == "https://google.com"
        engine._page.goto.assert_called_once()


class TestLoginOperation:
    """登录操作测试"""

    def test_login_result_creation(self):
        """测试登录结果创建"""
        from core.stagehand_engine.types import (
            LoginResult,
            OperationStatus,
            LoginState,
        )

        # 成功结果
        success_result = LoginResult(
            success=True,
            status=OperationStatus.SUCCESS,
            login_state=LoginState.LOGGED_IN,
            account_email="test@gmail.com",
        )
        assert success_result.success is True
        assert success_result.login_state == LoginState.LOGGED_IN

        # 失败结果 - 密码错误
        fail_result = LoginResult(
            success=False,
            status=OperationStatus.FAILED,
            login_state=LoginState.WRONG_PASSWORD,
            error="密码错误",
            can_retry=True,
        )
        assert fail_result.success is False
        assert fail_result.can_retry is True

        # 需要 2FA
        twofa_result = LoginResult(
            success=False,
            status=OperationStatus.PARTIAL,
            login_state=LoginState.NEED_2FA,
            need_2fa=True,
            two_fa_method="totp",
        )
        assert twofa_result.need_2fa is True
        assert twofa_result.two_fa_method == "totp"


class TestProStatusOperation:
    """Pro 状态检测测试"""

    def test_pro_status_result_creation(self):
        """测试 Pro 状态结果创建"""
        from core.stagehand_engine.types import (
            ProStatusResult,
            ProStatus,
        )

        # 活跃 Pro 用户
        active_result = ProStatusResult(
            status=ProStatus.ACTIVE,
            is_pro=True,
            plan_name="2 TB",
            storage_used="500 GB",
            storage_total="2 TB",
        )
        assert active_result.is_pro is True
        assert active_result.plan_name == "2 TB"

        # 免费用户
        free_result = ProStatusResult(
            status=ProStatus.FREE,
            is_pro=False,
            plan_name="15 GB (Free)",
        )
        assert free_result.is_pro is False


class TestFamilyOperation:
    """家庭组操作测试"""

    def test_family_status_result_creation(self):
        """测试家庭组状态结果创建"""
        from core.stagehand_engine.types import (
            FamilyStatusResult,
            FamilyMember,
            FamilyRole,
        )

        # 有家庭组的管理员
        manager_result = FamilyStatusResult(
            has_family=True,
            role=FamilyRole.MANAGER,
            is_manager=True,
            member_count=3,
            members=[
                FamilyMember(email="manager@gmail.com", role=FamilyRole.MANAGER),
                FamilyMember(email="member1@gmail.com", role=FamilyRole.MEMBER),
                FamilyMember(email="member2@gmail.com", role=FamilyRole.MEMBER),
            ],
            sharing_enabled=True,
        )
        assert manager_result.has_family is True
        assert manager_result.is_manager is True
        assert len(manager_result.members) == 3

        # 无家庭组
        no_family_result = FamilyStatusResult(
            has_family=False,
            role=FamilyRole.NONE,
        )
        assert no_family_result.has_family is False


# ==================== 集成测试 (需要实际环境) ====================

@pytest.mark.skipif(
    not os.getenv("MODEL_API_KEY"),
    reason="需要 MODEL_API_KEY 环境变量"
)
class TestIntegration:
    """集成测试 (需要实际环境)"""

    @pytest.mark.asyncio
    async def test_engine_start_stop(self):
        """测试引擎启动和停止"""
        from core.stagehand_engine import StagehandGoogleEngine

        engine = StagehandGoogleEngine(
            model_name="google/gemini-2.0-flash",
            model_api_key=os.getenv("MODEL_API_KEY"),
            headless=True,
        )

        try:
            await engine.start()
            assert engine.is_initialized is True
        finally:
            await engine.stop()
            assert engine.is_initialized is False


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
