// Reading a question for `lens new` (docs/design.md §7): the words to look
// for, and what the wording points at.
//
//   terms        the question's own words, stemmed (`cancelling` → `cancel`),
//                and the English keywords the agent supplied (`--terms`), since
//                code is mostly written in English; for a French question
//                without them, the English translations of its words from a
//                small lexicon of everyday app vocabulary (`commande` → `order`);
//                plus a few one-way synonyms (`buy` → `order`) at a lower weight.
//   bridged      the question is not English (see `isBridged`): its words were
//                bridged to English, by the supplied terms or the lexicon.
//   kinds        node kinds the wording points at: data words (`fields`,
//                `stored`, `données`) → entity, endpoint words → route, …
//   methods      HTTP methods the verbs point at (`fetch` → GET, `cancel` →
//                DELETE, `create` → POST, `update` → PUT / PATCH).
//   cardinality  `one` (by id, a specific…) or `all` (every, list…).
//
// Words are split by the engine's tokenizer (`codeindex.keywords` +
// `subtokens`), so a word in any script is kept as the engine indexes it.
//
// Pure and deterministic: the same question always reads the same. The
// lexicons are generic on purpose (no repository's own names): what a
// question means in a given repo is the ranking's job, over its real nodes.

import { codeindex } from "./engine.js";
import type { NodeKind } from "./model/types.js";

/** Weight of a synonym next to a word of the question (or its translation, or a supplied term), which weighs 1. */
export const SYNONYM_WEIGHT = 0.6;

/**
 * Weight of a bridged question's own words when the agent supplied English
 * terms: the terms say what to look for, the question's words only catch code
 * written in its language. Below SYNONYM_WEIGHT, so short words of another
 * language that prefix English identifiers (`con` → `config`, `per` →
 * `persist`) never outrank a term.
 */
export const OWN_WORD_WEIGHT = 0.25;

/**
 * Share of a question's words that must be English stopwords (the engine's
 * list: `the`, `does`, `what`…) for it to read as English. Every English
 * question of the evals is above it, every other language below.
 */
export const ENGLISH_SHARE = 0.2;

export interface QuestionReading {
  /** Search terms, sorted. */
  terms: string[];
  /** Each term's weight: 1, SYNONYM_WEIGHT for a synonym, OWN_WORD_WEIGHT for a bridged question's own word next to supplied terms. */
  weight: Map<string, number>;
  /** Node kinds the wording points at. */
  kinds: Set<NodeKind>;
  /** HTTP methods the verbs point at. */
  methods: Set<string>;
  cardinality?: "one" | "all";
  /** The question is not English (`isBridged`): its words were bridged to English. */
  bridged: boolean;
}

/** Words only French uses (none is an English word): one of them makes the question French. */
const FRENCH_MARKERS = new Set(
  (
    "le la les des du une est sont que qui quoi comment quel quelle quels quelles pour dans avec sur cette ces quand elle elles ils " +
    "pas ou aux au je tu nous vous leur leurs sa ses son mon ma mes ton ta tes cela ceci ca etre fait faut peut peux doit entre chaque " +
    "tout tous toute toutes quelqu quelque se ne qu jusqu lorsqu puis donc alors aussi tres plus moins"
  ).split(" "),
);

/** French words that carry no meaning for the search. */
const FRENCH_STOPWORDS = new Set(
  [
    ...FRENCH_MARKERS,
    ..."de un et il on en par ce l d c j m n s t y a".split(" "),
    ..."exactement concretement vraiment juste seulement bien comme ainsi deja encore toujours jamais rien autre autres meme".split(" "),
    ..."passe passer passee passent devient devenir arrive arriver aboutit aboutir change changer cote moi toi lui eux".split(" "),
    ..."etape etapes parcours complet complete demande dire decris decrire explique expliquer savoir veut veux voudrais".split(" "),
    ..."chose choses facon maniere cas fois quoi quel".split(" "),
  ].filter(Boolean),
);

/** English filler the engine's stopwords keep: words that say nothing about the code. */
const ENGLISH_FILLER = new Set(
  (
    "work works working happen happens happening walk whole thing things someone somebody anyone exactly actually just really way " +
    "tell describe explain show me please can could would should will there here like kind sort end come comes back hit hits " +
    "between through also only still going mean means good bad able need needs want wants"
  ).split(" "),
);

/**
 * Words that name a kind of node rather than a thing in the app ("which
 * route…", "the cart page", "quels champs"): hints (KIND_HINTS), never search
 * terms, or `route` would match every symbol of every `route.ts`.
 */
const KIND_WORDS = new Set("route endpoint screen page table entity field column job api ecran champ".split(" "));

/**
 * French → English, by folded prefix (`annul` covers annuler, annulée,
 * annulation). Everyday app vocabulary only. The longest matching prefix wins.
 */
const FRENCH_TO_ENGLISH: Record<string, string[]> = {
  commande: ["order"],
  annul: ["cancel"],
  retract: ["cancel"],
  supprim: ["delete", "remove"],
  effac: ["delete", "remove"],
  produit: ["product"],
  article: ["item", "article"],
  ligne: ["item", "line"],
  client: ["customer", "client", "user"],
  acheteur: ["customer", "buyer", "user"],
  utilisateur: ["user"],
  panier: ["cart", "basket"],
  paiement: ["payment", "pay"],
  payer: ["pay", "payment"],
  paye: ["pay", "payment"],
  achat: ["purchase", "order"],
  achet: ["purchase", "buy", "order"],
  vente: ["sale", "product"],
  catalogue: ["catalog", "product"],
  prix: ["price"],
  montant: ["amount", "total", "price"],
  facture: ["invoice"],
  livraison: ["delivery", "shipping"],
  livr: ["delivery", "shipping"],
  expedi: ["shipping", "shipment"],
  rembours: ["refund"],
  abonnement: ["subscription"],
  compte: ["account"],
  connexion: ["login", "auth", "session"],
  connect: ["login", "auth"],
  inscri: ["signup", "register"],
  motdepasse: ["password"],
  courriel: ["email", "mail"],
  envoi: ["send"],
  envoy: ["send"],
  notifi: ["notification", "notify"],
  recherch: ["search"],
  cherch: ["search", "find"],
  fichier: ["file", "upload"],
  image: ["image"],
  tache: ["task", "job"],
  planifi: ["schedule", "cron"],
  sante: ["health"],
  etat: ["status", "state", "health"],
  statut: ["status"],
  donnee: ["data"],
  champ: ["field"],
  fiche: ["record"],
  identifiant: ["id"],
  liste: ["list"],
  lister: ["list"],
  recuper: ["get", "fetch"],
  obten: ["get"],
  obtien: ["get"],
  consult: ["get", "view"],
  affich: ["show", "view", "display"],
  voir: ["view", "show"],
  parcour: ["list", "browse"],
  creat: ["create"],
  creer: ["create"],
  cree: ["create"],
  ajout: ["add", "create"],
  enregistr: ["save", "store", "record"],
  conserv: ["store", "save"],
  stock: ["store", "stock"],
  modifi: ["update", "edit"],
  miseajour: ["update"],
  valid: ["validate", "submit", "confirm"],
  confirm: ["confirm"],
  verifi: ["check", "verify"],
  lien: ["relation", "link"],
  reli: ["relation", "link"],
  rattach: ["relation"],
  referen: ["reference", "relation"],
  structur: ["structure", "schema"],
  serveur: ["server"],
  requete: ["request", "query"],
  reponse: ["response"],
  renvoi: ["return", "response"],
  retourn: ["return"],
  erreur: ["error"],
  journal: ["log"],
  ecran: ["screen", "page"],
  bouton: ["button"],
  formulaire: ["form"],
  tableaudebord: ["dashboard"],
  rapport: ["report"],
  parametre: ["setting", "config"],
  reglage: ["setting", "config"],
  role: ["role"],
  droit: ["permission", "role"],
  equipe: ["team"],
  entreprise: ["company", "organization"],
  societe: ["company"],
  adresse: ["address"],
  commentaire: ["comment"],
  avis: ["review"],
  stockage: ["storage"],
  boutique: ["shop", "store"],
  magasin: ["shop", "store"],
};

/** One-way English synonyms: the word asked → words code often uses for it (weighed SYNONYM_WEIGHT). */
const SYNONYMS: Record<string, string[]> = {
  buy: ["order", "purchase"],
  purchase: ["order"],
  checkout: ["order", "cart", "pay"],
  remove: ["delete"],
  wipe: ["delete"],
  erase: ["delete"],
  alive: ["health"],
  ping: ["health"],
  liveness: ["health"],
  readiness: ["health"],
  heartbeat: ["health"],
  uptime: ["health"],
  identifier: ["id"],
  catalog: ["product"],
  sale: ["product"],
  sell: ["product"],
  status: ["health"],
  sign: ["login", "auth"],
  signin: ["login", "auth"],
  login: ["auth", "session"],
};

/** Folded-word prefixes that point at a node kind. */
const KIND_HINTS: [NodeKind, string[]][] = [
  [
    "entity",
    [
      "data",
      "field",
      "column",
      "table",
      "record",
      "stor",
      "kept",
      "keep",
      "save",
      "persist",
      "database",
      "schema",
      "model",
      "structur",
      "relation",
      "link",
      "connect",
      "tie",
      "referenc",
      "remember",
      "information",
      "contain",
      "donnee",
      "champ",
      "fiche",
      "base",
      "conserv",
      "retien",
      "reten",
      "lien",
      "reli",
      "rattach",
      "enregistr",
      "inform",
      "info",
    ],
  ],
  ["route", ["endpoint", "route", "api", "request", "http", "url", "return", "respon", "renvoi", "retourn", "repond", "requete", "interrog", "ping"]],
  ["screen", ["page", "screen", "button", "click", "form", "ecran", "bouton", "cliqu", "formulaire"]],
  ["job", ["job", "cron", "schedul", "queue", "worker", "background", "tache", "planifi"]],
];

/** Folded-word prefixes that point at an HTTP method. */
const METHOD_HINTS: [string[], string[]][] = [
  [
    ["POST"],
    [
      "create",
      "add",
      "place",
      "plac",
      "submit",
      "new",
      "make",
      "buy",
      "purchas",
      "checkout",
      "send",
      "register",
      "creat",
      "creer",
      "ajout",
      "valid",
      "envoi",
      "soumet",
      "achet",
    ],
  ],
  [
    ["GET"],
    [
      "get",
      "fetch",
      "retriev",
      "view",
      "show",
      "read",
      "list",
      "look",
      "find",
      "brows",
      "see",
      "display",
      "open",
      "return",
      "recuper",
      "obten",
      "obtien",
      "consult",
      "affich",
      "voir",
      "parcour",
      "renvoi",
      "lire",
      "interrog",
    ],
  ],
  [["DELETE"], ["delet", "remov", "cancel", "wipe", "eras", "destroy", "supprim", "annul", "effac", "retract"]],
  [
    ["PUT", "PATCH"],
    ["updat", "chang", "edit", "modif", "renam", "miseajour"],
  ],
];

const ONE_HINTS = ["id", "identifier", "identifiant", "specific", "single", "particular", "precis", "particul", "detail"];
const ALL_HINTS = ["all", "every", "list", "brows", "toute", "tous", "liste", "lister", "parcour"];

/** Irregular English forms → the word code uses. */
const IRREGULAR: Record<string, string> = {
  bought: "buy",
  sold: "sell",
  paid: "pay",
  sent: "send",
  made: "make",
  kept: "keep",
  found: "find",
  gave: "give",
  given: "give",
  taken: "take",
  took: "take",
  written: "write",
  wrote: "write",
  ran: "run",
  shipped: "ship",
  children: "child",
  people: "person",
};

/** English stem: `cancelling` → `cancel`, `orders` → `order`, `entries` → `entry`. */
function englishStem(raw: string): string {
  let t = raw;
  const irregular = IRREGULAR[t];
  if (irregular) return irregular;
  if (t.length > 5 && (t.endsWith("ies") || t.endsWith("ied"))) t = `${t.slice(0, -3)}y`;
  else if (t.length > 5 && t.endsWith("ing")) t = t.slice(0, -3);
  else if (t.length > 4 && t.endsWith("ed")) t = t.slice(0, -2);
  else if (t.length > 3 && t.endsWith("s") && !/(ss|us|is)$/.test(t)) t = t.slice(0, -1);
  // `cancell` → `cancel`, `shipp` → `ship`
  if (t.length > 4 && t[t.length - 1] === t[t.length - 2] && !/[aeiou]/.test(t[t.length - 1]!)) t = t.slice(0, -1);
  return t;
}

/** French plural: `commandes` → `commande`, `articles` → `article`. */
const frenchSingular = (t: string) => (t.length > 4 && (t.endsWith("s") || t.endsWith("x")) && !t.endsWith("ss") ? t.slice(0, -1) : t);

/** French multi-word terms the lexicon reads as one word (`mot de passe`, `mise à jour`, `tableau de bord`). */
const joinPhrases = (folded: string) =>
  folded
    .replace(/\bmot[\s'-]+de[\s'-]+passe\b/g, "motdepasse")
    .replace(/\bmise[\s'-]+a[\s'-]+jour\b/g, "miseajour")
    .replace(/\btableau[\s'-]+de[\s'-]+bord\b/g, "tableaudebord");

/**
 * Folded, lowercased words of `text`, stopwords included, split by the
 * engine's tokenizer: `keywords` (Unicode letters, marks and digits, any
 * script) and `subtokens` (`orderItems` → `orderitems`, `order`, `items`).
 */
function words(text: string): string[] {
  const out: string[] = [];
  for (const raw of codeindex.keywords(joinPhrases(codeindex.foldText(text).toLowerCase()), () => true))
    for (const t of codeindex.subtokens(raw)) if (!out.includes(t)) out.push(t);
  return out;
}

const ASCII_WORD = /^[a-z0-9]+$/;
const LETTER = /\p{L}/gu;
const ASCII_LETTER = /[a-z]/i;

/** Most of the letters of `text`, once folded (`é` → `e`), are not a–z: Cyrillic, Arabic, CJK… */
function mostlyNonLatin(text: string): boolean {
  const letters = codeindex.foldText(text).match(LETTER) ?? [];
  return letters.length > 0 && letters.filter((c) => !ASCII_LETTER.test(c)).length * 2 > letters.length;
}

/** The share of the words of `text` that are English stopwords, by the engine's own list (what `keywords` drops). */
function englishShare(text: string): number {
  const all = codeindex.keywords(text, () => true).length;
  return all ? (all - codeindex.keywords(text).length) / all : 0;
}

/**
 * The question is not English when any of these holds:
 *   1. one of its words is a French marker (FRENCH_MARKERS: `le`, `est`, `quand`…);
 *   2. most of its letters are not Latin (`mostlyNonLatin`);
 *   3. terms were supplied and under ENGLISH_SHARE of its words are English
 *      stopwords (a Spanish, German… question: Latin letters, no French marker).
 * Without terms, a Latin-script question with no French marker reads as
 * English: there is nothing to bridge it with.
 */
export function isBridged(question: string, terms = ""): boolean {
  if (words(question).some((w) => FRENCH_MARKERS.has(w))) return true;
  if (mostlyNonLatin(question)) return true;
  return terms.trim() !== "" && englishShare(question) < ENGLISH_SHARE;
}

/** A word long enough to search for: 3 letters for a Latin word (`id` aside), 2 characters in another script (a CJK bigram). */
const searchable = (t: string) => (ASCII_WORD.test(t) ? t.length >= 3 || t === "id" : t.length >= 2);

function longestPrefix<T>(word: string, table: Record<string, T>): T | undefined {
  let best: string | undefined;
  for (const k of Object.keys(table)) if (word.startsWith(k) && (!best || k.length > best.length)) best = k;
  return best === undefined ? undefined : table[best];
}

const hinted = (ws: string[], prefixes: string[]) => ws.some((w) => prefixes.some((p) => w.startsWith(p)));

/**
 * The HTTP methods the leading verb of a verb-noun code name points at
 * (`placeOrder` → POST, `cancelOrder` → DELETE). A one-word name has none: a
 * Next handler named `GET` is its route's twin, which earns the method bonus.
 */
export function verbMethods(name: string): string[] {
  // subtokens: the run-together name first, then its parts (`placeorder`, `place`, `order`).
  const parts = codeindex.subtokens(name);
  const verb = parts.length > 2 ? parts[1]! : "";
  const out: string[] = [];
  if (verb.length >= 3) for (const [ms, prefixes] of METHOD_HINTS) if (prefixes.some((p) => verb.startsWith(p))) out.push(...ms);
  return out;
}

/**
 * Read `question`: the terms to search for, and the kinds, methods and
 * cardinality its wording points at. `terms` are English code keywords the
 * agent supplied (`lens new --terms`): each weighs 1, stemmed like an English
 * word. With them, a bridged question's own words weigh OWN_WORD_WEIGHT and the
 * French lexicon is not used (it is the fallback when no terms are given); an
 * English question's words keep weighing 1 next to them. The hints (kinds,
 * methods, cardinality) read the question and the terms together.
 */
export function readQuestion(question: string, terms = ""): QuestionReading {
  const ws = words(question);
  const supplied = words(terms);
  const bridged = isBridged(question, terms);
  const french = ws.some((w) => FRENCH_MARKERS.has(w));
  const weight = new Map<string, number>();
  const add = (t: string, w: number) => {
    if (!searchable(t) || KIND_WORDS.has(t)) return;
    if (w > (weight.get(t) ?? 0)) weight.set(t, w);
  };
  const stem = (t: string) => (ASCII_WORD.test(t) ? englishStem(t) : t);

  for (const t of supplied) if (!ENGLISH_FILLER.has(t)) add(stem(t), 1);
  if (supplied.length && bridged) {
    // The terms carry the search; the question's own words only catch code written in its language.
    for (const raw of ws) {
      if (FRENCH_STOPWORDS.has(raw) || raw.length < 4) continue;
      add(french ? frenchSingular(raw) : raw, OWN_WORD_WEIGHT);
    }
  } else if (french) {
    for (const raw of ws) {
      if (FRENCH_STOPWORDS.has(raw)) continue;
      const w = frenchSingular(raw);
      const en = longestPrefix(w, FRENCH_TO_ENGLISH);
      if (en) for (const t of en) add(englishStem(t), 1);
      // The word itself too: some code is written in French.
      if (w.length >= 4) add(w, 1);
    }
  } else {
    for (const raw of codeindex.keywords(question)) {
      for (const lower of codeindex.subtokens(raw)) {
        if (ENGLISH_FILLER.has(lower)) continue;
        add(stem(lower), 1);
      }
    }
  }
  for (const t of [...weight.keys()]) for (const s of SYNONYMS[t] ?? []) add(englishStem(s), SYNONYM_WEIGHT);

  const hintWords = [...ws, ...supplied];
  const kinds = new Set<NodeKind>();
  for (const [kind, prefixes] of KIND_HINTS) if (hinted(hintWords, prefixes)) kinds.add(kind);
  const methods = new Set<string>();
  for (const [ms, prefixes] of METHOD_HINTS) if (hinted(hintWords, prefixes)) for (const m of ms) methods.add(m);
  const one = hintWords.some((w) => ONE_HINTS.some((p) => (p === "id" ? w === "id" || w === "ids" : w.startsWith(p))));
  const many = hinted(hintWords, ALL_HINTS);
  const cardinality = one && !many ? "one" : many && !one ? "all" : undefined;

  return {
    terms: [...weight.keys()].sort(),
    weight,
    kinds,
    methods,
    ...(cardinality ? { cardinality } : {}),
    bridged,
  };
}

/** Function words of these languages (folded, lowercased); a word may count for several. */
const LANG_MARKERS: [string, Set<string>][] = [
  ["fr", FRENCH_MARKERS],
  [
    "es",
    new Set(
      "el los las del una unos unas como donde cuando porque pero muy esto esta este eso esa ese quien cual cuales hay tiene puedo quiero que se lo la y".split(
        " ",
      ),
    ),
  ],
  [
    "de",
    new Set("der die das den dem des ein eine einen einem und ist sind wie wo wer was warum nicht ich mir mich wird werden eigentlich auch noch".split(" ")),
  ],
  [
    "it",
    new Set(
      "il gli di per nel nella alla dei della delle degli che cosa come dove quando perche sono questo questa quello quella viene essere anche non ci si".split(
        " ",
      ),
    ),
  ],
  ["pt", new Set("o os um uma umas do da dos das no na ao pelo pela ele ela onde quando porque nao isso essa esse quem qual sao tem voce entao".split(" "))],
  ["nl", new Set("het een de en is zijn hoe waar wanneer waarom niet ik mij wordt worden ook nog dat deze die".split(" "))],
];

/** Letters one language writes (before folding): each one found adds to its count. */
const LANG_LETTERS: [string, RegExp][] = [
  ["es", /[¿¡ñ]/g],
  ["de", /[äöüß]/gi],
  ["fr", /[èêëœç]/gi],
  ["pt", /[ãõ]/gi],
];

/** Script → language, by the first script holding most of the letters. */
const SCRIPTS: [string, RegExp][] = [
  ["ja", /[\p{Script=Hiragana}\p{Script=Katakana}]/u],
  ["ko", /\p{Script=Hangul}/u],
  ["zh", /\p{Script=Han}/u],
  ["ru", /\p{Script=Cyrillic}/u],
  ["ar", /\p{Script=Arabic}/u],
  ["he", /\p{Script=Hebrew}/u],
  ["el", /\p{Script=Greek}/u],
  ["hi", /\p{Script=Devanagari}/u],
  ["th", /\p{Script=Thai}/u],
];

/**
 * A guess at the language of `question`, as a BCP-47 tag, for a conversation
 * turn the agent did not tag. By script when most letters are not Latin (any
 * kana makes it `ja`, before Han alone, `zh`); else each language counts its
 * function words (LANG_MARKERS) and letters (LANG_LETTERS) and the highest
 * count wins, unless it is under 2 and enough of the words are English
 * stopwords (ENGLISH_SHARE): then `en`. `und` (undetermined) when nothing
 * counts.
 */
export function guessLang(question: string): string {
  if (mostlyNonLatin(question)) {
    for (const [lang, re] of SCRIPTS) if (re.test(question)) return lang;
    return "und";
  }
  const ws = words(question);
  const counts = new Map<string, number>();
  for (const [lang, markers] of LANG_MARKERS) counts.set(lang, ws.filter((w) => markers.has(w)).length);
  for (const [lang, re] of LANG_LETTERS) counts.set(lang, (counts.get(lang) ?? 0) + (question.match(re)?.length ?? 0));
  let best = "und";
  let most = 0;
  for (const [lang, n] of counts)
    if (n > most) {
      best = lang;
      most = n;
    }
  const english = englishShare(question);
  if (english >= ENGLISH_SHARE && most < 2) return "en";
  return most ? best : english > 0 ? "en" : "und";
}
