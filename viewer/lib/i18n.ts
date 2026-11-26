// Interface strings: `t(key, params)` over flat key → text tables, English as
// the source and the fallback, one JSON file per locale (viewer/i18n/*.json).
// `{name}` placeholders are filled from params; a `count` param picks
// `<key>.one` / `<key>.other` by the locale's plural rules. Content written
// by the agent (labels, summaries, answers) is never translated.

import en from "../i18n/en.json";
import fr from "../i18n/fr.json";

export const LOCALES: Record<string, Record<string, string>> = { en, fr };
export const LANGS = ["en", "fr"] as const;
export type Lang = (typeof LANGS)[number];

let lang: Lang = "en";

export function setLang(l: Lang): void {
  lang = l;
}

export function getLang(): Lang {
  return lang;
}

/** The language to start in: a stored choice, else the browser's, else English. */
export function detectLang(stored: string | null | undefined, navigatorLangs: readonly string[] = []): Lang {
  if (stored && (LANGS as readonly string[]).includes(stored)) return stored as Lang;
  for (const n of navigatorLangs) {
    const base = n.toLowerCase().split("-")[0];
    if ((LANGS as readonly string[]).includes(base ?? "")) return base as Lang;
  }
  return "en";
}

function lookup(key: string): string | undefined {
  return LOCALES[lang]?.[key] ?? LOCALES.en?.[key];
}

export type Params = Record<string, string | number>;

export function t(key: string, params?: Params): string {
  let text: string | undefined;
  if (params && typeof params.count === "number") {
    let cat = "other";
    try {
      cat = new Intl.PluralRules(lang).select(params.count);
    } catch {
      cat = params.count === 1 ? "one" : "other";
    }
    text = lookup(`${key}.${cat}`) ?? lookup(`${key}.other`);
  }
  text ??= lookup(key) ?? key;
  if (!params) return text;
  return text.replace(/\{(\w+)\}/g, (m, name: string) => (name in params ? String(params[name]) : m));
}

/** Format a number for the current language. */
export function num(n: number): string {
  try {
    return new Intl.NumberFormat(lang).format(n);
  } catch {
    return String(n);
  }
}
