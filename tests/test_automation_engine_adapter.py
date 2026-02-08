from application.automation_engine_adapter import AutomationEngineAdapter


def test_run_bind_card_with_empty_cards_returns_failure():
    import asyncio

    result = asyncio.run(
        AutomationEngineAdapter.run_bind_card(
            profile_id="p1",
            account_info={"email": "a@example.com"},
            cards=[],
            config={},
        )
    )

    assert result["success"] is False
    assert "无可用卡片" in result["message"]


def test_run_auto_subscribe_batch_proxies_to_automation(monkeypatch):
    import asyncio

    async def fake_process_accounts_batch(**kwargs):
        return {"a@example.com": "ok"}

    monkeypatch.setattr(
        "automation.auto_subscribe.process_accounts_batch",
        fake_process_accounts_batch,
    )

    result = asyncio.run(
        AutomationEngineAdapter.run_auto_subscribe_batch(
            accounts=[{"email": "a@example.com", "browser_id": "b1"}],
            cards=[],
            cards_per_account=1,
            concurrent_count=1,
            sheerid_api_key="k",
            close_browser_after=False,
        )
    )

    assert result == {"a@example.com": "ok"}

