from rest_framework import viewsets

from .models import Order, Product


class OrderViewSet(viewsets.ModelViewSet):
    queryset = Order.objects.all()


class ProductViewSet(viewsets.ReadOnlyModelViewSet):
    queryset = Product.objects.all()
