from fastapi import APIRouter, Depends

from app.db import get_session
from app.models import User

router = APIRouter(prefix="/users")


@router.get("/{user_id}")
def get_user(user_id: int, session=Depends(get_session)):
    return session.query(User).filter(User.id == user_id).one()
