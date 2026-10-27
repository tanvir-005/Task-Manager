import logging
from contextlib import asynccontextmanager
from datetime import datetime

from fastapi import FastAPI, File, Form, HTTPException, Query, UploadFile
from sqlalchemy import select
from sqlalchemy.orm import Session, joinedload

from app.database import Base, Category, Task, engine
from app.executor import apply
from app.planner import make_plan


logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI):
    Base.metadata.create_all(bind=engine)
    yield


app = FastAPI(
    title="Task-Manager",
    lifespan=lifespan,
)


@app.get("/api/health")
def health_check():
    return {"status": "ok"}


@app.get("/api/tasks")
def get_tasks(
    start: datetime = Query(...),
    end: datetime = Query(...),
):
    if end <= start:
        raise HTTPException(
            status_code=400,
            detail="'end' must be later than 'start'.",
        )

    with Session(engine) as session:
        statement = (
            select(Task)
            .options(joinedload(Task.category))
            .where(
                Task.start < end,
                Task.end > start,
            )
            .order_by(Task.start)
        )

        tasks = session.scalars(statement).all()
        return [task.to_dict() for task in tasks]


@app.get("/api/categories")
def get_categories():
    with Session(engine) as session:
        categories = session.scalars(
            select(Category).order_by(Category.name)
        ).all()

        return [
            {
                "id": category.id,
                "name": category.name,
                "color": category.color,
            }
            for category in categories
        ]


@app.post("/api/prompt")
async def process_prompt(
    prompt: str = Form(...),
    now: str | None = Form(default=None),
    files: list[UploadFile] = File(default=[]),
):
    if not prompt.strip():
        raise HTTPException(
            status_code=400,
            detail="The prompt cannot be empty.",
        )

    if now is None:
        current_time = datetime.now().replace(
            second=0,
            microsecond=0,
        )
    else:
        try:
            current_time = datetime.fromisoformat(now)
        except ValueError:
            raise HTTPException(
                status_code=400,
                detail=(
                    "'now' must be a valid ISO datetime, "
                    "such as 2026-10-27T12:30."
                ),
            ) from None

        if current_time.tzinfo is not None:
            raise HTTPException(
                status_code=400,
                detail="'now' must use naive local time.",
            )

        current_time = current_time.replace(
            second=0,
            microsecond=0,
        )

    uploaded_files = []

    for uploaded_file in files:
        content = await uploaded_file.read()

        uploaded_files.append(
            (
                uploaded_file.filename or "uploaded_file",
                uploaded_file.content_type or "",
                content,
            )
        )

    with Session(engine) as session:
        try:
            plan = make_plan(
                prompt=prompt.strip(),
                now=current_time,
                files=uploaded_files,
                session=session,
            )
        except Exception:
            session.rollback()
            logger.exception("Groq planner failed")

            raise HTTPException(
                status_code=502,
                detail=(
                    "The Groq planner failed. Check the API key, "
                    "model configuration, and server logs."
                ),
            ) from None

        if plan.clarification:
            return {
                "message": plan.clarification,
                "results": [],
            }

        operations = [
            operation.model_dump()
            for operation in plan.operations
        ]

        try:
            results = apply(
                session=session,
                operations=operations,
                now=current_time,
            )
        except Exception:
            session.rollback()
            logger.exception("Task operation execution failed")

            raise HTTPException(
                status_code=500,
                detail="Failed to execute the planned operations.",
            ) from None

        return {
            "message": plan.message,
            "results": results,
        }