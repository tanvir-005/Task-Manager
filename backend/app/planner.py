import base64
import os
from datetime import datetime, timedelta
from io import BytesIO
from pathlib import Path

from dotenv import load_dotenv
from langchain.chat_models import init_chat_model
from langchain_core.messages import HumanMessage, SystemMessage
from pypdf import PdfReader
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.database import Category, Task
from app.executor import MAX_DAYS_AHEAD
from app.schemas import Plan


BACKEND_DIR = Path(__file__).resolve().parent.parent
load_dotenv(BACKEND_DIR / ".env")

LLM_PROVIDER = os.getenv("LLM_PROVIDER", "groq")
LLM_MODEL = os.getenv("LLM_MODEL", "llama-3.3-70b-versatile")

DEFAULT_DURATIONS = {
    "exam": 180,
    "class": 90,
    "meeting": 60,
    "call": 30,
    "workout": 60,
    "meal": 60,
    "study/work block": 120,
    "errand": 60,
}


def build_context(session: Session, now: datetime) -> str:
    window_start = now - timedelta(days=7)
    window_end = now + timedelta(days=MAX_DAYS_AHEAD)

    categories = session.scalars(
        select(Category).order_by(Category.name)
    ).all()

    category_names = [category.name for category in categories]

    tasks = session.scalars(
        select(Task)
        .options()
        .where(
            Task.start < window_end,
            Task.end >= window_start,
        )
        .order_by(Task.start)
        .limit(300)
    ).all()

    task_lines = []

    for task in tasks:
        status = task.status

        if task.status in ("pending", "postponed") and task.end < now:
            status = "due"

        task_lines.append(
            f"#{task.id} | "
            f"{task.start:%Y-%m-%d %H:%M}-"
            f"{task.end:%H:%M} | "
            f"{task.title} | "
            f"{task.category.name} | "
            f"{status}"
        )

    return (
        f"Existing categories: {', '.join(category_names) or 'None'}\n"
        f"Existing tasks:\n"
        f"{chr(10).join(task_lines) or 'None'}"
    )


def build_system_prompt(now: datetime, context: str) -> str:
    weekday = now.strftime("%A")

    return f"""
You are the planning engine for Task-Manager, a natural-language
calendar task manager.

CURRENT TIME
- Client local time: {now:%Y-%m-%d %H:%M}
- Weekday: {weekday}
- All datetimes are naive local time.
- Datetime output format: YYYY-MM-DDTHH:MM.
- Seconds must always be zero.

OUTPUT
- Return a structured Plan matching the supplied schema.
- Keep the confirmation message short and informative.
- Produce no more than 100 operations.
- Only use task IDs present in the supplied task context.
- Never claim an operation succeeded; the executor determines success.
- If the request is truly impossible to interpret or execute, set
  clarification and return an empty operations list.
- Do not ask for clarification when a reasonable interpretation exists.

SCHEDULING
- Never intentionally schedule a task in the past.
- The executor independently validates all scheduling restrictions.
- A task must start and end on the same day.
- Overlapping tasks are allowed.
- If no date is provided, resolve the requested time to its next
  occurrence from the current time.
- Interpret bare times using context. For example, "exam at 2 today"
  means 14:00 today if that time has not passed.
- Infer a reasonable end time when one is omitted.
- Default durations in minutes:
  exam: 180
  class: 90
  meeting: 60
  call: 30
  workout: 60
  meal: 60
  study/work block: 120
  errand: 60
- For other activities, choose a reasonable duration.
- A missing end time on a create operation may be omitted; the
  executor supplies a one-hour default.

CATEGORIES
- Reuse existing category names exactly whenever appropriate.
- Otherwise, choose a short, general category name.
- Do not invent a new category for every task.
- If no category is appropriate, use General.

ACTION SEMANTICS

create:
- Create a new task.
- Supply title and start.
- Supply a reasonable category and description when appropriate.
- The executor defaults the category to General.

complete:
- Complete only active tasks (pending or postponed).
- Future tasks may also be completed.
- "All done for today" means complete every active task today.

cancel:
- Cancel only active tasks.
- Preserve the original start and end times.
- "Cancel everything for tomorrow" means cancel every active task
  tomorrow.

postpone:
- Postpone only active tasks, including due tasks.
- Supply a new start, optionally a new end, or shift_minutes.
- If end is omitted, preserve the original duration.

restore:
- Restore only cancelled tasks.
- If the original start is at or after the current time, restore the
  task at its original time and omit new times.
- If the original start has passed, provide a new start or shift_minutes.

duplicate:
- Duplicate only completed tasks or due tasks.
- The original task must remain unchanged.
- Supply a new start or shift_minutes relative to the original task.
- A duplicate becomes a new pending task.

TASK SELECTION
- Use only IDs present in the task context.
- Select tasks matching the user's intent, dates, and activity names.
- If a request refers to one task, prefer the most relevant matching task.
- For "all", "everything", or equivalent wording, select every matching
  active task in the requested date range.
- When a request concerns multiple existing tasks, use one operation
  with multiple task_ids when they share the same action and parameters.
- For "I'll study for exam", identify the relevant exam and cancel
  today's other active tasks, leaving the exam untouched.
- Do not create tasks merely because the user mentions an activity
  while discussing an existing task.

CLIENT TIME
The client supplies the current local time. Use it instead of any
assumed server time.

{context}
""".strip()


def build_file_content(
    files: list[tuple[str, str, bytes]],
) -> list[dict]:
    content = []

    for filename, content_type, data in files:
        mime_type = content_type or "application/octet-stream"

        if mime_type.startswith("image/"):
            encoded = base64.b64encode(data).decode("ascii")

            content.append(
                {
                    "type": "image_url",
                    "image_url": {
                        "url": f"data:{mime_type};base64,{encoded}"
                    },
                }
            )

        elif filename.lower().endswith(".pdf") or (
            mime_type == "application/pdf"
        ):
            reader = PdfReader(BytesIO(data))
            extracted_text = "\n".join(
                page.extract_text() or "" for page in reader.pages
            )

            content.append(
                {
                    "type": "text",
                    "text": (
                        f"Contents of PDF '{filename}':\n"
                        f"{extracted_text[:30000]}"
                    ),
                }
            )

        else:
            decoded_text = data.decode("utf-8", errors="replace")

            content.append(
                {
                    "type": "text",
                    "text": (
                        f"Contents of file '{filename}':\n"
                        f"{decoded_text[:30000]}"
                    ),
                }
            )

    return content


def make_plan(
    prompt: str,
    now: datetime,
    files: list[tuple[str, str, bytes]],
    session: Session,
) -> Plan:
    context = build_context(session, now)
    system_prompt = build_system_prompt(now, context)

    user_content = [
        {
            "type": "text",
            "text": f"User request:\n{prompt}",
        }
    ]

    user_content.extend(build_file_content(files))

    model = init_chat_model(
        model=LLM_MODEL,
        model_provider=LLM_PROVIDER,
        temperature=0,
    )

    structured_model = model.with_structured_output(Plan)

    result = structured_model.invoke(
        [
            SystemMessage(content=system_prompt),
            HumanMessage(content=user_content),
        ]
    )

    if result.clarification and result.operations:
        raise ValueError(
            "An LLM plan cannot contain both clarification and operations."
        )

    if len(result.operations) > 100:
        raise ValueError("The LLM returned more than 100 operations.")

    return result