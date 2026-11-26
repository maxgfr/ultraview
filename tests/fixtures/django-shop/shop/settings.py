import os

SECRET_KEY = os.environ.get("DJANGO_SECRET_KEY", "dev")
STRIPE_SECRET_KEY = os.environ["STRIPE_SECRET_KEY"]
INVENTORY_URL = os.getenv("INVENTORY_URL", "http://inventory.internal")
INSTALLED_APPS = ["django.contrib.admin", "rest_framework", "orders"]
ROOT_URLCONF = "shop.urls"
