from celery import Celery
from celery.schedules import crontab

celery = Celery("orders", broker="redis://redis:6379/0")


@celery.task
def send_receipt(order_id):
    return order_id


@celery.task(bind=True, max_retries=3)
def nightly_report(self):
    """Build the report. @celery.task def fake(): ..."""
    return None


celery.conf.beat_schedule = {
    "nightly-report": {
        "task": "app.worker.nightly_report",
        "schedule": crontab(minute=0, hour=3),
    },
    "flush-receipts": {
        "task": "app.worker.send_receipt",
        "schedule": 300.0,
    },
}
