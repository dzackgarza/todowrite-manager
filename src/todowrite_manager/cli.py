from __future__ import annotations

from typing import cast

from cyclopts import App
from pydantic import validate_call

from .core import (
    advance_todo,
    build_markdown_todo_tree,
    build_todo_tree_reminder,
    build_todo_tree_result,
    create_plan,
    edit_todos,
    get_current_task,
    load_todo_forest,
)
from .models import AddOp, CancelOp, EditOp, PlanInput, TodoNode, TodoResult, UpdateOp

app = App(name="todowrite", help="Hierarchical todo tree manager.")


def _build_result(todos: list[TodoNode], current: TodoNode | None) -> TodoResult:
    return TodoResult(
        todos=todos,
        current=current,
        markdown=build_markdown_todo_tree(todos, current),
        reminder=build_todo_tree_reminder(),
        display=build_todo_tree_result(todos, current),
    )


def _run_json_tool(session_id: str, tool_name: str, payload: dict[str, object]) -> TodoResult:
    if tool_name == "todo-plan":
        raw_todos = payload.get("todos")
        if not isinstance(raw_todos, list):
            raise ValueError("todo-plan requires a todos array")
        todos = [PlanInput.model_validate(item) for item in cast(list[object], raw_todos)]
        nodes = create_plan(session_id, todos)
        current = get_current_task(nodes)
        return _build_result(nodes, current)

    if tool_name == "todo-read":
        nodes = load_todo_forest(session_id)
        current = get_current_task(nodes)
        return _build_result(nodes, current)

    if tool_name == "todo-advance":
        updated, current = advance_todo(
            session_id,
            str(payload["id"]),
            str(payload["action"]),
            str(payload["reason"]) if payload.get("reason") is not None else None,
        )
        return _build_result(updated, current)

    if tool_name == "todo-edit":
        raw_ops = payload.get("ops")
        if not isinstance(raw_ops, list):
            raise ValueError("todo-edit requires an ops array")
        ops: list[EditOp] = []
        for item in cast(list[object], raw_ops):
            if not isinstance(item, dict):
                continue
            raw_item = cast(dict[str, object], item)
            item_type: object = raw_item.get("type")
            if item_type == "add":
                ops.append(AddOp.model_validate(raw_item))
            elif item_type == "update":
                ops.append(UpdateOp.model_validate(raw_item))
            elif item_type == "cancel":
                ops.append(CancelOp.model_validate(raw_item))
        updated = edit_todos(session_id, ops)
        current = get_current_task(updated)
        return _build_result(updated, current)

    raise ValueError(f"Unknown tool: {tool_name}")


@app.command(name="todo-plan")
@validate_call
def todo_plan(session_id: str, todos: list[PlanInput]) -> None:
    nodes = create_plan(session_id, todos)
    current = get_current_task(nodes)
    print(_build_result(nodes, current).model_dump_json())


@app.command(name="todo-read")
@validate_call
def todo_read(session_id: str) -> None:
    nodes = load_todo_forest(session_id)
    current = get_current_task(nodes)
    print(_build_result(nodes, current).model_dump_json())


@app.command(name="todo-advance")
@validate_call
def todo_advance(
    session_id: str,
    id: str,  # noqa: A002
    action: str,
    reason: str | None = None,
) -> None:
    updated, current = advance_todo(session_id, id, action, reason)
    print(_build_result(updated, current).model_dump_json())


@app.command(name="todo-edit")
@validate_call
def todo_edit(
    session_id: str,
    add: list[AddOp] | None = None,
    update: list[UpdateOp] | None = None,
    cancel: list[CancelOp] | None = None,
) -> None:
    ops = [*(add or []), *(update or []), *(cancel or [])]
    updated = edit_todos(session_id, ops)
    current = get_current_task(updated)
    print(_build_result(updated, current).model_dump_json())


@app.command(name="run-json")
@validate_call
def run_json(tool_name: str, session_id: str, request_json: str) -> None:
    import json

    payload = json.loads(request_json)
    if not isinstance(payload, dict):
        raise ValueError("request_json must decode to an object")
    result = _run_json_tool(session_id, tool_name, cast(dict[str, object], payload))
    print(result.model_dump_json())


def main() -> None:
    app()
