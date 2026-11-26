from django.urls import include, path

from . import views

urlpatterns = [
    path("", views.order_list, name="order-list"),
    path("<int:pk>/", views.OrderDetail.as_view(), name="order-detail"),
    path(
        "checkout/",
        include(
            [
                path("start/", views.checkout_start),
                path("done/", views.checkout_done),
            ]
        ),
    ),
]
