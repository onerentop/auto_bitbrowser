import types
from unittest.mock import AsyncMock

import pytest

from core.stagehand_engine.operations.pro_status import ProStatusOperation
from core.stagehand_engine.types import FamilyRole, FamilyStatusResult, ProStatus


def _build_engine(page_content: str, family_result: FamilyStatusResult):
    engine = types.SimpleNamespace()
    engine.get_current_url = AsyncMock(return_value="https://one.google.com")
    engine.get_page_content = AsyncMock(return_value=page_content)
    engine.detect_family_status = AsyncMock(return_value=family_result)
    return engine


@pytest.mark.asyncio
async def test_keyword_pro_should_still_check_family_member():
    page = "google one pro 2 tb member benefits"
    family = FamilyStatusResult(has_family=True, role=FamilyRole.MEMBER, is_manager=False)
    engine = _build_engine(page, family)

    op = ProStatusOperation(engine)
    op._check_login_required = AsyncMock(return_value=False)

    result = await op.execute(navigate_if_needed=False)

    assert result.status == ProStatus.ACTIVE
    assert result.is_pro is True
    assert result.is_family_member is True
    assert "family_check(member)" in result.method_used
    engine.detect_family_status.assert_awaited_once_with(navigate_if_needed=True)


@pytest.mark.asyncio
async def test_keyword_pro_should_mark_independent_when_no_family():
    page = "google one pro 2 tb member benefits"
    family = FamilyStatusResult(has_family=False, role=FamilyRole.NONE, is_manager=False)
    engine = _build_engine(page, family)

    op = ProStatusOperation(engine)
    op._check_login_required = AsyncMock(return_value=False)

    result = await op.execute(navigate_if_needed=False)

    assert result.status == ProStatus.ACTIVE
    assert result.is_pro is True
    assert result.is_family_member is False
    assert "family_check(no_family)" in result.method_used
    engine.detect_family_status.assert_awaited_once_with(navigate_if_needed=True)
