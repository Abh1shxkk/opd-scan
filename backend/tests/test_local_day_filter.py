"""A date filter sent as the instant a local day begins must include uploads from that local morning."""

from __future__ import annotations

from datetime import datetime, timezone

from app.services.query import _coerce_dt


def test_iso_instants_from_the_browser_are_honoured_exactly():
    # 17 Sep 00:00 IST is 16 Sep 18:30 UTC.
    assert _coerce_dt("2026-09-16T18:30:00.000Z", end_of_day=False) == datetime(
        2026, 9, 16, 18, 30, tzinfo=timezone.utc
    )
    assert _coerce_dt("2026-09-17T18:29:59.999Z", end_of_day=True) == datetime(
        2026, 9, 17, 18, 29, 59, 999000, tzinfo=timezone.utc
    )


def test_a_bare_date_still_works_for_old_links():
    assert _coerce_dt("2026-09-17", end_of_day=True).hour == 23
