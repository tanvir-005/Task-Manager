from typing import Literal

from pydantic import BaseModel, Field


class Operation(BaseModel):
    action: Literal[
        "create",
        "complete",
        "cancel",
        "postpone",
        "restore",
        "duplicate",
    ] = Field(
        description="The operation to perform on tasks."
    )

    task_ids: list[int] = Field(
        default_factory=list,
        description="IDs of existing tasks affected by this operation. Empty for create.",
    )

    title: str | None = Field(
        default=None,
        description="Title of a new task. Required for create.",
    )

    description: str | None = Field(
        default=None,
        description="Short description of a new task.",
    )

    category: str | None = Field(
        default=None,
        description="Category name for a new task. Defaults to General.",
    )

    start: str | None = Field(
        default=None,
        description="Task start datetime in YYYY-MM-DDTHH:MM format.",
    )

    end: str | None = Field(
        default=None,
        description="Task end datetime in YYYY-MM-DDTHH:MM format.",
    )

    shift_minutes: int | None = Field(
        default=None,
        description="Number of minutes to shift an existing task's start and end.",
    )


class Plan(BaseModel):
    message: str = Field(
        description="A short, friendly confirmation of the intended actions.",
    )

    clarification: str | None = Field(
        default=None,
        description="A clarification question only when the request cannot be acted on. Operations must then be empty.",
    )

    operations: list[Operation] = Field(
        default_factory=list,
        description="Structured task operations to execute, with no more than 100 operations.",
    )