import { Product } from "../../models/product";

export default defineEventHandler(async () => {
  return Product.find().sort({ createdAt: -1 });
});
