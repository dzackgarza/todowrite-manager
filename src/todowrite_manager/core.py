from __future__ import annotations

import os
import re
from pathlib import Path
from typing import cast

from .models import (
    AddOp,
    CancelOp,
    EditOp,
    PlanInput,
    TodoDisplay,
    TodoNode,
    TodoPriority,
    TodoStatus,
    UpdateOp,
)

IMPROVED_TODO_DIR_ENV = "IMPROVED_TODO_DIR"
IMPROVED_TODO_VERIFICATION_PASSPHRASE_ENV = "IMPROVED_TODO_VERIFICATION_PASSPHRASE"
DEFAULT_TODO_DIR = Path.home() / ".local" / "share" / "opencode" / "todos"

STATUS_CHAR = {
    "pending": " ",
    "in_progress": "-",
    "completed": "x",
    "cancelled": "~",
}
CHAR_TO_STATUS = {
    " ": "pending",
    "-": "in_progress",
    "x": "completed",
    "~": "cancelled",
}
LINE_RE = re.compile(r"^( *)- \[(.)\] (.*?) <!-- ([^>]+) -->$")


def slugify(text: str) -> str:
    slug = re.sub(r"[^a-z0-9\s-]", "", text.lower()).strip()
    slug = re.sub(r"\s+", "-", slug)
    slug = re.sub(r"-+", "-", slug)
    return slug[:64]


def unique_slug(content: str, existing: set[str]) -> str:
    base = slugify(content)
    candidate = base
    counter = 2
    while candidate in existing:
        candidate = f"{base}-{counter}"
        counter += 1
    existing.add(candidate)
    return candidate


def assign_slugs(inputs: list[PlanInput], existing: set[str]) -> list[TodoNode]:
    return [
        TodoNode(
            id=unique_slug(item.content, existing),
            content=item.content,
            status="pending",
            priority=item.priority or "medium",
            children=assign_slugs(item.children, existing),
        )
        for item in inputs
    ]


def resolve_todo_dir() -> Path:
    override = os.environ.get(IMPROVED_TODO_DIR_ENV, "").strip()
    if override:
        return Path(override).expanduser()
    return DEFAULT_TODO_DIR


def resolve_todo_file_path(session_id: str) -> Path:
    return resolve_todo_dir() / f"{session_id}.md"


def serialize_node(node: TodoNode, depth: int) -> str:
    pad = "  " * depth
    status = STATUS_CHAR[node.status]
    pri = f" ({node.priority})" if node.priority != "medium" else ""
    cancel_suffix = f"; cancelled: {node.cancel_reason}" if node.cancel_reason else ""
    line = f"{pad}- [{status}] {node.content}{pri} <!-- {node.id}{cancel_suffix} -->"
    child_lines = "\n".join(serialize_node(child, depth + 1) for child in node.children)
    return f"{line}\n{child_lines}" if child_lines else line


def serialize_todo_forest(nodes: list[TodoNode]) -> str:
    return "\n".join(serialize_node(node, 0) for node in nodes) + "\n"


def parse_todo_forest(text: str) -> list[TodoNode]:
    lines = [line for line in text.splitlines() if line.strip()]
    stack: list[tuple[TodoNode, int]] = []
    roots: list[TodoNode] = []
    for line in lines:
        match = LINE_RE.match(line)
        if not match:
            continue
        depth = len(match.group(1)) // 2
        status_char = match.group(2)
        content_and_priority = match.group(3)
        comment_content = match.group(4)

        priority_match = re.match(r"^(.*?) \((high|medium|low)\)$", content_and_priority)
        content = priority_match.group(1) if priority_match else content_and_priority
        priority = priority_match.group(2) if priority_match else "medium"

        cancel_idx = comment_content.find("; cancelled: ")
        node_id = comment_content if cancel_idx == -1 else comment_content[:cancel_idx].strip()
        cancel_reason = (
            None if cancel_idx == -1 else comment_content[cancel_idx + len("; cancelled: ") :]
        )

        node = TodoNode(
            id=node_id.strip(),
            content=content,
            status=cast(TodoStatus, CHAR_TO_STATUS.get(status_char, "pending")),
            priority=cast(TodoPriority, priority),
            cancel_reason=cancel_reason,
            children=[],
        )

        while stack and stack[-1][1] >= depth:
            stack.pop()
        if not stack:
            roots.append(node)
        else:
            stack[-1][0].children.append(node)
        stack.append((node, depth))
    return roots


def load_todo_forest(session_id: str) -> list[TodoNode]:
    path = resolve_todo_file_path(session_id)
    try:
        return parse_todo_forest(path.read_text(encoding="utf-8"))
    except OSError:
        return []


def store_todo_forest(session_id: str, nodes: list[TodoNode]) -> None:
    path = resolve_todo_file_path(session_id)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    tmp.write_text(serialize_todo_forest(nodes), encoding="utf-8")
    tmp.replace(path)


def collect_all_ids(nodes: list[TodoNode]) -> set[str]:
    ids: set[str] = set()
    for node in nodes:
        ids.add(node.id)
        ids.update(collect_all_ids(node.children))
    return ids


def find_node(nodes: list[TodoNode], node_id: str) -> TodoNode | None:
    for node in nodes:
        if node.id == node_id:
            return node
        found = find_node(node.children, node_id)
        if found is not None:
            return found
    return None


def is_terminal(node: TodoNode) -> bool:
    return node.status in {"completed", "cancelled"}


def get_current_task(nodes: list[TodoNode]) -> TodoNode | None:
    for node in nodes:
        if is_terminal(node):
            continue
        if node.children and not all(is_terminal(child) for child in node.children):
            return get_current_task(node.children)
        return node
    return None


def count_todo_nodes(nodes: list[TodoNode]) -> int:
    return sum(1 + count_todo_nodes(node.children) for node in nodes)


def create_plan(session_id: str, inputs: list[PlanInput]) -> list[TodoNode]:
    existing = load_todo_forest(session_id)
    if existing:
        raise ValueError(
            "A plan already exists for this session. Use todo_edit or todo_advance instead."
        )
    nodes = assign_slugs(inputs, set())
    store_todo_forest(session_id, nodes)
    return nodes


def advance_todo(
    session_id: str,
    node_id: str,
    action: str,
    reason: str | None = None,
) -> tuple[list[TodoNode], TodoNode | None]:
    nodes = load_todo_forest(session_id)
    current = get_current_task(nodes)
    if current is None:
        raise ValueError("No current task — all tasks are complete or cancelled.")
    if current.id != node_id:
        raise ValueError(
            f'The current task is "{current.id}" ("{current.content}"). You must advance it first.'
        )
    if action == "cancel" and not (reason or "").strip():
        raise ValueError("A reason is required when cancelling a task.")

    def mutate(items: list[TodoNode]) -> list[TodoNode]:
        updated: list[TodoNode] = []
        for node in items:
            if node.id == node_id:
                updated.append(
                    node.model_copy(
                        update={
                            "status": "completed" if action == "complete" else "cancelled",
                            "cancel_reason": reason if action == "cancel" else None,
                            "children": mutate(node.children),
                        }
                    )
                )
            else:
                updated.append(node.model_copy(update={"children": mutate(node.children)}))
        return updated

    updated = mutate(nodes)
    store_todo_forest(session_id, updated)
    return updated, get_current_task(updated)


def edit_todos(session_id: str, ops: list[EditOp]) -> list[TodoNode]:
    nodes = load_todo_forest(session_id)
    for op in ops:
        if isinstance(op, AddOp):
            existing = collect_all_ids(nodes)
            new_node = TodoNode(
                id=unique_slug(op.content, existing),
                content=op.content,
                status="pending",
                priority=op.priority or "medium",
                children=[],
            )
            if not op.parent_id:
                if op.after_id:
                    idx = next(
                        (i for i, node in enumerate(nodes) if node.id == op.after_id),
                        len(nodes) - 1,
                    )
                    nodes = nodes[: idx + 1] + [new_node] + nodes[idx + 1 :]
                else:
                    nodes = [*nodes, new_node]
                continue

            nodes = _insert_add(nodes, op, new_node)
        elif isinstance(op, UpdateOp):
            target = find_node(nodes, op.id)
            if target is None:
                raise ValueError(f'No node with id "{op.id}"')
            if is_terminal(target):
                raise ValueError(f"Cannot update a {target.status} node.")

            nodes = _apply_update_op(nodes, op)
            continue

        if isinstance(op, CancelOp):
            target = find_node(nodes, op.id)
            if target is None:
                raise ValueError(f'No node with id "{op.id}"')
            if target.status == "completed":
                raise ValueError("Cannot cancel a completed node.")
            if target.status == "cancelled":
                raise ValueError(f'Node "{op.id}" is already cancelled.')

            nodes = _apply_cancel_op(nodes, op)

    store_todo_forest(session_id, nodes)
    return nodes


def _insert_add(nodes: list[TodoNode], op: AddOp, new_node: TodoNode) -> list[TodoNode]:
    updated: list[TodoNode] = []
    for node in nodes:
        if node.id == op.parent_id:
            children = list(node.children)
            if op.after_id:
                idx = next(
                    (i for i, child in enumerate(children) if child.id == op.after_id),
                    len(children) - 1,
                )
                children = children[: idx + 1] + [new_node] + children[idx + 1 :]
            else:
                children.append(new_node)
            updated.append(node.model_copy(update={"children": children}))
        else:
            updated.append(
                node.model_copy(update={"children": _insert_add(node.children, op, new_node)})
            )
    return updated


def _apply_update_op(nodes: list[TodoNode], op: UpdateOp) -> list[TodoNode]:
    updated: list[TodoNode] = []
    for node in nodes:
        if node.id == op.id:
            changes: dict[str, object] = {}
            if op.content is not None:
                changes["content"] = op.content
            if op.priority is not None:
                changes["priority"] = op.priority
            updated.append(node.model_copy(update=changes))
        else:
            updated.append(
                node.model_copy(update={"children": _apply_update_op(node.children, op)})
            )
    return updated


def _apply_cancel_op(nodes: list[TodoNode], op: CancelOp) -> list[TodoNode]:
    updated: list[TodoNode] = []
    for node in nodes:
        if node.id == op.id:
            updated.append(
                node.model_copy(update={"status": "cancelled", "cancel_reason": op.reason})
            )
        else:
            updated.append(
                node.model_copy(update={"children": _apply_cancel_op(node.children, op)})
            )
    return updated


def status_marker(status: str) -> str:
    return {
        "completed": "[x]",
        "in_progress": "[-]",
        "cancelled": "[~]",
    }.get(status, "[ ]")


def summarize_top_level_todos(todos: list[TodoNode]) -> list[str]:
    lines: list[str] = []
    for todo in todos:
        child_suffix = ""
        if len(todo.children) == 1:
            child_suffix = " (1 child)"
        elif todo.children:
            child_suffix = f" ({len(todo.children)} children)"
        lines.append(f"- {status_marker(todo.status)} {todo.content}{child_suffix}")
    return lines


def build_markdown_todo_tree(todos: list[TodoNode], current: TodoNode | None) -> str:
    lines = ["# Todo Tree", ""]

    def visit(nodes: list[TodoNode], depth: int) -> None:
        for node in nodes:
            pad = "  " * depth
            current_suffix = " <-- current" if current and node.id == current.id else ""
            lines.append(f"{pad}- {status_marker(node.status)} {node.content}{current_suffix}")
            visit(node.children, depth + 1)

    if not todos:
        lines.append("_No todos yet._")
    else:
        visit(todos, 0)
    return "\n".join(lines)


def build_todo_tree_reminder() -> str:
    return "\n".join(
        [
            "<system-reminder>",
            "The full todo tree has already been displayed in chat.",
            "Refer to that displayed tree instead of repeating the full hierarchy "
            "unless the user asks for it again.",
            "</system-reminder>",
            "",
        ]
    )


def build_todo_tree_result(todos: list[TodoNode], current: TodoNode | None) -> TodoDisplay:
    verification_passphrase = os.environ.get(IMPROVED_TODO_VERIFICATION_PASSPHRASE_ENV, "").strip()
    current_line = (
        f'\nCurrent task: {current.id} - "{current.content}"'
        if current
        else "\nAll tasks complete."
    )
    lines = [
        "Top-level todos:",
        *summarize_top_level_todos(todos),
        "",
        "Todo tree (JSON):",
        json_dump_todos(todos),
        current_line,
    ]
    if verification_passphrase:
        lines.extend(["", f"Verification passphrase: {verification_passphrase}"])
    return TodoDisplay(
        title=f"{len(todos)} top-level todos",
        metadata={
            "topLevelCount": len(todos),
            "totalCount": count_todo_nodes(todos),
            "currentTaskId": current.id if current else None,
        },
        output="\n".join(lines),
    )


def json_dump_todos(todos: list[TodoNode]) -> str:
    import json

    return json.dumps([todo.model_dump() for todo in todos], indent=2)
