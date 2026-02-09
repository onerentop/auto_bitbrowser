import types
from unittest.mock import AsyncMock

import pytest

from core.stagehand_engine.operations.pro_status import ProStatusOperation
from core.stagehand_engine.types import FamilyRole, FamilyStatusResult, ProStatus


def _build_extract_result(data: dict):
    return types.SimpleNamespace(success=True, data=data)


@pytest.mark.asyncio
async def test_family_member_should_be_true_when_secondary_check_detects_member():
    engine = types.SimpleNamespace()
    engine.extract = AsyncMock(
        return_value=_build_extract_result(
            {
                "is_subscribed": True,
                "is_family_member": False,
                "has_payment_options": False,
                "plan_name": "Google AI Pro - 2 TB",
            }
        )
    )
    engine.detect_family_status = AsyncMock(
        return_value=FamilyStatusResult(
            has_family=True,
            role=FamilyRole.MEMBER,
            is_manager=False,
        )
    )

    result = await ProStatusOperation(engine)._detect_by_extraction()

    assert result.status == ProStatus.ACTIVE
    assert result.is_pro is True
    assert result.is_family_member is True
    assert result.method_used == "ai_extraction+family_check(member)"
    engine.detect_family_status.assert_awaited_once_with(navigate_if_needed=True)


@pytest.mark.asyncio
async def test_family_member_should_be_false_when_secondary_check_detects_manager():
    engine = types.SimpleNamespace()
    engine.extract = AsyncMock(
        return_value=_build_extract_result(
            {
                "is_subscribed": True,
                "is_family_member": True,
                "has_payment_options": False,
                "plan_name": "Google AI Pro - 2 TB",
            }
        )
    )
    engine.detect_family_status = AsyncMock(
        return_value=FamilyStatusResult(
            has_family=True,
            role=FamilyRole.MANAGER,
            is_manager=True,
        )
    )

    result = await ProStatusOperation(engine)._detect_by_extraction()

    assert result.status == ProStatus.ACTIVE
    assert result.is_pro is True
    assert result.is_family_member is False
    assert result.method_used == "ai_extraction+family_check(manager)"
    engine.detect_family_status.assert_awaited_once_with(navigate_if_needed=True)


@pytest.mark.asyncio
async def test_should_skip_secondary_family_check_when_payment_options_exist():
    engine = types.SimpleNamespace()
    engine.extract = AsyncMock(
        return_value=_build_extract_result(
            {
                "is_subscribed": True,
                "is_family_member": True,
                "has_payment_options": True,
                "plan_name": "Google AI Pro - 2 TB",
            }
        )
    )
    engine.detect_family_status = AsyncMock()

    result = await ProStatusOperation(engine)._detect_by_extraction()

    assert result.status == ProStatus.ACTIVE
    assert result.is_pro is True
    assert result.is_family_member is False
    assert result.method_used == "ai_extraction+family_check(no_family)"
    engine.detect_family_status.assert_awaited_once_with(navigate_if_needed=True)
