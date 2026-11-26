from django.urls import path

from orders.models import Order

urlpatterns = [path("test-only/", lambda r: None)]


def test_create():
    Order.objects.create(status="x")
