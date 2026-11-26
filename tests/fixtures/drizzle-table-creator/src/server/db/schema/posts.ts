import { index } from "drizzle-orm/pg-core";
import { createTable } from "../table";
import { users } from "./users";

export const posts = createTable(
  "post",
  (d) => ({
    id: d.serial().primaryKey(),
    authorId: d
      .varchar({ length: 255 })
      .notNull()
      .references(() => users.id),
    title: d.text(),
  }),
  (t) => [index("post_author_idx").on(t.authorId)],
);

export const comments = createTable("comment", (d) => ({
  id: d.serial().primaryKey(),
  postId: d.integer().notNull().references(() => posts.id),
  body: d.text(),
}));

// export const drafts = createTable("draft", (d) => ({ id: d.serial() }));
