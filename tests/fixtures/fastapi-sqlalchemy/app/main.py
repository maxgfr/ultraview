from fastapi import FastAPI

from app.routers import orders, users
from .routers.health import router as health_router

app = FastAPI(title="Orders API")

app.include_router(orders.router, prefix="/api")
app.include_router(users.router, prefix="/api")
app.include_router(health_router)
# app.include_router(legacy.router, prefix="/old")


@app.get("/")
def root():
    """Say hello. Not a route: @app.get("/docstring")"""
    return {"service": "orders"}
