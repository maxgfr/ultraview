from django.conf import settings
from django.db import models


class TimeStamped(models.Model):
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        abstract = True


class Customer(TimeStamped):
    user = models.OneToOneField(settings.AUTH_USER_MODEL, on_delete=models.CASCADE)
    email = models.EmailField(unique=True)


class Product(models.Model):
    sku = models.CharField(max_length=32, unique=True)
    price = models.DecimalField(max_digits=10, decimal_places=2)


class Order(TimeStamped):
    customer = models.ForeignKey(Customer, on_delete=models.PROTECT, related_name="orders")
    products = models.ManyToManyField(Product, through="OrderItem")
    status = models.CharField(max_length=16, default="open")
    parent = models.ForeignKey("self", null=True, blank=True, on_delete=models.SET_NULL)

    class Meta:
        db_table = "shop_orders"


class OrderItem(models.Model):
    order = models.ForeignKey("orders.Order", on_delete=models.CASCADE)
    product = models.ForeignKey(Product, on_delete=models.PROTECT)
    quantity = models.PositiveIntegerField(default=1)


# class Ghost(models.Model):
#     name = models.CharField(max_length=10)
