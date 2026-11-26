from django.contrib import admin
from django.urls import include, path, re_path
from rest_framework import routers

from orders.api import OrderViewSet, ProductViewSet
from orders.views import legacy_product

router = routers.DefaultRouter()
router.register(r"orders", OrderViewSet)
router.register("products", ProductViewSet, basename="product")

urlpatterns = [
    path("admin/", admin.site.urls),
    path("api/", include(router.urls)),
    path("shop/", include("orders.urls")),
    re_path(r"^legacy/(?P<slug>[-\w]+)/$", legacy_product),
    # path("old/", include("old.urls")),
]
