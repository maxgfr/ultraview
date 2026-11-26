// The curated map of third-party services the `externals` extractor knows,
// as data: add a service by adding an entry. Pure, no logic.
//
//   id    the external's node id (`ext:<id>`)
//   npm   package names; a trailing `*` matches a prefix (`@aws-sdk/*`)
//   py    Python top-level import modules (`boto3`, `google.cloud`)
//   dist  Python distributions that provide those modules (what manifests
//         declare); a trailing `*` matches a prefix (`google-cloud-*`)
//   env   environment variable prefixes (`STRIPE` matches `STRIPE_SECRET_KEY`)
//   hosts API hosts of the service (`api.stripe.com`); a leading `*.` matches
//         the domain and any subdomain (`*.supabase.co`). A URL to one of them
//         is the service wherever the literal sits — never `www.` or docs
//         hosts, which are hyperlinks.

export interface SdkEntry {
  id: string;
  npm: string[];
  py: string[];
  dist: string[];
  env: string[];
  hosts?: string[];
}

export const SDK_MAP: readonly SdkEntry[] = [
  {
    id: "algolia",
    npm: ["algoliasearch", "@algolia/*"],
    py: ["algoliasearch"],
    dist: ["algoliasearch"],
    env: ["ALGOLIA"],
    hosts: ["*.algolia.net", "*.algolianet.com"],
  },
  { id: "anthropic", npm: ["@anthropic-ai/sdk"], py: ["anthropic"], dist: ["anthropic"], env: ["ANTHROPIC"], hosts: ["api.anthropic.com"] },
  {
    id: "aws",
    npm: ["@aws-sdk/*", "aws-sdk"],
    py: ["boto3", "botocore", "aioboto3"],
    dist: ["boto3", "botocore", "aioboto3"],
    env: ["AWS"],
    hosts: ["*.amazonaws.com"],
  },
  {
    id: "elasticsearch",
    npm: ["@elastic/elasticsearch"],
    py: ["elasticsearch"],
    dist: ["elasticsearch"],
    env: ["ELASTICSEARCH", "ELASTIC"],
    hosts: ["*.elastic-cloud.com", "*.found.io"],
  },
  {
    id: "firebase",
    npm: ["firebase", "firebase-admin", "firebase-functions", "@firebase/*"],
    py: ["firebase_admin"],
    dist: ["firebase-admin"],
    env: ["FIREBASE"],
    hosts: ["*.firebaseio.com", "firestore.googleapis.com", "identitytoolkit.googleapis.com", "securetoken.googleapis.com"],
  },
  { id: "github", npm: ["@octokit/*", "octokit"], py: ["github"], dist: ["pygithub"], env: ["GITHUB"], hosts: ["api.github.com", "uploads.github.com"] },
  {
    id: "google-cloud",
    npm: ["@google-cloud/*"],
    py: ["google.cloud"],
    dist: ["google-cloud-*"],
    env: ["GOOGLE_CLOUD", "GCP", "GCLOUD"],
    hosts: ["storage.googleapis.com", "*.cloudfunctions.net"],
  },
  {
    id: "mailgun",
    npm: ["mailgun.js", "mailgun-js"],
    py: ["mailgun"],
    dist: ["mailgun", "mailgun2"],
    env: ["MAILGUN"],
    hosts: ["api.mailgun.net", "api.eu.mailgun.net"],
  },
  {
    id: "mixpanel",
    npm: ["mixpanel", "mixpanel-browser"],
    py: ["mixpanel"],
    dist: ["mixpanel"],
    env: ["MIXPANEL"],
    hosts: ["api.mixpanel.com", "api-eu.mixpanel.com"],
  },
  { id: "mongodb", npm: ["mongodb"], py: ["pymongo", "motor"], dist: ["pymongo", "motor"], env: ["MONGODB", "MONGO"], hosts: ["*.mongodb.net"] },
  { id: "openai", npm: ["openai"], py: ["openai"], dist: ["openai"], env: ["OPENAI"], hosts: ["api.openai.com"] },
  {
    id: "postgres",
    npm: ["pg", "postgres", "@neondatabase/serverless"],
    py: ["psycopg", "psycopg2", "asyncpg"],
    dist: ["psycopg", "psycopg2", "psycopg2-binary", "psycopg-binary", "asyncpg"],
    env: ["POSTGRES", "PG"],
    hosts: ["*.neon.tech"],
  },
  {
    id: "posthog",
    npm: ["posthog-js", "posthog-node"],
    py: ["posthog"],
    dist: ["posthog"],
    env: ["POSTHOG"],
    hosts: ["app.posthog.com", "us.posthog.com", "eu.posthog.com", "us.i.posthog.com", "eu.i.posthog.com"],
  },
  { id: "pusher", npm: ["pusher", "pusher-js"], py: ["pusher"], dist: ["pusher"], env: ["PUSHER"], hosts: ["*.pusherapp.com", "sockjs.pusher.com"] },
  { id: "redis", npm: ["redis", "ioredis", "@upstash/redis"], py: ["redis"], dist: ["redis"], env: ["REDIS"], hosts: ["*.upstash.io"] },
  { id: "resend", npm: ["resend"], py: ["resend"], dist: ["resend"], env: ["RESEND"], hosts: ["api.resend.com"] },
  {
    id: "segment",
    npm: ["@segment/*", "analytics-node"],
    py: ["segment"],
    dist: ["segment-analytics-python", "analytics-python"],
    env: ["SEGMENT"],
    hosts: ["api.segment.io", "cdn.segment.com"],
  },
  { id: "sendgrid", npm: ["@sendgrid/*"], py: ["sendgrid"], dist: ["sendgrid"], env: ["SENDGRID"], hosts: ["api.sendgrid.com"] },
  {
    id: "sentry",
    npm: ["@sentry/*"],
    py: ["sentry_sdk"],
    dist: ["sentry-sdk"],
    env: ["SENTRY"],
    hosts: ["*.ingest.sentry.io", "*.ingest.us.sentry.io", "*.ingest.de.sentry.io"],
  },
  {
    id: "slack",
    npm: ["@slack/*"],
    py: ["slack_sdk", "slack_bolt"],
    dist: ["slack-sdk", "slack-bolt"],
    env: ["SLACK"],
    hosts: ["hooks.slack.com", "slack.com"],
  },
  {
    id: "stripe",
    npm: ["stripe", "@stripe/*"],
    py: ["stripe"],
    dist: ["stripe"],
    env: ["STRIPE"],
    hosts: ["api.stripe.com", "js.stripe.com", "files.stripe.com"],
  },
  { id: "supabase", npm: ["@supabase/*"], py: ["supabase"], dist: ["supabase"], env: ["SUPABASE"], hosts: ["*.supabase.co", "*.supabase.in"] },
  {
    id: "twilio",
    npm: ["twilio"],
    py: ["twilio"],
    dist: ["twilio"],
    env: ["TWILIO"],
    hosts: ["api.twilio.com", "verify.twilio.com", "conversations.twilio.com"],
  },
];

/**
 * Environment variables a CI runner sets that share an SDK's prefix without
 * the code talking to that service: GitHub Actions' `GITHUB_REF_NAME`,
 * `GITHUB_SHA`, `GITHUB_RUN_ID`… (`GITHUB_TOKEN` and `GITHUB_API_URL` stay:
 * they are read to call the API).
 */
export const ENV_IGNORED =
  /^GITHUB_(?:ACTIONS?|ACTION_\w+|ACTOR\w*|REF\w*|SHA|RUN_\w+|WORKFLOW\w*|WORKSPACE|REPOSITORY\w*|EVENT_\w+|HEAD_REF|BASE_REF|JOB|SERVER_URL|OUTPUT|ENV|STEP_SUMMARY|PATH|STATE|RETENTION_DAYS|TRIGGERING_ACTOR)$/;

/** Framework prefixes stripped from an env var name before matching (`NEXT_PUBLIC_SUPABASE_URL` → `SUPABASE_URL`). */
export const ENV_PUBLIC_PREFIXES: readonly string[] = ["NEXT_PUBLIC_", "NUXT_PUBLIC_", "VITE_", "REACT_APP_", "EXPO_PUBLIC_", "PUBLIC_", "GATSBY_"];

/**
 * Hosts that are never a third-party service: local, documentation-reserved
 * (RFC 2606 / RFC 6761), and the XML / schema / sitemap / vocabulary
 * namespaces that vendor formats write as URLs. Matched against the full host
 * and its registrable domain.
 */
export const IGNORED_HOSTS: readonly string[] = [
  "localhost",
  "example.com",
  "example.org",
  "example.net",
  "w3.org",
  "www.w3.org",
  "json-schema.org",
  "schema.org",
  "schemas.xmlsoap.org",
  "schemas.openxmlformats.org",
  "schemas.microsoft.com",
  "schemas.android.com",
  "xmlns.com",
  "xmlns.jcp.org",
  "purl.org",
  "purl.oclc.org",
  "ns.adobe.com",
  "relaxng.org",
  "sitemaps.org",
  "ogp.me",
  "rdfs.org",
  "opengis.net",
  "docbook.org",
  "iptc.org",
  "xmp.org",
];

/**
 * Registrable-domain labels reserved for documentation in any TLD:
 * `example.*` (RFC 2606) and its French twin `exemple.*` — placeholders in
 * forms, docs and fixtures, never a dependency.
 */
export const IGNORED_DOMAIN_LABELS: readonly string[] = ["example", "exemple", "beispiel", "ejemplo", "esempio"];

/**
 * Reserved / internal top-level labels: RFC 2606 / RFC 6761 (`test`,
 * `example`, `invalid`, `localhost`), RFC 6762 (`local`), RFC 8375 / 7686
 * (`arpa`, `onion`), and the private-use kin (`internal`, `lan`, `home`, `corp`).
 */
export const IGNORED_TLDS: readonly string[] = [
  "localhost",
  "local",
  "internal",
  "test",
  "example",
  "invalid",
  "lan",
  "home",
  "corp",
  "arpa",
  "onion",
  "localdomain",
];

/** URL paths of XML / schema namespaces on hosts that also serve real APIs (`www.google.com/schemas/sitemap/0.9`). */
export const NAMESPACE_PATH = /^\/(?:schemas?|ns|xmlns|xml\/ns|dtd|xsd)(?:\/|$)|\/XMLSchema(?:-instance)?$/i;

/**
 * Two-label public suffixes under which the registrable domain takes three
 * labels (`shop.co.uk`, `travail-emploi.gouv.fr`, `my-app.vercel.app`):
 * country second levels, government zones, and hosting platforms whose
 * subdomains belong to different owners (public suffix list, private section).
 */
export const MULTI_LABEL_SUFFIXES: readonly string[] = [
  "co.uk",
  "org.uk",
  "ac.uk",
  "gov.uk",
  "com.au",
  "net.au",
  "org.au",
  "co.nz",
  "co.jp",
  "ne.jp",
  "or.jp",
  "com.br",
  "com.cn",
  "com.hk",
  "com.sg",
  "com.tr",
  "com.mx",
  "co.in",
  "co.za",
  "co.kr",
  "gouv.fr",
  "gov.au",
  "gov.br",
  "gob.mx",
  "gob.es",
  "gv.at",
  "gc.ca",
  "gov.in",
  "github.io",
  "gitlab.io",
  "vercel.app",
  "netlify.app",
  "herokuapp.com",
  "pages.dev",
  "workers.dev",
  "web.app",
  "firebaseapp.com",
  "azurewebsites.net",
  "onrender.com",
  "fly.dev",
  "cloudfront.net",
];
