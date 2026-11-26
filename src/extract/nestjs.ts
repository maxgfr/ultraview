// NestJS routes: `@Controller(prefix)` classes and their `@Get(path)` /
// `@Post()` / … handler methods → `METHOD /prefix/path`, handler = the method
// name, line = the method decorator's. Prefixes may be a string, an array of
// strings, or `{ path }`. Only files importing `@nestjs/common` are read, so a
// `@Get` from another library is not a route.

import { importsModule } from "./js.js";
import { cleanRoutePath, stripParamPatterns } from "./routing.js";
import { classDeclarations, type Decorator, declares, isScriptFile, literalList, objectProps, propValue, sourceViews } from "./source.js";
import type { ExtractInput, ExtractOutput, Extractor, RouteFact } from "./types.js";

const METHOD_DECORATORS = new Map([
  ["Get", "GET"],
  ["Post", "POST"],
  ["Put", "PUT"],
  ["Patch", "PATCH"],
  ["Delete", "DELETE"],
  ["Options", "OPTIONS"],
  ["Head", "HEAD"],
  ["All", "ALL"],
]);

/** The paths a `@Controller(…)` / `@Get(…)` argument names; `[""]` when none. Undefined when not literal. */
function decoratorPaths(text: string, d: Decorator): string[] | undefined {
  const arg = d.args?.[0];
  if (!arg) return [""];
  if (arg.raw.startsWith("{")) {
    const obj = objectProps(text, arg.start);
    const path = obj ? propValue(obj.props, "path") : undefined;
    if (!path) return [""];
    return literalList(path.value);
  }
  return literalList(arg.raw);
}

function extractNest(input: ExtractInput): ExtractOutput {
  const { text, skeleton, lineOf } = sourceViews(input);
  if (!importsModule(text, "@nestjs/common")) return {};
  const routes: RouteFact[] = [];
  for (const cls of classDeclarations(skeleton, text)) {
    const controller = cls.decorators.find((d) => d.name === "Controller");
    if (!controller) continue;
    const prefixes = decoratorPaths(text, controller);
    if (!prefixes) continue;
    for (const member of cls.members) {
      if (member.kind !== "method") continue;
      for (const d of member.decorators) {
        const method = METHOD_DECORATORS.get(d.name);
        if (!method) continue;
        const paths = decoratorPaths(text, d);
        if (!paths) continue;
        for (const prefix of prefixes) {
          for (const p of paths) {
            routes.push({
              method,
              path: cleanRoutePath(stripParamPatterns(`${prefix}/${p}`)),
              file: input.rel,
              line: lineOf(d.start),
              framework: "nestjs",
              handler: member.name,
            });
          }
        }
      }
    }
  }
  return routes.length ? { routes } : {};
}

export const nestjsExtractor: Extractor = {
  id: "nestjs",
  applies(input, ctx) {
    return isScriptFile(input.rel) && declares(ctx, input.rel, ["@nestjs/common", "@nestjs/core"]);
  },
  extract: extractNest,
};
