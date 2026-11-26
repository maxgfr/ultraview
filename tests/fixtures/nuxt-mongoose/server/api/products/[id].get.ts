import { Product } from "../../models/product";

export default defineEventHandler(async (event) => {
  return Product.findById(getRouterParam(event, "id"));
});
