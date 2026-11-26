import { Order } from "../models/order";

export default defineEventHandler(async (event) => {
  if (event.method === "POST") return Order.create(await readBody(event));
  return Order.find();
});
