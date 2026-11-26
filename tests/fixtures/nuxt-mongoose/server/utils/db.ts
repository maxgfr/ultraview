import mongoose from "mongoose";

export async function connect() {
  await mongoose.connect(process.env.MONGO_URL as string);
}
