import { describe, expect, it } from "vitest";
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
