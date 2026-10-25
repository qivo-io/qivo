/* eslint-disable */
/**
 * Generated `ComponentApi` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type { FunctionReference } from "convex/server";

/**
 * A utility for referencing a Convex component's exposed API.
 *
 * Useful when expecting a parameter like `components.myComponent`.
 * Usage:
 * ```ts
 * async function myFunction(ctx: QueryCtx, component: ComponentApi) {
 *   return ctx.runQuery(component.someFile.someQuery, { ...args });
 * }
 * ```
 */
export type ComponentApi<Name extends string | undefined = string | undefined> =
  {
    accounts: {
      liveLogins: FunctionReference<
        "query",
        "internal",
        { ids: Array<string> },
        any,
        Name
      >;
      microsoftAccountKeys: FunctionReference<
        "query",
        "internal",
        { cursor: string | null },
        any,
        Name
      >;
      rekeyMicrosoftAccount: FunctionReference<
        "mutation",
        "internal",
        { oid: string; sub: string },
        any,
        Name
      >;
      setMicrosoftTenant: FunctionReference<
        "mutation",
        "internal",
        { id: string; oid: string; tid: string },
        any,
        Name
      >;
    };
    adapter: {
      create: FunctionReference<
        "mutation",
        "internal",
        {
          input:
            | {
                data: {
                  banExpires?: null | number;
                  banReason?: null | string;
                  banned?: null | boolean;
                  createdAt: number;
                  email: string;
                  emailVerified: boolean;
                  image?: null | string;
                  isAnonymous?: null | boolean;
                  name: string;
                  role?: null | string;
                  updatedAt: number;
                  userId?: null | string;
                };
                model: "user";
              }
            | {
                data: {
                  createdAt: number;
                  expiresAt: number;
                  impersonatedBy?: null | string;
                  ipAddress?: null | string;
                  token: string;
                  updatedAt: number;
                  userAgent?: null | string;
                  userId: string;
                };
                model: "session";
              }
            | {
                data: {
                  accessToken?: null | string;
                  accessTokenExpiresAt?: null | number;
                  accountId: string;
                  createdAt: number;
                  idToken?: null | string;
                  microsoftTenantId?: string;
                  password?: null | string;
                  providerId: string;
                  refreshToken?: null | string;
                  refreshTokenExpiresAt?: null | number;
                  scope?: null | string;
                  updatedAt: number;
                  userId: string;
                };
                model: "account";
              }
            | {
                data: {
                  createdAt: number;
                  expiresAt: number;
                  identifier: string;
                  updatedAt: number;
                  value: string;
                };
                model: "verification";
              }
            | {
                data: {
                  alg?: null | string;
                  createdAt: number;
                  crv?: null | string;
                  expiresAt?: null | number;
                  privateKey: string;
                  publicKey: string;
                };
                model: "jwks";
              }
            | {
                data: {
                  applicationType?: null | string;
                  backchannelLogoutSessionRequired?: null | boolean;
                  backchannelLogoutUri?: null | string;
                  clientCredentialsScopes?: null | Array<string>;
                  clientDiscoveryId?: null | string;
                  clientId: string;
                  clientSecret?: null | string;
                  contacts?: null | Array<string>;
                  createdAt?: null | number;
                  disabled?: null | boolean;
                  dpopBoundAccessTokens?: null | boolean;
                  enableEndSession?: null | boolean;
                  grantTypes?: null | Array<string>;
                  icon?: null | string;
                  jwks?: null | string;
                  jwksUri?: null | string;
                  metadata?: null | string;
                  name?: null | string;
                  policy?: null | string;
                  postLogoutRedirectUris?: null | Array<string>;
                  redirectUris: Array<string>;
                  referenceId?: null | string;
                  requirePKCE?: null | boolean;
                  responseTypes?: null | Array<string>;
                  scopes?: null | Array<string>;
                  skipConsent?: null | boolean;
                  softwareId?: null | string;
                  softwareStatement?: null | string;
                  softwareVersion?: null | string;
                  subjectType?: null | string;
                  tokenEndpointAuthMethod?: null | string;
                  tos?: null | string;
                  updatedAt?: null | number;
                  uri?: null | string;
                  userId?: null | string;
                };
                model: "oauthClient";
              }
            | {
                data: {
                  accessTokenTtl?: null | number;
                  allowedScopes?: null | Array<string>;
                  createdAt?: null | number;
                  customClaims?: null | string;
                  disabled?: null | boolean;
                  dpopBoundAccessTokensRequired?: null | boolean;
                  identifier: string;
                  metadata?: null | string;
                  name: string;
                  policyVersion?: null | number;
                  refreshTokenTtl?: null | number;
                  signingAlgorithm?: null | string;
                  signingKeyId?: null | string;
                  updatedAt?: null | number;
                };
                model: "oauthResource";
              }
            | {
                data: {
                  clientId: string;
                  createdAt?: null | number;
                  metadata?: null | string;
                  resourceId: string;
                };
                model: "oauthClientResource";
              }
            | {
                data: {
                  authTime?: null | number;
                  authorizationCodeId?: null | string;
                  clientId: string;
                  confirmation?: null | string;
                  createdAt?: null | number;
                  expiresAt?: null | number;
                  referenceId?: null | string;
                  requestedUserInfoClaims?: null | Array<string>;
                  resources?: null | Array<string>;
                  revoked?: null | number;
                  rotatedAt?: null | number;
                  rotationReplayExpiresAt?: null | number;
                  rotationReplayResponse?: null | string;
                  scopes: Array<string>;
                  sessionId?: null | string;
                  token: string;
                  userId: string;
                };
                model: "oauthRefreshToken";
              }
            | {
                data: {
                  authorizationCodeId?: null | string;
                  clientId: string;
                  confirmation?: null | string;
                  createdAt?: null | number;
                  expiresAt?: null | number;
                  referenceId?: null | string;
                  refreshId?: null | string;
                  requestedUserInfoClaims?: null | Array<string>;
                  resources?: null | Array<string>;
                  revoked?: null | number;
                  scopes: Array<string>;
                  sessionId?: null | string;
                  token?: null | string;
                  userId?: null | string;
                };
                model: "oauthAccessToken";
              }
            | {
                data: {
                  clientId: string;
                  createdAt?: null | number;
                  referenceId?: null | string;
                  requestedUserInfoClaims?: null | Array<string>;
                  resources?: null | Array<string>;
                  scopes: Array<string>;
                  updatedAt?: null | number;
                  userId?: null | string;
                };
                model: "oauthConsent";
              }
            | { data: { expiresAt: number }; model: "oauthClientAssertion" };
          onCreateHandle?: string;
          select?: Array<string>;
        },
        any,
        Name
      >;
      deleteMany: FunctionReference<
        "mutation",
        "internal",
        {
          input:
            | {
                model: "user";
                where?: Array<{
                  connector?: "AND" | "OR";
                  field:
                    | "name"
                    | "email"
                    | "emailVerified"
                    | "image"
                    | "createdAt"
                    | "updatedAt"
                    | "userId"
                    | "role"
                    | "banned"
                    | "banReason"
                    | "banExpires"
                    | "isAnonymous"
                    | "_id";
                  mode?: "sensitive" | "insensitive";
                  operator?:
                    | "lt"
                    | "lte"
                    | "gt"
                    | "gte"
                    | "eq"
                    | "in"
                    | "not_in"
                    | "ne"
                    | "contains"
                    | "starts_with"
                    | "ends_with";
                  value:
                    | string
                    | number
                    | boolean
                    | Array<string>
                    | Array<number>
                    | null;
                }>;
              }
            | {
                model: "session";
                where?: Array<{
                  connector?: "AND" | "OR";
                  field:
                    | "expiresAt"
                    | "token"
                    | "createdAt"
                    | "updatedAt"
                    | "ipAddress"
                    | "userAgent"
                    | "userId"
                    | "impersonatedBy"
                    | "_id";
                  mode?: "sensitive" | "insensitive";
                  operator?:
                    | "lt"
                    | "lte"
                    | "gt"
                    | "gte"
                    | "eq"
                    | "in"
                    | "not_in"
                    | "ne"
                    | "contains"
                    | "starts_with"
                    | "ends_with";
                  value:
                    | string
                    | number
                    | boolean
                    | Array<string>
                    | Array<number>
                    | null;
                }>;
              }
            | {
                model: "account";
                where?: Array<{
                  connector?: "AND" | "OR";
                  field:
                    | "accountId"
                    | "providerId"
                    | "userId"
                    | "accessToken"
                    | "refreshToken"
                    | "idToken"
                    | "accessTokenExpiresAt"
                    | "refreshTokenExpiresAt"
                    | "scope"
                    | "password"
                    | "createdAt"
                    | "updatedAt"
                    | "microsoftTenantId"
                    | "_id";
                  mode?: "sensitive" | "insensitive";
                  operator?:
                    | "lt"
                    | "lte"
                    | "gt"
                    | "gte"
                    | "eq"
                    | "in"
                    | "not_in"
                    | "ne"
                    | "contains"
                    | "starts_with"
                    | "ends_with";
                  value:
                    | string
                    | number
                    | boolean
                    | Array<string>
                    | Array<number>
                    | null;
                }>;
              }
            | {
                model: "verification";
                where?: Array<{
                  connector?: "AND" | "OR";
                  field:
                    | "identifier"
                    | "value"
                    | "expiresAt"
                    | "createdAt"
                    | "updatedAt"
                    | "_id";
                  mode?: "sensitive" | "insensitive";
                  operator?:
                    | "lt"
                    | "lte"
                    | "gt"
                    | "gte"
                    | "eq"
                    | "in"
                    | "not_in"
                    | "ne"
                    | "contains"
                    | "starts_with"
                    | "ends_with";
                  value:
                    | string
                    | number
                    | boolean
                    | Array<string>
                    | Array<number>
                    | null;
                }>;
              }
            | {
                model: "jwks";
                where?: Array<{
                  connector?: "AND" | "OR";
                  field:
                    | "publicKey"
                    | "privateKey"
                    | "createdAt"
                    | "expiresAt"
                    | "alg"
                    | "crv"
                    | "_id";
                  mode?: "sensitive" | "insensitive";
                  operator?:
                    | "lt"
                    | "lte"
                    | "gt"
                    | "gte"
                    | "eq"
                    | "in"
                    | "not_in"
                    | "ne"
                    | "contains"
                    | "starts_with"
                    | "ends_with";
                  value:
                    | string
                    | number
                    | boolean
                    | Array<string>
                    | Array<number>
                    | null;
                }>;
              }
            | {
                model: "oauthClient";
                where?: Array<{
                  connector?: "AND" | "OR";
                  field:
                    | "clientId"
                    | "clientSecret"
                    | "clientDiscoveryId"
                    | "disabled"
                    | "skipConsent"
                    | "enableEndSession"
                    | "subjectType"
                    | "scopes"
                    | "clientCredentialsScopes"
                    | "userId"
                    | "createdAt"
                    | "updatedAt"
                    | "name"
                    | "uri"
                    | "icon"
                    | "contacts"
                    | "tos"
                    | "policy"
                    | "softwareId"
                    | "softwareVersion"
                    | "softwareStatement"
                    | "redirectUris"
                    | "postLogoutRedirectUris"
                    | "backchannelLogoutUri"
                    | "backchannelLogoutSessionRequired"
                    | "tokenEndpointAuthMethod"
                    | "applicationType"
                    | "jwks"
                    | "jwksUri"
                    | "grantTypes"
                    | "responseTypes"
                    | "requirePKCE"
                    | "dpopBoundAccessTokens"
                    | "referenceId"
                    | "metadata"
                    | "_id";
                  mode?: "sensitive" | "insensitive";
                  operator?:
                    | "lt"
                    | "lte"
                    | "gt"
                    | "gte"
                    | "eq"
                    | "in"
                    | "not_in"
                    | "ne"
                    | "contains"
                    | "starts_with"
                    | "ends_with";
                  value:
                    | string
                    | number
                    | boolean
                    | Array<string>
                    | Array<number>
                    | null;
                }>;
              }
            | {
                model: "oauthResource";
                where?: Array<{
                  connector?: "AND" | "OR";
                  field:
                    | "identifier"
                    | "name"
                    | "accessTokenTtl"
                    | "refreshTokenTtl"
                    | "signingAlgorithm"
                    | "signingKeyId"
                    | "allowedScopes"
                    | "customClaims"
                    | "dpopBoundAccessTokensRequired"
                    | "disabled"
                    | "createdAt"
                    | "updatedAt"
                    | "policyVersion"
                    | "metadata"
                    | "_id";
                  mode?: "sensitive" | "insensitive";
                  operator?:
                    | "lt"
                    | "lte"
                    | "gt"
                    | "gte"
                    | "eq"
                    | "in"
                    | "not_in"
                    | "ne"
                    | "contains"
                    | "starts_with"
                    | "ends_with";
                  value:
                    | string
                    | number
                    | boolean
                    | Array<string>
                    | Array<number>
                    | null;
                }>;
              }
            | {
                model: "oauthClientResource";
                where?: Array<{
                  connector?: "AND" | "OR";
                  field:
                    | "clientId"
                    | "resourceId"
                    | "metadata"
                    | "createdAt"
                    | "_id";
                  mode?: "sensitive" | "insensitive";
                  operator?:
                    | "lt"
                    | "lte"
                    | "gt"
                    | "gte"
                    | "eq"
                    | "in"
                    | "not_in"
                    | "ne"
                    | "contains"
                    | "starts_with"
                    | "ends_with";
                  value:
                    | string
                    | number
                    | boolean
                    | Array<string>
                    | Array<number>
                    | null;
                }>;
              }
            | {
                model: "oauthRefreshToken";
                where?: Array<{
                  connector?: "AND" | "OR";
                  field:
                    | "token"
                    | "clientId"
                    | "sessionId"
                    | "userId"
                    | "referenceId"
                    | "authorizationCodeId"
                    | "resources"
                    | "requestedUserInfoClaims"
                    | "expiresAt"
                    | "createdAt"
                    | "revoked"
                    | "rotatedAt"
                    | "rotationReplayResponse"
                    | "rotationReplayExpiresAt"
                    | "authTime"
                    | "confirmation"
                    | "scopes"
                    | "_id";
                  mode?: "sensitive" | "insensitive";
                  operator?:
                    | "lt"
                    | "lte"
                    | "gt"
                    | "gte"
                    | "eq"
                    | "in"
                    | "not_in"
                    | "ne"
                    | "contains"
                    | "starts_with"
                    | "ends_with";
                  value:
                    | string
                    | number
                    | boolean
                    | Array<string>
                    | Array<number>
                    | null;
                }>;
              }
            | {
                model: "oauthAccessToken";
                where?: Array<{
                  connector?: "AND" | "OR";
                  field:
                    | "token"
                    | "clientId"
                    | "sessionId"
                    | "userId"
                    | "referenceId"
                    | "authorizationCodeId"
                    | "resources"
                    | "requestedUserInfoClaims"
                    | "refreshId"
                    | "expiresAt"
                    | "createdAt"
                    | "revoked"
                    | "confirmation"
                    | "scopes"
                    | "_id";
                  mode?: "sensitive" | "insensitive";
                  operator?:
                    | "lt"
                    | "lte"
                    | "gt"
                    | "gte"
                    | "eq"
                    | "in"
                    | "not_in"
                    | "ne"
                    | "contains"
                    | "starts_with"
                    | "ends_with";
                  value:
                    | string
                    | number
                    | boolean
                    | Array<string>
                    | Array<number>
                    | null;
                }>;
              }
            | {
                model: "oauthConsent";
                where?: Array<{
                  connector?: "AND" | "OR";
                  field:
                    | "clientId"
                    | "userId"
                    | "referenceId"
                    | "resources"
                    | "requestedUserInfoClaims"
                    | "scopes"
                    | "createdAt"
                    | "updatedAt"
                    | "_id";
                  mode?: "sensitive" | "insensitive";
                  operator?:
                    | "lt"
                    | "lte"
                    | "gt"
                    | "gte"
                    | "eq"
                    | "in"
                    | "not_in"
                    | "ne"
                    | "contains"
                    | "starts_with"
                    | "ends_with";
                  value:
                    | string
                    | number
                    | boolean
                    | Array<string>
                    | Array<number>
                    | null;
                }>;
              }
            | {
                model: "oauthClientAssertion";
                where?: Array<{
                  connector?: "AND" | "OR";
                  field: "expiresAt" | "_id";
                  mode?: "sensitive" | "insensitive";
                  operator?:
                    | "lt"
                    | "lte"
                    | "gt"
                    | "gte"
                    | "eq"
                    | "in"
                    | "not_in"
                    | "ne"
                    | "contains"
                    | "starts_with"
                    | "ends_with";
                  value:
                    | string
                    | number
                    | boolean
                    | Array<string>
                    | Array<number>
                    | null;
                }>;
              };
          onDeleteHandle?: string;
          paginationOpts: {
            cursor: string | null;
            endCursor?: string | null;
            id?: number;
            maximumBytesRead?: number;
            maximumRowsRead?: number;
            numItems: number;
          };
        },
        any,
        Name
      >;
      deleteOne: FunctionReference<
        "mutation",
        "internal",
        {
          input:
            | {
                model: "user";
                where?: Array<{
                  connector?: "AND" | "OR";
                  field:
                    | "name"
                    | "email"
                    | "emailVerified"
                    | "image"
                    | "createdAt"
                    | "updatedAt"
                    | "userId"
                    | "role"
                    | "banned"
                    | "banReason"
                    | "banExpires"
                    | "isAnonymous"
                    | "_id";
                  mode?: "sensitive" | "insensitive";
                  operator?:
                    | "lt"
                    | "lte"
                    | "gt"
                    | "gte"
                    | "eq"
                    | "in"
                    | "not_in"
                    | "ne"
                    | "contains"
                    | "starts_with"
                    | "ends_with";
                  value:
                    | string
                    | number
                    | boolean
                    | Array<string>
                    | Array<number>
                    | null;
                }>;
              }
            | {
                model: "session";
                where?: Array<{
                  connector?: "AND" | "OR";
                  field:
                    | "expiresAt"
                    | "token"
                    | "createdAt"
                    | "updatedAt"
                    | "ipAddress"
                    | "userAgent"
                    | "userId"
                    | "impersonatedBy"
                    | "_id";
                  mode?: "sensitive" | "insensitive";
                  operator?:
                    | "lt"
                    | "lte"
                    | "gt"
                    | "gte"
                    | "eq"
                    | "in"
                    | "not_in"
                    | "ne"
                    | "contains"
                    | "starts_with"
                    | "ends_with";
                  value:
                    | string
                    | number
                    | boolean
                    | Array<string>
                    | Array<number>
                    | null;
                }>;
              }
            | {
                model: "account";
                where?: Array<{
                  connector?: "AND" | "OR";
                  field:
                    | "accountId"
                    | "providerId"
                    | "userId"
                    | "accessToken"
                    | "refreshToken"
                    | "idToken"
                    | "accessTokenExpiresAt"
                    | "refreshTokenExpiresAt"
                    | "scope"
                    | "password"
                    | "createdAt"
                    | "updatedAt"
                    | "microsoftTenantId"
                    | "_id";
                  mode?: "sensitive" | "insensitive";
                  operator?:
                    | "lt"
                    | "lte"
                    | "gt"
                    | "gte"
                    | "eq"
                    | "in"
                    | "not_in"
                    | "ne"
                    | "contains"
                    | "starts_with"
                    | "ends_with";
                  value:
                    | string
                    | number
                    | boolean
                    | Array<string>
                    | Array<number>
                    | null;
                }>;
              }
            | {
                model: "verification";
                where?: Array<{
                  connector?: "AND" | "OR";
                  field:
                    | "identifier"
                    | "value"
                    | "expiresAt"
                    | "createdAt"
                    | "updatedAt"
                    | "_id";
                  mode?: "sensitive" | "insensitive";
                  operator?:
                    | "lt"
                    | "lte"
                    | "gt"
                    | "gte"
                    | "eq"
                    | "in"
                    | "not_in"
                    | "ne"
                    | "contains"
                    | "starts_with"
                    | "ends_with";
                  value:
                    | string
                    | number
                    | boolean
                    | Array<string>
                    | Array<number>
                    | null;
                }>;
              }
            | {
                model: "jwks";
                where?: Array<{
                  connector?: "AND" | "OR";
                  field:
                    | "publicKey"
                    | "privateKey"
                    | "createdAt"
                    | "expiresAt"
                    | "alg"
                    | "crv"
                    | "_id";
                  mode?: "sensitive" | "insensitive";
                  operator?:
                    | "lt"
                    | "lte"
                    | "gt"
                    | "gte"
                    | "eq"
                    | "in"
                    | "not_in"
                    | "ne"
                    | "contains"
                    | "starts_with"
                    | "ends_with";
                  value:
                    | string
                    | number
                    | boolean
                    | Array<string>
                    | Array<number>
                    | null;
                }>;
              }
            | {
                model: "oauthClient";
                where?: Array<{
                  connector?: "AND" | "OR";
                  field:
                    | "clientId"
                    | "clientSecret"
                    | "clientDiscoveryId"
                    | "disabled"
                    | "skipConsent"
                    | "enableEndSession"
                    | "subjectType"
                    | "scopes"
                    | "clientCredentialsScopes"
                    | "userId"
                    | "createdAt"
                    | "updatedAt"
                    | "name"
                    | "uri"
                    | "icon"
                    | "contacts"
                    | "tos"
                    | "policy"
                    | "softwareId"
                    | "softwareVersion"
                    | "softwareStatement"
                    | "redirectUris"
                    | "postLogoutRedirectUris"
                    | "backchannelLogoutUri"
                    | "backchannelLogoutSessionRequired"
                    | "tokenEndpointAuthMethod"
                    | "applicationType"
                    | "jwks"
                    | "jwksUri"
                    | "grantTypes"
                    | "responseTypes"
                    | "requirePKCE"
                    | "dpopBoundAccessTokens"
                    | "referenceId"
                    | "metadata"
                    | "_id";
                  mode?: "sensitive" | "insensitive";
                  operator?:
                    | "lt"
                    | "lte"
                    | "gt"
                    | "gte"
                    | "eq"
                    | "in"
                    | "not_in"
                    | "ne"
                    | "contains"
                    | "starts_with"
                    | "ends_with";
                  value:
                    | string
                    | number
                    | boolean
                    | Array<string>
                    | Array<number>
                    | null;
                }>;
              }
            | {
                model: "oauthResource";
                where?: Array<{
                  connector?: "AND" | "OR";
                  field:
                    | "identifier"
                    | "name"
                    | "accessTokenTtl"
                    | "refreshTokenTtl"
                    | "signingAlgorithm"
                    | "signingKeyId"
                    | "allowedScopes"
                    | "customClaims"
                    | "dpopBoundAccessTokensRequired"
                    | "disabled"
                    | "createdAt"
                    | "updatedAt"
                    | "policyVersion"
                    | "metadata"
                    | "_id";
                  mode?: "sensitive" | "insensitive";
                  operator?:
                    | "lt"
                    | "lte"
                    | "gt"
                    | "gte"
                    | "eq"
                    | "in"
                    | "not_in"
                    | "ne"
                    | "contains"
                    | "starts_with"
                    | "ends_with";
                  value:
                    | string
                    | number
                    | boolean
                    | Array<string>
                    | Array<number>
                    | null;
                }>;
              }
            | {
                model: "oauthClientResource";
                where?: Array<{
                  connector?: "AND" | "OR";
                  field:
                    | "clientId"
                    | "resourceId"
                    | "metadata"
                    | "createdAt"
                    | "_id";
                  mode?: "sensitive" | "insensitive";
                  operator?:
                    | "lt"
                    | "lte"
                    | "gt"
                    | "gte"
                    | "eq"
                    | "in"
                    | "not_in"
                    | "ne"
                    | "contains"
                    | "starts_with"
                    | "ends_with";
                  value:
                    | string
                    | number
                    | boolean
                    | Array<string>
                    | Array<number>
                    | null;
                }>;
              }
            | {
                model: "oauthRefreshToken";
                where?: Array<{
                  connector?: "AND" | "OR";
                  field:
                    | "token"
                    | "clientId"
                    | "sessionId"
                    | "userId"
                    | "referenceId"
                    | "authorizationCodeId"
                    | "resources"
                    | "requestedUserInfoClaims"
                    | "expiresAt"
                    | "createdAt"
                    | "revoked"
                    | "rotatedAt"
                    | "rotationReplayResponse"
                    | "rotationReplayExpiresAt"
                    | "authTime"
                    | "confirmation"
                    | "scopes"
                    | "_id";
                  mode?: "sensitive" | "insensitive";
                  operator?:
                    | "lt"
                    | "lte"
                    | "gt"
                    | "gte"
                    | "eq"
                    | "in"
                    | "not_in"
                    | "ne"
                    | "contains"
                    | "starts_with"
                    | "ends_with";
                  value:
                    | string
                    | number
                    | boolean
                    | Array<string>
                    | Array<number>
                    | null;
                }>;
              }
            | {
                model: "oauthAccessToken";
                where?: Array<{
                  connector?: "AND" | "OR";
                  field:
                    | "token"
                    | "clientId"
                    | "sessionId"
                    | "userId"
                    | "referenceId"
                    | "authorizationCodeId"
                    | "resources"
                    | "requestedUserInfoClaims"
                    | "refreshId"
                    | "expiresAt"
                    | "createdAt"
                    | "revoked"
                    | "confirmation"
                    | "scopes"
                    | "_id";
                  mode?: "sensitive" | "insensitive";
                  operator?:
                    | "lt"
                    | "lte"
                    | "gt"
                    | "gte"
                    | "eq"
                    | "in"
                    | "not_in"
                    | "ne"
                    | "contains"
                    | "starts_with"
                    | "ends_with";
                  value:
                    | string
                    | number
                    | boolean
                    | Array<string>
                    | Array<number>
                    | null;
                }>;
              }
            | {
                model: "oauthConsent";
                where?: Array<{
                  connector?: "AND" | "OR";
                  field:
                    | "clientId"
                    | "userId"
                    | "referenceId"
                    | "resources"
                    | "requestedUserInfoClaims"
                    | "scopes"
                    | "createdAt"
                    | "updatedAt"
                    | "_id";
                  mode?: "sensitive" | "insensitive";
                  operator?:
                    | "lt"
                    | "lte"
                    | "gt"
                    | "gte"
                    | "eq"
                    | "in"
                    | "not_in"
                    | "ne"
                    | "contains"
                    | "starts_with"
                    | "ends_with";
                  value:
                    | string
                    | number
                    | boolean
                    | Array<string>
                    | Array<number>
                    | null;
                }>;
              }
            | {
                model: "oauthClientAssertion";
                where?: Array<{
                  connector?: "AND" | "OR";
                  field: "expiresAt" | "_id";
                  mode?: "sensitive" | "insensitive";
                  operator?:
                    | "lt"
                    | "lte"
                    | "gt"
                    | "gte"
                    | "eq"
                    | "in"
                    | "not_in"
                    | "ne"
                    | "contains"
                    | "starts_with"
                    | "ends_with";
                  value:
                    | string
                    | number
                    | boolean
                    | Array<string>
                    | Array<number>
                    | null;
                }>;
              };
          onDeleteHandle?: string;
        },
        any,
        Name
      >;
      findMany: FunctionReference<
        "query",
        "internal",
        {
          join?: any;
          limit?: number;
          model:
            | "user"
            | "session"
            | "account"
            | "verification"
            | "jwks"
            | "oauthClient"
            | "oauthResource"
            | "oauthClientResource"
            | "oauthRefreshToken"
            | "oauthAccessToken"
            | "oauthConsent"
            | "oauthClientAssertion";
          offset?: number;
          paginationOpts: {
            cursor: string | null;
            endCursor?: string | null;
            id?: number;
            maximumBytesRead?: number;
            maximumRowsRead?: number;
            numItems: number;
          };
          select?: Array<string>;
          sortBy?: { direction: "asc" | "desc"; field: string };
          where?: Array<{
            connector?: "AND" | "OR";
            field: string;
            mode?: "sensitive" | "insensitive";
            operator?:
              | "lt"
              | "lte"
              | "gt"
              | "gte"
              | "eq"
              | "in"
              | "not_in"
              | "ne"
              | "contains"
              | "starts_with"
              | "ends_with";
            value:
              string | number | boolean | Array<string> | Array<number> | null;
          }>;
        },
        any,
        Name
      >;
      findOne: FunctionReference<
        "query",
        "internal",
        {
          join?: any;
          model:
            | "user"
            | "session"
            | "account"
            | "verification"
            | "jwks"
            | "oauthClient"
            | "oauthResource"
            | "oauthClientResource"
            | "oauthRefreshToken"
            | "oauthAccessToken"
            | "oauthConsent"
            | "oauthClientAssertion";
          select?: Array<string>;
          where?: Array<{
            connector?: "AND" | "OR";
            field: string;
            mode?: "sensitive" | "insensitive";
            operator?:
              | "lt"
              | "lte"
              | "gt"
              | "gte"
              | "eq"
              | "in"
              | "not_in"
              | "ne"
              | "contains"
              | "starts_with"
              | "ends_with";
            value:
              string | number | boolean | Array<string> | Array<number> | null;
          }>;
        },
        any,
        Name
      >;
      incrementOne: FunctionReference<
        "mutation",
        "internal",
        {
          input:
            | {
                increment: Record<string, number>;
                model: "user";
                set?: {
                  banExpires?: null | number;
                  banReason?: null | string;
                  banned?: null | boolean;
                  createdAt?: number;
                  email?: string;
                  emailVerified?: boolean;
                  image?: null | string;
                  isAnonymous?: null | boolean;
                  name?: string;
                  role?: null | string;
                  updatedAt?: number;
                  userId?: null | string;
                };
                where: Array<{
                  connector?: "AND" | "OR";
                  field:
                    | "name"
                    | "email"
                    | "emailVerified"
                    | "image"
                    | "createdAt"
                    | "updatedAt"
                    | "userId"
                    | "role"
                    | "banned"
                    | "banReason"
                    | "banExpires"
                    | "isAnonymous"
                    | "_id";
                  mode?: "sensitive" | "insensitive";
                  operator?:
                    | "lt"
                    | "lte"
                    | "gt"
                    | "gte"
                    | "eq"
                    | "in"
                    | "not_in"
                    | "ne"
                    | "contains"
                    | "starts_with"
                    | "ends_with";
                  value:
                    | string
                    | number
                    | boolean
                    | Array<string>
                    | Array<number>
                    | null;
                }>;
              }
            | {
                increment: Record<string, number>;
                model: "session";
                set?: {
                  createdAt?: number;
                  expiresAt?: number;
                  impersonatedBy?: null | string;
                  ipAddress?: null | string;
                  token?: string;
                  updatedAt?: number;
                  userAgent?: null | string;
                  userId?: string;
                };
                where: Array<{
                  connector?: "AND" | "OR";
                  field:
                    | "expiresAt"
                    | "token"
                    | "createdAt"
                    | "updatedAt"
                    | "ipAddress"
                    | "userAgent"
                    | "userId"
                    | "impersonatedBy"
                    | "_id";
                  mode?: "sensitive" | "insensitive";
                  operator?:
                    | "lt"
                    | "lte"
                    | "gt"
                    | "gte"
                    | "eq"
                    | "in"
                    | "not_in"
                    | "ne"
                    | "contains"
                    | "starts_with"
                    | "ends_with";
                  value:
                    | string
                    | number
                    | boolean
                    | Array<string>
                    | Array<number>
                    | null;
                }>;
              }
            | {
                increment: Record<string, number>;
                model: "account";
                set?: {
                  accessToken?: null | string;
                  accessTokenExpiresAt?: null | number;
                  accountId?: string;
                  createdAt?: number;
                  idToken?: null | string;
                  microsoftTenantId?: string;
                  password?: null | string;
                  providerId?: string;
                  refreshToken?: null | string;
                  refreshTokenExpiresAt?: null | number;
                  scope?: null | string;
                  updatedAt?: number;
                  userId?: string;
                };
                where: Array<{
                  connector?: "AND" | "OR";
                  field:
                    | "accountId"
                    | "providerId"
                    | "userId"
                    | "accessToken"
                    | "refreshToken"
                    | "idToken"
                    | "accessTokenExpiresAt"
                    | "refreshTokenExpiresAt"
                    | "scope"
                    | "password"
                    | "createdAt"
                    | "updatedAt"
                    | "microsoftTenantId"
                    | "_id";
                  mode?: "sensitive" | "insensitive";
                  operator?:
                    | "lt"
                    | "lte"
                    | "gt"
                    | "gte"
                    | "eq"
                    | "in"
                    | "not_in"
                    | "ne"
                    | "contains"
                    | "starts_with"
                    | "ends_with";
                  value:
                    | string
                    | number
                    | boolean
                    | Array<string>
                    | Array<number>
                    | null;
                }>;
              }
            | {
                increment: Record<string, number>;
                model: "verification";
                set?: {
                  createdAt?: number;
                  expiresAt?: number;
                  identifier?: string;
                  updatedAt?: number;
                  value?: string;
                };
                where: Array<{
                  connector?: "AND" | "OR";
                  field:
                    | "identifier"
                    | "value"
                    | "expiresAt"
                    | "createdAt"
                    | "updatedAt"
                    | "_id";
                  mode?: "sensitive" | "insensitive";
                  operator?:
                    | "lt"
                    | "lte"
                    | "gt"
                    | "gte"
                    | "eq"
                    | "in"
                    | "not_in"
                    | "ne"
                    | "contains"
                    | "starts_with"
                    | "ends_with";
                  value:
                    | string
                    | number
                    | boolean
                    | Array<string>
                    | Array<number>
                    | null;
                }>;
              }
            | {
                increment: Record<string, number>;
                model: "jwks";
                set?: {
                  alg?: null | string;
                  createdAt?: number;
                  crv?: null | string;
                  expiresAt?: null | number;
                  privateKey?: string;
                  publicKey?: string;
                };
                where: Array<{
                  connector?: "AND" | "OR";
                  field:
                    | "publicKey"
                    | "privateKey"
                    | "createdAt"
                    | "expiresAt"
                    | "alg"
                    | "crv"
                    | "_id";
                  mode?: "sensitive" | "insensitive";
                  operator?:
                    | "lt"
                    | "lte"
                    | "gt"
                    | "gte"
                    | "eq"
                    | "in"
                    | "not_in"
                    | "ne"
                    | "contains"
                    | "starts_with"
                    | "ends_with";
                  value:
                    | string
                    | number
                    | boolean
                    | Array<string>
                    | Array<number>
                    | null;
                }>;
              }
            | {
                increment: Record<string, number>;
                model: "oauthClient";
                set?: {
                  applicationType?: null | string;
                  backchannelLogoutSessionRequired?: null | boolean;
                  backchannelLogoutUri?: null | string;
                  clientCredentialsScopes?: null | Array<string>;
                  clientDiscoveryId?: null | string;
                  clientId?: string;
                  clientSecret?: null | string;
                  contacts?: null | Array<string>;
                  createdAt?: null | number;
                  disabled?: null | boolean;
                  dpopBoundAccessTokens?: null | boolean;
                  enableEndSession?: null | boolean;
                  grantTypes?: null | Array<string>;
                  icon?: null | string;
                  jwks?: null | string;
                  jwksUri?: null | string;
                  metadata?: null | string;
                  name?: null | string;
                  policy?: null | string;
                  postLogoutRedirectUris?: null | Array<string>;
                  redirectUris?: Array<string>;
                  referenceId?: null | string;
                  requirePKCE?: null | boolean;
                  responseTypes?: null | Array<string>;
                  scopes?: null | Array<string>;
                  skipConsent?: null | boolean;
                  softwareId?: null | string;
                  softwareStatement?: null | string;
                  softwareVersion?: null | string;
                  subjectType?: null | string;
                  tokenEndpointAuthMethod?: null | string;
                  tos?: null | string;
                  updatedAt?: null | number;
                  uri?: null | string;
                  userId?: null | string;
                };
                where: Array<{
                  connector?: "AND" | "OR";
                  field:
                    | "clientId"
                    | "clientSecret"
                    | "clientDiscoveryId"
                    | "disabled"
                    | "skipConsent"
                    | "enableEndSession"
                    | "subjectType"
                    | "scopes"
                    | "clientCredentialsScopes"
                    | "userId"
                    | "createdAt"
                    | "updatedAt"
                    | "name"
                    | "uri"
                    | "icon"
                    | "contacts"
                    | "tos"
                    | "policy"
                    | "softwareId"
                    | "softwareVersion"
                    | "softwareStatement"
                    | "redirectUris"
                    | "postLogoutRedirectUris"
                    | "backchannelLogoutUri"
                    | "backchannelLogoutSessionRequired"
                    | "tokenEndpointAuthMethod"
                    | "applicationType"
                    | "jwks"
                    | "jwksUri"
                    | "grantTypes"
                    | "responseTypes"
                    | "requirePKCE"
                    | "dpopBoundAccessTokens"
                    | "referenceId"
                    | "metadata"
                    | "_id";
                  mode?: "sensitive" | "insensitive";
                  operator?:
                    | "lt"
                    | "lte"
                    | "gt"
                    | "gte"
                    | "eq"
                    | "in"
                    | "not_in"
                    | "ne"
                    | "contains"
                    | "starts_with"
                    | "ends_with";
                  value:
                    | string
                    | number
                    | boolean
                    | Array<string>
                    | Array<number>
                    | null;
                }>;
              }
            | {
                increment: Record<string, number>;
                model: "oauthResource";
                set?: {
                  accessTokenTtl?: null | number;
                  allowedScopes?: null | Array<string>;
                  createdAt?: null | number;
                  customClaims?: null | string;
                  disabled?: null | boolean;
                  dpopBoundAccessTokensRequired?: null | boolean;
                  identifier?: string;
                  metadata?: null | string;
                  name?: string;
                  policyVersion?: null | number;
                  refreshTokenTtl?: null | number;
                  signingAlgorithm?: null | string;
                  signingKeyId?: null | string;
                  updatedAt?: null | number;
                };
                where: Array<{
                  connector?: "AND" | "OR";
                  field:
                    | "identifier"
                    | "name"
                    | "accessTokenTtl"
                    | "refreshTokenTtl"
                    | "signingAlgorithm"
                    | "signingKeyId"
                    | "allowedScopes"
                    | "customClaims"
                    | "dpopBoundAccessTokensRequired"
                    | "disabled"
                    | "createdAt"
                    | "updatedAt"
                    | "policyVersion"
                    | "metadata"
                    | "_id";
                  mode?: "sensitive" | "insensitive";
                  operator?:
                    | "lt"
                    | "lte"
                    | "gt"
                    | "gte"
                    | "eq"
                    | "in"
                    | "not_in"
                    | "ne"
                    | "contains"
                    | "starts_with"
                    | "ends_with";
                  value:
                    | string
                    | number
                    | boolean
                    | Array<string>
                    | Array<number>
                    | null;
                }>;
              }
            | {
                increment: Record<string, number>;
                model: "oauthClientResource";
                set?: {
                  clientId?: string;
                  createdAt?: null | number;
                  metadata?: null | string;
                  resourceId?: string;
                };
                where: Array<{
                  connector?: "AND" | "OR";
                  field:
                    | "clientId"
                    | "resourceId"
                    | "metadata"
                    | "createdAt"
                    | "_id";
                  mode?: "sensitive" | "insensitive";
                  operator?:
                    | "lt"
                    | "lte"
                    | "gt"
                    | "gte"
                    | "eq"
                    | "in"
                    | "not_in"
                    | "ne"
                    | "contains"
                    | "starts_with"
                    | "ends_with";
                  value:
                    | string
                    | number
                    | boolean
                    | Array<string>
                    | Array<number>
                    | null;
                }>;
              }
            | {
                increment: Record<string, number>;
                model: "oauthRefreshToken";
                set?: {
                  authTime?: null | number;
                  authorizationCodeId?: null | string;
                  clientId?: string;
                  confirmation?: null | string;
                  createdAt?: null | number;
                  expiresAt?: null | number;
                  referenceId?: null | string;
                  requestedUserInfoClaims?: null | Array<string>;
                  resources?: null | Array<string>;
                  revoked?: null | number;
                  rotatedAt?: null | number;
                  rotationReplayExpiresAt?: null | number;
                  rotationReplayResponse?: null | string;
                  scopes?: Array<string>;
                  sessionId?: null | string;
                  token?: string;
                  userId?: string;
                };
                where: Array<{
                  connector?: "AND" | "OR";
                  field:
                    | "token"
                    | "clientId"
                    | "sessionId"
                    | "userId"
                    | "referenceId"
                    | "authorizationCodeId"
                    | "resources"
                    | "requestedUserInfoClaims"
                    | "expiresAt"
                    | "createdAt"
                    | "revoked"
                    | "rotatedAt"
                    | "rotationReplayResponse"
                    | "rotationReplayExpiresAt"
                    | "authTime"
                    | "confirmation"
                    | "scopes"
                    | "_id";
                  mode?: "sensitive" | "insensitive";
                  operator?:
                    | "lt"
                    | "lte"
                    | "gt"
                    | "gte"
                    | "eq"
                    | "in"
                    | "not_in"
                    | "ne"
                    | "contains"
                    | "starts_with"
                    | "ends_with";
                  value:
                    | string
                    | number
                    | boolean
                    | Array<string>
                    | Array<number>
                    | null;
                }>;
              }
            | {
                increment: Record<string, number>;
                model: "oauthAccessToken";
                set?: {
                  authorizationCodeId?: null | string;
                  clientId?: string;
                  confirmation?: null | string;
                  createdAt?: null | number;
                  expiresAt?: null | number;
                  referenceId?: null | string;
                  refreshId?: null | string;
                  requestedUserInfoClaims?: null | Array<string>;
                  resources?: null | Array<string>;
                  revoked?: null | number;
                  scopes?: Array<string>;
                  sessionId?: null | string;
                  token?: null | string;
                  userId?: null | string;
                };
                where: Array<{
                  connector?: "AND" | "OR";
                  field:
                    | "token"
                    | "clientId"
                    | "sessionId"
                    | "userId"
                    | "referenceId"
                    | "authorizationCodeId"
                    | "resources"
                    | "requestedUserInfoClaims"
                    | "refreshId"
                    | "expiresAt"
                    | "createdAt"
                    | "revoked"
                    | "confirmation"
                    | "scopes"
                    | "_id";
                  mode?: "sensitive" | "insensitive";
                  operator?:
                    | "lt"
                    | "lte"
                    | "gt"
                    | "gte"
                    | "eq"
                    | "in"
                    | "not_in"
                    | "ne"
                    | "contains"
                    | "starts_with"
                    | "ends_with";
                  value:
                    | string
                    | number
                    | boolean
                    | Array<string>
                    | Array<number>
                    | null;
                }>;
              }
            | {
                increment: Record<string, number>;
                model: "oauthConsent";
                set?: {
                  clientId?: string;
                  createdAt?: null | number;
                  referenceId?: null | string;
                  requestedUserInfoClaims?: null | Array<string>;
                  resources?: null | Array<string>;
                  scopes?: Array<string>;
                  updatedAt?: null | number;
                  userId?: null | string;
                };
                where: Array<{
                  connector?: "AND" | "OR";
                  field:
                    | "clientId"
                    | "userId"
                    | "referenceId"
                    | "resources"
                    | "requestedUserInfoClaims"
                    | "scopes"
                    | "createdAt"
                    | "updatedAt"
                    | "_id";
                  mode?: "sensitive" | "insensitive";
                  operator?:
                    | "lt"
                    | "lte"
                    | "gt"
                    | "gte"
                    | "eq"
                    | "in"
                    | "not_in"
                    | "ne"
                    | "contains"
                    | "starts_with"
                    | "ends_with";
                  value:
                    | string
                    | number
                    | boolean
                    | Array<string>
                    | Array<number>
                    | null;
                }>;
              }
            | {
                increment: Record<string, number>;
                model: "oauthClientAssertion";
                set?: { expiresAt?: number };
                where: Array<{
                  connector?: "AND" | "OR";
                  field: "expiresAt" | "_id";
                  mode?: "sensitive" | "insensitive";
                  operator?:
                    | "lt"
                    | "lte"
                    | "gt"
                    | "gte"
                    | "eq"
                    | "in"
                    | "not_in"
                    | "ne"
                    | "contains"
                    | "starts_with"
                    | "ends_with";
                  value:
                    | string
                    | number
                    | boolean
                    | Array<string>
                    | Array<number>
                    | null;
                }>;
              };
          onUpdateHandle?: string;
        },
        any,
        Name
      >;
      updateMany: FunctionReference<
        "mutation",
        "internal",
        {
          input:
            | {
                model: "user";
                update: {
                  banExpires?: null | number;
                  banReason?: null | string;
                  banned?: null | boolean;
                  createdAt?: number;
                  email?: string;
                  emailVerified?: boolean;
                  image?: null | string;
                  isAnonymous?: null | boolean;
                  name?: string;
                  role?: null | string;
                  updatedAt?: number;
                  userId?: null | string;
                };
                where?: Array<{
                  connector?: "AND" | "OR";
                  field:
                    | "name"
                    | "email"
                    | "emailVerified"
                    | "image"
                    | "createdAt"
                    | "updatedAt"
                    | "userId"
                    | "role"
                    | "banned"
                    | "banReason"
                    | "banExpires"
                    | "isAnonymous"
                    | "_id";
                  mode?: "sensitive" | "insensitive";
                  operator?:
                    | "lt"
                    | "lte"
                    | "gt"
                    | "gte"
                    | "eq"
                    | "in"
                    | "not_in"
                    | "ne"
                    | "contains"
                    | "starts_with"
                    | "ends_with";
                  value:
                    | string
                    | number
                    | boolean
                    | Array<string>
                    | Array<number>
                    | null;
                }>;
              }
            | {
                model: "session";
                update: {
                  createdAt?: number;
                  expiresAt?: number;
                  impersonatedBy?: null | string;
                  ipAddress?: null | string;
                  token?: string;
                  updatedAt?: number;
                  userAgent?: null | string;
                  userId?: string;
                };
                where?: Array<{
                  connector?: "AND" | "OR";
                  field:
                    | "expiresAt"
                    | "token"
                    | "createdAt"
                    | "updatedAt"
                    | "ipAddress"
                    | "userAgent"
                    | "userId"
                    | "impersonatedBy"
                    | "_id";
                  mode?: "sensitive" | "insensitive";
                  operator?:
                    | "lt"
                    | "lte"
                    | "gt"
                    | "gte"
                    | "eq"
                    | "in"
                    | "not_in"
                    | "ne"
                    | "contains"
                    | "starts_with"
                    | "ends_with";
                  value:
                    | string
                    | number
                    | boolean
                    | Array<string>
                    | Array<number>
                    | null;
                }>;
              }
            | {
                model: "account";
                update: {
                  accessToken?: null | string;
                  accessTokenExpiresAt?: null | number;
                  accountId?: string;
                  createdAt?: number;
                  idToken?: null | string;
                  microsoftTenantId?: string;
                  password?: null | string;
                  providerId?: string;
                  refreshToken?: null | string;
                  refreshTokenExpiresAt?: null | number;
                  scope?: null | string;
                  updatedAt?: number;
                  userId?: string;
                };
                where?: Array<{
                  connector?: "AND" | "OR";
                  field:
                    | "accountId"
                    | "providerId"
                    | "userId"
                    | "accessToken"
                    | "refreshToken"
                    | "idToken"
                    | "accessTokenExpiresAt"
                    | "refreshTokenExpiresAt"
                    | "scope"
                    | "password"
                    | "createdAt"
                    | "updatedAt"
                    | "microsoftTenantId"
                    | "_id";
                  mode?: "sensitive" | "insensitive";
                  operator?:
                    | "lt"
                    | "lte"
                    | "gt"
                    | "gte"
                    | "eq"
                    | "in"
                    | "not_in"
                    | "ne"
                    | "contains"
                    | "starts_with"
                    | "ends_with";
                  value:
                    | string
                    | number
                    | boolean
                    | Array<string>
                    | Array<number>
                    | null;
                }>;
              }
            | {
                model: "verification";
                update: {
                  createdAt?: number;
                  expiresAt?: number;
                  identifier?: string;
                  updatedAt?: number;
                  value?: string;
                };
                where?: Array<{
                  connector?: "AND" | "OR";
                  field:
                    | "identifier"
                    | "value"
                    | "expiresAt"
                    | "createdAt"
                    | "updatedAt"
                    | "_id";
                  mode?: "sensitive" | "insensitive";
                  operator?:
                    | "lt"
                    | "lte"
                    | "gt"
                    | "gte"
                    | "eq"
                    | "in"
                    | "not_in"
                    | "ne"
                    | "contains"
                    | "starts_with"
                    | "ends_with";
                  value:
                    | string
                    | number
                    | boolean
                    | Array<string>
                    | Array<number>
                    | null;
                }>;
              }
            | {
                model: "jwks";
                update: {
                  alg?: null | string;
                  createdAt?: number;
                  crv?: null | string;
                  expiresAt?: null | number;
                  privateKey?: string;
                  publicKey?: string;
                };
                where?: Array<{
                  connector?: "AND" | "OR";
                  field:
                    | "publicKey"
                    | "privateKey"
                    | "createdAt"
                    | "expiresAt"
                    | "alg"
                    | "crv"
                    | "_id";
                  mode?: "sensitive" | "insensitive";
                  operator?:
                    | "lt"
                    | "lte"
                    | "gt"
                    | "gte"
                    | "eq"
                    | "in"
                    | "not_in"
                    | "ne"
                    | "contains"
                    | "starts_with"
                    | "ends_with";
                  value:
                    | string
                    | number
                    | boolean
                    | Array<string>
                    | Array<number>
                    | null;
                }>;
              }
            | {
                model: "oauthClient";
                update: {
                  applicationType?: null | string;
                  backchannelLogoutSessionRequired?: null | boolean;
                  backchannelLogoutUri?: null | string;
                  clientCredentialsScopes?: null | Array<string>;
                  clientDiscoveryId?: null | string;
                  clientId?: string;
                  clientSecret?: null | string;
                  contacts?: null | Array<string>;
                  createdAt?: null | number;
                  disabled?: null | boolean;
                  dpopBoundAccessTokens?: null | boolean;
                  enableEndSession?: null | boolean;
                  grantTypes?: null | Array<string>;
                  icon?: null | string;
                  jwks?: null | string;
                  jwksUri?: null | string;
                  metadata?: null | string;
                  name?: null | string;
                  policy?: null | string;
                  postLogoutRedirectUris?: null | Array<string>;
                  redirectUris?: Array<string>;
                  referenceId?: null | string;
                  requirePKCE?: null | boolean;
                  responseTypes?: null | Array<string>;
                  scopes?: null | Array<string>;
                  skipConsent?: null | boolean;
                  softwareId?: null | string;
                  softwareStatement?: null | string;
                  softwareVersion?: null | string;
                  subjectType?: null | string;
                  tokenEndpointAuthMethod?: null | string;
                  tos?: null | string;
                  updatedAt?: null | number;
                  uri?: null | string;
                  userId?: null | string;
                };
                where?: Array<{
                  connector?: "AND" | "OR";
                  field:
                    | "clientId"
                    | "clientSecret"
                    | "clientDiscoveryId"
                    | "disabled"
                    | "skipConsent"
                    | "enableEndSession"
                    | "subjectType"
                    | "scopes"
                    | "clientCredentialsScopes"
                    | "userId"
                    | "createdAt"
                    | "updatedAt"
                    | "name"
                    | "uri"
                    | "icon"
                    | "contacts"
                    | "tos"
                    | "policy"
                    | "softwareId"
                    | "softwareVersion"
                    | "softwareStatement"
                    | "redirectUris"
                    | "postLogoutRedirectUris"
                    | "backchannelLogoutUri"
                    | "backchannelLogoutSessionRequired"
                    | "tokenEndpointAuthMethod"
                    | "applicationType"
                    | "jwks"
                    | "jwksUri"
                    | "grantTypes"
                    | "responseTypes"
                    | "requirePKCE"
                    | "dpopBoundAccessTokens"
                    | "referenceId"
                    | "metadata"
                    | "_id";
                  mode?: "sensitive" | "insensitive";
                  operator?:
                    | "lt"
                    | "lte"
                    | "gt"
                    | "gte"
                    | "eq"
                    | "in"
                    | "not_in"
                    | "ne"
                    | "contains"
                    | "starts_with"
                    | "ends_with";
                  value:
                    | string
                    | number
                    | boolean
                    | Array<string>
                    | Array<number>
                    | null;
                }>;
              }
            | {
                model: "oauthResource";
                update: {
                  accessTokenTtl?: null | number;
                  allowedScopes?: null | Array<string>;
                  createdAt?: null | number;
                  customClaims?: null | string;
                  disabled?: null | boolean;
                  dpopBoundAccessTokensRequired?: null | boolean;
                  identifier?: string;
                  metadata?: null | string;
                  name?: string;
                  policyVersion?: null | number;
                  refreshTokenTtl?: null | number;
                  signingAlgorithm?: null | string;
                  signingKeyId?: null | string;
                  updatedAt?: null | number;
                };
                where?: Array<{
                  connector?: "AND" | "OR";
                  field:
                    | "identifier"
                    | "name"
                    | "accessTokenTtl"
                    | "refreshTokenTtl"
                    | "signingAlgorithm"
                    | "signingKeyId"
                    | "allowedScopes"
                    | "customClaims"
                    | "dpopBoundAccessTokensRequired"
                    | "disabled"
                    | "createdAt"
                    | "updatedAt"
                    | "policyVersion"
                    | "metadata"
                    | "_id";
                  mode?: "sensitive" | "insensitive";
                  operator?:
                    | "lt"
                    | "lte"
                    | "gt"
                    | "gte"
                    | "eq"
                    | "in"
                    | "not_in"
                    | "ne"
                    | "contains"
                    | "starts_with"
                    | "ends_with";
                  value:
                    | string
                    | number
                    | boolean
                    | Array<string>
                    | Array<number>
                    | null;
                }>;
              }
            | {
                model: "oauthClientResource";
                update: {
                  clientId?: string;
                  createdAt?: null | number;
                  metadata?: null | string;
                  resourceId?: string;
                };
                where?: Array<{
                  connector?: "AND" | "OR";
                  field:
                    | "clientId"
                    | "resourceId"
                    | "metadata"
                    | "createdAt"
                    | "_id";
                  mode?: "sensitive" | "insensitive";
                  operator?:
                    | "lt"
                    | "lte"
                    | "gt"
                    | "gte"
                    | "eq"
                    | "in"
                    | "not_in"
                    | "ne"
                    | "contains"
                    | "starts_with"
                    | "ends_with";
                  value:
                    | string
                    | number
                    | boolean
                    | Array<string>
                    | Array<number>
                    | null;
                }>;
              }
            | {
                model: "oauthRefreshToken";
                update: {
                  authTime?: null | number;
                  authorizationCodeId?: null | string;
                  clientId?: string;
                  confirmation?: null | string;
                  createdAt?: null | number;
                  expiresAt?: null | number;
                  referenceId?: null | string;
                  requestedUserInfoClaims?: null | Array<string>;
                  resources?: null | Array<string>;
                  revoked?: null | number;
                  rotatedAt?: null | number;
                  rotationReplayExpiresAt?: null | number;
                  rotationReplayResponse?: null | string;
                  scopes?: Array<string>;
                  sessionId?: null | string;
                  token?: string;
                  userId?: string;
                };
                where?: Array<{
                  connector?: "AND" | "OR";
                  field:
                    | "token"
                    | "clientId"
                    | "sessionId"
                    | "userId"
                    | "referenceId"
                    | "authorizationCodeId"
                    | "resources"
                    | "requestedUserInfoClaims"
                    | "expiresAt"
                    | "createdAt"
                    | "revoked"
                    | "rotatedAt"
                    | "rotationReplayResponse"
                    | "rotationReplayExpiresAt"
                    | "authTime"
                    | "confirmation"
                    | "scopes"
                    | "_id";
                  mode?: "sensitive" | "insensitive";
                  operator?:
                    | "lt"
                    | "lte"
                    | "gt"
                    | "gte"
                    | "eq"
                    | "in"
                    | "not_in"
                    | "ne"
                    | "contains"
                    | "starts_with"
                    | "ends_with";
                  value:
                    | string
                    | number
                    | boolean
                    | Array<string>
                    | Array<number>
                    | null;
                }>;
              }
            | {
                model: "oauthAccessToken";
                update: {
                  authorizationCodeId?: null | string;
                  clientId?: string;
                  confirmation?: null | string;
                  createdAt?: null | number;
                  expiresAt?: null | number;
                  referenceId?: null | string;
                  refreshId?: null | string;
                  requestedUserInfoClaims?: null | Array<string>;
                  resources?: null | Array<string>;
                  revoked?: null | number;
                  scopes?: Array<string>;
                  sessionId?: null | string;
                  token?: null | string;
                  userId?: null | string;
                };
                where?: Array<{
                  connector?: "AND" | "OR";
                  field:
                    | "token"
                    | "clientId"
                    | "sessionId"
                    | "userId"
                    | "referenceId"
                    | "authorizationCodeId"
                    | "resources"
                    | "requestedUserInfoClaims"
                    | "refreshId"
                    | "expiresAt"
                    | "createdAt"
                    | "revoked"
                    | "confirmation"
                    | "scopes"
                    | "_id";
                  mode?: "sensitive" | "insensitive";
                  operator?:
                    | "lt"
                    | "lte"
                    | "gt"
                    | "gte"
                    | "eq"
                    | "in"
                    | "not_in"
                    | "ne"
                    | "contains"
                    | "starts_with"
                    | "ends_with";
                  value:
                    | string
                    | number
                    | boolean
                    | Array<string>
                    | Array<number>
                    | null;
                }>;
              }
            | {
                model: "oauthConsent";
                update: {
                  clientId?: string;
                  createdAt?: null | number;
                  referenceId?: null | string;
                  requestedUserInfoClaims?: null | Array<string>;
                  resources?: null | Array<string>;
                  scopes?: Array<string>;
                  updatedAt?: null | number;
                  userId?: null | string;
                };
                where?: Array<{
                  connector?: "AND" | "OR";
                  field:
                    | "clientId"
                    | "userId"
                    | "referenceId"
                    | "resources"
                    | "requestedUserInfoClaims"
                    | "scopes"
                    | "createdAt"
                    | "updatedAt"
                    | "_id";
                  mode?: "sensitive" | "insensitive";
                  operator?:
                    | "lt"
                    | "lte"
                    | "gt"
                    | "gte"
                    | "eq"
                    | "in"
                    | "not_in"
                    | "ne"
                    | "contains"
                    | "starts_with"
                    | "ends_with";
                  value:
                    | string
                    | number
                    | boolean
                    | Array<string>
                    | Array<number>
                    | null;
                }>;
              }
            | {
                model: "oauthClientAssertion";
                update: { expiresAt?: number };
                where?: Array<{
                  connector?: "AND" | "OR";
                  field: "expiresAt" | "_id";
                  mode?: "sensitive" | "insensitive";
                  operator?:
                    | "lt"
                    | "lte"
                    | "gt"
                    | "gte"
                    | "eq"
                    | "in"
                    | "not_in"
                    | "ne"
                    | "contains"
                    | "starts_with"
                    | "ends_with";
                  value:
                    | string
                    | number
                    | boolean
                    | Array<string>
                    | Array<number>
                    | null;
                }>;
              };
          onUpdateHandle?: string;
          paginationOpts: {
            cursor: string | null;
            endCursor?: string | null;
            id?: number;
            maximumBytesRead?: number;
            maximumRowsRead?: number;
            numItems: number;
          };
        },
        any,
        Name
      >;
      updateOne: FunctionReference<
        "mutation",
        "internal",
        {
          input:
            | {
                model: "user";
                update: {
                  banExpires?: null | number;
                  banReason?: null | string;
                  banned?: null | boolean;
                  createdAt?: number;
                  email?: string;
                  emailVerified?: boolean;
                  image?: null | string;
                  isAnonymous?: null | boolean;
                  name?: string;
                  role?: null | string;
                  updatedAt?: number;
                  userId?: null | string;
                };
                where?: Array<{
                  connector?: "AND" | "OR";
                  field:
                    | "name"
                    | "email"
                    | "emailVerified"
                    | "image"
                    | "createdAt"
                    | "updatedAt"
                    | "userId"
                    | "role"
                    | "banned"
                    | "banReason"
                    | "banExpires"
                    | "isAnonymous"
                    | "_id";
                  mode?: "sensitive" | "insensitive";
                  operator?:
                    | "lt"
                    | "lte"
                    | "gt"
                    | "gte"
                    | "eq"
                    | "in"
                    | "not_in"
                    | "ne"
                    | "contains"
                    | "starts_with"
                    | "ends_with";
                  value:
                    | string
                    | number
                    | boolean
                    | Array<string>
                    | Array<number>
                    | null;
                }>;
              }
            | {
                model: "session";
                update: {
                  createdAt?: number;
                  expiresAt?: number;
                  impersonatedBy?: null | string;
                  ipAddress?: null | string;
                  token?: string;
                  updatedAt?: number;
                  userAgent?: null | string;
                  userId?: string;
                };
                where?: Array<{
                  connector?: "AND" | "OR";
                  field:
                    | "expiresAt"
                    | "token"
                    | "createdAt"
                    | "updatedAt"
                    | "ipAddress"
                    | "userAgent"
                    | "userId"
                    | "impersonatedBy"
                    | "_id";
                  mode?: "sensitive" | "insensitive";
                  operator?:
                    | "lt"
                    | "lte"
                    | "gt"
                    | "gte"
                    | "eq"
                    | "in"
                    | "not_in"
                    | "ne"
                    | "contains"
                    | "starts_with"
                    | "ends_with";
                  value:
                    | string
                    | number
                    | boolean
                    | Array<string>
                    | Array<number>
                    | null;
                }>;
              }
            | {
                model: "account";
                update: {
                  accessToken?: null | string;
                  accessTokenExpiresAt?: null | number;
                  accountId?: string;
                  createdAt?: number;
                  idToken?: null | string;
                  microsoftTenantId?: string;
                  password?: null | string;
                  providerId?: string;
                  refreshToken?: null | string;
                  refreshTokenExpiresAt?: null | number;
                  scope?: null | string;
                  updatedAt?: number;
                  userId?: string;
                };
                where?: Array<{
                  connector?: "AND" | "OR";
                  field:
                    | "accountId"
                    | "providerId"
                    | "userId"
                    | "accessToken"
                    | "refreshToken"
                    | "idToken"
                    | "accessTokenExpiresAt"
                    | "refreshTokenExpiresAt"
                    | "scope"
                    | "password"
                    | "createdAt"
                    | "updatedAt"
                    | "microsoftTenantId"
                    | "_id";
                  mode?: "sensitive" | "insensitive";
                  operator?:
                    | "lt"
                    | "lte"
                    | "gt"
                    | "gte"
                    | "eq"
                    | "in"
                    | "not_in"
                    | "ne"
                    | "contains"
                    | "starts_with"
                    | "ends_with";
                  value:
                    | string
                    | number
                    | boolean
                    | Array<string>
                    | Array<number>
                    | null;
                }>;
              }
            | {
                model: "verification";
                update: {
                  createdAt?: number;
                  expiresAt?: number;
                  identifier?: string;
                  updatedAt?: number;
                  value?: string;
                };
                where?: Array<{
                  connector?: "AND" | "OR";
                  field:
                    | "identifier"
                    | "value"
                    | "expiresAt"
                    | "createdAt"
                    | "updatedAt"
                    | "_id";
                  mode?: "sensitive" | "insensitive";
                  operator?:
                    | "lt"
                    | "lte"
                    | "gt"
                    | "gte"
                    | "eq"
                    | "in"
                    | "not_in"
                    | "ne"
                    | "contains"
                    | "starts_with"
                    | "ends_with";
                  value:
                    | string
                    | number
                    | boolean
                    | Array<string>
                    | Array<number>
                    | null;
                }>;
              }
            | {
                model: "jwks";
                update: {
                  alg?: null | string;
                  createdAt?: number;
                  crv?: null | string;
                  expiresAt?: null | number;
                  privateKey?: string;
                  publicKey?: string;
                };
                where?: Array<{
                  connector?: "AND" | "OR";
                  field:
                    | "publicKey"
                    | "privateKey"
                    | "createdAt"
                    | "expiresAt"
                    | "alg"
                    | "crv"
                    | "_id";
                  mode?: "sensitive" | "insensitive";
                  operator?:
                    | "lt"
                    | "lte"
                    | "gt"
                    | "gte"
                    | "eq"
                    | "in"
                    | "not_in"
                    | "ne"
                    | "contains"
                    | "starts_with"
                    | "ends_with";
                  value:
                    | string
                    | number
                    | boolean
                    | Array<string>
                    | Array<number>
                    | null;
                }>;
              }
            | {
                model: "oauthClient";
                update: {
                  applicationType?: null | string;
                  backchannelLogoutSessionRequired?: null | boolean;
                  backchannelLogoutUri?: null | string;
                  clientCredentialsScopes?: null | Array<string>;
                  clientDiscoveryId?: null | string;
                  clientId?: string;
                  clientSecret?: null | string;
                  contacts?: null | Array<string>;
                  createdAt?: null | number;
                  disabled?: null | boolean;
                  dpopBoundAccessTokens?: null | boolean;
                  enableEndSession?: null | boolean;
                  grantTypes?: null | Array<string>;
                  icon?: null | string;
                  jwks?: null | string;
                  jwksUri?: null | string;
                  metadata?: null | string;
                  name?: null | string;
                  policy?: null | string;
                  postLogoutRedirectUris?: null | Array<string>;
                  redirectUris?: Array<string>;
                  referenceId?: null | string;
                  requirePKCE?: null | boolean;
                  responseTypes?: null | Array<string>;
                  scopes?: null | Array<string>;
                  skipConsent?: null | boolean;
                  softwareId?: null | string;
                  softwareStatement?: null | string;
                  softwareVersion?: null | string;
                  subjectType?: null | string;
                  tokenEndpointAuthMethod?: null | string;
                  tos?: null | string;
                  updatedAt?: null | number;
                  uri?: null | string;
                  userId?: null | string;
                };
                where?: Array<{
                  connector?: "AND" | "OR";
                  field:
                    | "clientId"
                    | "clientSecret"
                    | "clientDiscoveryId"
                    | "disabled"
                    | "skipConsent"
                    | "enableEndSession"
                    | "subjectType"
                    | "scopes"
                    | "clientCredentialsScopes"
                    | "userId"
                    | "createdAt"
                    | "updatedAt"
                    | "name"
                    | "uri"
                    | "icon"
                    | "contacts"
                    | "tos"
                    | "policy"
                    | "softwareId"
                    | "softwareVersion"
                    | "softwareStatement"
                    | "redirectUris"
                    | "postLogoutRedirectUris"
                    | "backchannelLogoutUri"
                    | "backchannelLogoutSessionRequired"
                    | "tokenEndpointAuthMethod"
                    | "applicationType"
                    | "jwks"
                    | "jwksUri"
                    | "grantTypes"
                    | "responseTypes"
                    | "requirePKCE"
                    | "dpopBoundAccessTokens"
                    | "referenceId"
                    | "metadata"
                    | "_id";
                  mode?: "sensitive" | "insensitive";
                  operator?:
                    | "lt"
                    | "lte"
                    | "gt"
                    | "gte"
                    | "eq"
                    | "in"
                    | "not_in"
                    | "ne"
                    | "contains"
                    | "starts_with"
                    | "ends_with";
                  value:
                    | string
                    | number
                    | boolean
                    | Array<string>
                    | Array<number>
                    | null;
                }>;
              }
            | {
                model: "oauthResource";
                update: {
                  accessTokenTtl?: null | number;
                  allowedScopes?: null | Array<string>;
                  createdAt?: null | number;
                  customClaims?: null | string;
                  disabled?: null | boolean;
                  dpopBoundAccessTokensRequired?: null | boolean;
                  identifier?: string;
                  metadata?: null | string;
                  name?: string;
                  policyVersion?: null | number;
                  refreshTokenTtl?: null | number;
                  signingAlgorithm?: null | string;
                  signingKeyId?: null | string;
                  updatedAt?: null | number;
                };
                where?: Array<{
                  connector?: "AND" | "OR";
                  field:
                    | "identifier"
                    | "name"
                    | "accessTokenTtl"
                    | "refreshTokenTtl"
                    | "signingAlgorithm"
                    | "signingKeyId"
                    | "allowedScopes"
                    | "customClaims"
                    | "dpopBoundAccessTokensRequired"
                    | "disabled"
                    | "createdAt"
                    | "updatedAt"
                    | "policyVersion"
                    | "metadata"
                    | "_id";
                  mode?: "sensitive" | "insensitive";
                  operator?:
                    | "lt"
                    | "lte"
                    | "gt"
                    | "gte"
                    | "eq"
                    | "in"
                    | "not_in"
                    | "ne"
                    | "contains"
                    | "starts_with"
                    | "ends_with";
                  value:
                    | string
                    | number
                    | boolean
                    | Array<string>
                    | Array<number>
                    | null;
                }>;
              }
            | {
                model: "oauthClientResource";
                update: {
                  clientId?: string;
                  createdAt?: null | number;
                  metadata?: null | string;
                  resourceId?: string;
                };
                where?: Array<{
                  connector?: "AND" | "OR";
                  field:
                    | "clientId"
                    | "resourceId"
                    | "metadata"
                    | "createdAt"
                    | "_id";
                  mode?: "sensitive" | "insensitive";
                  operator?:
                    | "lt"
                    | "lte"
                    | "gt"
                    | "gte"
                    | "eq"
                    | "in"
                    | "not_in"
                    | "ne"
                    | "contains"
                    | "starts_with"
                    | "ends_with";
                  value:
                    | string
                    | number
                    | boolean
                    | Array<string>
                    | Array<number>
                    | null;
                }>;
              }
            | {
                model: "oauthRefreshToken";
                update: {
                  authTime?: null | number;
                  authorizationCodeId?: null | string;
                  clientId?: string;
                  confirmation?: null | string;
                  createdAt?: null | number;
                  expiresAt?: null | number;
                  referenceId?: null | string;
                  requestedUserInfoClaims?: null | Array<string>;
                  resources?: null | Array<string>;
                  revoked?: null | number;
                  rotatedAt?: null | number;
                  rotationReplayExpiresAt?: null | number;
                  rotationReplayResponse?: null | string;
                  scopes?: Array<string>;
                  sessionId?: null | string;
                  token?: string;
                  userId?: string;
                };
                where?: Array<{
                  connector?: "AND" | "OR";
                  field:
                    | "token"
                    | "clientId"
                    | "sessionId"
                    | "userId"
                    | "referenceId"
                    | "authorizationCodeId"
                    | "resources"
                    | "requestedUserInfoClaims"
                    | "expiresAt"
                    | "createdAt"
                    | "revoked"
                    | "rotatedAt"
                    | "rotationReplayResponse"
                    | "rotationReplayExpiresAt"
                    | "authTime"
                    | "confirmation"
                    | "scopes"
                    | "_id";
                  mode?: "sensitive" | "insensitive";
                  operator?:
                    | "lt"
                    | "lte"
                    | "gt"
                    | "gte"
                    | "eq"
                    | "in"
                    | "not_in"
                    | "ne"
                    | "contains"
                    | "starts_with"
                    | "ends_with";
                  value:
                    | string
                    | number
                    | boolean
                    | Array<string>
                    | Array<number>
                    | null;
                }>;
              }
            | {
                model: "oauthAccessToken";
                update: {
                  authorizationCodeId?: null | string;
                  clientId?: string;
                  confirmation?: null | string;
                  createdAt?: null | number;
                  expiresAt?: null | number;
                  referenceId?: null | string;
                  refreshId?: null | string;
                  requestedUserInfoClaims?: null | Array<string>;
                  resources?: null | Array<string>;
                  revoked?: null | number;
                  scopes?: Array<string>;
                  sessionId?: null | string;
                  token?: null | string;
                  userId?: null | string;
                };
                where?: Array<{
                  connector?: "AND" | "OR";
                  field:
                    | "token"
                    | "clientId"
                    | "sessionId"
                    | "userId"
                    | "referenceId"
                    | "authorizationCodeId"
                    | "resources"
                    | "requestedUserInfoClaims"
                    | "refreshId"
                    | "expiresAt"
                    | "createdAt"
                    | "revoked"
                    | "confirmation"
                    | "scopes"
                    | "_id";
                  mode?: "sensitive" | "insensitive";
                  operator?:
                    | "lt"
                    | "lte"
                    | "gt"
                    | "gte"
                    | "eq"
                    | "in"
                    | "not_in"
                    | "ne"
                    | "contains"
                    | "starts_with"
                    | "ends_with";
                  value:
                    | string
                    | number
                    | boolean
                    | Array<string>
                    | Array<number>
                    | null;
                }>;
              }
            | {
                model: "oauthConsent";
                update: {
                  clientId?: string;
                  createdAt?: null | number;
                  referenceId?: null | string;
                  requestedUserInfoClaims?: null | Array<string>;
                  resources?: null | Array<string>;
                  scopes?: Array<string>;
                  updatedAt?: null | number;
                  userId?: null | string;
                };
                where?: Array<{
                  connector?: "AND" | "OR";
                  field:
                    | "clientId"
                    | "userId"
                    | "referenceId"
                    | "resources"
                    | "requestedUserInfoClaims"
                    | "scopes"
                    | "createdAt"
                    | "updatedAt"
                    | "_id";
                  mode?: "sensitive" | "insensitive";
                  operator?:
                    | "lt"
                    | "lte"
                    | "gt"
                    | "gte"
                    | "eq"
                    | "in"
                    | "not_in"
                    | "ne"
                    | "contains"
                    | "starts_with"
                    | "ends_with";
                  value:
                    | string
                    | number
                    | boolean
                    | Array<string>
                    | Array<number>
                    | null;
                }>;
              }
            | {
                model: "oauthClientAssertion";
                update: { expiresAt?: number };
                where?: Array<{
                  connector?: "AND" | "OR";
                  field: "expiresAt" | "_id";
                  mode?: "sensitive" | "insensitive";
                  operator?:
                    | "lt"
                    | "lte"
                    | "gt"
                    | "gte"
                    | "eq"
                    | "in"
                    | "not_in"
                    | "ne"
                    | "contains"
                    | "starts_with"
                    | "ends_with";
                  value:
                    | string
                    | number
                    | boolean
                    | Array<string>
                    | Array<number>
                    | null;
                }>;
              };
          onUpdateHandle?: string;
        },
        any,
        Name
      >;
    };
    oauth: {
      deleteClients: FunctionReference<
        "mutation",
        "internal",
        { field: "clientId" | "userId"; numItems: number; value: string },
        any,
        Name
      >;
      deleteSpentTokens: FunctionReference<
        "mutation",
        "internal",
        { expiredBefore: number; numItems: number; revokedBefore: number },
        any,
        Name
      >;
      deleteUnusedClients: FunctionReference<
        "mutation",
        "internal",
        { before: number; clientIds: Array<string> },
        any,
        Name
      >;
      revokeAccessTokens: FunctionReference<
        "mutation",
        "internal",
        {
          cursor: string | null;
          now: number;
          numItems: number;
          userId: string;
        },
        any,
        Name
      >;
      unusedClients: FunctionReference<
        "query",
        "internal",
        {
          before: number;
          cursor: string | null;
          maximumBytesRead: number;
          numItems: number;
        },
        any,
        Name
      >;
    };
    sessions: {
      liveSessionUser: FunctionReference<
        "query",
        "internal",
        { sessionId: string; userId: string },
        null | {
          _id: string;
          email: string;
          emailVerified: boolean;
          isAnonymous: boolean | null;
          name: string;
        },
        Name
      >;
    };
  };
