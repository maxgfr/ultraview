import { Product } from "../../models/product";

export default defineEventHandler(async (event) => {
  // Product.deleteMany({}) would wipe the catalog: never.
  await Product.findByIdAndDelete(getRouterParam(event, "id"));
  return { ok: true };
});
