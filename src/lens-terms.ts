// Reading a question for `lens new` (docs/design.md §7): the words to look
// for, and what the wording points at.
//
//   terms        the question's own words, stemmed (`cancelling` → `cancel`);
//                for a French question, their English translations from a
//                small lexicon of everyday app vocabulary (`commande` → `order`),
//                since code is mostly written in English; plus a few one-way
//                synonyms (`buy` → `order`) at a lower weight.
//   kinds        node kinds the wording points at: data words (`fields`,
//                `stored`, `données`) → entity, endpoint words → route, …
//   methods      HTTP methods the verbs point at (`fetch` → GET, `cancel` →
//                DELETE, `create` → POST, `update` → PUT / PATCH).
//   cardinality  `one` (by id, a specific…) or `all` (every, list…).
//
// Pure and deterministic: the same question always reads the same. The
// lexicons are generic on purpose (no repository's own names): what a
// question means in a given repo is the ranking's job, over its real nodes.

import { codeindex } from "./engine.js";
import type { NodeKind } from "./model/types.js";

/** Weight of a synonym next to a word of the question (or its translation), which weighs 1. */
export const SYNONYM_WEIGHT = 0.6;

export interface QuestionReading {
  /** Search terms, sorted. */
  terms: string[];
  /** Each term's weight: 1, or SYNONYM_WEIGHT for a synonym. */
  weight: Map<string, number>;
  /** Node kinds the wording points at. */
  kinds: Set<NodeKind>;
  /** HTTP methods the verbs point at. */
  methods: Set<string>;
  cardinality?: "one" | "all";
  /** The question reads as French: its words were bridged to English. */
  french: boolean;
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

/** Folded, lowercased words of the question, stopwords included. */
function words(question: string): string[] {
  return codeindex
    .foldText(question)
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

function longestPrefix<T>(word: string, table: Record<string, T>): T | undefined {
  let best: string | undefined;
  for (const k of Object.keys(table)) if (word.startsWith(k) && (!best || k.length > best.length)) best = k;
  return best === undefined ? undefined : table[best];
}

const hinted = (ws: string[], prefixes: string[]) => ws.some((w) => prefixes.some((p) => w.startsWith(p)));

/** Read `question`: the terms to search for, and the kinds, methods and cardinality its wording points at. */
export function readQuestion(question: string): QuestionReading {
  const all = words(question);
  // `mot de passe`, `mise à jour`, `tableau de bord`: one word for the lexicon.
  const joined = all
    .join(" ")
    .replace(/\bmot de passe\b/g, "motdepasse")
    .replace(/\bmise a jour\b/g, "miseajour")
    .replace(/\btableau de bord\b/g, "tableaudebord");
  const ws = joined.split(" ").filter(Boolean);
  const french = ws.some((w) => FRENCH_MARKERS.has(w));
  const weight = new Map<string, number>();
  const add = (t: string, w: number) => {
    if ((t.length < 3 && t !== "id") || KIND_WORDS.has(t)) return;
    if (w > (weight.get(t) ?? 0)) weight.set(t, w);
  };

  if (french) {
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
      const lower = codeindex.foldText(raw).toLowerCase();
      if (!/^[a-z0-9]+$/.test(lower) || ENGLISH_FILLER.has(lower)) continue;
      add(englishStem(lower), 1);
    }
  }
  for (const t of [...weight.keys()]) for (const s of SYNONYMS[t] ?? []) add(englishStem(s), SYNONYM_WEIGHT);

  const kinds = new Set<NodeKind>();
  for (const [kind, prefixes] of KIND_HINTS) if (hinted(ws, prefixes)) kinds.add(kind);
  const methods = new Set<string>();
  for (const [ms, prefixes] of METHOD_HINTS) if (hinted(ws, prefixes)) for (const m of ms) methods.add(m);
  const one = ws.some((w) => ONE_HINTS.some((p) => (p === "id" ? w === "id" || w === "ids" : w.startsWith(p))));
  const many = hinted(ws, ALL_HINTS);
  const cardinality = one && !many ? "one" : many && !one ? "all" : undefined;

  return {
    terms: [...weight.keys()].sort(),
    weight,
    kinds,
    methods,
    ...(cardinality ? { cardinality } : {}),
    french,
  };
}
