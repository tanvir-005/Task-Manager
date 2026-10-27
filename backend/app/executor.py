import colorsys
import os
from datetime import datetime, timedelta

from dotenv import load_dotenv
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.database import Category, Task


load_dotenv()

MAX_DAYS_AHEAD = int(os.getenv("MAX_DAYS_AHEAD", "60"))

COLOR_PALETTE = [
    "#2563EB",
    "#DC2626",
    "#16A34A",
    "#9333EA",
    "#EA580C",
    "#0891B2",
    "#DB2777",
    "#4F46E5",
    "#65A30D",
    "#CA8A04",
    "#0D9488",
    "#7C3AED",
]

GOLDEN_ANGLE = 0.618034


def normalize_category_name(name: str) -> str:
    return name.strip().casefold()


def get_used_colors(session: Session) -> set[str]:
    colors = session.scalars(select(Category.color)).all()
    return {color.upper() for color in colors}


def next_category_color(session: Session) -> str:
    used_colors = get_used_colors(session)

    for color in COLOR_PALETTE:
        if color.upper() not in used_colors:
            return color

    hue = 0.0

    while True:
        red, green, blue = colorsys.hls_to_rgb(hue, 0.5, 0.65)

        color = "#{:02X}{:02X}{:02X}".format(
            round(red * 255),
            round(green * 255),
            round(blue * 255),
        )

        if color not in used_colors:
            return color

        hue = (hue + GOLDEN_ANGLE) % 1.0


def get_or_create_category(
    session: Session,
    name: str,
) -> Category:
    cleaned_name = name.strip() or "General"
    normalized_name = normalize_category_name(cleaned_name)

    categories = session.scalars(select(Category)).all()

    for category in categories:
        if normalize_category_name(category.name) == normalized_name:
            return category

    category = Category(
        name=cleaned_name,
        color=next_category_color(session),
    )

    session.add(category)
    session.flush()

    return category


def validate_start_time(
    start: datetime,
    now: datetime,
) -> str | None:
    now = now.replace(second=0, microsecond=0)

    if start < now:
        return "Task start cannot be in the past."

    maximum_start = now + timedelta(days=MAX_DAYS_AHEAD)

    if start > maximum_start:
        return (
            f"Task cannot start more than "
            f"{MAX_DAYS_AHEAD} days ahead."
        )

    return None


def validate_task_times(
    start: datetime,
    end: datetime,
    now: datetime,
) -> tuple[datetime, datetime] | str:
    start = start.replace(second=0, microsecond=0)
    end = end.replace(second=0, microsecond=0)

    error = validate_start_time(start, now)

    if error:
        return error

    if end.date() != start.date():
        end = start.replace(hour=23, minute=59)

    if end <= start:
        return "Task end must be later than its start."

    return start, end


def _parse_datetime(
    value: str | datetime | None,
) -> datetime | None:
    if value is None:
        return None

    if isinstance(value, datetime):
        if value.tzinfo is not None:
            return None

        return value.replace(second=0, microsecond=0)

    try:
        parsed = datetime.fromisoformat(value)
    except (TypeError, ValueError):
        return None

    if parsed.tzinfo is not None:
        return None

    return parsed.replace(second=0, microsecond=0)


def _task_error(task_id: int, message: str) -> str:
    return f"Task #{task_id}: {message}"


def _get_active_task(
    session: Session,
    task_id: int,
) -> Task:
    task = session.get(Task, task_id)

    if task is None:
        raise ValueError("Task not found.")

    if task.status not in ("pending", "postponed"):
        raise ValueError("Task is not active.")

    return task


def _get_task(
    session: Session,
    task_id: int,
) -> Task:
    task = session.get(Task, task_id)

    if task is None:
        raise ValueError("Task not found.")

    return task


def _resolve_new_times(
    operation: dict,
    task: Task,
    now: datetime,
    preserve_duration: bool = True,
) -> tuple[datetime, datetime]:
    start_value = operation.get("start")
    end_value = operation.get("end")
    shift_minutes = operation.get("shift_minutes")

    if start_value is not None:
        start = _parse_datetime(start_value)

        if start is None:
            raise ValueError("Invalid start datetime.")

        if end_value is not None:
            end = _parse_datetime(end_value)

            if end is None:
                raise ValueError("Invalid end datetime.")

        elif preserve_duration:
            end = start + (task.end - task.start)

        else:
            end = start + timedelta(hours=1)

    elif shift_minutes is not None:
        try:
            shift = int(shift_minutes)
        except (ValueError, TypeError):
            raise ValueError("Invalid shift_minutes.") from None

        start = task.start + timedelta(minutes=shift)
        end = task.end + timedelta(minutes=shift)

    else:
        raise ValueError(
            "A new start or shift_minutes is required."
        )

    result = validate_task_times(start, end, now)

    if isinstance(result, str):
        raise ValueError(result)

    return result


def _create_task(
    session: Session,
    operation: dict,
    now: datetime,
) -> Task:
    title = operation.get("title")

    if not isinstance(title, str) or not title.strip():
        raise ValueError("A non-empty title is required.")

    start = _parse_datetime(operation.get("start"))

    if start is None:
        raise ValueError("A valid start datetime is required.")

    end_value = operation.get("end")

    if end_value is None:
        end = start + timedelta(hours=1)
    else:
        end = _parse_datetime(end_value)

        if end is None:
            raise ValueError("Invalid end datetime.")

    result = validate_task_times(start, end, now)

    if isinstance(result, str):
        raise ValueError(result)

    start, end = result

    category_name = operation.get("category") or "General"

    if not isinstance(category_name, str):
        raise ValueError("Category must be a string.")

    category = get_or_create_category(session, category_name)

    task = Task(
        title=title.strip(),
        description=str(
            operation.get("description") or ""
        ).strip(),
        category_id=category.id,
        start=start,
        end=end,
        status="pending",
    )

    session.add(task)
    session.flush()

    return task


def _complete_task(
    session: Session,
    task_id: int,
) -> Task:
    task = _get_active_task(session, task_id)
    task.status = "completed"
    return task


def _cancel_task(
    session: Session,
    task_id: int,
) -> Task:
    task = _get_active_task(session, task_id)
    task.status = "cancelled"
    return task


def _postpone_task(
    session: Session,
    operation: dict,
    task_id: int,
    now: datetime,
) -> Task:
    task = _get_active_task(session, task_id)

    start, end = _resolve_new_times(
        operation,
        task,
        now,
    )

    task.start = start
    task.end = end
    task.status = "postponed"

    return task


def _restore_task(
    session: Session,
    operation: dict,
    task_id: int,
    now: datetime,
) -> Task:
    task = _get_task(session, task_id)

    if task.status != "cancelled":
        raise ValueError(
            "Only cancelled tasks can be restored."
        )

    if task.start >= now:
        task.status = "pending"
        return task

    start, end = _resolve_new_times(
        operation,
        task,
        now,
    )

    task.start = start
    task.end = end
    task.status = "pending"

    return task


def _duplicate_task(
    session: Session,
    operation: dict,
    task_id: int,
    now: datetime,
) -> Task:
    task = _get_task(session, task_id)

    is_due = (
        task.status in ("pending", "postponed")
        and task.end < now
    )
    is_completed = task.status == "completed"

    if not is_completed and not is_due:
        raise ValueError(
            "Only completed or due tasks can be duplicated."
        )

    start_value = operation.get("start")
    shift_minutes = operation.get("shift_minutes")

    if start_value is not None:
        start = _parse_datetime(start_value)

        if start is None:
            raise ValueError("Invalid start datetime.")

        end = start + (task.end - task.start)

    elif shift_minutes is not None:
        try:
            shift = int(shift_minutes)
        except (ValueError, TypeError):
            raise ValueError("Invalid shift_minutes.") from None

        start = task.start + timedelta(minutes=shift)
        end = task.end + timedelta(minutes=shift)

    else:
        raise ValueError(
            "A new start or shift_minutes is required."
        )

    result = validate_task_times(start, end, now)

    if isinstance(result, str):
        raise ValueError(result)

    start, end = result

    duplicate = Task(
        title=task.title,
        description=task.description,
        category_id=task.category_id,
        start=start,
        end=end,
        status="pending",
    )

    session.add(duplicate)
    session.flush()

    return duplicate


def _execute_one(
    session: Session,
    operation: dict,
    now: datetime,
) -> list[str]:
    action = operation.get("action")

    if action == "create":
        _create_task(session, operation, now)
        return []

    task_ids = operation.get("task_ids") or []

    if not task_ids:
        raise ValueError("At least one task ID is required.")

    failures = []

    for task_id in task_ids:
        try:
            # Each task gets its own savepoint. A failed task
            # cannot roll back earlier successful tasks.
            with session.begin_nested():
                if action == "complete":
                    _complete_task(session, task_id)

                elif action == "cancel":
                    _cancel_task(session, task_id)

                elif action == "postpone":
                    _postpone_task(
                        session,
                        operation,
                        task_id,
                        now,
                    )

                elif action == "restore":
                    _restore_task(
                        session,
                        operation,
                        task_id,
                        now,
                    )

                elif action == "duplicate":
                    _duplicate_task(
                        session,
                        operation,
                        task_id,
                        now,
                    )

                else:
                    raise ValueError(
                        f"Unsupported action: {action}"
                    )

                session.flush()

        except ValueError as exc:
            failures.append(
                _task_error(task_id, str(exc))
            )

    return failures


def apply(
    session: Session,
    operations: list[dict],
    now: datetime,
) -> list[dict]:
    if len(operations) > 100:
        raise ValueError(
            "A prompt cannot contain more than 100 operations."
        )

    results = []

    for operation in operations:
        action = operation.get("action", "unknown")

        try:
            # The outer savepoint protects each whole operation.
            with session.begin_nested():
                failures = _execute_one(
                    session,
                    operation,
                    now,
                )

            session.commit()

            if action == "create":
                ok = 1
            else:
                task_ids = operation.get("task_ids") or []
                ok = len(task_ids) - len(failures)

            results.append(
                {
                    "action": action,
                    "ok": ok,
                    "failed": failures,
                }
            )

        except (ValueError, TypeError) as exc:
            session.rollback()

            results.append(
                {
                    "action": action,
                    "ok": 0,
                    "failed": [str(exc)],
                }
            )

    return results