import { sql } from "drizzle-orm";
import { db } from "../db";
import { posts } from "../db/schema/posts";
import { users } from "../db/schema/users";

export async function feed() {
  return db.select().from(posts).innerJoin(users, sql`true`);
}

export async function publish(title: string, authorId: string) {
  await db.insert(posts).values({ title, authorId });
}

export async function authorCount() {
  return db.execute(sql`SELECT count(*) FROM board_user`);
}

export async function purgeAudit() {
  return db.execute(sql`DELETE FROM audit_log`);
}
