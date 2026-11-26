import { Product } from "~/server/models/product";

export default defineEventHandler(async (event) => {
  const body = await readBody(event);
  return Product.create(body);
});
