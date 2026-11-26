CREATE TABLE IF NOT EXISTS "board_user" (
	"id" varchar(255) PRIMARY KEY NOT NULL,
	"email" varchar(255) NOT NULL
);

CREATE TABLE IF NOT EXISTS "board_post" (
	"id" serial PRIMARY KEY NOT NULL,
	"author_id" varchar(255) NOT NULL REFERENCES "board_user"("id"),
	"title" text
);

CREATE TABLE IF NOT EXISTS "board_comment" (
	"id" serial PRIMARY KEY NOT NULL,
	"post_id" integer NOT NULL REFERENCES "board_post"("id"),
	"body" text
);

CREATE TABLE IF NOT EXISTS "audit_log" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" varchar(255) REFERENCES "board_user"("id")
);
