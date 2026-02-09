import types
from unittest.mock import AsyncMock

import pytest

from core.stagehand_engine.operations.family import FamilyOperation
from core.stagehand_engine.types import FamilyRole


def _build_engine(page_content: str):
    engine = types.SimpleNamespace()
    engine.get_page_content = AsyncMock(return_value=page_content)
    return engine


@pytest.mark.asyncio
async def test_keywords_should_detect_has_family_even_when_get_started_exists():
    page = """
    Your family on Google
    With a Family Group, you can share Google services
    Dyg Gonzales Member
    Bruna Gonzaga Family manager
    """
    op = FamilyOperation(_build_engine(page))

    result = await op._detect_by_keywords()

    assert result.has_family is True
    assert result.role == FamilyRole.MEMBER
    assert result.is_manager is False


@pytest.mark.asyncio
async def test_keywords_should_detect_no_family_for_people_sharing_get_started_page():
    page = """
    People & sharing
    Your family on Google
    You can create a Family Group with up to 6 people
    Get started
    """
    op = FamilyOperation(_build_engine(page))

    result = await op._detect_by_keywords()

    assert result.has_family is False
    assert result.role == FamilyRole.NONE
    assert result.is_manager is False
