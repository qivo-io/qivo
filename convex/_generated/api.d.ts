/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as admin from "../admin.js";
import type * as adminAuth from "../adminAuth.js";
import type * as adminBilling from "../adminBilling.js";
import type * as adminDemo from "../adminDemo.js";
import type * as appearance from "../appearance.js";
import type * as auth from "../auth.js";
import type * as backgroundPreviewProcessor from "../backgroundPreviewProcessor.js";
import type * as backgroundPreviews from "../backgroundPreviews.js";
import type * as billing from "../billing.js";
import type * as billingActions from "../billingActions.js";
import type * as billingHttp from "../billingHttp.js";
import type * as billingMail from "../billingMail.js";
import type * as billingMetering from "../billingMetering.js";
import type * as billingSync from "../billingSync.js";
import type * as comments from "../comments.js";
import type * as crons from "../crons.js";
import type * as demo from "../demo.js";
import type * as demoReporting from "../demoReporting.js";
import type * as demoReportingHttp from "../demoReportingHttp.js";
import type * as demoUploads from "../demoUploads.js";
import type * as demoVisitor from "../demoVisitor.js";
import type * as files from "../files.js";
import type * as http from "../http.js";
import type * as identity from "../identity.js";
import type * as internal_demoCleanup from "../internal/demoCleanup.js";
import type * as internal_demoMetrics from "../internal/demoMetrics.js";
import type * as internal_demoTest from "../internal/demoTest.js";
import type * as internal_guestOrg from "../internal/guestOrg.js";
import type * as internal_marketingDemo from "../internal/marketingDemo.js";
import type * as internal_marketingDemoData from "../internal/marketingDemoData.js";
import type * as internal_oauthSmoke from "../internal/oauthSmoke.js";
import type * as internal_operator from "../internal/operator.js";
import type * as issues from "../issues.js";
import type * as jobs from "../jobs.js";
import type * as labels from "../labels.js";
import type * as lib_access from "../lib/access.js";
import type * as lib_backgroundPreviews from "../lib/backgroundPreviews.js";
import type * as lib_billableUsers from "../lib/billableUsers.js";
import type * as lib_billingAccess from "../lib/billingAccess.js";
import type * as lib_billingTypes from "../lib/billingTypes.js";
import type * as lib_core from "../lib/core.js";
import type * as lib_db from "../lib/db.js";
import type * as lib_demo from "../lib/demo.js";
import type * as lib_demoMetricsReport from "../lib/demoMetricsReport.js";
import type * as lib_demoReporting from "../lib/demoReporting.js";
import type * as lib_demoVisitor from "../lib/demoVisitor.js";
import type * as lib_deployment from "../lib/deployment.js";
import type * as lib_enums from "../lib/enums.js";
import type * as lib_fileTokens from "../lib/fileTokens.js";
import type * as lib_functions from "../lib/functions.js";
import type * as lib_oauth from "../lib/oauth.js";
import type * as lib_oauthAdapter from "../lib/oauthAdapter.js";
import type * as lib_oauthProvider from "../lib/oauthProvider.js";
import type * as lib_orgExport from "../lib/orgExport.js";
import type * as lib_panorama from "../lib/panorama.js";
import type * as lib_panoramaCuration from "../lib/panoramaCuration.js";
import type * as lib_panoramaFilename from "../lib/panoramaFilename.js";
import type * as lib_panoramaImage from "../lib/panoramaImage.js";
import type * as lib_panoramaWeeks from "../lib/panoramaWeeks.js";
import type * as lib_polar from "../lib/polar.js";
import type * as lib_projectLimits from "../lib/projectLimits.js";
import type * as lib_review from "../lib/review.js";
import type * as lib_search from "../lib/search.js";
import type * as lib_snapshotRelations from "../lib/snapshotRelations.js";
import type * as lib_taskEvents from "../lib/taskEvents.js";
import type * as lib_taskRefs from "../lib/taskRefs.js";
import type * as lib_teamSync from "../lib/teamSync.js";
import type * as lib_visibility from "../lib/visibility.js";
import type * as lib_webhookTransport from "../lib/webhookTransport.js";
import type * as machine_auth from "../machine/auth.js";
import type * as machine_curation from "../machine/curation.js";
import type * as machine_mcp from "../machine/mcp.js";
import type * as machine_rest from "../machine/rest.js";
import type * as machine_testing from "../machine/testing.js";
import type * as mail from "../mail.js";
import type * as messages from "../messages.js";
import type * as model_activity from "../model/activity.js";
import type * as model_admin from "../model/admin.js";
import type * as model_appearance from "../model/appearance.js";
import type * as model_billing from "../model/billing.js";
import type * as model_billingUsage from "../model/billingUsage.js";
import type * as model_cascade from "../model/cascade.js";
import type * as model_demoMetrics from "../model/demoMetrics.js";
import type * as model_demoSeed from "../model/demoSeed.js";
import type * as model_demoUploads from "../model/demoUploads.js";
import type * as model_issues from "../model/issues.js";
import type * as model_messages from "../model/messages.js";
import type * as model_orgs from "../model/orgs.js";
import type * as model_projects from "../model/projects.js";
import type * as model_taskEvents from "../model/taskEvents.js";
import type * as model_taskValues from "../model/taskValues.js";
import type * as model_webhookHealth from "../model/webhookHealth.js";
import type * as model_webhookOwners from "../model/webhookOwners.js";
import type * as model_webhookQueue from "../model/webhookQueue.js";
import type * as oauthConnections from "../oauthConnections.js";
import type * as orgExport from "../orgExport.js";
import type * as orgs from "../orgs.js";
import type * as panoramaCuration from "../panoramaCuration.js";
import type * as panoramaImages from "../panoramaImages.js";
import type * as panoramaUploads from "../panoramaUploads.js";
import type * as planning from "../planning.js";
import type * as prefs from "../prefs.js";
import type * as profiles from "../profiles.js";
import type * as projects from "../projects.js";
import type * as roadmap from "../roadmap.js";
import type * as snapshot from "../snapshot.js";
import type * as teamSync from "../teamSync.js";
import type * as teams from "../teams.js";
import type * as tokens from "../tokens.js";
import type * as webhookActions from "../webhookActions.js";
import type * as webhookQueue from "../webhookQueue.js";
import type * as webhooks from "../webhooks.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  admin: typeof admin;
  adminAuth: typeof adminAuth;
  adminBilling: typeof adminBilling;
  adminDemo: typeof adminDemo;
  appearance: typeof appearance;
  auth: typeof auth;
  backgroundPreviewProcessor: typeof backgroundPreviewProcessor;
  backgroundPreviews: typeof backgroundPreviews;
  billing: typeof billing;
  billingActions: typeof billingActions;
  billingHttp: typeof billingHttp;
  billingMail: typeof billingMail;
  billingMetering: typeof billingMetering;
  billingSync: typeof billingSync;
  comments: typeof comments;
  crons: typeof crons;
  demo: typeof demo;
  demoReporting: typeof demoReporting;
  demoReportingHttp: typeof demoReportingHttp;
  demoUploads: typeof demoUploads;
  demoVisitor: typeof demoVisitor;
  files: typeof files;
  http: typeof http;
  identity: typeof identity;
  "internal/demoCleanup": typeof internal_demoCleanup;
  "internal/demoMetrics": typeof internal_demoMetrics;
  "internal/demoTest": typeof internal_demoTest;
  "internal/guestOrg": typeof internal_guestOrg;
  "internal/marketingDemo": typeof internal_marketingDemo;
  "internal/marketingDemoData": typeof internal_marketingDemoData;
  "internal/oauthSmoke": typeof internal_oauthSmoke;
  "internal/operator": typeof internal_operator;
  issues: typeof issues;
  jobs: typeof jobs;
  labels: typeof labels;
  "lib/access": typeof lib_access;
  "lib/backgroundPreviews": typeof lib_backgroundPreviews;
  "lib/billableUsers": typeof lib_billableUsers;
  "lib/billingAccess": typeof lib_billingAccess;
  "lib/billingTypes": typeof lib_billingTypes;
  "lib/core": typeof lib_core;
  "lib/db": typeof lib_db;
  "lib/demo": typeof lib_demo;
  "lib/demoMetricsReport": typeof lib_demoMetricsReport;
  "lib/demoReporting": typeof lib_demoReporting;
  "lib/demoVisitor": typeof lib_demoVisitor;
  "lib/deployment": typeof lib_deployment;
  "lib/enums": typeof lib_enums;
  "lib/fileTokens": typeof lib_fileTokens;
  "lib/functions": typeof lib_functions;
  "lib/oauth": typeof lib_oauth;
  "lib/oauthAdapter": typeof lib_oauthAdapter;
  "lib/oauthProvider": typeof lib_oauthProvider;
  "lib/orgExport": typeof lib_orgExport;
  "lib/panorama": typeof lib_panorama;
  "lib/panoramaCuration": typeof lib_panoramaCuration;
  "lib/panoramaFilename": typeof lib_panoramaFilename;
  "lib/panoramaImage": typeof lib_panoramaImage;
  "lib/panoramaWeeks": typeof lib_panoramaWeeks;
  "lib/polar": typeof lib_polar;
  "lib/projectLimits": typeof lib_projectLimits;
  "lib/review": typeof lib_review;
  "lib/search": typeof lib_search;
  "lib/snapshotRelations": typeof lib_snapshotRelations;
  "lib/taskEvents": typeof lib_taskEvents;
  "lib/taskRefs": typeof lib_taskRefs;
  "lib/teamSync": typeof lib_teamSync;
  "lib/visibility": typeof lib_visibility;
  "lib/webhookTransport": typeof lib_webhookTransport;
  "machine/auth": typeof machine_auth;
  "machine/curation": typeof machine_curation;
  "machine/mcp": typeof machine_mcp;
  "machine/rest": typeof machine_rest;
  "machine/testing": typeof machine_testing;
  mail: typeof mail;
  messages: typeof messages;
  "model/activity": typeof model_activity;
  "model/admin": typeof model_admin;
  "model/appearance": typeof model_appearance;
  "model/billing": typeof model_billing;
  "model/billingUsage": typeof model_billingUsage;
  "model/cascade": typeof model_cascade;
  "model/demoMetrics": typeof model_demoMetrics;
  "model/demoSeed": typeof model_demoSeed;
  "model/demoUploads": typeof model_demoUploads;
  "model/issues": typeof model_issues;
  "model/messages": typeof model_messages;
  "model/orgs": typeof model_orgs;
  "model/projects": typeof model_projects;
  "model/taskEvents": typeof model_taskEvents;
  "model/taskValues": typeof model_taskValues;
  "model/webhookHealth": typeof model_webhookHealth;
  "model/webhookOwners": typeof model_webhookOwners;
  "model/webhookQueue": typeof model_webhookQueue;
  oauthConnections: typeof oauthConnections;
  orgExport: typeof orgExport;
  orgs: typeof orgs;
  panoramaCuration: typeof panoramaCuration;
  panoramaImages: typeof panoramaImages;
  panoramaUploads: typeof panoramaUploads;
  planning: typeof planning;
  prefs: typeof prefs;
  profiles: typeof profiles;
  projects: typeof projects;
  roadmap: typeof roadmap;
  snapshot: typeof snapshot;
  teamSync: typeof teamSync;
  teams: typeof teams;
  tokens: typeof tokens;
  webhookActions: typeof webhookActions;
  webhookQueue: typeof webhookQueue;
  webhooks: typeof webhooks;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {
  betterAuth: import("../betterAuth/_generated/component.js").ComponentApi<"betterAuth">;
};
