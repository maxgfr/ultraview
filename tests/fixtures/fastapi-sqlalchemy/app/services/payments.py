import os

import httpx

PAYMENTS_URL = os.getenv("PAYMENTS_URL", "http://localhost:9000")
STRIPE_KEY = os.getenv("STRIPE_SECRET_KEY")


async def charge(amount):
    async with httpx.AsyncClient(base_url=PAYMENTS_URL) as client:
        await client.post("/payments", json={"amount": amount})
        await client.get(f"/payments/{amount}?expand=refunds")
    # httpx.delete("https://api.stripe.com/v1/old")
    return httpx.post("https://api.stripe.com/v1/charges", data={"amount": amount}, auth=(STRIPE_KEY, ""))


def receipt_url(order_id):
    # Not a call: a dict's .get on a non-HTTP object.
    cache = {}
    return cache.get(f"/receipts/{order_id}")
