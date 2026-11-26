import { relations } from "drizzle-orm";
import { comments, posts } from "./posts";
import { users } from "./users";

export const usersRelations = relations(users, ({ many }) => ({ posts: many(posts) }));

export const postsRelations = relations(posts, ({ one, many }) => ({
  author: one(users, { fields: [posts.authorId], references: [users.id] }),
  comments: many(comments),
}));
