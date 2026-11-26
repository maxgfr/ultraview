import { createTable } from "../table";

export const users = createTable("user", (d) => ({
  id: d.varchar({ length: 255 }).notNull().primaryKey(),
  email: d.varchar({ length: 255 }).notNull(),
}));
