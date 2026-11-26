import { describe, expect, it } from "vitest";
import { runExtractors } from "../src/extract/index.js";
import { djangoModelsExtractor, djangoOrmExtractor, sqlalchemyModelsExtractor, sqlalchemyOrmExtractor } from "../src/extract/python-orm.js";
import { memoryContext } from "./helpers.js";

function factsOf(files: Record<string, string>) {
  return runExtractors("/repo", Object.keys(files), (abs) => files[abs.slice("/repo/".length)]);
}
const entitiesOf = (files: Record<string, string>) =>
  factsOf(files).entities.map(
    (e) => `${e.name}(${e.orm}):${e.line} ${e.fields.map((f) => `${f.name}:${f.type}${f.relation ? `->${f.relation}` : ""}`).join(" ")}`,
  );
const usesOf = (files: Record<string, string>) => factsOf(files).entityUses.map((u) => `${u.entity} ${u.op} ${u.file}:${u.line}`);

const lines = (...l: string[]) => l.join("\n");
const SA = { "requirements.txt": "SQLAlchemy>=2\n" };
const DJ = { "requirements.txt": "Django>=5\n" };

const SA_MODELS = lines(
  "from sqlalchemy import Column, ForeignKey, Integer, String",
  "from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship",
  "class Base(DeclarativeBase):",
  "    pass",
  "class User(Base):",
  '    __tablename__ = "users"',
  "    id: Mapped[int] = mapped_column(primary_key=True)",
  '    posts: Mapped[list["Post"]] = relationship(back_populates="author")',
  "class Post(Base):",
  '    __tablename__ = "posts"',
  "    id = Column(Integer, primary_key=True)",
  '    author_id = Column(Integer, ForeignKey("users.id"))',
  '    author = relationship("User")',
  '    title: Mapped[str] = mapped_column(String(200), doc="Column(Fake)")',
  "    note: Mapped[Optional[str]]",
);

describe("sqlalchemy models extractor", () => {
  it("reads declarative classes, columns, relationships and foreign keys", () => {
    expect(entitiesOf({ ...SA, "app/models.py": SA_MODELS })).toEqual([
      "User(sqlalchemy):5 id:int posts:Post[]->Post",
      "Post(sqlalchemy):9 id:Integer author_id:Integer->User author:User->User title:str note:str?",
    ]);
  });

  it("reads Flask-SQLAlchemy db.Model classes without __tablename__", () => {
    const files = {
      "requirements.txt": "flask-sqlalchemy\n",
      "app/models.py": lines(
        "from app import db",
        "class Customer(db.Model):",
        "    id = db.Column(db.Integer, primary_key=True)",
        "class Invoice(db.Model):",
        "    id = db.Column(db.Integer, primary_key=True)",
        '    customer_id = db.Column(db.Integer, db.ForeignKey("customer.id"))',
      ),
    };
    expect(entitiesOf(files)).toEqual(["Customer(sqlalchemy):2 id:Integer", "Invoice(sqlalchemy):4 id:Integer customer_id:Integer->Customer"]);
  });

  describe("false-positive guards", () => {
    it("skips bases, mixins, abstract classes, commented and docstring classes, and plain classes", () => {
      const ents = entitiesOf({
        ...SA,
        "app/models.py": lines(
          "from sqlalchemy import Column, Integer",
          "from sqlalchemy.orm import declarative_base",
          "Base = declarative_base()",
          "class Mixin:",
          "    created = Column(Integer)",
          "class Abstract(Base):",
          "    __abstract__ = True",
          "    id = Column(Integer, primary_key=True)",
          "# class Ghost(Base):",
          '#     __tablename__ = "ghosts"',
          '"""',
          "class Doc(Base):",
          '    __tablename__ = "docs"',
          '"""',
          "class Plain(object):",
          "    id = 1",
          "class Thing(Base):",
          '    __tablename__ = "things"',
        ),
      });
      expect(ents).toEqual(["Thing(sqlalchemy):17 "]);
    });

    it("needs sqlalchemy declared, and skips tests", () => {
      expect(sqlalchemyModelsExtractor.applies({ rel: "m.py", text: SA_MODELS }, memoryContext({ "requirements.txt": "django\n", "m.py": "" }))).toBe(false);
      expect(entitiesOf({ ...SA, "tests/models.py": SA_MODELS })).toEqual([]);
    });
  });
});

describe("sqlalchemy uses extractor", () => {
  it("reads session.query/get/add and Core select/insert/update/delete on declared models", () => {
    const uses = usesOf({
      ...SA,
      "app/models.py": SA_MODELS,
      "app/repo.py": lines(
        "import sqlalchemy as sa",
        "from sqlalchemy import select, delete",
        "from app.models import Post, User",
        "def f(session, db):",
        "    session.query(User).all()",
        "    db.session.get(Post, 1)",
        "    session.add(Post(title='x'))",
        "    session.add_all([User(), User()])",
        "    session.scalars(select(Post).where(Post.id == 1))",
        "    session.execute(delete(User))",
        "    session.execute(sa.update(Post).values(title='y'))",
        "    session.execute(sa.insert(User))",
      ),
    });
    expect(uses).toEqual([
      "User read app/repo.py:5",
      "Post read app/repo.py:6",
      "Post write app/repo.py:7",
      "User write app/repo.py:8",
      "Post read app/repo.py:9",
      "User write app/repo.py:10",
      "Post write app/repo.py:11",
      "User write app/repo.py:12",
    ]);
  });

  describe("false-positive guards", () => {
    it("ignores comments, strings, undeclared models, and select() that is not SQLAlchemy's", () => {
      const uses = usesOf({
        ...SA,
        "app/models.py": SA_MODELS,
        "app/repo.py": lines(
          "from selectors import select",
          "def f(session, cache):",
          "    # session.query(User)",
          '    log.info("session.add(Post())")',
          "    session.query(Ghost)",
          "    select(Post)",
          "    cache.add(User())",
          "    update(Post)",
        ),
      });
      expect(uses).toEqual([]);
    });

    it("needs sqlalchemy declared", () => {
      const src = "session.query(User)";
      expect(sqlalchemyOrmExtractor.applies({ rel: "a.py", text: src }, memoryContext({ "requirements.txt": "django\n", "a.py": src }))).toBe(false);
    });
  });
});

const DJ_MODELS = lines(
  "from django.conf import settings",
  "from django.db import models",
  "class Base(models.Model):",
  "    created = models.DateTimeField(auto_now_add=True)",
  "    class Meta:",
  "        abstract = True",
  "class Author(Base):",
  "    user = models.OneToOneField(settings.AUTH_USER_MODEL, on_delete=models.CASCADE)",
  "    name = models.CharField(max_length=100)",
  "class Book(models.Model):",
  '    author = models.ForeignKey("library.Author", on_delete=models.CASCADE)',
  "    sequel = models.OneToOneField('self', null=True, on_delete=models.SET_NULL)",
  "    tags = models.ManyToManyField(to=Tag)",
  "    objects = models.Manager()",
  "    class Meta:",
  '        db_table = "books"',
);

describe("django models extractor", () => {
  it("reads models, fields and relations (class, app-label string, self); skips abstract ones", () => {
    expect(entitiesOf({ ...DJ, "library/models.py": DJ_MODELS })).toEqual([
      "Author(django):7 user:OneToOneField name:CharField",
      "Book(django):10 author:ForeignKey->Author sequel:OneToOneField->Book tags:ManyToManyField",
    ]);
  });

  describe("false-positive guards", () => {
    it("skips commented models, docstring models, non-model classes and files without django.db models", () => {
      const ents = entitiesOf({
        ...DJ,
        "a/models.py": lines(
          "from django.db import models",
          "# class Ghost(models.Model):",
          "#     name = models.CharField()",
          "class Form(forms.Form):",
          "    name = models.CharField()",
          "def f():",
          '    """class Doc(models.Model): pass"""',
        ),
        "b/models.py": lines("import my_lib as models", "class Fake(models.Model):", "    x = models.CharField()"),
      });
      expect(ents).toEqual([]);
    });

    it("needs django declared, and skips tests and markdown", () => {
      expect(djangoModelsExtractor.applies({ rel: "m.py", text: DJ_MODELS }, memoryContext({ "requirements.txt": "flask\n", "m.py": "" }))).toBe(false);
      expect(entitiesOf({ ...DJ, "library/tests/test_models.py": DJ_MODELS, "docs/models.md": DJ_MODELS })).toEqual([]);
    });
  });
});

describe("django orm extractor", () => {
  it("reads manager calls; a write anywhere on the chain wins", () => {
    const uses = usesOf({
      ...DJ,
      "library/models.py": DJ_MODELS,
      "library/views.py": lines(
        "from .models import Author, Book",
        "def f():",
        "    Book.objects.filter(title='x').order_by('-id')",
        "    Author.objects.get(pk=1)",
        "    Book.objects.create(title='y')",
        "    Book.objects.filter(pk=1).update(title='z')",
        "    Author.objects.bulk_create([])",
        "    Book.objects.get_or_create(title='w')",
      ),
    });
    expect(uses).toEqual([
      "Book read library/views.py:3",
      "Author read library/views.py:4",
      "Book write library/views.py:5",
      "Book write library/views.py:6",
      "Author write library/views.py:7",
      "Book write library/views.py:8",
    ]);
  });

  describe("false-positive guards", () => {
    it("ignores comments, strings, unknown managers and models nobody declares", () => {
      const uses = usesOf({
        ...DJ,
        "library/models.py": DJ_MODELS,
        "library/views.py": lines(
          "# Book.objects.all()",
          'log.info("Book.objects.delete()")',
          "Book.archived.all()",
          "Ghost.objects.all()",
          "book.objects.all()",
          "Book.objects.custom_thing()",
        ),
      });
      expect(uses).toEqual([]);
    });

    it("needs django declared", () => {
      expect(djangoOrmExtractor.applies({ rel: "v.py", text: "" }, memoryContext({ "requirements.txt": "sqlalchemy\n", "v.py": "" }))).toBe(false);
    });
  });
});
