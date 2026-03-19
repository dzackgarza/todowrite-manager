from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

TodoStatus = Literal["pending", "in_progress", "completed", "cancelled"]
TodoPriority = Literal["high", "medium", "low"]


class PlanInput(BaseModel):
    model_config = ConfigDict(extra="forbid")

    content: str = Field(min_length=1)
    priority: TodoPriority | None = None
    children: list[PlanInput] = Field(default_factory=list)


PlanInput.model_rebuild()


class TodoNode(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: str
    content: str
    status: TodoStatus
    priority: TodoPriority
    cancel_reason: str | None = None
    children: list[TodoNode] = Field(default_factory=list)


TodoNode.model_rebuild()


class AddOp(BaseModel):
    model_config = ConfigDict(extra="forbid")

    type: Literal["add"]
    parent_id: str | None = None
    after_id: str | None = None
    content: str
    priority: TodoPriority | None = None


class UpdateOp(BaseModel):
    model_config = ConfigDict(extra="forbid")

    type: Literal["update"]
    id: str
    content: str | None = None
    priority: TodoPriority | None = None


class CancelOp(BaseModel):
    model_config = ConfigDict(extra="forbid")

    type: Literal["cancel"]
    id: str
    reason: str


EditOp = AddOp | UpdateOp | CancelOp


class TodoDisplay(BaseModel):
    model_config = ConfigDict(extra="forbid")

    title: str
    metadata: dict[str, object]
    output: str


class TodoResult(BaseModel):
    model_config = ConfigDict(extra="forbid")

    todos: list[TodoNode]
    current: TodoNode | None
    markdown: str
    reminder: str
    display: TodoDisplay
