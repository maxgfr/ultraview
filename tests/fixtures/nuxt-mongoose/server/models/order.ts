import mongoose from "mongoose";

const orderSchema = new mongoose.Schema({
  product: { type: mongoose.Schema.Types.ObjectId, ref: "Product", required: true },
  lines: [{ type: mongoose.Schema.Types.ObjectId, ref: "Product" }],
  customer: { type: mongoose.Schema.Types.ObjectId, ref: "Customer" },
  status: { type: String, enum: ["new", "paid"], default: "new" },
});

export const Order = mongoose.models.Order || mongoose.model("Order", orderSchema);
