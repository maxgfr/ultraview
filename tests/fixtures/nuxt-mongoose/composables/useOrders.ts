export function useOrders() {
  return useFetch("/api/orders", { method: "GET" });
}

export function placeOrder(productId: string) {
  return $fetch("/api/orders", { method: "POST", body: { productId } });
}
