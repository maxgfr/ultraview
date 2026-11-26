import os

from sqlalchemy import create_engine, text
from sqlalchemy.orm import sessionmaker

engine = create_engine(os.environ["DATABASE_URL"])
SessionLocal = sessionmaker(bind=engine)


def get_session():
    session = SessionLocal()
    try:
        yield session
    finally:
        session.close()


def open_orders(session):
    return session.execute(text("SELECT id, total FROM orders WHERE status = 'open'")).all()


def audit(session, action):
    session.execute(text("INSERT INTO audit_log (action) VALUES (:action)"), {"action": action})
    # session.execute(text("DELETE FROM audit_log"))
    print("update the orders later")
