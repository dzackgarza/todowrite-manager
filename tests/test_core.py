from todowrite_manager.core import (
    build_markdown_todo_tree,
    parse_todo_forest,
    serialize_todo_forest,
)
from todowrite_manager.models import TodoNode


def test_serialize_and_parse_round_trip() -> None:
    nodes = [
        TodoNode(
            id="root",
            content="Root task",
            status="pending",
            priority="medium",
            children=[
                TodoNode(
                    id="child",
                    content="Child task",
                    status="completed",
                    priority="high",
                    children=[],
                )
            ],
        )
    ]
    parsed = parse_todo_forest(serialize_todo_forest(nodes))
    assert parsed[0].id == "root"
    assert parsed[0].children[0].id == "child"
    assert parsed[0].children[0].status == "completed"


def test_build_markdown_marks_current_task() -> None:
    current = TodoNode(
        id="current",
        content="Do thing",
        status="pending",
        priority="medium",
        children=[],
    )
    markdown = build_markdown_todo_tree([current], current)
    assert "<-- current" in markdown
