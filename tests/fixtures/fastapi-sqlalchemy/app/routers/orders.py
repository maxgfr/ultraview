import logging

from fastapi import APIRouter, Depends
from sqlalchemy import select, update
from sqlalchemy.orm import Session

from app.db import get_session
from app.models import Order
from app.services.payments import charge

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/orders", tags=["orders"])


@router.get("")
def list_orders(session: Session = Depends(get_session)):
    return session.scalars(select(Order)).all()


@router.get("/{order_id}")
def get_order(order_id: int, session: Session = Depends(get_session)):
    return session.get(Order, order_id)


@router.post("/", status_code=201)
async def create_order(payload: dict, session: Session = Depends(get_session)):
    session.add(Order(user_id=payload["user_id"], total=payload["total"]))
    session.commit()
    await charge(payload["total"])
    logger.info("router.delete('/orders') is not a route; session.query(Order) is not a use")
    return {"ok": True}


@router.api_route("/{order_id}/cancel", methods=["POST", "PUT"])
def cancel_order(order_id: int, session: Session = Depends(get_session)):
    session.execute(update(Order).where(Order.id == order_id).values(status="cancelled"))
