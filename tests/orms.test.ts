import { describe, expect, it } from "vitest";
import { tableNameTemplate } from "../src/extract/drizzle.js";
import { factsOfFiles } from "./helpers.js";

const pkg = (deps: Record<string, string>) => JSON.stringify({ dependencies: deps });

function entitiesOf(files: Record<string, string>): string[] {
  return factsOfFiles(files).entities.map(
    (e) => `${e.name} ${e.orm} ${e.file}:${e.line} ${e.fields.map((f) => `${f.name}:${f.type}${f.relation ? `->${f.relation}` : ""}`).join(",")}`,
  );
}

function usesOf(files: Record<string, string>): string[] {
  return factsOfFiles(files).entityUses.map((u) => `${u.entity} ${u.op} ${u.file}:${u.line}`);
}

describe("drizzle", () => {
  const drizzle = { "package.json": pkg({ "drizzle-orm": "^0.36" }) };
  const schema = [
    'import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";',
    'import { relations } from "drizzle-orm";',
    'export const authors = sqliteTable("authors", (t) => ({ id: t.integer().primaryKey(), name: t.text() }));',
    'export const posts = sqliteTable("posts", {',
    "  id: integer().primaryKey(),",
    "  authorId: integer().references((): AnyColumn => authors.id),",
    '  title: text("title"),',
    "  ...timestamps,",
    "});",
    "export const authorsRelations = relations(authors, ({ many }) => ({ posts: many(posts) }));",
  ].join("\n");

  it("tables named by their const, builder types, references and relations()", () => {
    expect(entitiesOf({ ...drizzle, "src/schema.ts": schema })).toEqual([
      "authors drizzle src/schema.ts:3 id:integer,name:text,posts:posts[]->posts",
      "posts drizzle src/schema.ts:4 id:integer,authorId:integer->authors,title:text",
    ]);
  });

  it("query-builder uses on declared, imported, and namespace-imported tables", () => {
    expect(
      usesOf({
        ...drizzle,
        "src/schema.ts": schema,
        "src/repo.ts": [
          'import { db } from "./db";',
          'import * as s from "./schema";',
          'import { authors, posts } from "./schema";',
          "await db.select({ n: posts.title }).from(posts).innerJoin(authors, eq(posts.authorId, authors.id));",
          "await this.db.insert(s.posts).values({});",
          "await tx.update(authors).set({ name: 'x' });",
          "await db.query.posts.findMany();",
          "await db.$count(authors);",
        ].join("\n"),
      }),
    ).toEqual([
      "authors read src/repo.ts:4",
      "posts read src/repo.ts:4",
      "posts write src/repo.ts:5",
      "authors write src/repo.ts:6",
      "posts read src/repo.ts:7",
      "authors read src/repo.ts:8",
    ]);
  });

  describe("false-positive guards", () => {
    it("ignores unreachable tables, other receivers, comments, strings and undeclared deps", () => {
      expect(
        usesOf({
          ...drizzle,
          "src/schema.ts": schema,
          "src/repo.ts": [
            'import { posts } from "./schema";',
            "const map = new Map();",
            "map.delete(posts);",
            "db.insert(somethingElse);",
            "// db.delete(posts);",
            'console.log("db.insert(posts)");',
          ].join("\n"),
        }),
      ).toEqual([]);
      expect(entitiesOf({ "package.json": pkg({}), "src/schema.ts": schema })).toEqual([]);
      expect(entitiesOf({ ...drizzle, "src/schema.ts": 'const pgTable = (n, c) => c;\nexport const fake = pgTable("fake", { id: 1 });\n' })).toEqual([]);
    });
  });

  describe("table creators", () => {
    const creatorSchema = [
      'import { index, pgTableCreator } from "drizzle-orm/pg-core";',
      'import { relations } from "drizzle-orm";',
      "export const createTable = pgTableCreator((name) => `app_${name}`);",
      'export const users = createTable("user", (d) => ({ id: d.varchar({ length: 255 }).notNull().primaryKey(), age: d.integer() }));',
      "export const posts = createTable(",
      '  "post",',
      "  (d) => ({",
      "    authorId: d",
      "      .varchar({ length: 255 })",
      "      .notNull()",
      "      .references(() => users.id),",
      "    title: d.text(),",
      "  }),",
      '  (t) => [index("post_author_idx").on(t.authorId)],',
      ");",
      "export const usersRelations = relations(users, ({ many }) => ({ posts: many(posts) }));",
      "export const postsRelations = relations(posts, ({ one }) => ({ author: one(users, { fields: [posts.authorId], references: [users.id] }) }));",
    ].join("\n");

    it("same-file creator: builder-method types, multi-line chained references, relations()", () => {
      expect(entitiesOf({ ...drizzle, "src/server/db/schema.ts": creatorSchema })).toEqual([
        "users drizzle src/server/db/schema.ts:4 id:varchar,age:integer,posts:posts[]->posts",
        "posts drizzle src/server/db/schema.ts:5 authorId:varchar->users,title:text,author:users->users",
      ]);
    });

    it("namespace-imported and aliased creators", () => {
      const ns = [
        'import * as pg from "drizzle-orm/pg-core";',
        "const table = pg.pgTableCreator((name) => name);",
        'export const tags = table("tag", { id: pg.serial("id") });',
      ].join("\n");
      const aliased = [
        'import { sqliteTableCreator as creator } from "drizzle-orm/sqlite-core";',
        "const t = creator((name) => `x_${name}`);",
        'export const notes = t("note", (d) => ({ body: d.text() }));',
      ].join("\n");
      expect(entitiesOf({ ...drizzle, "src/a.ts": ns, "src/b.ts": aliased })).toEqual([
        "tags drizzle src/a.ts:3 id:serial",
        "notes drizzle src/b.ts:3 body:text",
      ]);
    });

    it("imported creator: tables declared in other files, references and uses across them", () => {
      const files = {
        ...drizzle,
        "src/server/db/table.ts":
          'import { pgTableCreator } from "drizzle-orm/pg-core";\nexport const createTable = pgTableCreator((name) => `app_${name}`);\n',
        "src/server/db/schema/users.ts": [
          'import { createTable } from "../table";',
          'export const users = createTable("user", (d) => ({ id: d.varchar({ length: 255 }).primaryKey() }));',
        ].join("\n"),
        "src/server/db/schema/posts.ts": [
          'import { relations } from "drizzle-orm";',
          'import { createTable as make } from "~/server/db/table";',
          'import { users } from "./users";',
          'export const posts = make("post", (d) => ({ authorId: d.varchar({ length: 255 }).references(() => users.id) }));',
          "export const postsRelations = relations(posts, ({ one }) => ({ author: one(users) }));",
          "export async function latest() { return db.select().from(posts); }",
        ].join("\n"),
      };
      expect(entitiesOf(files)).toEqual([
        "posts drizzle src/server/db/schema/posts.ts:4 authorId:varchar->users,author:users->users",
        "users drizzle src/server/db/schema/users.ts:2 id:varchar",
      ]);
      expect(usesOf(files)).toEqual(["posts read src/server/db/schema/posts.ts:6"]);
    });

    it("ignores calls to imported functions that are not table creators, and creators outside drizzle-orm", () => {
      const files = {
        ...drizzle,
        "src/util.ts":
          "export const make = (name, cols) => ({ name, cols });\nconst pgTableCreator = (f) => f;\nexport const fake = pgTableCreator((n) => n);\n",
        "src/schema.ts": [
          'import { fake, make } from "./util";',
          'export const things = make("thing", (d) => ({ id: d.integer() }));',
          'export const others = fake("other", (d) => ({ id: d.integer() }));',
        ].join("\n"),
      };
      expect(entitiesOf(files)).toEqual([]);
    });

    describe("physical table name", () => {
      const consts = new Map([["PREFIX", "acme"]]);
      it.each([
        ["(name) => `app_${name}`", "app_", ""],
        ["name => `${name}_v2`", "", "_v2"],
        ["(name: string) => `${PREFIX}_${name}`", "acme_", ""],
        ['(name) => "app_" + name + "_t"', "app_", "_t"],
        ["(name) => PREFIX + '_' + name", "acme_", ""],
        ["(name) => name", "", ""],
        ["(name) => { return `app_${name}`; }", "app_", ""],
        ["(name) => (`app_${name}`)", "app_", ""],
      ])("%s", (raw, prefix, suffix) => {
        expect(tableNameTemplate(raw, consts)).toEqual({ prefix, suffix });
      });
      it.each([["(name) => name.toUpperCase()"], ["(name) => `${UNKNOWN}_${name}`"], ["(name) => `${name}_${name}`"], ["(name) => 'static'"], ["makeName"]])(
        "not computable: %s",
        (raw) => {
          expect(tableNameTemplate(raw, consts)).toBeUndefined();
        },
      );
    });

    it("unifies a Drizzle table with the SQL-migration table of its physical name", () => {
      const migration = [
        "CREATE TABLE app_user (id varchar(255) PRIMARY KEY);",
        "CREATE TABLE app_post (author_id varchar(255) REFERENCES app_user(id), title text);",
        "CREATE TABLE audit_log (user_id varchar(255) REFERENCES app_user(id));",
      ].join("\n");
      const files = {
        ...drizzle,
        "drizzle/0000_init.sql": migration,
        "src/server/db/schema.ts": creatorSchema,
        "src/server/db/report.ts": "export const count = () => sql`SELECT count(*) FROM app_user`;\nexport const audit = () => sql`DELETE FROM audit_log`;\n",
      };
      expect(entitiesOf(files)).toEqual([
        "audit_log sql drizzle/0000_init.sql:3 user_id:varchar(255)->users",
        "users drizzle src/server/db/schema.ts:4 id:varchar,age:integer,posts:posts[]->posts",
        "posts drizzle src/server/db/schema.ts:5 authorId:varchar->users,title:text,author:users->users",
      ]);
      expect(usesOf(files)).toEqual(["users read src/server/db/report.ts:1", "audit_log write src/server/db/report.ts:2"]);
    });

    it("unifies tables of an imported creator, and plain pgTable tables, with their SQL tables", () => {
      const files = {
        ...drizzle,
        "drizzle/0000_init.sql": "CREATE TABLE app_user (id varchar(255));\nCREATE TABLE order_items (id serial);\nCREATE TABLE user (id int);\n",
        "src/db/table.ts": 'import { pgTableCreator } from "drizzle-orm/pg-core";\nexport const createTable = pgTableCreator((name) => `app_${name}`);\n',
        "src/db/users.ts": 'import { createTable } from "./table";\nexport const users = createTable("user", (d) => ({ id: d.varchar({ length: 255 }) }));\n',
        "src/db/items.ts": 'import { pgTable, serial } from "drizzle-orm/pg-core";\nexport const orderItems = pgTable("order_items", { id: serial("id") });\n',
      };
      expect(entitiesOf(files)).toEqual([
        "user sql drizzle/0000_init.sql:3 id:int",
        "orderItems drizzle src/db/items.ts:2 id:serial",
        "users drizzle src/db/users.ts:2 id:varchar",
      ]);
    });

    it("keeps the SQL table when the creator's name template is not computable", () => {
      const files = {
        ...drizzle,
        "drizzle/0000_init.sql": "CREATE TABLE app_user (id varchar(255));\n",
        "src/db/schema.ts": [
          'import { pgTableCreator } from "drizzle-orm/pg-core";',
          "const createTable = pgTableCreator((name) => prefixed(name));",
          'export const users = createTable("user", (d) => ({ id: d.varchar() }));',
        ].join("\n"),
      };
      expect(entitiesOf(files)).toEqual(["app_user sql drizzle/0000_init.sql:1 id:varchar(255)", "users drizzle src/db/schema.ts:3 id:varchar"]);
    });
  });
});

describe("typeorm", () => {
  const typeorm = { "package.json": pkg({ typeorm: "^0.3" }) };
  const entities = {
    "src/photo.entity.ts": [
      'import { BaseEntity, Column, Entity, ManyToMany, ManyToOne, PrimaryColumn } from "typeorm";',
      "@Entity({ name: 'photos' })",
      "export class Photo extends BaseEntity {",
      "  @PrimaryColumn() id!: string;",
      '  @Column({ type: "varchar", length: 200 }) url!: string;',
      '  @ManyToOne(type => Album, "photos") album?: Relation<Album>;',
      '  @ManyToMany("Tag") tags!: Tag[];',
      "  notAColumn = 1;",
      "  @BeforeInsert() touch() {}",
      "}",
      "export class Plain { @Column() x!: string; }",
    ].join("\n"),
    "src/album.entity.ts":
      'import { Entity, PrimaryGeneratedColumn } from "typeorm";\n@Entity()\nexport class Album {\n  @PrimaryGeneratedColumn() id: number;\n}\n',
  };

  it("@Entity classes, column and relation fields; relations to undeclared classes dropped", () => {
    expect(entitiesOf({ ...typeorm, ...entities })).toEqual([
      "Album typeorm src/album.entity.ts:2 id:number",
      "Photo typeorm src/photo.entity.ts:2 id:string,url:string,album:Relation<Album>->Album,tags:Tag[]",
    ]);
  });

  it("repository, entity manager and Active Record uses", () => {
    expect(
      usesOf({
        ...typeorm,
        ...entities,
        "src/photos.ts": [
          'import { AppDataSource } from "./data-source";',
          'import { Photo } from "./photo.entity";',
          'import { Album } from "./album.entity";',
          "const photos = AppDataSource.getRepository(Photo);",
          "await photos.findOneBy({ id });",
          "await AppDataSource.getRepository(Album).save({});",
          "await AppDataSource.manager.remove(Photo, photo);",
          "await Photo.find();",
          "await em.count(Album);",
        ].join("\n"),
      }),
    ).toEqual([
      "Photo read src/photos.ts:5",
      "Album write src/photos.ts:6",
      "Photo write src/photos.ts:7",
      "Photo read src/photos.ts:8",
      "Album read src/photos.ts:9",
    ]);
  });

  it("needs typeorm declared and imported for entities", () => {
    expect(entitiesOf({ "package.json": pkg({}), ...entities })).toEqual([]);
    expect(entitiesOf({ ...typeorm, "src/x.ts": "@Entity()\nexport class X {\n  @Column() a: string;\n}\n" })).toEqual([]);
  });
});

describe("mongoose", () => {
  const mongoose = { "package.json": pkg({ mongoose: "^8" }) };

  it("models from inline schemas, generic model<T>(), refs", () => {
    expect(
      entitiesOf({
        ...mongoose,
        "src/models.ts": [
          'import mongoose, { Schema } from "mongoose";',
          'export const User = mongoose.model<IUser>("User", new Schema({ email: { type: String, unique: true }, friends: [{ type: Schema.Types.ObjectId, ref: "User" }] }));',
          '// export const Ghost = mongoose.model("Ghost", new Schema({}));',
        ].join("\n"),
      }),
    ).toEqual(["User mongoose src/models.ts:2 email:String,friends:ObjectId[]->User"]);
  });

  describe("false-positive guards", () => {
    it("statics only on reachable model names; built-ins and packages are not models", () => {
      expect(
        usesOf({
          ...mongoose,
          "src/m.ts": 'import { model, Schema } from "mongoose";\nexport const Cat = model("Cat", new Schema({ name: String }));\n',
          "src/use.ts": [
            'import { Cat } from "./m";',
            'import { Dog } from "some-package";',
            "await Cat.find();",
            "await Dog.find();",
            "Object.create(null);",
            "await Cat.findByIdAndUpdate(id, {});",
            "// await Cat.deleteMany({});",
          ].join("\n"),
        }),
      ).toEqual(["Cat read src/use.ts:3", "Cat write src/use.ts:6"]);
    });

    it("needs mongoose declared", () => {
      expect(entitiesOf({ "package.json": pkg({}), "src/m.ts": 'import { model, Schema } from "mongoose";\nmodel("Cat", new Schema({}));\n' })).toEqual([]);
    });
  });
});

describe("sequelize", () => {
  const sequelize = { "package.json": pkg({ sequelize: "^6", "sequelize-typescript": "^2" }) };

  it("define(), class + init(), sequelize-typescript, and cross-file associations", () => {
    expect(
      entitiesOf({
        ...sequelize,
        "models/user.js": [
          'const { DataTypes } = require("sequelize");',
          "module.exports = (sequelize) => {",
          '  const User = sequelize.define("User", {',
          "    email: { type: DataTypes.STRING(255), allowNull: false },",
          "    age: DataTypes.INTEGER,",
          "  });",
          "  User.associate = (models) => { User.hasMany(models.Post, { as: 'posts' }); };",
          "  return User;",
          "};",
        ].join("\n"),
        "models/post.ts": [
          'import { DataTypes, Model } from "sequelize";',
          "export class Post extends Model<InferAttributes<Post>> {",
          "  static associate(models) { this.belongsTo(models.User); }",
          "}",
          "Post.init({ title: DataTypes.TEXT }, { sequelize, modelName: 'post' });",
        ].join("\n"),
        "models/tag.ts": [
          'import { BelongsToMany, Column, Model, Table } from "sequelize-typescript";',
          "@Table",
          "export class Tag extends Model {",
          "  @Column label: string;",
          "  @BelongsToMany(() => Post, () => PostTag) posts: Post[];",
          "}",
        ].join("\n"),
        "models/index.js": "Tag.hasOne(Unknown);\n",
      }),
    ).toEqual([
      "Post sequelize models/post.ts:2 title:TEXT,User:User->User",
      "Tag sequelize models/tag.ts:2 label:string,posts:Post[]->Post",
      "User sequelize models/user.js:3 email:STRING,age:INTEGER,posts:Post[]->Post",
    ]);
  });

  it("model statics, models.X registries", () => {
    expect(
      usesOf({
        ...sequelize,
        "models/user.ts":
          'import { DataTypes, Model } from "sequelize";\nexport class User extends Model {}\nUser.init({ email: DataTypes.STRING }, { sequelize });\n',
        "src/users.ts":
          'import { User } from "../models/user";\nawait User.findAll();\nawait User.bulkCreate([]);\nawait models.User.destroy({ where: {} });\nawait db.User.findByPk(1);\n',
      }),
    ).toEqual(["User read src/users.ts:2", "User write src/users.ts:3", "User write src/users.ts:4", "User read src/users.ts:5"]);
  });

  it("needs sequelize declared, and a define() on a non-Sequelize file is nothing", () => {
    expect(
      entitiesOf({ "package.json": pkg({}), "m.js": 'const { DataTypes } = require("sequelize");\nsequelize.define("A", { x: DataTypes.STRING });\n' }),
    ).toEqual([]);
    expect(entitiesOf({ ...sequelize, "el.js": 'customElements.define("x-card", { connected: true });\n' })).toEqual([]);
  });
});
