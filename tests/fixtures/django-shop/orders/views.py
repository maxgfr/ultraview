import logging

import requests
import stripe
from django.conf import settings
from django.http import JsonResponse
from django.views import View

from .models import Order, Product

logger = logging.getLogger(__name__)
stripe.api_key = settings.STRIPE_SECRET_KEY


def order_list(request):
    orders = Order.objects.filter(status="open").select_related("customer")
    logger.info("Order.objects.all() is not a use, requests.get('/x') is not a call")
    return JsonResponse({"orders": [o.pk for o in orders]})


class OrderDetail(View):
    def get(self, request, pk):
        order = Order.objects.get(pk=pk)
        stock = requests.get(f"{settings.INVENTORY_URL}/stock/{order.pk}?fresh=1", timeout=5)
        return JsonResponse({"status": order.status, "stock": stock.json()})

    def delete(self, request, pk):
        Order.objects.filter(pk=pk).delete()
        return JsonResponse({}, status=204)


def checkout_start(request):
    product = Product.objects.get(sku=request.GET["sku"])
    intent = stripe.PaymentIntent.create(amount=int(product.price * 100), currency="eur")
    Order.objects.create(status="pending")
    return JsonResponse({"client_secret": intent.client_secret})


def checkout_done(request):
    requests.post("https://hooks.slack.com/services/T000/B000/XXX", json={"text": "paid"})
    return JsonResponse({"ok": True})


def legacy_product(request, slug):
    # Product.objects.delete()
    return JsonResponse({"slug": slug})
