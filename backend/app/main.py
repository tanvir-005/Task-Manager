from fastapi import FastAPI

app = FastAPI(title="Task-Manager")


@app.get("/api/health")
def health_check():
    return {"status": "ok"}