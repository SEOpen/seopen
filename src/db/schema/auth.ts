import { bigint, boolean, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";

// Better Auth's tables (src/lib/auth). Better Auth makes the text ids; column names follow its
// defaults with usePlural, so `pnpm db:generate` and Better Auth agree without field mappings.

const createdAt = () => timestamp({ withTimezone: true }).notNull().defaultNow();
const ts = () => timestamp({ withTimezone: true });

export const users = pgTable("users", {
  id: text().primaryKey(),
  email: text().notNull().unique(),
  name: text().notNull().default(""),
  image: text(),
  emailVerified: boolean().notNull().default(false),
  /** When the welcome email was claimed (src/lib/welcome-email.ts). Null until the first sign-in. */
  welcomeEmailAt: ts(),
  /** The weekly recap email (src/lib/recap), which the person turns on in Settings. Off until they do. */
  weeklyRecap: boolean().notNull().default(false),
  /** Alert emails (src/modules/alerts), which go to people who get the weekly recap. On until they turn them off. */
  alertEmails: boolean().notNull().default(true),
  /**
   * Where a self sign-up's first visit to the site came from, set once when the account is made and
   * never after (src/lib/first-visit.ts): the campaign tag (utm_source or ref), the other site that
   * linked to us, and the site page it landed on. Null when there was none, and for invites.
   */
  firstSource: text(),
  firstReferrerHost: text(),
  firstLandingPath: text(),
  createdAt: createdAt(),
  updatedAt: ts().notNull().defaultNow(),
});

export const sessions = pgTable(
  "sessions",
  {
    id: text().primaryKey(),
    userId: text()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    token: text().notNull().unique(),
    expiresAt: ts().notNull(),
    ipAddress: text(),
    userAgent: text(),
    createdAt: createdAt(),
    updatedAt: ts().notNull().defaultNow(),
  },
  (t) => [index().on(t.userId)],
);

/** Sign-in methods: "credential" holds the password hash, "google" the login-only Google link. */
export const accounts = pgTable(
  "accounts",
  {
    id: text().primaryKey(),
    userId: text()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    accountId: text().notNull(),
    providerId: text().notNull(),
    accessToken: text(),
    refreshToken: text(),
    idToken: text(),
    accessTokenExpiresAt: ts(),
    refreshTokenExpiresAt: ts(),
    scope: text(),
    password: text(),
    createdAt: createdAt(),
    updatedAt: ts().notNull().defaultNow(),
  },
  (t) => [index().on(t.userId)],
);

/** Email verification and password reset tokens. */
export const verifications = pgTable(
  "verifications",
  {
    id: text().primaryKey(),
    identifier: text().notNull(),
    value: text().notNull(),
    expiresAt: ts().notNull(),
    createdAt: createdAt(),
    updatedAt: ts().notNull().defaultNow(),
  },
  (t) => [index().on(t.identifier)],
);

/** Better Auth's rate limit counters, in Postgres so every instance shares one limit. */
export const rateLimits = pgTable("rate_limits", {
  id: text().primaryKey(),
  key: text().notNull().unique(),
  count: integer().notNull(),
  lastRequest: bigint({ mode: "number" }).notNull(),
});

// ---------------------------------------------------------------------------
// OAuth for the MCP server (src/lib/auth/oauth.ts). Better Auth's
// oauth-provider (through @better-auth/mcp) and jwt plugins own these tables, with their default
// field names under usePlural. A consent's `referenceId` is the id of the workspace it was given for.
// ---------------------------------------------------------------------------

/** An app that signs in over OAuth: registered dynamically, or found from its client ID metadata document. */
export const oauthClients = pgTable(
  "oauth_clients",
  {
    id: text().primaryKey(),
    clientId: text().notNull().unique(),
    clientSecret: text(),
    /** Set for a client found from a client ID metadata document. */
    clientDiscoveryId: text(),
    disabled: boolean().default(false),
    skipConsent: boolean(),
    enableEndSession: boolean(),
    subjectType: text(),
    scopes: text().array(),
    clientCredentialsScopes: text().array().default([]),
    userId: text().references(() => users.id, { onDelete: "cascade" }),
    createdAt: ts(),
    updatedAt: ts(),
    name: text(),
    uri: text(),
    icon: text(),
    contacts: text().array(),
    tos: text(),
    policy: text(),
    softwareId: text(),
    softwareVersion: text(),
    softwareStatement: text(),
    redirectUris: text().array().notNull(),
    postLogoutRedirectUris: text().array(),
    backchannelLogoutUri: text(),
    backchannelLogoutSessionRequired: boolean(),
    tokenEndpointAuthMethod: text(),
    applicationType: text(),
    jwks: text(),
    jwksUri: text(),
    grantTypes: text().array(),
    responseTypes: text().array(),
    requirePKCE: boolean(),
    dpopBoundAccessTokens: boolean().default(false),
    referenceId: text(),
    metadata: jsonb(),
  },
  (t) => [index().on(t.userId)],
);

/** Protected resources tokens are issued for: one row, the MCP endpoint, which the plugin seeds. */
export const oauthResources = pgTable("oauth_resources", {
  id: text().primaryKey(),
  identifier: text().notNull().unique(),
  name: text().notNull(),
  accessTokenTtl: integer(),
  refreshTokenTtl: integer(),
  signingAlgorithm: text(),
  signingKeyId: text(),
  allowedScopes: text().array(),
  customClaims: jsonb(),
  dpopBoundAccessTokensRequired: boolean().default(false),
  disabled: boolean().default(false),
  createdAt: ts(),
  updatedAt: ts(),
  policyVersion: integer().default(1),
  metadata: jsonb(),
});

export const oauthClientResources = pgTable(
  "oauth_client_resources",
  {
    id: text().primaryKey(),
    clientId: text()
      .notNull()
      .references(() => oauthClients.clientId, { onDelete: "cascade" }),
    resourceId: text()
      .notNull()
      .references(() => oauthResources.identifier, { onDelete: "cascade" }),
    metadata: jsonb(),
    createdAt: ts(),
  },
  (t) => [uniqueIndex().on(t.clientId, t.resourceId), index().on(t.clientId), index().on(t.resourceId)],
);

/** Refresh tokens, stored hashed. Disconnecting an app on the MCP page deletes its rows. */
export const oauthRefreshTokens = pgTable(
  "oauth_refresh_tokens",
  {
    id: text().primaryKey(),
    token: text().notNull().unique(),
    clientId: text()
      .notNull()
      .references(() => oauthClients.clientId, { onDelete: "cascade" }),
    sessionId: text().references(() => sessions.id, { onDelete: "set null" }),
    userId: text()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    referenceId: text(),
    authorizationCodeId: text(),
    resources: text().array(),
    requestedUserInfoClaims: text().array(),
    expiresAt: ts(),
    createdAt: ts(),
    revoked: ts(),
    rotatedAt: ts(),
    rotationReplayResponse: text(),
    rotationReplayExpiresAt: ts(),
    authTime: ts(),
    confirmation: jsonb(),
    scopes: text().array().notNull(),
  },
  (t) => [index().on(t.clientId), index().on(t.sessionId), index().on(t.userId), index().on(t.authorizationCodeId)],
);

/** Opaque access tokens only. Tokens for the MCP endpoint are JWTs, which aren't stored. */
export const oauthAccessTokens = pgTable(
  "oauth_access_tokens",
  {
    id: text().primaryKey(),
    token: text().unique(),
    clientId: text()
      .notNull()
      .references(() => oauthClients.clientId, { onDelete: "cascade" }),
    sessionId: text().references(() => sessions.id, { onDelete: "set null" }),
    userId: text().references(() => users.id, { onDelete: "cascade" }),
    referenceId: text(),
    authorizationCodeId: text(),
    resources: text().array(),
    requestedUserInfoClaims: text().array(),
    refreshId: text().references(() => oauthRefreshTokens.id, { onDelete: "cascade" }),
    expiresAt: ts(),
    createdAt: ts(),
    revoked: ts(),
    confirmation: jsonb(),
    scopes: text().array().notNull(),
  },
  (t) => [index().on(t.clientId), index().on(t.sessionId), index().on(t.userId), index().on(t.authorizationCodeId), index().on(t.refreshId)],
);

/** What a user let an app do, per workspace (`referenceId`). The MCP endpoint checks it on every call. */
export const oauthConsents = pgTable(
  "oauth_consents",
  {
    id: text().primaryKey(),
    clientId: text()
      .notNull()
      .references(() => oauthClients.clientId, { onDelete: "cascade" }),
    userId: text().references(() => users.id, { onDelete: "cascade" }),
    referenceId: text(),
    resources: text().array(),
    requestedUserInfoClaims: text().array(),
    scopes: text().array().notNull(),
    createdAt: ts(),
    updatedAt: ts(),
  },
  (t) => [index().on(t.clientId), index().on(t.userId)],
);

/** Client assertions already used (private_key_jwt), kept until they expire so none can be replayed. */
export const oauthClientAssertions = pgTable("oauth_client_assertions", {
  id: text().primaryKey(),
  expiresAt: ts().notNull(),
});

/** The keys access tokens are signed with. The private keys are encrypted with the auth secret. */
export const jwks = pgTable("jwks", {
  id: text().primaryKey(),
  publicKey: text().notNull(),
  privateKey: text().notNull(),
  createdAt: ts().notNull(),
  expiresAt: ts(),
  alg: text(),
  crv: text(),
});
