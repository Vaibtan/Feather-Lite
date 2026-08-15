from __future__ import annotations

from typing import Any

from pydantic import BaseModel


class ScenarioSummary(BaseModel):
    scenario_id: str
    description: str


class ScenarioRunResponse(BaseModel):
    scenario_id: str
    passed: bool
    conversation_id: str
    expected_state_path: list[str]
    actual_state_path: list[str]
    expected_tools: list[str]
    actual_tools: list[str]
    expected_call_control_actions: list[str]
    actual_call_control_actions: list[str]
    required_event_types: list[str]
    actual_event_types: list[str]
    expected_final_outcome: str | None
    final_outcome: str | None
    replay_snapshot: dict[str, Any]
    assertion_failures: list[str]
