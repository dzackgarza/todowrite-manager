from __future__ import annotations

import json
from pathlib import Path

import pytest
from _pytest.capture import CaptureFixture

from todowrite_manager.cli import run_json
from todowrite_manager.core import (
    IMPROVED_TODO_DIR_ENV,
    IMPROVED_TODO_VERIFICATION_PASSPHRASE_ENV,
    advance_todo,
    build_todo_tree_result,
    create_plan,
    edit_todos,
    get_current_task,
    load_todo_forest,
    parse_todo_forest,
    serialize_todo_forest,
    store_todo_forest,
)
from todowrite_manager.models import AddOp, CancelOp, PlanInput, TodoNode, UpdateOp


def sample_tree() -> list[TodoNode]:
    return [
        TodoNode(
            id="ship-persistence-layer",
            content="Ship persistence layer",
            status="in_progress",
            priority="high",
            children=[
                TodoNode(
                    id="design-schema",
                    content="Design schema",
                    status="completed",
                    priority="high",
                    children=[],
                ),
                TodoNode(
                    id="implement-writes",
                    content="Implement writes",
                    status="pending",
                    priority="high",
                    children=[
                        TodoNode(
                            id="add-transaction-wrapper",
                            content="Add transaction wrapper",
                            status="pending",
                            priority="medium",
                            children=[],
                        )
                    ],
                ),
            ],
        ),
        TodoNode(
            id="add-mcp-coverage",
            content="Add MCP coverage",
            status="pending",
            priority="medium",
            children=[],
        ),
    ]


def test_round_trip_preserves_nested_tree_and_status_markers() -> None:
    tree = [
        TodoNode(
            id="pending",
            content="Pending",
            status="pending",
            priority="medium",
            children=[],
        ),
        TodoNode(
            id="in-progress",
            content="In progress",
            status="in_progress",
            priority="medium",
            children=[],
        ),
        TodoNode(
            id="completed",
            content="Completed",
            status="completed",
            priority="medium",
            children=[],
        ),
        TodoNode(
            id="cancelled",
            content="Cancelled",
            status="cancelled",
            priority="high",
            cancel_reason="Superseded by a better plan",
            children=[],
        ),
    ]

    serialized = serialize_todo_forest(tree)

    assert "- [ ] Pending" in serialized
    assert "- [-] In progress" in serialized
    assert "- [x] Completed" in serialized
    assert "- [~] Cancelled (high)" in serialized
    assert parse_todo_forest(serialized) == tree


def test_create_plan_deduplicates_slugs_and_rejects_overwrite(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv(IMPROVED_TODO_DIR_ENV, str(tmp_path))

    nodes = create_plan(
        "ses-plan",
        [
            PlanInput(content="Fix bug"),
            PlanInput(content="Fix bug"),
            PlanInput(content="Fix bug"),
        ],
    )

    assert [node.id for node in nodes] == ["fix-bug", "fix-bug-2", "fix-bug-3"]
    assert load_todo_forest("ses-plan") == nodes

    with pytest.raises(ValueError, match="A plan already exists"):
        create_plan("ses-plan", [PlanInput(content="Overwrite")])


def test_get_current_task_and_advance_flow(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv(IMPROVED_TODO_DIR_ENV, str(tmp_path))
    tree = sample_tree()
    store_todo_forest("ses-flow", tree)

    current = get_current_task(tree)
    assert current is not None
    assert current.id == "add-transaction-wrapper"

    with pytest.raises(ValueError, match="The current task is"):
        advance_todo("ses-flow", "add-mcp-coverage", "complete")

    updated, next_task = advance_todo("ses-flow", "add-transaction-wrapper", "complete")

    assert updated[0].children[1].children[0].status == "completed"
    assert next_task is not None
    assert next_task.id == "implement-writes"


def test_edit_todos_adds_updates_and_cancels_nodes(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv(IMPROVED_TODO_DIR_ENV, str(tmp_path))
    store_todo_forest("ses-edit", sample_tree())

    updated = edit_todos(
        "ses-edit",
        [
            AddOp(type="add", content="Write release notes", priority="low"),
            AddOp(type="add", parent_id="implement-writes", content="Add error handling"),
            UpdateOp(
                type="update",
                id="add-transaction-wrapper",
                content="Add retry logic",
                priority="high",
            ),
            CancelOp(
                type="cancel",
                id="add-mcp-coverage",
                reason="Deprioritised for this release",
            ),
        ],
    )

    assert updated[-1].content == "Write release notes"
    assert updated[0].children[1].children[1].content == "Add error handling"
    assert updated[0].children[1].children[0].content == "Add retry logic"
    assert updated[0].children[1].children[0].status == "pending"
    assert updated[1].status == "cancelled"
    assert updated[1].cancel_reason == "Deprioritised for this release"

    with pytest.raises(ValueError, match="Cannot update a completed node"):
        edit_todos(
            "ses-edit",
            [UpdateOp(type="update", id="design-schema", content="Changed")],
        )


def test_run_json_tool_and_display_include_verification_witness(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    capsys: CaptureFixture[str],
) -> None:
    monkeypatch.setenv(IMPROVED_TODO_DIR_ENV, str(tmp_path))
    monkeypatch.setenv(
        IMPROVED_TODO_VERIFICATION_PASSPHRASE_ENV,
        "TODOWRITE-PROOF-PASS-20260321",
    )

    run_json(
        "todo-plan",
        "ses-json",
        json.dumps(
            {
                "todos": [
                    {
                        "content": "Design the API",
                        "children": [{"content": "Write handlers"}],
                    }
                ]
            }
        ),
    )
    planned = json.loads(capsys.readouterr().out)

    assert planned["current"]["id"] == "write-handlers"
    assert "Write handlers <-- current" in planned["markdown"]
    assert (
        "Verification passphrase: TODOWRITE-PROOF-PASS-20260321"
        in planned["display"]["output"]
    )

    run_json(
        "todo-edit",
        "ses-json",
        json.dumps(
            {
                "ops": [
                    {
                        "type": "update",
                        "id": "write-handlers",
                        "content": "Write HTTP handlers",
                    }
                ]
            }
        ),
    )
    edited = json.loads(capsys.readouterr().out)

    assert edited["todos"][0]["children"][0]["content"] == "Write HTTP handlers"
    assert "Write HTTP handlers" in edited["display"]["output"]

    stored = load_todo_forest("ses-json")
    result = build_todo_tree_result(stored, get_current_task(stored))
    assert result.metadata["currentTaskId"] == "write-handlers"
