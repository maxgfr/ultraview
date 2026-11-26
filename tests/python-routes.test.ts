import { describe, expect, it } from "vitest";
import { runExtractors } from "../src/extract/index.js";
import { djangoPath, djangoRegexPath, djangoUrlsExtractor, fastapiExtractor, flaskExtractor } from "../src/extract/python-routes.js";
import { memoryContext } from "./helpers.js";

function routesOf(files: Record<string, string>): string[] {
  const facts = runExtractors("/repo", Object.keys(files), (abs) => files[abs.slice("/repo/".length)]);
  return facts.routes.map((r) => `${r.method} ${r.path} ${r.file}:${r.line}${r.handler ? ` ${r.handler}` : ""}`);
}

const lines = (...l: string[]) => l.join("\n");

describe("fastapi extractor", () => {
  const DEPS = { "pyproject.toml": '[project]\ndependencies = ["fastapi"]\n' };

  it("reads decorators on FastAPI() and APIRouter(prefix=…) receivers, with handlers and params", () => {
    const routes = routesOf({
      ...DEPS,
      "app/main.py": lines(
        "from fastapi import FastAPI, APIRouter",
        "app = FastAPI()",
        'items = APIRouter(prefix="/items")',
        '@app.get("/")',
        "def home(): ...",
        '@items.put("/{item_id}")',
        "@requires_auth",
        "async def update_item(item_id: int): ...",
        '@items.api_route("/{path:path}", methods=["GET", "DELETE"])',
        "def catch_all(path): ...",
        "@app.post(",
        '    "/login",',
        "    status_code=201,",
        ")",
        "def login(): ...",
      ),
    });
    expect(routes).toEqual([
      "GET / app/main.py:4 home",
      "PUT /items/:item_id app/main.py:6 update_item",
      "DELETE /items/:path app/main.py:9 catch_all",
      "GET /items/:path app/main.py:9 catch_all",
      "POST /login app/main.py:11 login",
    ]);
  });

  it("applies include_router prefixes, same-file and across files (module and object imports)", () => {
    const routes = routesOf({
      ...DEPS,
      "src/app/main.py": lines(
        "from fastapi import FastAPI, APIRouter",
        "from app.routers import orders",
        "from .routers.users import router as users_router",
        "app = FastAPI()",
        'api = APIRouter(prefix="/api")',
        "api.include_router(orders.router)",
        'api.include_router(users_router, prefix="/v1")',
        "app.include_router(api)",
      ),
      "src/app/routers/orders.py": lines("from fastapi import APIRouter", 'router = APIRouter(prefix="/orders")', '@router.get("")', "def list_orders(): ..."),
      "src/app/routers/users.py": lines("from fastapi import APIRouter", "router = APIRouter()", '@router.get("/users/{id}")', "def get_user(id): ..."),
    });
    expect(routes).toEqual(["GET /api/orders src/app/routers/orders.py:3 list_orders", "GET /api/v1/users/:id src/app/routers/users.py:3 get_user"]);
  });

  describe("false-positive guards", () => {
    it("ignores comments, docstrings, log strings and non-router receivers", () => {
      const routes = routesOf({
        ...DEPS,
        "app/main.py": lines(
          "from fastapi import FastAPI",
          "app = FastAPI()",
          '# @app.get("/commented")',
          "def f():",
          '    """@app.get("/docstring")"""',
          "    log.info(\"@app.get('/logged')\")",
          'cache.get("/not-a-route")',
          '@cache.get("/decorated-cache")',
          "def g(): ...",
          '@app.get("relative")',
          "def h(): ...",
        ),
      });
      expect(routes).toEqual([]);
    });

    it("needs fastapi declared, and skips tests and markdown", () => {
      const src = lines("from fastapi import FastAPI", "app = FastAPI()", '@app.get("/x")', "def x(): ...");
      expect(fastapiExtractor.applies({ rel: "app.py", text: src }, memoryContext({ "requirements.txt": "flask\n", "app.py": src }))).toBe(false);
      expect(routesOf({ ...DEPS, "tests/test_app.py": src, "app/test_main.py": src, "docs/api.md": src })).toEqual([]);
    });
  });
});

describe("flask extractor", () => {
  const DEPS = { "requirements.txt": "Flask==3.0\n" };

  it("reads route/verb decorators and add_url_rule, one route per method", () => {
    const routes = routesOf({
      ...DEPS,
      "app.py": lines(
        "from flask import Flask",
        "app = Flask(__name__)",
        '@app.route("/orders", methods=["GET", "POST"])',
        "def orders(): ...",
        '@app.route("/orders/<int:order_id>")',
        "def order(order_id): ...",
        '@app.delete("/orders/<order_id>")',
        "def delete_order(order_id): ...",
        'app.add_url_rule("/health", "health", view_func=views.health)',
      ),
    });
    expect(routes).toEqual([
      "GET /orders app.py:3 orders",
      "POST /orders app.py:3 orders",
      "GET /orders/:order_id app.py:5 order",
      "DELETE /orders/:order_id app.py:7 delete_order",
      "GET /health app.py:9 views.health",
    ]);
  });

  it("applies blueprint url_prefix and register_blueprint mounts, same-file and across files", () => {
    const routes = routesOf({
      ...DEPS,
      "shop/__init__.py": lines(
        "from flask import Flask, Blueprint",
        "from shop.orders import bp as orders_bp",
        "from . import users",
        "app = Flask(__name__)",
        'admin = Blueprint("admin", __name__, url_prefix="/admin")',
        '@admin.get("/stats")',
        "def stats(): ...",
        'app.register_blueprint(admin, url_prefix="/internal")',
        'app.register_blueprint(orders_bp, url_prefix="/api")',
        "app.register_blueprint(users.bp)",
      ),
      "shop/orders.py": lines("from flask import Blueprint", 'bp = Blueprint("orders", __name__, url_prefix="/orders")', '@bp.post("/")', "def create(): ..."),
      "shop/users.py": lines("from flask import Blueprint", 'bp = Blueprint("users", __name__, url_prefix="/users")', '@bp.get("/<id>")', "def show(id): ..."),
    });
    expect(routes).toEqual(["GET /internal/stats shop/__init__.py:6 stats", "POST /api/orders shop/orders.py:3 create", "GET /users/:id shop/users.py:3 show"]);
  });

  describe("false-positive guards", () => {
    it("ignores comments, docstrings, strings and route-like calls on other objects", () => {
      const routes = routesOf({
        ...DEPS,
        "app.py": lines(
          "from flask import Flask",
          "app = Flask(__name__)",
          '# @app.route("/commented")',
          "def f():",
          "    '''",
          '    @app.route("/docstring")',
          "    '''",
          "    print(\"@app.route('/printed')\")",
          '@router.route("/not-flask")',
          "def g(): ...",
        ),
      });
      expect(routes).toEqual([]);
    });

    it("needs flask declared, and skips tests", () => {
      const src = lines("from flask import Flask", "app = Flask(__name__)", '@app.route("/x")', "def x(): ...");
      expect(flaskExtractor.applies({ rel: "app.py", text: src }, memoryContext({ "requirements.txt": "fastapi\n", "app.py": src }))).toBe(false);
      expect(routesOf({ ...DEPS, "tests/conftest_app.py": src, "app_test.py": src })).toEqual([]);
    });
  });
});

describe("django urls extractor", () => {
  const DEPS = { "requirements.txt": "Django>=5\ndjangorestframework\n" };

  it("reads path / re_path with views, include() of modules and inline lists, across files", () => {
    const routes = routesOf({
      ...DEPS,
      "project/urls.py": lines(
        "from django.urls import include, path, re_path",
        "from blog import views as blog_views",
        "urlpatterns = [",
        '    path("", blog_views.home),',
        '    path("blog/", include("blog.urls")),',
        '    path("api/", include([path("ping/", blog_views.ping), path("v1/", include(("blog.api_urls", "api")))])),',
        '    re_path(r"^archive/(?P<year>[0-9]{4})/$", blog_views.archive),',
        "]",
      ),
      "blog/urls.py": lines(
        "from django.urls import path",
        "from . import views",
        "urlpatterns = [",
        '    path("<slug:slug>/", views.PostDetail.as_view(), name="post"),',
        "]",
      ),
      "blog/api_urls.py": lines("from django.urls import path", "from . import api", 'urlpatterns = [path("posts/", api.posts)]'),
    });
    expect(routes).toEqual([
      "ALL /api/v1/posts blog/api_urls.py:3 api.posts",
      "ALL /blog/:slug blog/urls.py:4 views.PostDetail",
      "ALL / project/urls.py:4 blog_views.home",
      "ALL /api/ping project/urls.py:6 blog_views.ping",
      "ALL /archive/:year project/urls.py:7 blog_views.archive",
    ]);
  });

  it("turns a DRF router into list/detail routes, trimmed to each viewset's actions", () => {
    const routes = routesOf({
      ...DEPS,
      "shop/urls.py": lines(
        "from django.urls import include, path",
        "from rest_framework.routers import DefaultRouter",
        "from orders.api import OrderViewSet, TagViewSet, NoteViewSet",
        "router = DefaultRouter()",
        'router.register(r"orders", OrderViewSet)',
        'router.register("tags", TagViewSet)',
        'router.register("notes", NoteViewSet)',
        'urlpatterns = [path("api/", include(router.urls))]',
      ),
      "orders/api.py": lines(
        "from rest_framework import mixins, viewsets",
        "class OrderViewSet(viewsets.ModelViewSet): ...",
        "class TagViewSet(mixins.ListModelMixin, mixins.RetrieveModelMixin, viewsets.GenericViewSet):",
        "    pass",
        "class NoteViewSet(viewsets.ViewSet):",
        "    def list(self, request): ...",
        "    def destroy(self, request, pk=None): ...",
      ),
    });
    expect(routes).toEqual([
      "DELETE /api/orders/:pk shop/urls.py:5 OrderViewSet",
      "GET /api/orders shop/urls.py:5 OrderViewSet",
      "GET /api/orders/:pk shop/urls.py:5 OrderViewSet",
      "PATCH /api/orders/:pk shop/urls.py:5 OrderViewSet",
      "POST /api/orders shop/urls.py:5 OrderViewSet",
      "PUT /api/orders/:pk shop/urls.py:5 OrderViewSet",
      "GET /api/tags shop/urls.py:6 TagViewSet",
      "GET /api/tags/:pk shop/urls.py:6 TagViewSet",
      "DELETE /api/notes/:pk shop/urls.py:7 NoteViewSet",
      "GET /api/notes shop/urls.py:7 NoteViewSet",
    ]);
  });

  it("normalizes Django route strings and regexes", () => {
    expect(djangoPath("orders/<int:pk>/items/")).toBe("/orders/:pk/items");
    expect(djangoPath("")).toBe("/");
    expect(djangoRegexPath(String.raw`^blog/(?P<slug>[-\w]+)/(\d+)/$`)).toBe("/blog/:slug/:p");
    expect(djangoRegexPath("^files/.*$")).toBeUndefined();
  });

  describe("false-positive guards", () => {
    it("ignores commented patterns, docstrings, a path() that is not Django's and files without urlpatterns", () => {
      const routes = routesOf({
        ...DEPS,
        "a/urls.py": lines(
          '"""path("doc/", views.doc)"""',
          "from django.urls import path",
          "urlpatterns = [",
          '    # path("old/", views.old),',
          "]",
          "log.info(\"path('logged/', views.x)\")",
        ),
        "b/urls.py": lines("from os import path", 'urlpatterns = [path("fake/", view)]'),
        "c/views.py": lines("from django.urls import path", 'x = path("nope/", view)'),
        "d/urls.py": lines("from django.urls import path", 'urlpatterns = [path("drf/", v)]', "router.register('ghost', GhostViewSet)"),
      });
      expect(routes).toEqual(["ALL /drf d/urls.py:2 v"]);
    });

    it("needs django declared (and djangorestframework for routers), and skips tests", () => {
      const src = lines("from django.urls import path", 'urlpatterns = [path("x/", v)]');
      expect(djangoUrlsExtractor.applies({ rel: "urls.py", text: src }, memoryContext({ "requirements.txt": "flask\n", "urls.py": src }))).toBe(false);
      expect(routesOf({ ...DEPS, "app/tests/urls.py": src })).toEqual([]);
      const drf = lines(
        "from django.urls import path, include",
        "from rest_framework import routers",
        "router = routers.DefaultRouter()",
        'router.register("o", OViewSet)',
        "urlpatterns = router.urls",
      );
      expect(routesOf({ "requirements.txt": "django\n", "urls.py": drf })).toEqual([]);
    });
  });
});
