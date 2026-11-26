import { Schema, model } from "mongoose";

const productSchema = new Schema(
  {
    name: { type: String, required: true },
    priceCents: Number,
    tags: [String],
    dimensions: { width: Number, height: Number },
  },
  { timestamps: true },
);

export const Product = model("Product", productSchema);
