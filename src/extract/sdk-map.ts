// The curated map of third-party services the `externals` extractor knows,
// as data: add a service by adding an entry. Pure, no logic.
//
//   id    the external's node id (`ext:<id>`)
//   npm   package names; a trailing `*` matches a prefix (`@aws-sdk/*`)
//   py    Python top-level import modules (`boto3`, `google.cloud`)
//   dist  Python distributions that provide those modules (what manifests
//         declare); a trailing `*` matches a prefix (`google-cloud-*`)
//   env   environment variable prefixes (`STRIPE` matches `STRIPE_SECRET_KEY`)

export interface SdkEntry {
  id: string;
  npm: string[];
  py: string[];
  dist: string[];
  env: string[];
}

export const SDK_MAP: readonly SdkEntry[] = [
  { id: "algolia", npm: ["algoliasearch", "@algolia/*"], py: ["algoliasearch"], dist: ["algoliasearch"], env: ["ALGOLIA"] },
  { id: "anthropic", npm: ["@anthropic-ai/sdk"], py: ["anthropic"], dist: ["anthropic"], env: ["ANTHROPIC"] },
  { id: "aws", npm: ["@aws-sdk/*", "aws-sdk"], py: ["boto3", "botocore", "aioboto3"], dist: ["boto3", "botocore", "aioboto3"], env: ["AWS"] },
  { id: "elasticsearch", npm: ["@elastic/elasticsearch"], py: ["elasticsearch"], dist: ["elasticsearch"], env: ["ELASTICSEARCH", "ELASTIC"] },
  {
    id: "firebase",
    npm: ["firebase", "firebase-admin", "firebase-functions", "@firebase/*"],
    py: ["firebase_admin"],
    dist: ["firebase-admin"],
    env: ["FIREBASE"],
  },
  { id: "github", npm: ["@octokit/*", "octokit"], py: ["github"], dist: ["pygithub"], env: ["GITHUB"] },
  { id: "google-cloud", npm: ["@google-cloud/*"], py: ["google.cloud"], dist: ["google-cloud-*"], env: ["GOOGLE_CLOUD", "GCP", "GCLOUD"] },
  { id: "mailgun", npm: ["mailgun.js", "mailgun-js"], py: ["mailgun"], dist: ["mailgun", "mailgun2"], env: ["MAILGUN"] },
  { id: "mixpanel", npm: ["mixpanel", "mixpanel-browser"], py: ["mixpanel"], dist: ["mixpanel"], env: ["MIXPANEL"] },
  { id: "mongodb", npm: ["mongodb"], py: ["pymongo", "motor"], dist: ["pymongo", "motor"], env: ["MONGODB", "MONGO"] },
  { id: "openai", npm: ["openai"], py: ["openai"], dist: ["openai"], env: ["OPENAI"] },
  {
    id: "postgres",
    npm: ["pg", "postgres", "@neondatabase/serverless"],
    py: ["psycopg", "psycopg2", "asyncpg"],
    dist: ["psycopg", "psycopg2", "psycopg2-binary", "psycopg-binary", "asyncpg"],
    env: ["POSTGRES", "PG"],
  },
  { id: "posthog", npm: ["posthog-js", "posthog-node"], py: ["posthog"], dist: ["posthog"], env: ["POSTHOG"] },
  { id: "pusher", npm: ["pusher", "pusher-js"], py: ["pusher"], dist: ["pusher"], env: ["PUSHER"] },
  { id: "redis", npm: ["redis", "ioredis", "@upstash/redis"], py: ["redis"], dist: ["redis"], env: ["REDIS"] },
  { id: "resend", npm: ["resend"], py: ["resend"], dist: ["resend"], env: ["RESEND"] },
  { id: "segment", npm: ["@segment/*", "analytics-node"], py: ["segment"], dist: ["segment-analytics-python", "analytics-python"], env: ["SEGMENT"] },
  { id: "sendgrid", npm: ["@sendgrid/*"], py: ["sendgrid"], dist: ["sendgrid"], env: ["SENDGRID"] },
  { id: "sentry", npm: ["@sentry/*"], py: ["sentry_sdk"], dist: ["sentry-sdk"], env: ["SENTRY"] },
  { id: "slack", npm: ["@slack/*"], py: ["slack_sdk", "slack_bolt"], dist: ["slack-sdk", "slack-bolt"], env: ["SLACK"] },
  { id: "stripe", npm: ["stripe", "@stripe/*"], py: ["stripe"], dist: ["stripe"], env: ["STRIPE"] },
  { id: "supabase", npm: ["@supabase/*"], py: ["supabase"], dist: ["supabase"], env: ["SUPABASE"] },
  { id: "twilio", npm: ["twilio"], py: ["twilio"], dist: ["twilio"], env: ["TWILIO"] },
];

/** Framework prefixes stripped from an env var name before matching (`NEXT_PUBLIC_SUPABASE_URL` → `SUPABASE_URL`). */
export const ENV_PUBLIC_PREFIXES: readonly string[] = ["NEXT_PUBLIC_", "NUXT_PUBLIC_", "VITE_", "REACT_APP_", "EXPO_PUBLIC_", "PUBLIC_", "GATSBY_"];

/** Hosts that are never a third-party service: local, documentation-reserved, XML / schema namespaces. */
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
  "xmlns.com",
  "purl.org",
  "ns.adobe.com",
  "relaxng.org",
];

/** Reserved / internal top-level labels (RFC 2606, RFC 6762) and their kin. */
export const IGNORED_TLDS: readonly string[] = ["localhost", "local", "internal", "test", "example", "invalid", "lan", "home", "corp"];

/** Two-label public suffixes under which the registrable domain takes three labels (`shop.co.uk`). */
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
];
