import { Product } from "../server/models/product";

it("lists", async () => {
  await $fetch("/api/test-only");
  await Product.deleteMany({});
});
