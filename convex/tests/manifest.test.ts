/* The function-surface manifest + the wrapper rule.
 *
 * Three walls in one file:
 *   1. MANIFEST — every registered function in the tree as one sorted row
 *      "<module>:<export> <kind> <visibility> <argsJson>", byte-compared to a
 *      committed literal. exportArgs() serializes the REAL wire validator, so
 *      customFunction-merged args (org_id) are pinned exactly as clients send
 *      them, and any surface change shows up as a PR diff of the literal.
 *   2. PUBLIC — the public subset hand-grouped module → export → wrapper.
 *      This is the human review artifact: which auth posture each door
 *      carries. A public function is "added WITH a reason" = its row lands in
 *      both literals in the same diff.
 *   3. The wrapper rule — (a) no module but lib/functions.ts imports bare
 *      query/mutation/action from _generated/server (import type excluded;
 *      one name-tight documented exception below); (b) every public
 *      function's wire args carry org_id unless its PUBLIC wrapper is a
 *      non-org one — the belt that catches a bare registration smuggled past
 *      (a) via re-export.
 *
 * REGENERATION RITUAL (any time a function is added/changed/removed):
 *   npx vitest run convex/tests/manifest.test.ts
 * On mismatch the test prints the actual rows between cut lines — paste them
 * over the MANIFEST block, update the PUBLIC map (and its count) by hand,
 * re-run. Never hand-guess rows; the printed output is the transcription
 * source.
 *
 * Why this walk: _generated/api exports anyApi, a lazy Proxy that fabricates
 * references on property access and enumerates NOTHING — walking it is a
 * silent no-op. The honest enumeration is the CLI's own, done in-process:
 * import every module eagerly and keep the exports carrying the registration
 * flags. isQuery/isMutation/isAction, isPublic/isInternal and exportArgs()
 * are the verified runtime property names (convex/dist/esm/server/impl/
 * registration_impl.js).
 *
 * Exclusions: _generated (not app code), betterAuth/** (vendored COMPONENT —
 * its functions register against the component, not the app api, and its
 * modules can throw in app context), tests/** (this file included),
 * convex.config.ts (defineApp at import time), auth.config.ts, env.d.ts. */
/// <reference types="vite/client" />

import { describe, expect, it } from 'vitest'

/* --------------------------------------------------------- the module walk */

const modules = import.meta.glob(
  [
    '../**/*.ts',
    '!../_generated/**',
    '!../betterAuth/**',
    '!../tests/**',
    '!../convex.config.ts',
    '!../auth.config.ts',
    '!../env.d.ts',
  ],
  { eager: true },
) as Record<string, Record<string, unknown>>

/* A registered Convex function is a callable object carrying the flags. */
type Registered = ((...args: unknown[]) => unknown) & {
  isQuery?: true
  isMutation?: true
  isAction?: true
  isPublic?: true
  isInternal?: true
  exportArgs?: () => string
}

type Row = { module: string; name: string; kind: string; vis: string; args: string }

const rows: Row[] = []
for (const [path, mod] of Object.entries(modules)) {
  const module = path.replace(/^\.\.\//, '').replace(/\.ts$/, '')
  for (const [name, value] of Object.entries(mod)) {
    const fn = value as Registered
    if (typeof fn !== 'function' || fn.exportArgs === undefined) continue
    const kind =
      fn.isQuery === true
        ? 'query'
        : fn.isMutation === true
          ? 'mutation'
          : fn.isAction === true
            ? 'action'
            : 'http'
    const vis = fn.isPublic === true ? 'public' : 'internal'
    rows.push({ module, name, kind, vis, args: fn.exportArgs() })
  }
}

const actual = rows.map((r) => `${r.module}:${r.name} ${r.kind} ${r.vis} ${r.args}`).sort()

/* ------------------------------------------------- the committed baseline */

const MANIFEST = `
accessRemovals:preview query public {"type":"object","value":{"change":{"fieldType":{"type":"union","value":[{"type":"object","value":{"kind":{"fieldType":{"type":"literal","value":"user_grant"},"optional":false},"project_id":{"fieldType":{"type":"string"},"optional":false},"user_id":{"fieldType":{"type":"string"},"optional":false}}},{"type":"object","value":{"kind":{"fieldType":{"type":"literal","value":"team_grant"},"optional":false},"project_id":{"fieldType":{"type":"string"},"optional":false},"team_id":{"fieldType":{"type":"string"},"optional":false}}},{"type":"object","value":{"kind":{"fieldType":{"type":"literal","value":"team_member"},"optional":false},"team_id":{"fieldType":{"type":"string"},"optional":false},"user_id":{"fieldType":{"type":"string"},"optional":false}}},{"type":"object","value":{"kind":{"fieldType":{"type":"literal","value":"delete_team"},"optional":false},"team_id":{"fieldType":{"type":"string"},"optional":false}}}]},"optional":false},"org_id":{"fieldType":{"type":"string"},"optional":false}}}
admin:addOperator mutation internal {"type":"object","value":{"email":{"fieldType":{"type":"string"},"optional":false},"note":{"fieldType":{"type":"string"},"optional":true}}}
admin:auditLog query public {"type":"object","value":{"limit":{"fieldType":{"type":"number"},"optional":true},"cursor":{"fieldType":{"type":"union","value":[{"type":"string"},{"type":"null"}]},"optional":true}}}
admin:isOperator query public {"type":"object","value":{}}
admin:promoteOrgAdmin mutation public {"type":"object","value":{"profile_id":{"fieldType":{"type":"string"},"optional":false}}}
admin:removeOperator mutation internal {"type":"object","value":{"email":{"fieldType":{"type":"string"},"optional":false}}}
adminAuth:banUser action public {"type":"object","value":{"email":{"fieldType":{"type":"string"},"optional":false}}}
adminAuth:createBreakGlass action public {"type":"object","value":{"org_id":{"fieldType":{"type":"string"},"optional":false},"email":{"fieldType":{"type":"string"},"optional":false},"name":{"fieldType":{"type":"string"},"optional":true}}}
adminAuth:deleteOrphanLogin mutation internal {"type":"object","value":{"email":{"fieldType":{"type":"string"},"optional":false}}}
adminAuth:insertBreakGlass mutation internal {"type":"object","value":{"org_id":{"fieldType":{"type":"string"},"optional":false},"email":{"fieldType":{"type":"string"},"optional":false},"name":{"fieldType":{"type":"string"},"optional":false},"auth_user_id":{"fieldType":{"type":"string"},"optional":false},"actor":{"fieldType":{"type":"object","value":{"auth_user_id":{"fieldType":{"type":"string"},"optional":false},"email":{"fieldType":{"type":"string"},"optional":false}}},"optional":false}}}
adminAuth:logAction mutation internal {"type":"object","value":{"actor_auth_id":{"fieldType":{"type":"string"},"optional":true},"actor_email":{"fieldType":{"type":"string"},"optional":false},"action":{"fieldType":{"type":"union","value":[{"type":"literal","value":"recovery_link"},{"type":"literal","value":"ban"},{"type":"literal","value":"unban"}]},"optional":false},"target_org_id":{"fieldType":{"type":"string"},"optional":true},"target_profile_id":{"fieldType":{"type":"string"},"optional":true},"detail":{"fieldType":{"type":"any"},"optional":false}}}
adminAuth:operatorCheck query internal {"type":"object","value":{}}
adminAuth:profilesByEmail query internal {"type":"object","value":{"email":{"fieldType":{"type":"string"},"optional":false}}}
adminAuth:purgeLoginTokens mutation internal {"type":"object","value":{"auth_user_id":{"fieldType":{"type":"string"},"optional":false}}}
adminAuth:recoveryLink action public {"type":"object","value":{"email":{"fieldType":{"type":"string"},"optional":false}}}
adminAuth:removeAuthUser mutation internal {"type":"object","value":{"auth_user_id":{"fieldType":{"type":"string"},"optional":false}}}
adminAuth:unbanUser action public {"type":"object","value":{"email":{"fieldType":{"type":"string"},"optional":false}}}
adminBilling:assignPlan mutation public {"type":"object","value":{"org_id":{"fieldType":{"type":"string"},"optional":false},"plan_id":{"fieldType":{"type":"string"},"optional":false}}}
adminBilling:connectPlan mutation internal {"type":"object","value":{"plan_id":{"fieldType":{"type":"string"},"optional":false},"polar_product_id":{"fieldType":{"type":"string"},"optional":false},"api_meter_id":{"fieldType":{"type":"string"},"optional":false},"storage_meter_id":{"fieldType":{"type":"string"},"optional":false},"actor":{"fieldType":{"type":"string"},"optional":false},"email":{"fieldType":{"type":"string"},"optional":false}}}
adminBilling:grantComplimentary mutation public {"type":"object","value":{"org_id":{"fieldType":{"type":"string"},"optional":false},"months":{"fieldType":{"type":"number"},"optional":false}}}
adminBilling:insertPlan mutation internal {"type":"object","value":{"plan":{"fieldType":{"type":"object","value":{"name":{"fieldType":{"type":"string"},"optional":false},"currency":{"fieldType":{"type":"string"},"optional":false},"seat_price_cents":{"fieldType":{"type":"number"},"optional":false},"minimum_seats":{"fieldType":{"type":"number"},"optional":false},"storage_gb_per_seat":{"fieldType":{"type":"number"},"optional":false},"minimum_storage_gb":{"fieldType":{"type":"number"},"optional":false},"api_calls_per_seat":{"fieldType":{"type":"number"},"optional":false},"storage_block_price_cents":{"fieldType":{"type":"number"},"optional":false},"api_block_price_cents":{"fieldType":{"type":"number"},"optional":false},"api_block_size":{"fieldType":{"type":"number"},"optional":false},"polar_product_id":{"fieldType":{"type":"string"},"optional":true},"api_meter_id":{"fieldType":{"type":"string"},"optional":true},"storage_meter_id":{"fieldType":{"type":"string"},"optional":true}}},"optional":false},"actor":{"fieldType":{"type":"string"},"optional":false},"email":{"fieldType":{"type":"string"},"optional":false}}}
adminBilling:listPlans query public {"type":"object","value":{}}
adminBilling:orgBilling query public {"type":"object","value":{"org_id":{"fieldType":{"type":"string"},"optional":false}}}
adminBilling:setDefaultPlan mutation public {"type":"object","value":{"plan_id":{"fieldType":{"type":"string"},"optional":false}}}
adminDemo:metrics query public {"type":"object","value":{}}
adminOrgs:cancelInvite mutation public {"type":"object","value":{"profile_id":{"fieldType":{"type":"string"},"optional":false}}}
adminOrgs:checkAddress query public {"type":"object","value":{"slug":{"fieldType":{"type":"string"},"optional":false}}}
adminOrgs:checkPeople query public {"type":"object","value":{"org_id":{"fieldType":{"type":"string"},"optional":true},"emails":{"fieldType":{"type":"array","value":{"type":"string"}},"optional":false}}}
adminOrgs:createOrganization action public {"type":"object","value":{"name":{"fieldType":{"type":"string"},"optional":false},"slug":{"fieldType":{"type":"string"},"optional":true},"plan_id":{"fieldType":{"type":"string"},"optional":true},"complimentary_months":{"fieldType":{"type":"number"},"optional":true},"people":{"fieldType":{"type":"array","value":{"type":"object","value":{"name":{"fieldType":{"type":"string"},"optional":false},"email":{"fieldType":{"type":"string"},"optional":false},"role":{"fieldType":{"type":"union","value":[{"type":"literal","value":"admin"},{"type":"literal","value":"user"},{"type":"literal","value":"viewer"}]},"optional":false}}}},"optional":false}}}
adminOrgs:editInvite action public {"type":"object","value":{"profile_id":{"fieldType":{"type":"string"},"optional":false},"name":{"fieldType":{"type":"string"},"optional":false},"email":{"fieldType":{"type":"string"},"optional":false}}}
adminOrgs:insertOrganization mutation internal {"type":"object","value":{"name":{"fieldType":{"type":"string"},"optional":false},"slug":{"fieldType":{"type":"string"},"optional":true},"plan_id":{"fieldType":{"type":"string"},"optional":true},"complimentary_months":{"fieldType":{"type":"number"},"optional":true},"people":{"fieldType":{"type":"array","value":{"type":"object","value":{"name":{"fieldType":{"type":"string"},"optional":false},"email":{"fieldType":{"type":"string"},"optional":false},"role":{"fieldType":{"type":"union","value":[{"type":"literal","value":"admin"},{"type":"literal","value":"user"},{"type":"literal","value":"viewer"}]},"optional":false}}}},"optional":false},"actor":{"fieldType":{"type":"object","value":{"auth_user_id":{"fieldType":{"type":"string"},"optional":false},"email":{"fieldType":{"type":"string"},"optional":false}}},"optional":false}}}
adminOrgs:insertPeople mutation internal {"type":"object","value":{"org_id":{"fieldType":{"type":"string"},"optional":false},"people":{"fieldType":{"type":"array","value":{"type":"object","value":{"name":{"fieldType":{"type":"string"},"optional":false},"email":{"fieldType":{"type":"string"},"optional":false},"role":{"fieldType":{"type":"union","value":[{"type":"literal","value":"admin"},{"type":"literal","value":"user"},{"type":"literal","value":"viewer"}]},"optional":false}}}},"optional":false},"actor":{"fieldType":{"type":"object","value":{"auth_user_id":{"fieldType":{"type":"string"},"optional":false},"email":{"fieldType":{"type":"string"},"optional":false}}},"optional":false}}}
adminOrgs:invitePeople action public {"type":"object","value":{"org_id":{"fieldType":{"type":"string"},"optional":false},"people":{"fieldType":{"type":"array","value":{"type":"object","value":{"name":{"fieldType":{"type":"string"},"optional":false},"email":{"fieldType":{"type":"string"},"optional":false},"role":{"fieldType":{"type":"union","value":[{"type":"literal","value":"admin"},{"type":"literal","value":"user"},{"type":"literal","value":"viewer"}]},"optional":false}}}},"optional":false}}}
adminOrgs:resendInvite action public {"type":"object","value":{"profile_id":{"fieldType":{"type":"string"},"optional":false}}}
adminOrgs:setMemberRole mutation public {"type":"object","value":{"profile_id":{"fieldType":{"type":"string"},"optional":false},"role":{"fieldType":{"type":"union","value":[{"type":"literal","value":"admin"},{"type":"literal","value":"user"},{"type":"literal","value":"viewer"}]},"optional":false}}}
adminOrgs:suggestAddress query public {"type":"object","value":{"name":{"fieldType":{"type":"string"},"optional":false}}}
adminOrgs:updateInvite mutation internal {"type":"object","value":{"profile_id":{"fieldType":{"type":"string"},"optional":false},"name":{"fieldType":{"type":"string"},"optional":false},"email":{"fieldType":{"type":"string"},"optional":false},"actor":{"fieldType":{"type":"object","value":{"auth_user_id":{"fieldType":{"type":"string"},"optional":false},"email":{"fieldType":{"type":"string"},"optional":false}}},"optional":false}}}
adminPeople:detailHead query internal {"type":"object","value":{"org_id":{"fieldType":{"type":"string"},"optional":false}}}
adminPeople:invitePage query internal {"type":"object","value":{"profile_id":{"fieldType":{"type":"string"},"optional":false},"cursor":{"fieldType":{"type":"union","value":[{"type":"string"},{"type":"null"}]},"optional":false}}}
adminPeople:loginPage query internal {"type":"object","value":{"auth_user_ids":{"fieldType":{"type":"array","value":{"type":"string"}},"optional":false}}}
adminPeople:memberPage query internal {"type":"object","value":{"org_id":{"fieldType":{"type":"string"},"optional":false},"cursor":{"fieldType":{"type":"union","value":[{"type":"string"},{"type":"null"}]},"optional":false}}}
adminPeople:orgDetail action public {"type":"object","value":{"org_id":{"fieldType":{"type":"string"},"optional":false}}}
adminPeople:profilePage query internal {"type":"object","value":{"cursor":{"fieldType":{"type":"union","value":[{"type":"string"},{"type":"null"}]},"optional":false},"size":{"fieldType":{"type":"number"},"optional":true}}}
adminPeople:teamCountPage query internal {"type":"object","value":{"team_id":{"fieldType":{"type":"string"},"optional":false},"child":{"fieldType":{"type":"union","value":[{"type":"literal","value":"members"},{"type":"literal","value":"projects"}]},"optional":false},"cursor":{"fieldType":{"type":"union","value":[{"type":"string"},{"type":"null"}]},"optional":false}}}
adminPeople:teamPage query internal {"type":"object","value":{"org_id":{"fieldType":{"type":"string"},"optional":false},"cursor":{"fieldType":{"type":"union","value":[{"type":"string"},{"type":"null"}]},"optional":false}}}
adminPeople:userPage action public {"type":"object","value":{"search":{"fieldType":{"type":"string"},"optional":false},"cursor":{"fieldType":{"type":"union","value":[{"type":"string"},{"type":"null"}]},"optional":false}}}
adminStats:childPage query internal {"type":"object","value":{"table":{"fieldType":{"type":"union","value":[{"type":"literal","value":"team_members"},{"type":"literal","value":"project_access"},{"type":"literal","value":"project_team_access"},{"type":"literal","value":"milestones"},{"type":"literal","value":"issue_links"}]},"optional":false},"parent_id":{"fieldType":{"type":"string"},"optional":false},"cursor":{"fieldType":{"type":"union","value":[{"type":"string"},{"type":"null"}]},"optional":false}}}
adminStats:listOrgs action public {"type":"object","value":{}}
adminStats:orgHead query internal {"type":"object","value":{"org_id":{"fieldType":{"type":"string"},"optional":false}}}
adminStats:orgNames action public {"type":"object","value":{}}
adminStats:orgPage query internal {"type":"object","value":{"cursor":{"fieldType":{"type":"union","value":[{"type":"string"},{"type":"null"}]},"optional":false}}}
adminStats:orgPart query internal {"type":"object","value":{"org_id":{"fieldType":{"type":"string"},"optional":false},"part":{"fieldType":{"type":"union","value":[{"type":"literal","value":"profiles"},{"type":"literal","value":"stamps"},{"type":"literal","value":"teams"},{"type":"literal","value":"projects"},{"type":"literal","value":"issues"},{"type":"literal","value":"activity"},{"type":"literal","value":"deleted"}]},"optional":false},"cursor":{"fieldType":{"type":"union","value":[{"type":"string"},{"type":"null"}]},"optional":false}}}
adminStats:platformStats action public {"type":"object","value":{}}
adminStats:tablePage query internal {"type":"object","value":{"table":{"fieldType":{"type":"union","value":[{"type":"literal","value":"organizations"},{"type":"literal","value":"profiles"},{"type":"literal","value":"teams"},{"type":"literal","value":"projects"},{"type":"literal","value":"issues"},{"type":"literal","value":"activity_events"},{"type":"literal","value":"team_members"},{"type":"literal","value":"project_access"},{"type":"literal","value":"project_team_access"},{"type":"literal","value":"issue_links"},{"type":"literal","value":"milestones"},{"type":"literal","value":"org_counters"},{"type":"literal","value":"sync_stamps"},{"type":"literal","value":"deleted_rows"}]},"optional":false},"cursor":{"fieldType":{"type":"union","value":[{"type":"string"},{"type":"null"}]},"optional":false},"window":{"fieldType":{"type":"object","value":{"cutoff30":{"fieldType":{"type":"string"},"optional":false},"cutoff84":{"fieldType":{"type":"string"},"optional":false}}},"optional":true}}}
apiAccess:page query public {"type":"object","value":{"period":{"fieldType":{"type":"string"},"optional":true},"kind":{"fieldType":{"type":"union","value":[{"type":"literal","value":"all"},{"type":"literal","value":"agent_keys"},{"type":"literal","value":"mcp_tokens"},{"type":"literal","value":"oauth_connections"}]},"optional":false},"state":{"fieldType":{"type":"union","value":[{"type":"literal","value":"all"},{"type":"literal","value":"active"}]},"optional":false},"person":{"fieldType":{"type":"string"},"optional":true},"search":{"fieldType":{"type":"string"},"optional":true},"cursor":{"fieldType":{"type":"string"},"optional":true},"org_id":{"fieldType":{"type":"string"},"optional":false}}}
apiAccess:people query public {"type":"object","value":{"search":{"fieldType":{"type":"string"},"optional":true},"cursor":{"fieldType":{"type":"string"},"optional":true},"org_id":{"fieldType":{"type":"string"},"optional":false}}}
apiAccess:revoke mutation public {"type":"object","value":{"table":{"fieldType":{"type":"union","value":[{"type":"literal","value":"agent_keys"},{"type":"literal","value":"mcp_tokens"},{"type":"literal","value":"oauth_connections"}]},"optional":false},"id":{"fieldType":{"type":"string"},"optional":false},"org_id":{"fieldType":{"type":"string"},"optional":false}}}
apiAccess:summary query public {"type":"object","value":{"period":{"fieldType":{"type":"string"},"optional":true},"org_id":{"fieldType":{"type":"string"},"optional":false}}}
appearance:beginDemoUploadWork mutation internal {"type":"object","value":{"id":{"fieldType":{"type":"string"},"optional":false},"minter":{"fieldType":{"type":"string"},"optional":false}}}
appearance:cancelUpload mutation public {"type":"object","value":{"ticket_id":{"fieldType":{"type":"string"},"optional":false}}}
appearance:clearForDeletedLogin mutation internal {"type":"object","value":{"auth_user_id":{"fieldType":{"type":"string"},"optional":false}}}
appearance:createUpload mutation public {"type":"object","value":{"name":{"fieldType":{"type":"string"},"optional":false}}}
appearance:dailyImage query public {"type":"object","value":{"date":{"fieldType":{"type":"string"},"optional":false}}}
appearance:discardUpload mutation internal {"type":"object","value":{"storage_id":{"fieldType":{"type":"id","tableName":"_storage"},"optional":false}}}
appearance:finalizeUpload mutation internal {"type":"object","value":{"ticket_id":{"fieldType":{"type":"string"},"optional":false},"minter":{"fieldType":{"type":"string"},"optional":false},"storage_id":{"fieldType":{"type":"id","tableName":"_storage"},"optional":false},"width":{"fieldType":{"type":"number"},"optional":false},"height":{"fieldType":{"type":"number"},"optional":false}}}
appearance:gatewayCustom query internal {"type":"object","value":{"id":{"fieldType":{"type":"string"},"optional":false},"minter":{"fieldType":{"type":"string"},"optional":false},"preview":{"fieldType":{"type":"boolean"},"optional":true}}}
appearance:get query public {"type":"object","value":{}}
appearance:mintCustomUrl query public {"type":"object","value":{}}
appearance:publicCanvas query internal {"type":"object","value":{"date":{"fieldType":{"type":"string"},"optional":false}}}
appearance:removeCustom mutation public {"type":"object","value":{}}
appearance:save mutation public {"type":"object","value":{"mode":{"fieldType":{"type":"union","value":[{"type":"literal","value":"dark"},{"type":"literal","value":"light"},{"type":"literal","value":"blue"}]},"optional":false},"image_source":{"fieldType":{"type":"union","value":[{"type":"literal","value":"daily"},{"type":"literal","value":"custom"},{"type":"literal","value":"none"}]},"optional":false}}}
appearance:uploadContext query internal {"type":"object","value":{"id":{"fieldType":{"type":"string"},"optional":false},"minter":{"fieldType":{"type":"string"},"optional":false},"exp":{"fieldType":{"type":"number"},"optional":false}}}
archiveMarks:clearTasks mutation internal {"type":"object","value":{"issues":{"fieldType":{"type":"array","value":{"type":"string"}},"optional":false}}}
archiveMarks:markTasks mutation internal {"type":"object","value":{"issues":{"fieldType":{"type":"array","value":{"type":"string"}},"optional":false}}}
auditRetention:expire mutation internal {"type":"object","value":{"cutoff":{"fieldType":{"type":"string"},"optional":true},"deleted":{"fieldType":{"type":"number"},"optional":true}}}
authRetention:expireSessions mutation internal {"type":"object","value":{"cutoff":{"fieldType":{"type":"number"},"optional":true},"deleted":{"fieldType":{"type":"number"},"optional":true}}}
authRetention:expireTokens mutation internal {"type":"object","value":{"cutoff":{"fieldType":{"type":"number"},"optional":true},"deleted":{"fieldType":{"type":"number"},"optional":true}}}
authTriggers:onCreate mutation internal {"type":"object","value":{"doc":{"fieldType":{"type":"any"},"optional":false},"model":{"fieldType":{"type":"string"},"optional":false}}}
authTriggers:onDelete mutation internal {"type":"object","value":{"doc":{"fieldType":{"type":"any"},"optional":false},"model":{"fieldType":{"type":"string"},"optional":false}}}
authTriggers:onExpiredDelete mutation internal {"type":"object","value":{"doc":{"fieldType":{"type":"any"},"optional":false},"model":{"fieldType":{"type":"string"},"optional":false}}}
backgroundPreviewProcessor:generate action internal {"type":"object","value":{"kind":{"fieldType":{"type":"union","value":[{"type":"literal","value":"library"},{"type":"literal","value":"custom"}]},"optional":false},"id":{"fieldType":{"type":"string"},"optional":false},"storage_id":{"fieldType":{"type":"id","tableName":"_storage"},"optional":false},"attempt":{"fieldType":{"type":"number"},"optional":true}}}
backgroundPreviews:attach mutation internal {"type":"object","value":{"kind":{"fieldType":{"type":"union","value":[{"type":"literal","value":"library"},{"type":"literal","value":"custom"}]},"optional":false},"id":{"fieldType":{"type":"string"},"optional":false},"storage_id":{"fieldType":{"type":"id","tableName":"_storage"},"optional":false},"preview_storage_id":{"fieldType":{"type":"id","tableName":"_storage"},"optional":false},"preview_version":{"fieldType":{"type":"number"},"optional":false},"demo_ticket_id":{"fieldType":{"type":"string"},"optional":true}}}
backgroundPreviews:backfill mutation internal {"type":"object","value":{"kind":{"fieldType":{"type":"union","value":[{"type":"literal","value":"library"},{"type":"literal","value":"custom"}]},"optional":false},"cursor":{"fieldType":{"type":"string"},"optional":true}}}
backgroundPreviews:beginDemoWork mutation internal {"type":"object","value":{"kind":{"fieldType":{"type":"union","value":[{"type":"literal","value":"library"},{"type":"literal","value":"custom"}]},"optional":false},"id":{"fieldType":{"type":"string"},"optional":false},"storage_id":{"fieldType":{"type":"id","tableName":"_storage"},"optional":false}}}
backgroundPreviews:source query internal {"type":"object","value":{"kind":{"fieldType":{"type":"union","value":[{"type":"literal","value":"library"},{"type":"literal","value":"custom"}]},"optional":false},"id":{"fieldType":{"type":"string"},"optional":false},"storage_id":{"fieldType":{"type":"id","tableName":"_storage"},"optional":false}}}
billing:adminContext query internal {"type":"object","value":{"org_id":{"fieldType":{"type":"string"},"optional":false}}}
billing:status query public {"type":"object","value":{"org_id":{"fieldType":{"type":"string"},"optional":false}}}
billing:storageNowPage query internal {"type":"object","value":{"org_id":{"fieldType":{"type":"string"},"optional":false},"cursor":{"fieldType":{"type":"union","value":[{"type":"string"},{"type":"null"}]},"optional":false},"size":{"fieldType":{"type":"number"},"optional":true}}}
billing:summary query public {"type":"object","value":{"org_id":{"fieldType":{"type":"string"},"optional":false}}}
billing:usageHead query internal {"type":"object","value":{"org_id":{"fieldType":{"type":"string"},"optional":false}}}
billing:usageReport action public {"type":"object","value":{"org_id":{"fieldType":{"type":"string"},"optional":false}}}
billingActions:cancelSubscription action public {"type":"object","value":{"org_id":{"fieldType":{"type":"string"},"optional":false}}}
billingActions:checkout action public {"type":"object","value":{"org_id":{"fieldType":{"type":"string"},"optional":false}}}
billingActions:clearEndedCheckout mutation internal {"type":"object","value":{"org_id":{"fieldType":{"type":"string"},"optional":false},"checkout_id":{"fieldType":{"type":"string"},"optional":false}}}
billingActions:connectPlan action public {"type":"object","value":{"plan_id":{"fieldType":{"type":"string"},"optional":false},"polar_product_id":{"fieldType":{"type":"string"},"optional":false},"api_meter_id":{"fieldType":{"type":"string"},"optional":false},"storage_meter_id":{"fieldType":{"type":"string"},"optional":false}}}
billingActions:createPlan action public {"type":"object","value":{"plan":{"fieldType":{"type":"object","value":{"name":{"fieldType":{"type":"string"},"optional":false},"currency":{"fieldType":{"type":"string"},"optional":false},"seat_price_cents":{"fieldType":{"type":"number"},"optional":false},"minimum_seats":{"fieldType":{"type":"number"},"optional":false},"storage_gb_per_seat":{"fieldType":{"type":"number"},"optional":false},"minimum_storage_gb":{"fieldType":{"type":"number"},"optional":false},"api_calls_per_seat":{"fieldType":{"type":"number"},"optional":false},"storage_block_price_cents":{"fieldType":{"type":"number"},"optional":false},"api_block_price_cents":{"fieldType":{"type":"number"},"optional":false},"api_block_size":{"fieldType":{"type":"number"},"optional":false},"polar_product_id":{"fieldType":{"type":"string"},"optional":true},"api_meter_id":{"fieldType":{"type":"string"},"optional":true},"storage_meter_id":{"fieldType":{"type":"string"},"optional":true}}},"optional":false}}}
billingActions:finishCheckout mutation internal {"type":"object","value":{"org_id":{"fieldType":{"type":"string"},"optional":false},"token":{"fieldType":{"type":"string"},"optional":false},"checkout_id":{"fieldType":{"type":"string"},"optional":true},"url":{"fieldType":{"type":"string"},"optional":true},"expires_at":{"fieldType":{"type":"string"},"optional":true}}}
billingActions:planForOperator query internal {"type":"object","value":{"plan_id":{"fieldType":{"type":"string"},"optional":false}}}
billingActions:portal action public {"type":"object","value":{"org_id":{"fieldType":{"type":"string"},"optional":false}}}
billingActions:reserveCheckout mutation internal {"type":"object","value":{"org_id":{"fieldType":{"type":"string"},"optional":false}}}
billingMail:ready query internal {"type":"object","value":{"key":{"fieldType":{"type":"string"},"optional":false}}}
billingMail:send action internal {"type":"object","value":{"to":{"fieldType":{"type":"string"},"optional":false},"url":{"fieldType":{"type":"string"},"optional":false},"until":{"fieldType":{"type":"string"},"optional":false},"notice_key":{"fieldType":{"type":"string"},"optional":false},"attempt":{"fieldType":{"type":"number"},"optional":true}}}
billingMail:sent mutation internal {"type":"object","value":{"key":{"fieldType":{"type":"string"},"optional":false}}}
billingMail:unsent mutation internal {"type":"object","value":{"key":{"fieldType":{"type":"string"},"optional":false},"attempts":{"fieldType":{"type":"number"},"optional":false}}}
billingMetering:ingress mutation internal {"type":"object","value":{"shard":{"fieldType":{"type":"number"},"optional":false}}}
billingMetering:oauthCall mutation internal {"type":"object","value":{"connection_id":{"fieldType":{"type":"string"},"optional":false}}}
billingSync:apply mutation internal {"type":"object","value":{"payload":{"fieldType":{"type":"string"},"optional":false},"event_id":{"fieldType":{"type":"string"},"optional":true}}}
billingSync:claim mutation internal {"type":"object","value":{"org_id":{"fieldType":{"type":"string"},"optional":false}}}
billingSync:claimWebhook mutation internal {"type":"object","value":{"event_id":{"fieldType":{"type":"string"},"optional":false}}}
billingSync:eventReady mutation internal {"type":"object","value":{"id":{"fieldType":{"type":"string"},"optional":false}}}
billingSync:eventResult mutation internal {"type":"object","value":{"id":{"fieldType":{"type":"string"},"optional":false},"success":{"fieldType":{"type":"boolean"},"optional":false}}}
billingSync:pendingEvents query internal {"type":"object","value":{}}
billingSync:processWebhook action internal {"type":"object","value":{"event_id":{"fieldType":{"type":"string"},"optional":false}}}
billingSync:pump action internal {"type":"object","value":{}}
billingSync:receiveWebhook mutation internal {"type":"object","value":{"event_id":{"fieldType":{"type":"string"},"optional":false},"subscription_id":{"fieldType":{"type":"string"},"optional":false}}}
billingSync:reconcile action internal {"type":"object","value":{"org_id":{"fieldType":{"type":"string"},"optional":false}}}
billingSync:release mutation internal {"type":"object","value":{"org_id":{"fieldType":{"type":"string"},"optional":false},"token":{"fieldType":{"type":"string"},"optional":false},"seats":{"fieldType":{"type":"number"},"optional":true},"error":{"fieldType":{"type":"string"},"optional":true}}}
billingSync:remindAdmins mutation internal {"type":"object","value":{"subscription":{"fieldType":{"type":"id","tableName":"billing_subscriptions"},"optional":false},"until":{"fieldType":{"type":"string"},"optional":false},"kind":{"fieldType":{"type":"union","value":[{"type":"literal","value":"seven_days"},{"type":"literal","value":"one_day"},{"type":"literal","value":"expired"}]},"optional":false}}}
billingSync:reminders mutation internal {"type":"object","value":{"now":{"fieldType":{"type":"number"},"optional":false},"lane":{"fieldType":{"type":"union","value":[{"type":"literal","value":"due"},{"type":"literal","value":"unset"}]},"optional":true},"cursor":{"fieldType":{"type":"union","value":[{"type":"string"},{"type":"null"}]},"optional":false},"threshold":{"fieldType":{"type":"number"},"optional":true}}}
billingSync:requestSync mutation internal {"type":"object","value":{"org_id":{"fieldType":{"type":"string"},"optional":false}}}
billingSync:restartStorage mutation internal {"type":"object","value":{"period":{"fieldType":{"type":"id","tableName":"billing_periods"},"optional":false}}}
billingSync:storageStep mutation internal {"type":"object","value":{"period":{"fieldType":{"type":"id","tableName":"billing_periods"},"optional":false},"run":{"fieldType":{"type":"string"},"optional":false},"phase":{"fieldType":{"type":"union","value":[{"type":"literal","value":"own"},{"type":"literal","value":"unscoped"},{"type":"literal","value":"tasks"}]},"optional":true},"cursor":{"fieldType":{"type":"string"},"optional":true},"size":{"fieldType":{"type":"number"},"optional":true},"bytes":{"fieldType":{"type":"number"},"optional":false}}}
billingSync:sweep mutation internal {"type":"object","value":{}}
billingSync:webhookFailed mutation internal {"type":"object","value":{"event_id":{"fieldType":{"type":"string"},"optional":false},"claim":{"fieldType":{"type":"string"},"optional":false},"error":{"fieldType":{"type":"string"},"optional":false},"refused":{"fieldType":{"type":"boolean"},"optional":true}}}
commentLimits:begin mutation internal {"type":"object","value":{"issue_id":{"fieldType":{"type":"string"},"optional":false}}}
commentLimits:recover mutation internal {"type":"object","value":{}}
commentLimits:step mutation internal {"type":"object","value":{"issue_id":{"fieldType":{"type":"string"},"optional":false}}}
commentLimits:sweep mutation internal {"type":"object","value":{}}
comments:countThread mutation public {"type":"object","value":{"issue_id":{"fieldType":{"type":"string"},"optional":false},"org_id":{"fieldType":{"type":"string"},"optional":false}}}
comments:create mutation public {"type":"object","value":{"id":{"fieldType":{"type":"string"},"optional":false},"issue_id":{"fieldType":{"type":"string"},"optional":false},"body":{"fieldType":{"type":"string"},"optional":false},"org_id":{"fieldType":{"type":"string"},"optional":false}}}
comments:remove mutation public {"type":"object","value":{"id":{"fieldType":{"type":"string"},"optional":false},"expected":{"fieldType":{"type":"object","value":{"body":{"fieldType":{"type":"string"},"optional":false}}},"optional":true},"org_id":{"fieldType":{"type":"string"},"optional":false}}}
comments:update mutation public {"type":"object","value":{"id":{"fieldType":{"type":"string"},"optional":false},"body":{"fieldType":{"type":"string"},"optional":false},"expected":{"fieldType":{"type":"object","value":{"body":{"fieldType":{"type":"string"},"optional":false}}},"optional":true},"org_id":{"fieldType":{"type":"string"},"optional":false}}}
deletedItems:detachArchived mutation internal {"type":"object","value":{"job_id":{"fieldType":{"type":"id","tableName":"archived_detaches"},"optional":false}}}
deletedItems:expire mutation internal {"type":"object","value":{"cursor":{"fieldType":{"type":"string"},"optional":true},"now":{"fieldType":{"type":"number"},"optional":true}}}
deletedItems:item query public {"type":"object","value":{"id":{"fieldType":{"type":"string"},"optional":false}}}
deletedItems:list query public {"type":"object","value":{"deleted_by":{"fieldType":{"type":"string"},"optional":true}}}
deletedItems:matches query public {"type":"object","value":{"text":{"fieldType":{"type":"string"},"optional":false}}}
deletedItems:purge mutation public {"type":"object","value":{"ids":{"fieldType":{"type":"array","value":{"type":"string"}},"optional":false},"org_id":{"fieldType":{"type":"string"},"optional":false}}}
deletedItems:purgeOrg mutation internal {"type":"object","value":{"org_id":{"fieldType":{"type":"string"},"optional":false}}}
deletedItems:purgeTasks mutation internal {"type":"object","value":{"task_ids":{"fieldType":{"type":"array","value":{"type":"string"}},"optional":false}}}
deletedItems:recover mutation internal {"type":"object","value":{}}
deletedItems:restore mutation public {"type":"object","value":{"ids":{"fieldType":{"type":"array","value":{"type":"string"}},"optional":false},"bulk":{"fieldType":{"type":"boolean"},"optional":true},"org_id":{"fieldType":{"type":"string"},"optional":false}}}
deletedItems:step mutation internal {"type":"object","value":{"item_id":{"fieldType":{"type":"string"},"optional":false}}}
demo:configuration query public {"type":"object","value":{}}
demo:current query public {"type":"object","value":{}}
demo:ensureMine mutation public {"type":"object","value":{}}
demo:expire mutation internal {"type":"object","value":{"id":{"fieldType":{"type":"string"},"optional":false}}}
demo:tokenDeadline query internal {"type":"object","value":{"auth_user_id":{"fieldType":{"type":"string"},"optional":false}}}
demoReporting:publish action internal {"type":"object","value":{}}
demoReporting:receive mutation internal {"type":"object","value":{"payload":{"fieldType":{"type":"string"},"optional":false}}}
demoUploads:abandon mutation internal {"type":"object","value":{"id":{"fieldType":{"type":"string"},"optional":false},"minter":{"fieldType":{"type":"string"},"optional":false},"storage_id":{"fieldType":{"type":"id","tableName":"_storage"},"optional":true}}}
demoUploads:admit mutation internal {"type":"object","value":{}}
demoUploads:begin mutation internal {"type":"object","value":{"id":{"fieldType":{"type":"string"},"optional":false},"minter":{"fieldType":{"type":"string"},"optional":false},"exp":{"fieldType":{"type":"number"},"optional":false}}}
demoUploads:finish mutation internal {"type":"object","value":{"id":{"fieldType":{"type":"string"},"optional":false},"minter":{"fieldType":{"type":"string"},"optional":false},"storage_id":{"fieldType":{"type":"id","tableName":"_storage"},"optional":false}}}
demoUploads:sweep mutation internal {"type":"object","value":{"cursor":{"fieldType":{"type":"string"},"optional":true},"after":{"fieldType":{"type":"number"},"optional":true}}}
demoVisitor:record mutation internal {"type":"object","value":{"auth_user_id":{"fieldType":{"type":"string"},"optional":false},"browser":{"fieldType":{"type":"string"},"optional":false},"os":{"fieldType":{"type":"string"},"optional":false}}}
files:attach mutation public {"type":"object","value":{"id":{"fieldType":{"type":"string"},"optional":false},"issue_id":{"fieldType":{"type":"string"},"optional":false},"storage_id":{"fieldType":{"type":"id","tableName":"_storage"},"optional":false},"name":{"fieldType":{"type":"string"},"optional":false},"mime":{"fieldType":{"type":"string"},"optional":true},"inline":{"fieldType":{"type":"boolean"},"optional":false},"org_id":{"fieldType":{"type":"string"},"optional":false}}}
files:avatarUploadUrl mutation public {"type":"object","value":{"profile_id":{"fieldType":{"type":"string"},"optional":false}}}
files:clearAvatar mutation public {"type":"object","value":{"profile_id":{"fieldType":{"type":"string"},"optional":false},"expected":{"fieldType":{"type":"object","value":{"avatar_storage_id":{"fieldType":{"type":"union","value":[{"type":"string"},{"type":"null"}]},"optional":false}}},"optional":true}}}
files:eraseHeldFile mutation internal {"type":"object","value":{"storage_id":{"fieldType":{"type":"id","tableName":"_storage"},"optional":false}}}
files:eraseHeldFiles mutation internal {"type":"object","value":{"now":{"fieldType":{"type":"number"},"optional":true},"counts":{"fieldType":{"type":"object","value":{"erased":{"fieldType":{"type":"number"},"optional":false},"kept":{"fieldType":{"type":"number"},"optional":false}}},"optional":true}}}
files:gatewayAttachment query internal {"type":"object","value":{"id":{"fieldType":{"type":"string"},"optional":false},"minter":{"fieldType":{"type":"string"},"optional":false}}}
files:gatewayAvatar query internal {"type":"object","value":{"id":{"fieldType":{"type":"string"},"optional":false},"minter":{"fieldType":{"type":"string"},"optional":false}}}
files:mintUrls query public {"type":"object","value":{"attachment_ids":{"fieldType":{"type":"array","value":{"type":"string"}},"optional":true},"profile_ids":{"fieldType":{"type":"array","value":{"type":"string"}},"optional":true},"org_id":{"fieldType":{"type":"string"},"optional":false}}}
files:reapDroppedImage mutation internal {"type":"object","value":{"id":{"fieldType":{"type":"string"},"optional":false}}}
files:reapOrphans mutation internal {"type":"object","value":{"phase":{"fieldType":{"type":"union","value":[{"type":"literal","value":"tickets"},{"type":"literal","value":"accounts"},{"type":"literal","value":"files"}]},"optional":true},"cursor":{"fieldType":{"type":"string"},"optional":true},"now":{"fieldType":{"type":"number"},"optional":true},"counts":{"fieldType":{"type":"object","value":{"deleted":{"fieldType":{"type":"number"},"optional":false},"held":{"fieldType":{"type":"number"},"optional":true},"kept":{"fieldType":{"type":"number"},"optional":false},"tickets":{"fieldType":{"type":"number"},"optional":false},"accounts":{"fieldType":{"type":"number"},"optional":false},"skipped":{"fieldType":{"type":"number"},"optional":true}}},"optional":true},"restored":{"fieldType":{"type":"boolean"},"optional":true},"since":{"fieldType":{"type":"number"},"optional":true}}}
files:removeAttachment mutation public {"type":"object","value":{"id":{"fieldType":{"type":"string"},"optional":false},"org_id":{"fieldType":{"type":"string"},"optional":false}}}
files:restoreWitness mutation internal {"type":"object","value":{}}
files:setAvatar mutation public {"type":"object","value":{"profile_id":{"fieldType":{"type":"string"},"optional":false},"storage_id":{"fieldType":{"type":"id","tableName":"_storage"},"optional":false},"expected":{"fieldType":{"type":"object","value":{"avatar_storage_id":{"fieldType":{"type":"union","value":[{"type":"string"},{"type":"null"}]},"optional":false}}},"optional":true}}}
files:uploadUrl mutation public {"type":"object","value":{"issue_id":{"fieldType":{"type":"string"},"optional":false},"org_id":{"fieldType":{"type":"string"},"optional":false}}}
identity:acceptInvitation mutation public {"type":"object","value":{"profile_id":{"fieldType":{"type":"string"},"optional":false}}}
identity:claimMySeats mutation public {"type":"object","value":{}}
identity:claimSeatsInternal mutation internal {"type":"object","value":{"userId":{"fieldType":{"type":"string"},"optional":false},"email":{"fieldType":{"type":"string"},"optional":false},"emailVerified":{"fieldType":{"type":"boolean"},"optional":false}}}
identity:createOrganization mutation public {"type":"object","value":{"name":{"fieldType":{"type":"string"},"optional":false}}}
identity:whoami query public {"type":"object","value":{}}
inbox:item query public {"type":"object","value":{"issue_id":{"fieldType":{"type":"string"},"optional":false},"org_id":{"fieldType":{"type":"string"},"optional":false}}}
inbox:summary query public {"type":"object","value":{}}
internal/adminAccessReport:check query internal {"type":"object","value":{"phase":{"fieldType":{"type":"union","value":[{"type":"literal","value":"projects"},{"type":"literal","value":"work"},{"type":"literal","value":"machine"}]},"optional":false},"cursor":{"fieldType":{"type":"union","value":[{"type":"string"},{"type":"null"}]},"optional":true},"page_size":{"fieldType":{"type":"number"},"optional":true}}}
internal/adminAccessReport:run action internal {"type":"object","value":{"cursor":{"fieldType":{"type":"union","value":[{"type":"string"},{"type":"null"}]},"optional":true},"page_size":{"fieldType":{"type":"number"},"optional":true}}}
internal/archivedReadsBackfill:audit mutation internal {"type":"object","value":{"tasks":{"fieldType":{"type":"number"},"optional":false},"scheduled":{"fieldType":{"type":"number"},"optional":false},"pages":{"fieldType":{"type":"number"},"optional":false},"done":{"fieldType":{"type":"boolean"},"optional":false},"org_id":{"fieldType":{"type":"union","value":[{"type":"string"},{"type":"null"}]},"optional":false},"cursor":{"fieldType":{"type":"union","value":[{"type":"string"},{"type":"null"}]},"optional":false},"error":{"fieldType":{"type":"string"},"optional":true}}}
internal/archivedReadsBackfill:mark mutation internal {"type":"object","value":{"issues":{"fieldType":{"type":"array","value":{"type":"string"}},"optional":false}}}
internal/archivedReadsBackfill:remaining query internal {"type":"object","value":{"org_id":{"fieldType":{"type":"union","value":[{"type":"string"},{"type":"null"}]},"optional":true},"cursor":{"fieldType":{"type":"union","value":[{"type":"string"},{"type":"null"}]},"optional":true}}}
internal/archivedReadsBackfill:run action internal {"type":"object","value":{"dry_run":{"fieldType":{"type":"boolean"},"optional":false},"org_id":{"fieldType":{"type":"union","value":[{"type":"string"},{"type":"null"}]},"optional":true},"cursor":{"fieldType":{"type":"union","value":[{"type":"string"},{"type":"null"}]},"optional":true}}}
internal/archivedReadsBackfill:scan query internal {"type":"object","value":{"org_id":{"fieldType":{"type":"union","value":[{"type":"string"},{"type":"null"}]},"optional":true},"cursor":{"fieldType":{"type":"union","value":[{"type":"string"},{"type":"null"}]},"optional":true}}}
internal/commentCountsBackfill:audit mutation internal {"type":"object","value":{"counted":{"fieldType":{"type":"number"},"optional":false},"comments":{"fieldType":{"type":"number"},"optional":false},"full":{"fieldType":{"type":"number"},"optional":false},"dropped":{"fieldType":{"type":"number"},"optional":false},"cleared":{"fieldType":{"type":"number"},"optional":false},"cursor":{"fieldType":{"type":"union","value":[{"type":"string"},{"type":"null"}]},"optional":false},"failed":{"fieldType":{"type":"string"},"optional":true}}}
internal/commentCountsBackfill:check query internal {"type":"object","value":{"issue_id":{"fieldType":{"type":"string"},"optional":false},"after":{"fieldType":{"type":"number"},"optional":false}}}
internal/commentCountsBackfill:clearHeld mutation internal {"type":"object","value":{"org_id":{"fieldType":{"type":"string"},"optional":false},"issue_id":{"fieldType":{"type":"string"},"optional":false}}}
internal/commentCountsBackfill:dropRow mutation internal {"type":"object","value":{"org_id":{"fieldType":{"type":"string"},"optional":false},"issue_id":{"fieldType":{"type":"string"},"optional":false}}}
internal/commentCountsBackfill:orgPage query internal {"type":"object","value":{"after":{"fieldType":{"type":"union","value":[{"type":"string"},{"type":"null"}]},"optional":false}}}
internal/commentCountsBackfill:rowPage query internal {"type":"object","value":{"org_id":{"fieldType":{"type":"string"},"optional":false},"after":{"fieldType":{"type":"number"},"optional":false}}}
internal/commentCountsBackfill:run action internal {"type":"object","value":{"dry_run":{"fieldType":{"type":"boolean"},"optional":false},"recount":{"fieldType":{"type":"boolean"},"optional":true},"cursor":{"fieldType":{"type":"string"},"optional":true}}}
internal/commentCountsBackfill:state query internal {"type":"object","value":{"issue_id":{"fieldType":{"type":"string"},"optional":false}}}
internal/commentCountsBackfill:step mutation internal {"type":"object","value":{"issue_id":{"fieldType":{"type":"string"},"optional":false},"restart":{"fieldType":{"type":"boolean"},"optional":false}}}
internal/commentCountsBackfill:taskPage query internal {"type":"object","value":{"org_id":{"fieldType":{"type":"string"},"optional":false},"after":{"fieldType":{"type":"number"},"optional":false}}}
internal/credentialKeysBackfill:audit mutation internal {"type":"object","value":{"agent_keys":{"fieldType":{"type":"number"},"optional":false},"mcp_tokens":{"fieldType":{"type":"number"},"optional":false},"oauth_connections":{"fieldType":{"type":"number"},"optional":false},"orphans":{"fieldType":{"type":"number"},"optional":false}}}
internal/credentialKeysBackfill:fix mutation internal {"type":"object","value":{"ids":{"fieldType":{"type":"array","value":{"type":"union","value":[{"type":"id","tableName":"agent_keys"},{"type":"id","tableName":"mcp_tokens"},{"type":"id","tableName":"oauth_connections"}]}},"optional":false}}}
internal/credentialKeysBackfill:remaining query internal {"type":"object","value":{"table":{"fieldType":{"type":"union","value":[{"type":"literal","value":"agent_keys"},{"type":"literal","value":"mcp_tokens"},{"type":"literal","value":"oauth_connections"}]},"optional":false},"cursor":{"fieldType":{"type":"union","value":[{"type":"string"},{"type":"null"}]},"optional":true}}}
internal/credentialKeysBackfill:run action internal {"type":"object","value":{"dry_run":{"fieldType":{"type":"boolean"},"optional":false},"table":{"fieldType":{"type":"union","value":[{"type":"union","value":[{"type":"literal","value":"agent_keys"},{"type":"literal","value":"mcp_tokens"},{"type":"literal","value":"oauth_connections"}]},{"type":"null"}]},"optional":true},"cursor":{"fieldType":{"type":"union","value":[{"type":"string"},{"type":"null"}]},"optional":true}}}
internal/credentialKeysBackfill:scan query internal {"type":"object","value":{"table":{"fieldType":{"type":"union","value":[{"type":"literal","value":"agent_keys"},{"type":"literal","value":"mcp_tokens"},{"type":"literal","value":"oauth_connections"}]},"optional":false},"cursor":{"fieldType":{"type":"union","value":[{"type":"string"},{"type":"null"}]},"optional":false}}}
internal/demoCleanup:purge mutation internal {"type":"object","value":{"demo_id":{"fieldType":{"type":"string"},"optional":false}}}
internal/demoCleanup:recover mutation internal {"type":"object","value":{}}
internal/demoMetrics:sample mutation internal {"type":"object","value":{}}
internal/demoMetrics:samplePage mutation internal {"type":"object","value":{"run_id":{"fieldType":{"type":"string"},"optional":false},"step":{"fieldType":{"type":"number"},"optional":false}}}
internal/demoMetrics:snapshot query internal {"type":"object","value":{}}
internal/demoTest:expireOwned mutation internal {"type":"object","value":{"auth_user_id":{"fieldType":{"type":"string"},"optional":false},"expected_site_url":{"fieldType":{"type":"string"},"optional":false},"delay_ms":{"fieldType":{"type":"number"},"optional":false}}}
internal/demoTest:inspect query internal {"type":"object","value":{"auth_user_id":{"fieldType":{"type":"string"},"optional":false},"org_id":{"fieldType":{"type":"string"},"optional":true},"expected_site_url":{"fieldType":{"type":"string"},"optional":false}}}
internal/descriptionsBackfill:audit mutation internal {"type":"object","value":{"repair":{"fieldType":{"type":"boolean"},"optional":false},"tasks":{"fieldType":{"type":"number"},"optional":false},"missing":{"fieldType":{"type":"number"},"optional":false},"differ":{"fieldType":{"type":"number"},"optional":false},"duplicates":{"fieldType":{"type":"number"},"optional":false},"orphans":{"fieldType":{"type":"number"},"optional":false},"waiting":{"fieldType":{"type":"number"},"optional":false},"skipped":{"fieldType":{"type":"number"},"optional":false},"done":{"fieldType":{"type":"boolean"},"optional":false},"cursor":{"fieldType":{"type":"union","value":[{"type":"object","value":{"phase":{"fieldType":{"type":"union","value":[{"type":"literal","value":"tasks"},{"type":"literal","value":"rows"}]},"optional":false},"after":{"fieldType":{"type":"number"},"optional":false}}},{"type":"null"}]},"optional":false}}}
internal/descriptionsBackfill:check query internal {"type":"object","value":{"phase":{"fieldType":{"type":"union","value":[{"type":"literal","value":"tasks"},{"type":"literal","value":"rows"}]},"optional":false},"after":{"fieldType":{"type":"number"},"optional":false}}}
internal/descriptionsBackfill:page mutation internal {"type":"object","value":{"phase":{"fieldType":{"type":"union","value":[{"type":"literal","value":"tasks"},{"type":"literal","value":"rows"}]},"optional":false},"after":{"fieldType":{"type":"number"},"optional":false},"repair":{"fieldType":{"type":"boolean"},"optional":false}}}
internal/descriptionsBackfill:run action internal {"type":"object","value":{"dry_run":{"fieldType":{"type":"boolean"},"optional":false},"repair":{"fieldType":{"type":"boolean"},"optional":true},"cursor":{"fieldType":{"type":"object","value":{"phase":{"fieldType":{"type":"union","value":[{"type":"literal","value":"tasks"},{"type":"literal","value":"rows"}]},"optional":false},"after":{"fieldType":{"type":"number"},"optional":false}}},"optional":true}}}
internal/guestOrg:zzGuestOrg mutation internal {"type":"object","value":{}}
internal/inboxItemsBackfill:audit mutation internal {"type":"object","value":{"profiles":{"fieldType":{"type":"number"},"optional":false},"items":{"fieldType":{"type":"number"},"optional":false},"trimmed":{"fieldType":{"type":"number"},"optional":false},"stuck":{"fieldType":{"type":"number"},"optional":false},"orphan_rows":{"fieldType":{"type":"number"},"optional":false},"rebuild":{"fieldType":{"type":"boolean"},"optional":false},"cursor":{"fieldType":{"type":"union","value":[{"type":"string"},{"type":"null"}]},"optional":false},"error":{"fieldType":{"type":"string"},"optional":true}}}
internal/inboxItemsBackfill:check query internal {"type":"object","value":{"profile_id":{"fieldType":{"type":"string"},"optional":false},"after":{"fieldType":{"type":"string"},"optional":true}}}
internal/inboxItemsBackfill:orphansDeleted mutation internal {"type":"object","value":{"table":{"fieldType":{"type":"union","value":[{"type":"literal","value":"inbox_items"},{"type":"literal","value":"inbox_state"}]},"optional":false},"after":{"fieldType":{"type":"union","value":[{"type":"string"},{"type":"null"}]},"optional":false},"at":{"fieldType":{"type":"union","value":[{"type":"object","value":{"id":{"fieldType":{"type":"string"},"optional":false},"from":{"fieldType":{"type":"string"},"optional":true}}},{"type":"null"}]},"optional":false}}}
internal/inboxItemsBackfill:orphansFound query internal {"type":"object","value":{"table":{"fieldType":{"type":"union","value":[{"type":"literal","value":"inbox_items"},{"type":"literal","value":"inbox_state"}]},"optional":false},"after":{"fieldType":{"type":"union","value":[{"type":"string"},{"type":"null"}]},"optional":false},"at":{"fieldType":{"type":"union","value":[{"type":"object","value":{"id":{"fieldType":{"type":"string"},"optional":false},"from":{"fieldType":{"type":"string"},"optional":true}}},{"type":"null"}]},"optional":false}}}
internal/inboxItemsBackfill:profilePage query internal {"type":"object","value":{"after":{"fieldType":{"type":"union","value":[{"type":"string"},{"type":"null"}]},"optional":false}}}
internal/inboxItemsBackfill:profileState query internal {"type":"object","value":{"profile_id":{"fieldType":{"type":"string"},"optional":false}}}
internal/inboxItemsBackfill:remaining query internal {"type":"object","value":{"cursor":{"fieldType":{"type":"union","value":[{"type":"string"},{"type":"null"}]},"optional":true}}}
internal/inboxItemsBackfill:reset mutation internal {"type":"object","value":{"profile_id":{"fieldType":{"type":"string"},"optional":false}}}
internal/inboxItemsBackfill:run action internal {"type":"object","value":{"dry_run":{"fieldType":{"type":"boolean"},"optional":false},"rebuild":{"fieldType":{"type":"boolean"},"optional":true},"cursor":{"fieldType":{"type":"union","value":[{"type":"string"},{"type":"null"}]},"optional":true}}}
internal/inboxItemsBackfill:step mutation internal {"type":"object","value":{"profile_id":{"fieldType":{"type":"string"},"optional":false}}}
internal/labelCountsBackfill:audit mutation internal {"type":"object","value":{"counted":{"fieldType":{"type":"number"},"optional":false},"labels":{"fieldType":{"type":"number"},"optional":false},"tasks":{"fieldType":{"type":"number"},"optional":false},"uses":{"fieldType":{"type":"number"},"optional":false},"orphans":{"fieldType":{"type":"number"},"optional":false},"cursor":{"fieldType":{"type":"union","value":[{"type":"union","value":[{"type":"object","value":{"table":{"fieldType":{"type":"literal","value":"organizations"},"optional":false},"cursor":{"fieldType":{"type":"union","value":[{"type":"string"},{"type":"null"}]},"optional":false},"org":{"fieldType":{"type":"object","value":{"id":{"fieldType":{"type":"string"},"optional":false},"due":{"fieldType":{"type":"string"},"optional":true},"reset":{"fieldType":{"type":"union","value":[{"type":"string"},{"type":"null"}]},"optional":true}}},"optional":true}}},{"type":"object","value":{"table":{"fieldType":{"type":"union","value":[{"type":"literal","value":"label_counts"},{"type":"literal","value":"label_count_runs"}]},"optional":false},"cursor":{"fieldType":{"type":"union","value":[{"type":"string"},{"type":"null"}]},"optional":false}}}]},{"type":"null"}]},"optional":false},"error":{"fieldType":{"type":"string"},"optional":true}}}
internal/labelCountsBackfill:check query internal {"type":"object","value":{"org_id":{"fieldType":{"type":"string"},"optional":false},"after":{"fieldType":{"type":"number"},"optional":false}}}
internal/labelCountsBackfill:labelPage query internal {"type":"object","value":{"org_id":{"fieldType":{"type":"string"},"optional":false},"cursor":{"fieldType":{"type":"union","value":[{"type":"string"},{"type":"null"}]},"optional":false}}}
internal/labelCountsBackfill:orgPage query internal {"type":"object","value":{"cursor":{"fieldType":{"type":"union","value":[{"type":"string"},{"type":"null"}]},"optional":false}}}
internal/labelCountsBackfill:orphans mutation internal {"type":"object","value":{"table":{"fieldType":{"type":"union","value":[{"type":"literal","value":"label_counts"},{"type":"literal","value":"label_count_runs"}]},"optional":false},"dry_run":{"fieldType":{"type":"boolean"},"optional":false},"cursor":{"fieldType":{"type":"union","value":[{"type":"string"},{"type":"null"}]},"optional":false}}}
internal/labelCountsBackfill:run action internal {"type":"object","value":{"dry_run":{"fieldType":{"type":"boolean"},"optional":false},"recount":{"fieldType":{"type":"boolean"},"optional":true},"cursor":{"fieldType":{"type":"union","value":[{"type":"object","value":{"table":{"fieldType":{"type":"literal","value":"organizations"},"optional":false},"cursor":{"fieldType":{"type":"union","value":[{"type":"string"},{"type":"null"}]},"optional":false},"org":{"fieldType":{"type":"object","value":{"id":{"fieldType":{"type":"string"},"optional":false},"due":{"fieldType":{"type":"string"},"optional":true},"reset":{"fieldType":{"type":"union","value":[{"type":"string"},{"type":"null"}]},"optional":true}}},"optional":true}}},{"type":"object","value":{"table":{"fieldType":{"type":"union","value":[{"type":"literal","value":"label_counts"},{"type":"literal","value":"label_count_runs"}]},"optional":false},"cursor":{"fieldType":{"type":"union","value":[{"type":"string"},{"type":"null"}]},"optional":false}}}]},"optional":true}}}
internal/labelCountsBackfill:step mutation internal {"type":"object","value":{"org_id":{"fieldType":{"type":"string"},"optional":false},"cursor":{"fieldType":{"type":"union","value":[{"type":"string"},{"type":"null"}]},"optional":false},"restart":{"fieldType":{"type":"boolean"},"optional":true}}}
internal/legacyIconsBackfill:audit mutation internal {"type":"object","value":{"projects":{"fieldType":{"type":"number"},"optional":false},"teams":{"fieldType":{"type":"number"},"optional":false},"deleted_projects":{"fieldType":{"type":"number"},"optional":false},"done":{"fieldType":{"type":"boolean"},"optional":false},"cursor":{"fieldType":{"type":"union","value":[{"type":"object","value":{"dry_run":{"fieldType":{"type":"boolean"},"optional":false},"phase":{"fieldType":{"type":"union","value":[{"type":"literal","value":"projects"},{"type":"literal","value":"teams"},{"type":"literal","value":"deleted_projects"}]},"optional":false},"cursor":{"fieldType":{"type":"union","value":[{"type":"string"},{"type":"null"}]},"optional":false}}},{"type":"null"}]},"optional":false},"error":{"fieldType":{"type":"string"},"optional":true}}}
internal/legacyIconsBackfill:check query internal {"type":"object","value":{"phase":{"fieldType":{"type":"union","value":[{"type":"literal","value":"projects"},{"type":"literal","value":"teams"},{"type":"literal","value":"deleted_projects"}]},"optional":false},"cursor":{"fieldType":{"type":"union","value":[{"type":"string"},{"type":"null"}]},"optional":true}}}
internal/legacyIconsBackfill:page mutation internal {"type":"object","value":{"phase":{"fieldType":{"type":"union","value":[{"type":"literal","value":"projects"},{"type":"literal","value":"teams"},{"type":"literal","value":"deleted_projects"}]},"optional":false},"cursor":{"fieldType":{"type":"union","value":[{"type":"string"},{"type":"null"}]},"optional":false}}}
internal/legacyIconsBackfill:run action internal {"type":"object","value":{"dry_run":{"fieldType":{"type":"boolean"},"optional":false},"cursor":{"fieldType":{"type":"object","value":{"dry_run":{"fieldType":{"type":"boolean"},"optional":false},"phase":{"fieldType":{"type":"union","value":[{"type":"literal","value":"projects"},{"type":"literal","value":"teams"},{"type":"literal","value":"deleted_projects"}]},"optional":false},"cursor":{"fieldType":{"type":"union","value":[{"type":"string"},{"type":"null"}]},"optional":false}}},"optional":true}}}
internal/liveCountsBackfill:audit mutation internal {"type":"object","value":{"counted":{"fieldType":{"type":"number"},"optional":false},"active_tasks":{"fieldType":{"type":"number"},"optional":false},"live_projects":{"fieldType":{"type":"number"},"optional":false}}}
internal/liveCountsBackfill:check query internal {"type":"object","value":{"org_id":{"fieldType":{"type":"string"},"optional":false},"table":{"fieldType":{"type":"union","value":[{"type":"literal","value":"issues"},{"type":"literal","value":"projects"}]},"optional":false},"after":{"fieldType":{"type":"number"},"optional":false}}}
internal/liveCountsBackfill:orgPage query internal {"type":"object","value":{"cursor":{"fieldType":{"type":"union","value":[{"type":"string"},{"type":"null"}]},"optional":false}}}
internal/liveCountsBackfill:run action internal {"type":"object","value":{"dry_run":{"fieldType":{"type":"boolean"},"optional":false},"recount":{"fieldType":{"type":"boolean"},"optional":true},"cursor":{"fieldType":{"type":"string"},"optional":true}}}
internal/liveCountsBackfill:state query internal {"type":"object","value":{"org_id":{"fieldType":{"type":"string"},"optional":false}}}
internal/liveCountsBackfill:step mutation internal {"type":"object","value":{"org_id":{"fieldType":{"type":"string"},"optional":false},"recount":{"fieldType":{"type":"boolean"},"optional":false}}}
internal/marketingDemo:adoptAvatar mutation internal {"type":"object","value":{"expected_site_url":{"fieldType":{"type":"string"},"optional":false},"person":{"fieldType":{"type":"string"},"optional":false},"storage_id":{"fieldType":{"type":"id","tableName":"_storage"},"optional":false}}}
internal/marketingDemo:apply mutation internal {"type":"object","value":{"expected_site_url":{"fieldType":{"type":"string"},"optional":false},"anchor":{"fieldType":{"type":"string"},"optional":false},"mode":{"fieldType":{"type":"union","value":[{"type":"literal","value":"seed"},{"type":"literal","value":"wipe"}]},"optional":false}}}
internal/marketingDemo:avatarUpload mutation internal {"type":"object","value":{"expected_site_url":{"fieldType":{"type":"string"},"optional":false},"person":{"fieldType":{"type":"string"},"optional":false}}}
internal/marketingDemo:checkReserved query internal {"type":"object","value":{"expected_site_url":{"fieldType":{"type":"string"},"optional":false},"part":{"fieldType":{"type":"number"},"optional":false}}}
internal/marketingDemo:inspect query internal {"type":"object","value":{"expected_site_url":{"fieldType":{"type":"string"},"optional":false}}}
internal/marketingDemo:provision mutation internal {"type":"object","value":{"expected_site_url":{"fieldType":{"type":"string"},"optional":false},"credential_set_id":{"fieldType":{"type":"string"},"optional":false},"password_hashes":{"fieldType":{"type":"record","keys":{"type":"string"},"values":{"fieldType":{"type":"string"},"optional":false}},"optional":false},"sample_avatars":{"fieldType":{"type":"boolean"},"optional":true}}}
internal/marketingDemo:restoreSeat mutation internal {"type":"object","value":{"expected_site_url":{"fieldType":{"type":"string"},"optional":false},"person":{"fieldType":{"type":"string"},"optional":false},"sample_avatar":{"fieldType":{"type":"boolean"},"optional":true}}}
internal/microsoftAccounts:count query internal {"type":"object","value":{"cursor":{"fieldType":{"type":"union","value":[{"type":"string"},{"type":"null"}]},"optional":false}}}
internal/milestoneWeeks:check query internal {"type":"object","value":{"phase":{"fieldType":{"type":"union","value":[{"type":"literal","value":"live"},{"type":"literal","value":"deleted"}]},"optional":false},"cursor":{"fieldType":{"type":"union","value":[{"type":"string"},{"type":"null"}]},"optional":true},"page_size":{"fieldType":{"type":"number"},"optional":true}}}
internal/milestoneWeeks:run action internal {"type":"object","value":{"page_size":{"fieldType":{"type":"number"},"optional":true}}}
internal/nameKeysBackfill:audit mutation internal {"type":"object","value":{"orgs":{"fieldType":{"type":"number"},"optional":false},"stamped":{"fieldType":{"type":"number"},"optional":false},"missing":{"fieldType":{"type":"number"},"optional":false},"stale":{"fieldType":{"type":"number"},"optional":false},"done":{"fieldType":{"type":"boolean"},"optional":false},"cursor":{"fieldType":{"type":"union","value":[{"type":"union","value":[{"type":"object","value":{"dry_run":{"fieldType":{"type":"boolean"},"optional":false},"org_id":{"fieldType":{"type":"string"},"optional":false},"table":{"fieldType":{"type":"union","value":[{"type":"literal","value":"profiles"},{"type":"literal","value":"teams"},{"type":"literal","value":"projects"}]},"optional":false},"page":{"fieldType":{"type":"union","value":[{"type":"string"},{"type":"null"}]},"optional":false}}},{"type":"object","value":{"dry_run":{"fieldType":{"type":"boolean"},"optional":false},"after":{"fieldType":{"type":"string"},"optional":false}}}]},{"type":"null"}]},"optional":false},"error":{"fieldType":{"type":"string"},"optional":true}}}
internal/nameKeysBackfill:check query internal {"type":"object","value":{"org_id":{"fieldType":{"type":"string"},"optional":false},"table":{"fieldType":{"type":"union","value":[{"type":"literal","value":"profiles"},{"type":"literal","value":"teams"},{"type":"literal","value":"projects"}]},"optional":false},"cursor":{"fieldType":{"type":"union","value":[{"type":"string"},{"type":"null"}]},"optional":true}}}
internal/nameKeysBackfill:orgPage query internal {"type":"object","value":{"from":{"fieldType":{"type":"union","value":[{"type":"string"},{"type":"null"}]},"optional":false},"inclusive":{"fieldType":{"type":"boolean"},"optional":false}}}
internal/nameKeysBackfill:run action internal {"type":"object","value":{"dry_run":{"fieldType":{"type":"boolean"},"optional":false},"cursor":{"fieldType":{"type":"union","value":[{"type":"object","value":{"dry_run":{"fieldType":{"type":"boolean"},"optional":false},"org_id":{"fieldType":{"type":"string"},"optional":false},"table":{"fieldType":{"type":"union","value":[{"type":"literal","value":"profiles"},{"type":"literal","value":"teams"},{"type":"literal","value":"projects"}]},"optional":false},"page":{"fieldType":{"type":"union","value":[{"type":"string"},{"type":"null"}]},"optional":false}}},{"type":"object","value":{"dry_run":{"fieldType":{"type":"boolean"},"optional":false},"after":{"fieldType":{"type":"string"},"optional":false}}}]},"optional":true}}}
internal/nameKeysBackfill:stamp mutation internal {"type":"object","value":{"org_id":{"fieldType":{"type":"string"},"optional":false}}}
internal/nameKeysBackfill:step mutation internal {"type":"object","value":{"org_id":{"fieldType":{"type":"string"},"optional":false},"table":{"fieldType":{"type":"union","value":[{"type":"literal","value":"profiles"},{"type":"literal","value":"teams"},{"type":"literal","value":"projects"}]},"optional":false},"cursor":{"fieldType":{"type":"union","value":[{"type":"string"},{"type":"null"}]},"optional":true}}}
internal/navBackfill:audit mutation internal {"type":"object","value":{"stamped":{"fieldType":{"type":"number"},"optional":false},"archive_states":{"fieldType":{"type":"number"},"optional":false},"reach_missing":{"fieldType":{"type":"number"},"optional":false},"reach_extra":{"fieldType":{"type":"number"},"optional":false},"reach_stale":{"fieldType":{"type":"number"},"optional":false},"done":{"fieldType":{"type":"boolean"},"optional":false},"cursor":{"fieldType":{"type":"union","value":[{"type":"union","value":[{"type":"object","value":{"dry_run":{"fieldType":{"type":"boolean"},"optional":false},"table":{"fieldType":{"type":"union","value":[{"type":"literal","value":"projects"},{"type":"literal","value":"project_access"},{"type":"literal","value":"project_team_access"},{"type":"literal","value":"project_reach"}]},"optional":false},"at":{"fieldType":{"type":"union","value":[{"type":"null"},{"type":"object","value":{"after":{"fieldType":{"type":"number"},"optional":false},"seen":{"fieldType":{"type":"array","value":{"type":"string"}},"optional":false}}}]},"optional":false}}},{"type":"object","value":{"dry_run":{"fieldType":{"type":"boolean"},"optional":false},"table":{"fieldType":{"type":"literal","value":"organizations"},"optional":false},"after":{"fieldType":{"type":"union","value":[{"type":"string"},{"type":"null"}]},"optional":false}}}]},{"type":"null"}]},"optional":false},"error":{"fieldType":{"type":"string"},"optional":true}}}
internal/navBackfill:check query internal {"type":"object","value":{"table":{"fieldType":{"type":"union","value":[{"type":"literal","value":"projects"},{"type":"literal","value":"project_access"},{"type":"literal","value":"project_team_access"},{"type":"literal","value":"project_reach"}]},"optional":false},"at":{"fieldType":{"type":"union","value":[{"type":"null"},{"type":"object","value":{"after":{"fieldType":{"type":"number"},"optional":false},"seen":{"fieldType":{"type":"array","value":{"type":"string"}},"optional":false}}}]},"optional":false}}}
internal/navBackfill:orgPage query internal {"type":"object","value":{"after":{"fieldType":{"type":"union","value":[{"type":"string"},{"type":"null"}]},"optional":false}}}
internal/navBackfill:run action internal {"type":"object","value":{"dry_run":{"fieldType":{"type":"boolean"},"optional":false},"cursor":{"fieldType":{"type":"union","value":[{"type":"object","value":{"dry_run":{"fieldType":{"type":"boolean"},"optional":false},"table":{"fieldType":{"type":"union","value":[{"type":"literal","value":"projects"},{"type":"literal","value":"project_access"},{"type":"literal","value":"project_team_access"},{"type":"literal","value":"project_reach"}]},"optional":false},"at":{"fieldType":{"type":"union","value":[{"type":"null"},{"type":"object","value":{"after":{"fieldType":{"type":"number"},"optional":false},"seen":{"fieldType":{"type":"array","value":{"type":"string"}},"optional":false}}}]},"optional":false}}},{"type":"object","value":{"dry_run":{"fieldType":{"type":"boolean"},"optional":false},"table":{"fieldType":{"type":"literal","value":"organizations"},"optional":false},"after":{"fieldType":{"type":"union","value":[{"type":"string"},{"type":"null"}]},"optional":false}}}]},"optional":true}}}
internal/navBackfill:stamp mutation internal {"type":"object","value":{"org_id":{"fieldType":{"type":"string"},"optional":false}}}
internal/navBackfill:step mutation internal {"type":"object","value":{"table":{"fieldType":{"type":"union","value":[{"type":"literal","value":"projects"},{"type":"literal","value":"project_access"},{"type":"literal","value":"project_team_access"},{"type":"literal","value":"project_reach"}]},"optional":false},"at":{"fieldType":{"type":"union","value":[{"type":"null"},{"type":"object","value":{"after":{"fieldType":{"type":"number"},"optional":false},"seen":{"fieldType":{"type":"array","value":{"type":"string"}},"optional":false}}}]},"optional":false}}}
internal/oauthSmoke:cleanup mutation internal {"type":"object","value":{"expected_site_url":{"fieldType":{"type":"string"},"optional":false},"client_id":{"fieldType":{"type":"string"},"optional":false},"client_name":{"fieldType":{"type":"string"},"optional":false}}}
internal/operator:provisionOperator mutation internal {"type":"object","value":{"email":{"fieldType":{"type":"string"},"optional":false},"password_hash":{"fieldType":{"type":"string"},"optional":false}}}
internal/operator:retireLegacyFixtures mutation internal {"type":"object","value":{"expected_site_url":{"fieldType":{"type":"string"},"optional":false},"dry_run":{"fieldType":{"type":"boolean"},"optional":true}}}
internal/operator:testOperator action internal {"type":"object","value":{}}
internal/overCapRows:check query internal {"type":"object","value":{"phase":{"fieldType":{"type":"union","value":[{"type":"literal","value":"projects"},{"type":"literal","value":"teams"},{"type":"literal","value":"milestones"},{"type":"literal","value":"organizations"},{"type":"literal","value":"profiles"},{"type":"literal","value":"agent_keys"},{"type":"literal","value":"mcp_tokens"},{"type":"literal","value":"labels"},{"type":"literal","value":"issue_attachments"},{"type":"literal","value":"issues"},{"type":"literal","value":"comments"},{"type":"literal","value":"emails"},{"type":"literal","value":"deleted_projects"},{"type":"literal","value":"deleted_milestones"},{"type":"literal","value":"deleted_issue_attachments"},{"type":"literal","value":"deleted_issues"},{"type":"literal","value":"deleted_comments"}]},"optional":false},"cursor":{"fieldType":{"type":"union","value":[{"type":"string"},{"type":"null"}]},"optional":true},"page_size":{"fieldType":{"type":"number"},"optional":true}}}
internal/overCapRows:describe mutation internal {"type":"object","value":{"id":{"fieldType":{"type":"id","tableName":"issues"},"optional":false}}}
internal/overCapRows:fix action internal {"type":"object","value":{"dry_run":{"fieldType":{"type":"boolean"},"optional":false},"page_size":{"fieldType":{"type":"number"},"optional":true}}}
internal/overCapRows:page mutation internal {"type":"object","value":{"phase":{"fieldType":{"type":"union","value":[{"type":"literal","value":"projects"},{"type":"literal","value":"teams"},{"type":"literal","value":"milestones"},{"type":"literal","value":"organizations"},{"type":"literal","value":"profiles"},{"type":"literal","value":"agent_keys"},{"type":"literal","value":"mcp_tokens"},{"type":"literal","value":"labels"},{"type":"literal","value":"issue_attachments"},{"type":"literal","value":"issues"},{"type":"literal","value":"comments"},{"type":"literal","value":"emails"},{"type":"literal","value":"deleted_projects"},{"type":"literal","value":"deleted_milestones"},{"type":"literal","value":"deleted_issue_attachments"},{"type":"literal","value":"deleted_issues"},{"type":"literal","value":"deleted_comments"}]},"optional":false},"dry_run":{"fieldType":{"type":"boolean"},"optional":false},"cursor":{"fieldType":{"type":"union","value":[{"type":"string"},{"type":"null"}]},"optional":false},"page_size":{"fieldType":{"type":"number"},"optional":true}}}
internal/storageTotalsBackfill:audit mutation internal {"type":"object","value":{"counted":{"fieldType":{"type":"number"},"optional":false},"bytes":{"fieldType":{"type":"number"},"optional":false},"files":{"fieldType":{"type":"number"},"optional":false},"strays":{"fieldType":{"type":"number"},"optional":false},"error":{"fieldType":{"type":"string"},"optional":true}}}
internal/storageTotalsBackfill:check query internal {"type":"object","value":{"org_id":{"fieldType":{"type":"string"},"optional":false},"after":{"fieldType":{"type":"number"},"optional":false}}}
internal/storageTotalsBackfill:clearStray mutation internal {"type":"object","value":{"org_id":{"fieldType":{"type":"string"},"optional":false}}}
internal/storageTotalsBackfill:orgPage query internal {"type":"object","value":{"after":{"fieldType":{"type":"union","value":[{"type":"string"},{"type":"null"}]},"optional":false}}}
internal/storageTotalsBackfill:orphanPage query internal {"type":"object","value":{"org_id":{"fieldType":{"type":"string"},"optional":false},"stored":{"fieldType":{"type":"boolean"},"optional":false},"cursor":{"fieldType":{"type":"union","value":[{"type":"string"},{"type":"null"}]},"optional":false},"size":{"fieldType":{"type":"number"},"optional":false}}}
internal/storageTotalsBackfill:projectRows query internal {"type":"object","value":{"org_id":{"fieldType":{"type":"string"},"optional":false},"cursor":{"fieldType":{"type":"union","value":[{"type":"string"},{"type":"null"}]},"optional":false}}}
internal/storageTotalsBackfill:run action internal {"type":"object","value":{"dry_run":{"fieldType":{"type":"boolean"},"optional":false},"recount":{"fieldType":{"type":"boolean"},"optional":true},"cursor":{"fieldType":{"type":"string"},"optional":true}}}
internal/storageTotalsBackfill:state query internal {"type":"object","value":{"org_id":{"fieldType":{"type":"string"},"optional":false}}}
internal/storageTotalsBackfill:step mutation internal {"type":"object","value":{"org_id":{"fieldType":{"type":"string"},"optional":false},"recount":{"fieldType":{"type":"boolean"},"optional":false},"run":{"fieldType":{"type":"string"},"optional":false}}}
internal/storageTotalsBackfill:totalsPage query internal {"type":"object","value":{"after":{"fieldType":{"type":"union","value":[{"type":"string"},{"type":"null"}]},"optional":false}}}
internal/storedGrantees:backfill action internal {"type":"object","value":{"dry_run":{"fieldType":{"type":"boolean"},"optional":false},"page_size":{"fieldType":{"type":"number"},"optional":true}}}
internal/storedGrantees:page mutation internal {"type":"object","value":{"table":{"fieldType":{"type":"union","value":[{"type":"literal","value":"project_access"},{"type":"literal","value":"project_team_access"}]},"optional":false},"dry_run":{"fieldType":{"type":"boolean"},"optional":false},"cursor":{"fieldType":{"type":"union","value":[{"type":"string"},{"type":"null"}]},"optional":false},"page_size":{"fieldType":{"type":"number"},"optional":true}}}
internal/teamCountsBackfill:audit mutation internal {"type":"object","value":{"counted":{"fieldType":{"type":"number"},"optional":false},"members":{"fieldType":{"type":"number"},"optional":false},"orphans":{"fieldType":{"type":"number"},"optional":false},"cursor":{"fieldType":{"type":"union","value":[{"type":"union","value":[{"type":"object","value":{"table":{"fieldType":{"type":"literal","value":"teams"},"optional":false},"cursor":{"fieldType":{"type":"union","value":[{"type":"string"},{"type":"null"}]},"optional":false},"team":{"fieldType":{"type":"object","value":{"id":{"fieldType":{"type":"string"},"optional":false},"started":{"fieldType":{"type":"literal","value":true},"optional":true}}},"optional":true}}},{"type":"object","value":{"table":{"fieldType":{"type":"literal","value":"team_counts"},"optional":false},"cursor":{"fieldType":{"type":"union","value":[{"type":"string"},{"type":"null"}]},"optional":false}}}]},{"type":"null"}]},"optional":false},"error":{"fieldType":{"type":"string"},"optional":true}}}
internal/teamCountsBackfill:check query internal {"type":"object","value":{"team_id":{"fieldType":{"type":"string"},"optional":false},"after":{"fieldType":{"type":"number"},"optional":false}}}
internal/teamCountsBackfill:orphans mutation internal {"type":"object","value":{"dry_run":{"fieldType":{"type":"boolean"},"optional":false},"cursor":{"fieldType":{"type":"union","value":[{"type":"string"},{"type":"null"}]},"optional":false}}}
internal/teamCountsBackfill:run action internal {"type":"object","value":{"dry_run":{"fieldType":{"type":"boolean"},"optional":false},"recount":{"fieldType":{"type":"boolean"},"optional":true},"cursor":{"fieldType":{"type":"union","value":[{"type":"object","value":{"table":{"fieldType":{"type":"literal","value":"teams"},"optional":false},"cursor":{"fieldType":{"type":"union","value":[{"type":"string"},{"type":"null"}]},"optional":false},"team":{"fieldType":{"type":"object","value":{"id":{"fieldType":{"type":"string"},"optional":false},"started":{"fieldType":{"type":"literal","value":true},"optional":true}}},"optional":true}}},{"type":"object","value":{"table":{"fieldType":{"type":"literal","value":"team_counts"},"optional":false},"cursor":{"fieldType":{"type":"union","value":[{"type":"string"},{"type":"null"}]},"optional":false}}}]},"optional":true}}}
internal/teamCountsBackfill:state query internal {"type":"object","value":{"team_id":{"fieldType":{"type":"string"},"optional":false}}}
internal/teamCountsBackfill:step mutation internal {"type":"object","value":{"team_id":{"fieldType":{"type":"string"},"optional":false},"restart":{"fieldType":{"type":"boolean"},"optional":true}}}
internal/teamCountsBackfill:teamPage query internal {"type":"object","value":{"cursor":{"fieldType":{"type":"union","value":[{"type":"string"},{"type":"null"}]},"optional":false}}}
internal/usageRanksBackfill:accountsPage query internal {"type":"object","value":{"org_id":{"fieldType":{"type":"string"},"optional":false},"period":{"fieldType":{"type":"string"},"optional":false},"after":{"fieldType":{"type":"union","value":[{"type":"string"},{"type":"null"}]},"optional":false}}}
internal/usageRanksBackfill:audit mutation internal {"type":"object","value":{"rows":{"fieldType":{"type":"number"},"optional":false},"calls":{"fieldType":{"type":"number"},"optional":false}}}
internal/usageRanksBackfill:bucketState query internal {"type":"object","value":{"org_id":{"fieldType":{"type":"string"},"optional":false},"period":{"fieldType":{"type":"string"},"optional":false}}}
internal/usageRanksBackfill:check action internal {"type":"object","value":{"cursor":{"fieldType":{"type":"union","value":[{"type":"object","value":{"after_org":{"fieldType":{"type":"union","value":[{"type":"string"},{"type":"null"}]},"optional":false},"org":{"fieldType":{"type":"union","value":[{"type":"string"},{"type":"null"}]},"optional":false},"period":{"fieldType":{"type":"union","value":[{"type":"string"},{"type":"null"}]},"optional":false},"bucket":{"fieldType":{"type":"union","value":[{"type":"null"},{"type":"object","value":{"period":{"fieldType":{"type":"string"},"optional":false},"start":{"fieldType":{"type":"union","value":[{"type":"object","value":{"ranked":{"fieldType":{"type":"boolean"},"optional":false},"total":{"fieldType":{"type":"union","value":[{"type":"number"},{"type":"null"}]},"optional":false},"revision":{"fieldType":{"type":"number"},"optional":false},"month_total_row":{"fieldType":{"type":"boolean"},"optional":false}}},{"type":"null"}]},"optional":false},"rows_cursor":{"fieldType":{"type":"union","value":[{"type":"string"},{"type":"null"}]},"optional":false},"rows_calls":{"fieldType":{"type":"number"},"optional":false},"rows_done":{"fieldType":{"type":"boolean"},"optional":false},"accounts_after":{"fieldType":{"type":"union","value":[{"type":"string"},{"type":"null"}]},"optional":false},"accounts_calls":{"fieldType":{"type":"number"},"optional":false},"accounts_done":{"fieldType":{"type":"boolean"},"optional":false}}}]},"optional":false},"gone":{"fieldType":{"type":"union","value":[{"type":"null"},{"type":"object","value":{"table":{"fieldType":{"type":"union","value":[{"type":"literal","value":"billing_usage_accounts"},{"type":"literal","value":"billing_month_totals"}]},"optional":false},"after":{"fieldType":{"type":"union","value":[{"type":"string"},{"type":"null"}]},"optional":false}}}]},"optional":false}}},{"type":"null"}]},"optional":true}}}
internal/usageRanksBackfill:fix mutation internal {"type":"object","value":{"ids":{"fieldType":{"type":"array","value":{"type":"id","tableName":"billing_usage"}},"optional":false}}}
internal/usageRanksBackfill:goneOrgs query internal {"type":"object","value":{"table":{"fieldType":{"type":"union","value":[{"type":"literal","value":"billing_usage_accounts"},{"type":"literal","value":"billing_month_totals"}]},"optional":false},"after":{"fieldType":{"type":"union","value":[{"type":"string"},{"type":"null"}]},"optional":false}}}
internal/usageRanksBackfill:nextBucket query internal {"type":"object","value":{"org_id":{"fieldType":{"type":"string"},"optional":false},"after":{"fieldType":{"type":"union","value":[{"type":"string"},{"type":"null"}]},"optional":false}}}
internal/usageRanksBackfill:nextOrg query internal {"type":"object","value":{"after":{"fieldType":{"type":"union","value":[{"type":"string"},{"type":"null"}]},"optional":false}}}
internal/usageRanksBackfill:remaining query internal {"type":"object","value":{"cursor":{"fieldType":{"type":"union","value":[{"type":"string"},{"type":"null"}]},"optional":true}}}
internal/usageRanksBackfill:rowsPage query internal {"type":"object","value":{"org_id":{"fieldType":{"type":"string"},"optional":false},"period":{"fieldType":{"type":"string"},"optional":false},"cursor":{"fieldType":{"type":"union","value":[{"type":"string"},{"type":"null"}]},"optional":false}}}
internal/usageRanksBackfill:run action internal {"type":"object","value":{"dry_run":{"fieldType":{"type":"boolean"},"optional":false},"cursor":{"fieldType":{"type":"union","value":[{"type":"string"},{"type":"null"}]},"optional":true}}}
internal/usageRanksBackfill:scan query internal {"type":"object","value":{"cursor":{"fieldType":{"type":"union","value":[{"type":"string"},{"type":"null"}]},"optional":false}}}
internal/usedIdsBackfill:audit mutation internal {"type":"object","value":{"issues":{"fieldType":{"type":"number"},"optional":false},"projects":{"fieldType":{"type":"number"},"optional":false},"stored_issues":{"fieldType":{"type":"number"},"optional":false},"stored_projects":{"fieldType":{"type":"number"},"optional":false},"deleted_tasks":{"fieldType":{"type":"number"},"optional":false},"project_items":{"fieldType":{"type":"number"},"optional":false},"orphans":{"fieldType":{"type":"number"},"optional":false},"done":{"fieldType":{"type":"boolean"},"optional":false},"source":{"fieldType":{"type":"union","value":[{"type":"union","value":[{"type":"literal","value":"issues"},{"type":"literal","value":"projects"},{"type":"literal","value":"stored_issues"},{"type":"literal","value":"stored_projects"},{"type":"literal","value":"deleted_tasks"},{"type":"literal","value":"project_items"}]},{"type":"null"}]},"optional":false},"cursor":{"fieldType":{"type":"union","value":[{"type":"string"},{"type":"null"}]},"optional":false}}}
internal/usedIdsBackfill:fix mutation internal {"type":"object","value":{"uses":{"fieldType":{"type":"array","value":{"type":"object","value":{"table":{"fieldType":{"type":"union","value":[{"type":"literal","value":"issues"},{"type":"literal","value":"projects"}]},"optional":false},"row_id":{"fieldType":{"type":"string"},"optional":false},"org_id":{"fieldType":{"type":"string"},"optional":false}}}},"optional":false}}}
internal/usedIdsBackfill:remaining query internal {"type":"object","value":{"source":{"fieldType":{"type":"union","value":[{"type":"literal","value":"issues"},{"type":"literal","value":"projects"},{"type":"literal","value":"stored_issues"},{"type":"literal","value":"stored_projects"},{"type":"literal","value":"deleted_tasks"},{"type":"literal","value":"project_items"}]},"optional":false},"cursor":{"fieldType":{"type":"union","value":[{"type":"string"},{"type":"null"}]},"optional":true}}}
internal/usedIdsBackfill:run action internal {"type":"object","value":{"dry_run":{"fieldType":{"type":"boolean"},"optional":false},"source":{"fieldType":{"type":"union","value":[{"type":"union","value":[{"type":"literal","value":"issues"},{"type":"literal","value":"projects"},{"type":"literal","value":"stored_issues"},{"type":"literal","value":"stored_projects"},{"type":"literal","value":"deleted_tasks"},{"type":"literal","value":"project_items"}]},{"type":"null"}]},"optional":true},"cursor":{"fieldType":{"type":"union","value":[{"type":"string"},{"type":"null"}]},"optional":true}}}
internal/usedIdsBackfill:scan query internal {"type":"object","value":{"source":{"fieldType":{"type":"union","value":[{"type":"literal","value":"issues"},{"type":"literal","value":"projects"},{"type":"literal","value":"stored_issues"},{"type":"literal","value":"stored_projects"},{"type":"literal","value":"deleted_tasks"},{"type":"literal","value":"project_items"}]},"optional":false},"cursor":{"fieldType":{"type":"union","value":[{"type":"string"},{"type":"null"}]},"optional":false}}}
internal/windowKeysBackfill:audit mutation internal {"type":"object","value":{"issues":{"fieldType":{"type":"number"},"optional":false},"projects":{"fieldType":{"type":"number"},"optional":false}}}
internal/windowKeysBackfill:page mutation internal {"type":"object","value":{"table":{"fieldType":{"type":"union","value":[{"type":"literal","value":"issues"},{"type":"literal","value":"projects"}]},"optional":false},"dry_run":{"fieldType":{"type":"boolean"},"optional":false},"cursor":{"fieldType":{"type":"union","value":[{"type":"string"},{"type":"null"}]},"optional":false}}}
internal/windowKeysBackfill:remaining query internal {"type":"object","value":{"table":{"fieldType":{"type":"union","value":[{"type":"literal","value":"issues"},{"type":"literal","value":"projects"}]},"optional":false},"cursor":{"fieldType":{"type":"union","value":[{"type":"string"},{"type":"null"}]},"optional":true}}}
internal/windowKeysBackfill:run action internal {"type":"object","value":{"dry_run":{"fieldType":{"type":"boolean"},"optional":false}}}
invites:deliveries query public {"type":"object","value":{"org_id":{"fieldType":{"type":"string"},"optional":false}}}
invites:reserve mutation internal {"type":"object","value":{"profile_id":{"fieldType":{"type":"string"},"optional":false},"org_id":{"fieldType":{"type":"string"},"optional":false},"email":{"fieldType":{"type":"string"},"optional":false},"resend":{"fieldType":{"type":"boolean"},"optional":false},"actor":{"fieldType":{"type":"object","value":{"auth_user_id":{"fieldType":{"type":"string"},"optional":true},"email":{"fieldType":{"type":"string"},"optional":false}}},"optional":false},"app":{"fieldType":{"type":"boolean"},"optional":false},"by":{"fieldType":{"type":"string"},"optional":true}}}
invites:sendAgain mutation public {"type":"object","value":{"profile_id":{"fieldType":{"type":"string"},"optional":false},"org_id":{"fieldType":{"type":"string"},"optional":false}}}
invites:sendFromApp action internal {"type":"object","value":{"invites":{"fieldType":{"type":"array","value":{"type":"object","value":{"profile_id":{"fieldType":{"type":"string"},"optional":false},"email":{"fieldType":{"type":"string"},"optional":true},"unless_sent":{"fieldType":{"type":"boolean"},"optional":true},"by":{"fieldType":{"type":"string"},"optional":true},"row":{"fieldType":{"type":"id","tableName":"platform_audit_log"},"optional":true}}}},"optional":false},"resend":{"fieldType":{"type":"boolean"},"optional":true}}}
invites:settle mutation internal {"type":"object","value":{"row":{"fieldType":{"type":"id","tableName":"platform_audit_log"},"optional":false},"sent":{"fieldType":{"type":"boolean"},"optional":false},"uncertain":{"fieldType":{"type":"boolean"},"optional":false}}}
invites:targets query internal {"type":"object","value":{"invites":{"fieldType":{"type":"array","value":{"type":"object","value":{"profile_id":{"fieldType":{"type":"string"},"optional":false},"email":{"fieldType":{"type":"string"},"optional":true},"unless_sent":{"fieldType":{"type":"boolean"},"optional":true},"by":{"fieldType":{"type":"string"},"optional":true},"row":{"fieldType":{"type":"id","tableName":"platform_audit_log"},"optional":true}}}},"optional":false},"operator":{"fieldType":{"type":"boolean"},"optional":false},"strict":{"fieldType":{"type":"boolean"},"optional":false}}}
issues:addLink mutation public {"type":"object","value":{"id":{"fieldType":{"type":"string"},"optional":false},"source_id":{"fieldType":{"type":"string"},"optional":false},"target_id":{"fieldType":{"type":"string"},"optional":false},"type":{"fieldType":{"type":"union","value":[{"type":"literal","value":"blocks"},{"type":"literal","value":"relates"}]},"optional":false},"org_id":{"fieldType":{"type":"string"},"optional":false}}}
issues:archive mutation public {"type":"object","value":{"id":{"fieldType":{"type":"string"},"optional":false},"reason":{"fieldType":{"type":"string"},"optional":true},"keep_subtasks":{"fieldType":{"type":"boolean"},"optional":true},"org_id":{"fieldType":{"type":"string"},"optional":false}}}
issues:archivedPage query public {"type":"object","value":{"scope":{"fieldType":{"type":"union","value":[{"type":"object","value":{"org_id":{"fieldType":{"type":"string"},"optional":false},"project_ids":{"fieldType":{"type":"array","value":{"type":"string"}},"optional":false}}},{"type":"object","value":{"org_id":{"fieldType":{"type":"string"},"optional":false},"all":{"fieldType":{"type":"literal","value":true},"optional":false}}}]},"optional":false},"cursor":{"fieldType":{"type":"string"},"optional":true},"search":{"fieldType":{"type":"string"},"optional":true},"limit":{"fieldType":{"type":"number"},"optional":true}}}
issues:archivedTask query public {"type":"object","value":{"id":{"fieldType":{"type":"string"},"optional":false}}}
issues:create mutation public {"type":"object","value":{"id":{"fieldType":{"type":"string"},"optional":false},"project_id":{"fieldType":{"type":"string"},"optional":false},"title":{"fieldType":{"type":"string"},"optional":false},"description":{"fieldType":{"type":"union","value":[{"type":"string"},{"type":"null"}]},"optional":true},"status":{"fieldType":{"type":"union","value":[{"type":"union","value":[{"type":"literal","value":"backlog"},{"type":"literal","value":"todo"},{"type":"literal","value":"progress"},{"type":"literal","value":"review"},{"type":"literal","value":"done"}]},{"type":"null"}]},"optional":true},"priority":{"fieldType":{"type":"union","value":[{"type":"union","value":[{"type":"literal","value":"urgent"},{"type":"literal","value":"high"},{"type":"literal","value":"medium"},{"type":"literal","value":"low"}]},{"type":"null"}]},"optional":true},"assignee_id":{"fieldType":{"type":"union","value":[{"type":"string"},{"type":"null"}]},"optional":true},"reviewer_id":{"fieldType":{"type":"union","value":[{"type":"string"},{"type":"null"}]},"optional":true},"parent_id":{"fieldType":{"type":"union","value":[{"type":"string"},{"type":"null"}]},"optional":true},"start_week":{"fieldType":{"type":"union","value":[{"type":"string"},{"type":"null"}]},"optional":true},"end_week":{"fieldType":{"type":"union","value":[{"type":"string"},{"type":"null"}]},"optional":true},"due_date":{"fieldType":{"type":"union","value":[{"type":"string"},{"type":"null"}]},"optional":true},"remaining_hours":{"fieldType":{"type":"union","value":[{"type":"number"},{"type":"null"}]},"optional":true},"paused":{"fieldType":{"type":"union","value":[{"type":"boolean"},{"type":"null"}]},"optional":true},"org_id":{"fieldType":{"type":"string"},"optional":false}}}
issues:createLinked mutation public {"type":"object","value":{"id":{"fieldType":{"type":"string"},"optional":false},"new_id":{"fieldType":{"type":"string"},"optional":false},"link_id":{"fieldType":{"type":"string"},"optional":false},"title":{"fieldType":{"type":"string"},"optional":false},"kind":{"fieldType":{"type":"union","value":[{"type":"literal","value":"blocks"},{"type":"literal","value":"blocked_by"},{"type":"literal","value":"relates"}]},"optional":false},"org_id":{"fieldType":{"type":"string"},"optional":false}}}
issues:createParent mutation public {"type":"object","value":{"id":{"fieldType":{"type":"string"},"optional":false},"parent_id":{"fieldType":{"type":"string"},"optional":false},"title":{"fieldType":{"type":"string"},"optional":false},"expected":{"fieldType":{"type":"object","value":{"title":{"fieldType":{"type":"string"},"optional":true},"description":{"fieldType":{"type":"string"},"optional":true},"status":{"fieldType":{"type":"union","value":[{"type":"literal","value":"backlog"},{"type":"literal","value":"todo"},{"type":"literal","value":"progress"},{"type":"literal","value":"review"},{"type":"literal","value":"done"}]},"optional":true},"priority":{"fieldType":{"type":"union","value":[{"type":"literal","value":"urgent"},{"type":"literal","value":"high"},{"type":"literal","value":"medium"},{"type":"literal","value":"low"}]},"optional":true},"assignee_id":{"fieldType":{"type":"union","value":[{"type":"string"},{"type":"null"}]},"optional":true},"reviewer_id":{"fieldType":{"type":"union","value":[{"type":"string"},{"type":"null"}]},"optional":true},"start_week":{"fieldType":{"type":"union","value":[{"type":"string"},{"type":"null"}]},"optional":true},"end_week":{"fieldType":{"type":"union","value":[{"type":"string"},{"type":"null"}]},"optional":true},"due_date":{"fieldType":{"type":"union","value":[{"type":"string"},{"type":"null"}]},"optional":true},"remaining_hours":{"fieldType":{"type":"union","value":[{"type":"number"},{"type":"null"}]},"optional":true},"paused":{"fieldType":{"type":"boolean"},"optional":true},"parent_id":{"fieldType":{"type":"union","value":[{"type":"string"},{"type":"null"}]},"optional":true},"has_hidden_parent":{"fieldType":{"type":"boolean"},"optional":true},"project_id":{"fieldType":{"type":"string"},"optional":true}}},"optional":true},"org_id":{"fieldType":{"type":"string"},"optional":false}}}
issues:deleteDeep mutation public {"type":"object","value":{"id":{"fieldType":{"type":"string"},"optional":false},"subtask_ids":{"fieldType":{"type":"array","value":{"type":"string"}},"optional":true},"reason":{"fieldType":{"type":"string"},"optional":true},"org_id":{"fieldType":{"type":"string"},"optional":false}}}
issues:move mutation public {"type":"object","value":{"id":{"fieldType":{"type":"string"},"optional":false},"project_id":{"fieldType":{"type":"string"},"optional":false},"detach_parent":{"fieldType":{"type":"boolean"},"optional":true},"expected":{"fieldType":{"type":"object","value":{"title":{"fieldType":{"type":"string"},"optional":true},"description":{"fieldType":{"type":"string"},"optional":true},"status":{"fieldType":{"type":"union","value":[{"type":"literal","value":"backlog"},{"type":"literal","value":"todo"},{"type":"literal","value":"progress"},{"type":"literal","value":"review"},{"type":"literal","value":"done"}]},"optional":true},"priority":{"fieldType":{"type":"union","value":[{"type":"literal","value":"urgent"},{"type":"literal","value":"high"},{"type":"literal","value":"medium"},{"type":"literal","value":"low"}]},"optional":true},"assignee_id":{"fieldType":{"type":"union","value":[{"type":"string"},{"type":"null"}]},"optional":true},"reviewer_id":{"fieldType":{"type":"union","value":[{"type":"string"},{"type":"null"}]},"optional":true},"start_week":{"fieldType":{"type":"union","value":[{"type":"string"},{"type":"null"}]},"optional":true},"end_week":{"fieldType":{"type":"union","value":[{"type":"string"},{"type":"null"}]},"optional":true},"due_date":{"fieldType":{"type":"union","value":[{"type":"string"},{"type":"null"}]},"optional":true},"remaining_hours":{"fieldType":{"type":"union","value":[{"type":"number"},{"type":"null"}]},"optional":true},"paused":{"fieldType":{"type":"boolean"},"optional":true},"parent_id":{"fieldType":{"type":"union","value":[{"type":"string"},{"type":"null"}]},"optional":true},"has_hidden_parent":{"fieldType":{"type":"boolean"},"optional":true},"project_id":{"fieldType":{"type":"string"},"optional":true}}},"optional":true},"org_id":{"fieldType":{"type":"string"},"optional":false}}}
issues:moveCarriesSubtasks query public {"type":"object","value":{"id":{"fieldType":{"type":"string"},"optional":false},"project_id":{"fieldType":{"type":"string"},"optional":false},"org_id":{"fieldType":{"type":"string"},"optional":false}}}
issues:removeLink mutation public {"type":"object","value":{"a":{"fieldType":{"type":"string"},"optional":false},"b":{"fieldType":{"type":"string"},"optional":false},"expected":{"fieldType":{"type":"object","value":{"kind":{"fieldType":{"type":"union","value":[{"type":"literal","value":"blocks"},{"type":"literal","value":"blocked_by"},{"type":"literal","value":"relates"}]},"optional":false}}},"optional":true},"org_id":{"fieldType":{"type":"string"},"optional":false}}}
issues:setSubscriber mutation public {"type":"object","value":{"issue_id":{"fieldType":{"type":"string"},"optional":false},"profile_id":{"fieldType":{"type":"string"},"optional":false},"subscribed":{"fieldType":{"type":"boolean"},"optional":false},"org_id":{"fieldType":{"type":"string"},"optional":false}}}
issues:subscribe mutation public {"type":"object","value":{"issue_id":{"fieldType":{"type":"string"},"optional":false},"org_id":{"fieldType":{"type":"string"},"optional":false}}}
issues:subscribers query public {"type":"object","value":{"issue_id":{"fieldType":{"type":"string"},"optional":false},"org_id":{"fieldType":{"type":"string"},"optional":false}}}
issues:unarchive mutation public {"type":"object","value":{"id":{"fieldType":{"type":"string"},"optional":false},"org_id":{"fieldType":{"type":"string"},"optional":false}}}
issues:unsubscribe mutation public {"type":"object","value":{"issue_id":{"fieldType":{"type":"string"},"optional":false},"org_id":{"fieldType":{"type":"string"},"optional":false}}}
issues:update mutation public {"type":"object","value":{"id":{"fieldType":{"type":"string"},"optional":false},"patch":{"fieldType":{"type":"object","value":{"title":{"fieldType":{"type":"string"},"optional":true},"description":{"fieldType":{"type":"union","value":[{"type":"string"},{"type":"null"}]},"optional":true},"status":{"fieldType":{"type":"union","value":[{"type":"literal","value":"backlog"},{"type":"literal","value":"todo"},{"type":"literal","value":"progress"},{"type":"literal","value":"review"},{"type":"literal","value":"done"}]},"optional":true},"priority":{"fieldType":{"type":"union","value":[{"type":"literal","value":"urgent"},{"type":"literal","value":"high"},{"type":"literal","value":"medium"},{"type":"literal","value":"low"}]},"optional":true},"assignee_id":{"fieldType":{"type":"union","value":[{"type":"string"},{"type":"null"}]},"optional":true},"reviewer_id":{"fieldType":{"type":"union","value":[{"type":"string"},{"type":"null"}]},"optional":true},"parent_id":{"fieldType":{"type":"union","value":[{"type":"string"},{"type":"null"}]},"optional":true},"start_week":{"fieldType":{"type":"union","value":[{"type":"string"},{"type":"null"}]},"optional":true},"end_week":{"fieldType":{"type":"union","value":[{"type":"string"},{"type":"null"}]},"optional":true},"due_date":{"fieldType":{"type":"union","value":[{"type":"string"},{"type":"null"}]},"optional":true},"remaining_hours":{"fieldType":{"type":"union","value":[{"type":"number"},{"type":"null"}]},"optional":true},"paused":{"fieldType":{"type":"boolean"},"optional":true}}},"optional":false},"expected":{"fieldType":{"type":"object","value":{"title":{"fieldType":{"type":"string"},"optional":true},"description":{"fieldType":{"type":"string"},"optional":true},"status":{"fieldType":{"type":"union","value":[{"type":"literal","value":"backlog"},{"type":"literal","value":"todo"},{"type":"literal","value":"progress"},{"type":"literal","value":"review"},{"type":"literal","value":"done"}]},"optional":true},"priority":{"fieldType":{"type":"union","value":[{"type":"literal","value":"urgent"},{"type":"literal","value":"high"},{"type":"literal","value":"medium"},{"type":"literal","value":"low"}]},"optional":true},"assignee_id":{"fieldType":{"type":"union","value":[{"type":"string"},{"type":"null"}]},"optional":true},"reviewer_id":{"fieldType":{"type":"union","value":[{"type":"string"},{"type":"null"}]},"optional":true},"start_week":{"fieldType":{"type":"union","value":[{"type":"string"},{"type":"null"}]},"optional":true},"end_week":{"fieldType":{"type":"union","value":[{"type":"string"},{"type":"null"}]},"optional":true},"due_date":{"fieldType":{"type":"union","value":[{"type":"string"},{"type":"null"}]},"optional":true},"remaining_hours":{"fieldType":{"type":"union","value":[{"type":"number"},{"type":"null"}]},"optional":true},"paused":{"fieldType":{"type":"boolean"},"optional":true},"parent_id":{"fieldType":{"type":"union","value":[{"type":"string"},{"type":"null"}]},"optional":true},"has_hidden_parent":{"fieldType":{"type":"boolean"},"optional":true},"project_id":{"fieldType":{"type":"string"},"optional":true}}},"optional":true},"org_id":{"fieldType":{"type":"string"},"optional":false}}}
jobs:archiveDoneIssues mutation internal {"type":"object","value":{"phase":{"fieldType":{"type":"union","value":[{"type":"literal","value":"projects"},{"type":"literal","value":"flagged"},{"type":"literal","value":"window"},{"type":"literal","value":"hand"}]},"optional":true},"cursor":{"fieldType":{"type":"string"},"optional":true},"left":{"fieldType":{"type":"array","value":{"type":"string"}},"optional":true},"due":{"fieldType":{"type":"object","value":{"org_id":{"fieldType":{"type":"string"},"optional":false},"projects":{"fieldType":{"type":"array","value":{"type":"string"}},"optional":false},"rows":{"fieldType":{"type":"array","value":{"type":"id","tableName":"archive_rechecks"}},"optional":true}}},"optional":true},"after":{"fieldType":{"type":"string"},"optional":true},"since":{"fieldType":{"type":"string"},"optional":true},"now":{"fieldType":{"type":"string"},"optional":true},"projects":{"fieldType":{"type":"number"},"optional":true},"repairs":{"fieldType":{"type":"number"},"optional":true},"tasks":{"fieldType":{"type":"number"},"optional":true},"full":{"fieldType":{"type":"boolean"},"optional":true},"resumed":{"fieldType":{"type":"boolean"},"optional":true},"organizations":{"fieldType":{"type":"number"},"optional":true}}}
jobs:archiveOrg mutation internal {"type":"object","value":{"org_id":{"fieldType":{"type":"string"},"optional":false},"now":{"fieldType":{"type":"string"},"optional":false},"phase":{"fieldType":{"type":"union","value":[{"type":"literal","value":"archive"},{"type":"literal","value":"repair"}]},"optional":false},"cutoff":{"fieldType":{"type":"string"},"optional":true},"cursor":{"fieldType":{"type":"string"},"optional":true},"size":{"fieldType":{"type":"number"},"optional":true},"archived":{"fieldType":{"type":"number"},"optional":false},"flagged":{"fieldType":{"type":"number"},"optional":false}}}
jobs:archiveProject mutation internal {"type":"object","value":{"project_id":{"fieldType":{"type":"string"},"optional":false},"org_id":{"fieldType":{"type":"string"},"optional":false},"now":{"fieldType":{"type":"string"},"optional":false},"cursor":{"fieldType":{"type":"string"},"optional":true},"size":{"fieldType":{"type":"number"},"optional":true},"archived":{"fieldType":{"type":"number"},"optional":false},"next":{"fieldType":{"type":"array","value":{"type":"string"}},"optional":true},"rows":{"fieldType":{"type":"array","value":{"type":"id","tableName":"archive_rechecks"}},"optional":true}}}
jobs:repairOrg mutation internal {"type":"object","value":{"org_id":{"fieldType":{"type":"string"},"optional":false},"now":{"fieldType":{"type":"string"},"optional":false},"cursor":{"fieldType":{"type":"string"},"optional":true},"flagged":{"fieldType":{"type":"number"},"optional":false}}}
jobs:sweepDueProfiles mutation internal {"type":"object","value":{"profiles":{"fieldType":{"type":"array","value":{"type":"string"}},"optional":false},"now":{"fieldType":{"type":"string"},"optional":false},"deleted":{"fieldType":{"type":"number"},"optional":false}}}
jobs:sweepProfiles mutation internal {"type":"object","value":{"from":{"fieldType":{"type":"string"},"optional":false},"to":{"fieldType":{"type":"string"},"optional":false},"now":{"fieldType":{"type":"string"},"optional":false},"deleted":{"fieldType":{"type":"number"},"optional":false},"woken":{"fieldType":{"type":"number"},"optional":false}}}
jobs:sweepReadMessages mutation internal {"type":"object","value":{"phase":{"fieldType":{"type":"union","value":[{"type":"literal","value":"seed"},{"type":"literal","value":"due"}]},"optional":true},"cursor":{"fieldType":{"type":"string"},"optional":true},"now":{"fieldType":{"type":"string"},"optional":true},"pages":{"fieldType":{"type":"number"},"optional":true}}}
jobs:wakeSnoozes mutation internal {"type":"object","value":{"now":{"fieldType":{"type":"string"},"optional":false},"woken":{"fieldType":{"type":"number"},"optional":false}}}
labelRemovals:recover mutation internal {"type":"object","value":{}}
labelRemovals:step mutation internal {"type":"object","value":{"label_id":{"fieldType":{"type":"string"},"optional":false}}}
labels:byIds query public {"type":"object","value":{"ids":{"fieldType":{"type":"array","value":{"type":"string"}},"optional":false},"org_id":{"fieldType":{"type":"string"},"optional":false}}}
labels:create mutation public {"type":"object","value":{"id":{"fieldType":{"type":"string"},"optional":false},"name":{"fieldType":{"type":"string"},"optional":false},"color":{"fieldType":{"type":"string"},"optional":false},"org_id":{"fieldType":{"type":"string"},"optional":false}}}
labels:picker query public {"type":"object","value":{"search":{"fieldType":{"type":"string"},"optional":true},"after":{"fieldType":{"type":"string"},"optional":true},"through":{"fieldType":{"type":"string"},"optional":true},"org_id":{"fieldType":{"type":"string"},"optional":false}}}
labels:remove mutation public {"type":"object","value":{"id":{"fieldType":{"type":"string"},"optional":false},"expected":{"fieldType":{"type":"object","value":{"name":{"fieldType":{"type":"string"},"optional":true},"color":{"fieldType":{"type":"string"},"optional":true}}},"optional":true},"org_id":{"fieldType":{"type":"string"},"optional":false}}}
labels:settingsPage query public {"type":"object","value":{"search":{"fieldType":{"type":"string"},"optional":true},"after":{"fieldType":{"type":"string"},"optional":true},"through":{"fieldType":{"type":"string"},"optional":true},"org_id":{"fieldType":{"type":"string"},"optional":false}}}
labels:toggle mutation public {"type":"object","value":{"issue_id":{"fieldType":{"type":"string"},"optional":false},"label_id":{"fieldType":{"type":"string"},"optional":false},"on":{"fieldType":{"type":"boolean"},"optional":false},"org_id":{"fieldType":{"type":"string"},"optional":false}}}
labels:update mutation public {"type":"object","value":{"id":{"fieldType":{"type":"string"},"optional":false},"patch":{"fieldType":{"type":"object","value":{"name":{"fieldType":{"type":"string"},"optional":true},"color":{"fieldType":{"type":"string"},"optional":true}}},"optional":false},"expected":{"fieldType":{"type":"object","value":{"name":{"fieldType":{"type":"string"},"optional":true},"color":{"fieldType":{"type":"string"},"optional":true}}},"optional":true},"org_id":{"fieldType":{"type":"string"},"optional":false}}}
machine/auth:lookupCredential query internal {"type":"object","value":{"hash":{"fieldType":{"type":"string"},"optional":false},"isAgent":{"fieldType":{"type":"boolean"},"optional":false},"now":{"fieldType":{"type":"string"},"optional":false}}}
machine/auth:touchCredential mutation internal {"type":"object","value":{"table":{"fieldType":{"type":"union","value":[{"type":"literal","value":"agent_keys"},{"type":"literal","value":"mcp_tokens"}]},"optional":false},"tokenId":{"fieldType":{"type":"string"},"optional":false},"rowId":{"fieldType":{"type":"string"},"optional":false},"profileId":{"fieldType":{"type":"string"},"optional":false},"now":{"fieldType":{"type":"string"},"optional":false}}}
machine/discussion:mcpDeleteComment mutation internal {"type":"object","value":{"callerId":{"fieldType":{"type":"string"},"optional":false},"access":{"fieldType":{"type":"union","value":[{"type":"literal","value":"read"},{"type":"literal","value":"write"}]},"optional":false},"comment":{"fieldType":{"type":"string"},"optional":false},"expected":{"fieldType":{"type":"record","keys":{"type":"string"},"values":{"fieldType":{"type":"union","value":[{"type":"string"},{"type":"number"},{"type":"boolean"},{"type":"null"}]},"optional":false}},"optional":true}}}
machine/discussion:mcpListInbox query internal {"type":"object","value":{"callerId":{"fieldType":{"type":"string"},"optional":false},"access":{"fieldType":{"type":"union","value":[{"type":"literal","value":"read"},{"type":"literal","value":"write"}]},"optional":false},"unread_only":{"fieldType":{"type":"boolean"},"optional":true},"include_snoozed":{"fieldType":{"type":"boolean"},"optional":true},"limit":{"fieldType":{"type":"number"},"optional":true},"offset":{"fieldType":{"type":"number"},"optional":true}}}
machine/discussion:mcpSetFollowing mutation internal {"type":"object","value":{"callerId":{"fieldType":{"type":"string"},"optional":false},"access":{"fieldType":{"type":"union","value":[{"type":"literal","value":"read"},{"type":"literal","value":"write"}]},"optional":false},"ref":{"fieldType":{"type":"string"},"optional":false},"following":{"fieldType":{"type":"boolean"},"optional":false}}}
machine/discussion:mcpUpdateComment mutation internal {"type":"object","value":{"callerId":{"fieldType":{"type":"string"},"optional":false},"access":{"fieldType":{"type":"union","value":[{"type":"literal","value":"read"},{"type":"literal","value":"write"}]},"optional":false},"comment":{"fieldType":{"type":"string"},"optional":false},"body":{"fieldType":{"type":"string"},"optional":false},"expected":{"fieldType":{"type":"record","keys":{"type":"string"},"values":{"fieldType":{"type":"union","value":[{"type":"string"},{"type":"number"},{"type":"boolean"},{"type":"null"}]},"optional":false}},"optional":true}}}
machine/discussion:mcpUpdateInbox mutation internal {"type":"object","value":{"callerId":{"fieldType":{"type":"string"},"optional":false},"access":{"fieldType":{"type":"union","value":[{"type":"literal","value":"read"},{"type":"literal","value":"write"}]},"optional":false},"action":{"fieldType":{"type":"union","value":[{"type":"literal","value":"read"},{"type":"literal","value":"unread"},{"type":"literal","value":"remove"},{"type":"literal","value":"snooze"}]},"optional":false},"tasks":{"fieldType":{"type":"array","value":{"type":"string"}},"optional":true},"all":{"fieldType":{"type":"boolean"},"optional":true},"until":{"fieldType":{"type":"union","value":[{"type":"string"},{"type":"null"}]},"optional":true},"before":{"fieldType":{"type":"number"},"optional":true}}}
machine/discussion:restDeleteComment mutation internal {"type":"object","value":{"callerId":{"fieldType":{"type":"string"},"optional":false},"access":{"fieldType":{"type":"union","value":[{"type":"literal","value":"read"},{"type":"literal","value":"write"}]},"optional":false},"ref":{"fieldType":{"type":"string"},"optional":false},"body":{"fieldType":{"type":"string"},"optional":true}}}
machine/discussion:restFollowTask mutation internal {"type":"object","value":{"callerId":{"fieldType":{"type":"string"},"optional":false},"access":{"fieldType":{"type":"union","value":[{"type":"literal","value":"read"},{"type":"literal","value":"write"}]},"optional":false},"ref":{"fieldType":{"type":"string"},"optional":false},"body":{"fieldType":{"type":"string"},"optional":true}}}
machine/discussion:restListInbox query internal {"type":"object","value":{"callerId":{"fieldType":{"type":"string"},"optional":false},"access":{"fieldType":{"type":"union","value":[{"type":"literal","value":"read"},{"type":"literal","value":"write"}]},"optional":false},"unread_only":{"fieldType":{"type":"string"},"optional":true},"include_snoozed":{"fieldType":{"type":"string"},"optional":true},"limit":{"fieldType":{"type":"string"},"optional":true},"offset":{"fieldType":{"type":"string"},"optional":true}}}
machine/discussion:restReadInbox mutation internal {"type":"object","value":{"callerId":{"fieldType":{"type":"string"},"optional":false},"access":{"fieldType":{"type":"union","value":[{"type":"literal","value":"read"},{"type":"literal","value":"write"}]},"optional":false},"body":{"fieldType":{"type":"string"},"optional":false}}}
machine/discussion:restRemoveInbox mutation internal {"type":"object","value":{"callerId":{"fieldType":{"type":"string"},"optional":false},"access":{"fieldType":{"type":"union","value":[{"type":"literal","value":"read"},{"type":"literal","value":"write"}]},"optional":false},"body":{"fieldType":{"type":"string"},"optional":false}}}
machine/discussion:restSnoozeInbox mutation internal {"type":"object","value":{"callerId":{"fieldType":{"type":"string"},"optional":false},"access":{"fieldType":{"type":"union","value":[{"type":"literal","value":"read"},{"type":"literal","value":"write"}]},"optional":false},"body":{"fieldType":{"type":"string"},"optional":false}}}
machine/discussion:restUnfollowTask mutation internal {"type":"object","value":{"callerId":{"fieldType":{"type":"string"},"optional":false},"access":{"fieldType":{"type":"union","value":[{"type":"literal","value":"read"},{"type":"literal","value":"write"}]},"optional":false},"ref":{"fieldType":{"type":"string"},"optional":false},"body":{"fieldType":{"type":"string"},"optional":true}}}
machine/discussion:restUnreadInbox mutation internal {"type":"object","value":{"callerId":{"fieldType":{"type":"string"},"optional":false},"access":{"fieldType":{"type":"union","value":[{"type":"literal","value":"read"},{"type":"literal","value":"write"}]},"optional":false},"body":{"fieldType":{"type":"string"},"optional":false}}}
machine/discussion:restUpdateComment mutation internal {"type":"object","value":{"callerId":{"fieldType":{"type":"string"},"optional":false},"access":{"fieldType":{"type":"union","value":[{"type":"literal","value":"read"},{"type":"literal","value":"write"}]},"optional":false},"ref":{"fieldType":{"type":"string"},"optional":false},"body":{"fieldType":{"type":"string"},"optional":false}}}
machine/mcp:addComment mutation internal {"type":"object","value":{"callerId":{"fieldType":{"type":"string"},"optional":false},"access":{"fieldType":{"type":"union","value":[{"type":"literal","value":"read"},{"type":"literal","value":"write"}]},"optional":false},"ref":{"fieldType":{"type":"string"},"optional":false},"body":{"fieldType":{"type":"string"},"optional":false}}}
machine/mcp:createIssue mutation internal {"type":"object","value":{"callerId":{"fieldType":{"type":"string"},"optional":false},"access":{"fieldType":{"type":"union","value":[{"type":"literal","value":"read"},{"type":"literal","value":"write"}]},"optional":false},"project":{"fieldType":{"type":"string"},"optional":false},"sub_project":{"fieldType":{"type":"string"},"optional":true},"title":{"fieldType":{"type":"string"},"optional":false},"description":{"fieldType":{"type":"string"},"optional":true},"status":{"fieldType":{"type":"union","value":[{"type":"literal","value":"backlog"},{"type":"literal","value":"todo"},{"type":"literal","value":"progress"},{"type":"literal","value":"review"},{"type":"literal","value":"done"}]},"optional":true},"priority":{"fieldType":{"type":"union","value":[{"type":"literal","value":"urgent"},{"type":"literal","value":"high"},{"type":"literal","value":"medium"},{"type":"literal","value":"low"}]},"optional":true},"assignee_id":{"fieldType":{"type":"union","value":[{"type":"string"},{"type":"null"}]},"optional":true},"reviewer_id":{"fieldType":{"type":"union","value":[{"type":"string"},{"type":"null"}]},"optional":true},"reporter_id":{"fieldType":{"type":"string"},"optional":true},"parent":{"fieldType":{"type":"union","value":[{"type":"string"},{"type":"null"}]},"optional":true},"start_week":{"fieldType":{"type":"union","value":[{"type":"string"},{"type":"null"}]},"optional":true},"end_week":{"fieldType":{"type":"union","value":[{"type":"string"},{"type":"null"}]},"optional":true},"due_date":{"fieldType":{"type":"union","value":[{"type":"string"},{"type":"null"}]},"optional":true},"remaining_hours":{"fieldType":{"type":"union","value":[{"type":"number"},{"type":"null"}]},"optional":true},"paused":{"fieldType":{"type":"boolean"},"optional":true},"archived":{"fieldType":{"type":"boolean"},"optional":true}}}
machine/mcp:deleteIssue mutation internal {"type":"object","value":{"callerId":{"fieldType":{"type":"string"},"optional":false},"access":{"fieldType":{"type":"union","value":[{"type":"literal","value":"read"},{"type":"literal","value":"write"}]},"optional":false},"credential":{"fieldType":{"type":"object","value":{"profile_id":{"fieldType":{"type":"string"},"optional":false},"credential_table":{"fieldType":{"type":"union","value":[{"type":"literal","value":"agent_keys"},{"type":"literal","value":"mcp_tokens"},{"type":"literal","value":"oauth_connections"}]},"optional":false},"credential_id":{"fieldType":{"type":"string"},"optional":false},"credential_row_id":{"fieldType":{"type":"string"},"optional":false}}},"optional":false},"ref":{"fieldType":{"type":"string"},"optional":false}}}
machine/mcp:getIssue query internal {"type":"object","value":{"callerId":{"fieldType":{"type":"string"},"optional":false},"access":{"fieldType":{"type":"union","value":[{"type":"literal","value":"read"},{"type":"literal","value":"write"}]},"optional":false},"today":{"fieldType":{"type":"string"},"optional":false},"ref":{"fieldType":{"type":"string"},"optional":false}}}
machine/mcp:getMe query internal {"type":"object","value":{"callerId":{"fieldType":{"type":"string"},"optional":false},"access":{"fieldType":{"type":"union","value":[{"type":"literal","value":"read"},{"type":"literal","value":"write"}]},"optional":false},"credential":{"fieldType":{"type":"object","value":{"profile_id":{"fieldType":{"type":"string"},"optional":false},"credential_table":{"fieldType":{"type":"union","value":[{"type":"literal","value":"agent_keys"},{"type":"literal","value":"mcp_tokens"},{"type":"literal","value":"oauth_connections"}]},"optional":false},"credential_id":{"fieldType":{"type":"string"},"optional":false},"credential_row_id":{"fieldType":{"type":"string"},"optional":false}}},"optional":false}}}
machine/mcp:listComments query internal {"type":"object","value":{"callerId":{"fieldType":{"type":"string"},"optional":false},"access":{"fieldType":{"type":"union","value":[{"type":"literal","value":"read"},{"type":"literal","value":"write"}]},"optional":false},"ref":{"fieldType":{"type":"string"},"optional":false},"limit":{"fieldType":{"type":"number"},"optional":true},"before":{"fieldType":{"type":"string"},"optional":true}}}
machine/mcp:listIssues query internal {"type":"object","value":{"callerId":{"fieldType":{"type":"string"},"optional":false},"access":{"fieldType":{"type":"union","value":[{"type":"literal","value":"read"},{"type":"literal","value":"write"}]},"optional":false},"today":{"fieldType":{"type":"string"},"optional":false},"project":{"fieldType":{"type":"string"},"optional":true},"status":{"fieldType":{"type":"union","value":[{"type":"union","value":[{"type":"literal","value":"backlog"},{"type":"literal","value":"todo"},{"type":"literal","value":"progress"},{"type":"literal","value":"review"},{"type":"literal","value":"done"}]},{"type":"array","value":{"type":"union","value":[{"type":"literal","value":"backlog"},{"type":"literal","value":"todo"},{"type":"literal","value":"progress"},{"type":"literal","value":"review"},{"type":"literal","value":"done"}]}}]},"optional":true},"priority":{"fieldType":{"type":"union","value":[{"type":"literal","value":"urgent"},{"type":"literal","value":"high"},{"type":"literal","value":"medium"},{"type":"literal","value":"low"}]},"optional":true},"assignee_id":{"fieldType":{"type":"string"},"optional":true},"owner_id":{"fieldType":{"type":"string"},"optional":true},"search":{"fieldType":{"type":"string"},"optional":true},"archived":{"fieldType":{"type":"boolean"},"optional":true},"limit":{"fieldType":{"type":"number"},"optional":true},"offset":{"fieldType":{"type":"number"},"optional":true},"cursor":{"fieldType":{"type":"string"},"optional":true}}}
machine/mcp:listLabels query internal {"type":"object","value":{"callerId":{"fieldType":{"type":"string"},"optional":false},"access":{"fieldType":{"type":"union","value":[{"type":"literal","value":"read"},{"type":"literal","value":"write"}]},"optional":false}}}
machine/mcp:listProjectUsers query internal {"type":"object","value":{"callerId":{"fieldType":{"type":"string"},"optional":false},"access":{"fieldType":{"type":"union","value":[{"type":"literal","value":"read"},{"type":"literal","value":"write"}]},"optional":false},"project":{"fieldType":{"type":"string"},"optional":false}}}
machine/mcp:listProjects query internal {"type":"object","value":{"callerId":{"fieldType":{"type":"string"},"optional":false},"access":{"fieldType":{"type":"union","value":[{"type":"literal","value":"read"},{"type":"literal","value":"write"}]},"optional":false},"archived":{"fieldType":{"type":"boolean"},"optional":true}}}
machine/mcp:listTeams query internal {"type":"object","value":{"callerId":{"fieldType":{"type":"string"},"optional":false},"access":{"fieldType":{"type":"union","value":[{"type":"literal","value":"read"},{"type":"literal","value":"write"}]},"optional":false}}}
machine/mcp:listUsers query internal {"type":"object","value":{"callerId":{"fieldType":{"type":"string"},"optional":false},"access":{"fieldType":{"type":"union","value":[{"type":"literal","value":"read"},{"type":"literal","value":"write"}]},"optional":false}}}
machine/mcp:setLabel mutation internal {"type":"object","value":{"callerId":{"fieldType":{"type":"string"},"optional":false},"access":{"fieldType":{"type":"union","value":[{"type":"literal","value":"read"},{"type":"literal","value":"write"}]},"optional":false},"label":{"fieldType":{"type":"string"},"optional":true},"name":{"fieldType":{"type":"string"},"optional":true},"color":{"fieldType":{"type":"string"},"optional":true},"expected":{"fieldType":{"type":"record","keys":{"type":"string"},"values":{"fieldType":{"type":"union","value":[{"type":"string"},{"type":"number"},{"type":"boolean"},{"type":"null"}]},"optional":false}},"optional":true}}}
machine/mcp:setTaskLink mutation internal {"type":"object","value":{"callerId":{"fieldType":{"type":"string"},"optional":false},"access":{"fieldType":{"type":"union","value":[{"type":"literal","value":"read"},{"type":"literal","value":"write"}]},"optional":false},"ref":{"fieldType":{"type":"string"},"optional":false},"other":{"fieldType":{"type":"string"},"optional":false},"kind":{"fieldType":{"type":"union","value":[{"type":"literal","value":"blocks"},{"type":"literal","value":"blocked_by"},{"type":"literal","value":"relates"}]},"optional":false},"linked":{"fieldType":{"type":"boolean"},"optional":false}}}
machine/mcp:updateIssue mutation internal {"type":"object","value":{"callerId":{"fieldType":{"type":"string"},"optional":false},"access":{"fieldType":{"type":"union","value":[{"type":"literal","value":"read"},{"type":"literal","value":"write"}]},"optional":false},"ref":{"fieldType":{"type":"string"},"optional":false},"title":{"fieldType":{"type":"string"},"optional":true},"description":{"fieldType":{"type":"string"},"optional":true},"status":{"fieldType":{"type":"union","value":[{"type":"literal","value":"backlog"},{"type":"literal","value":"todo"},{"type":"literal","value":"progress"},{"type":"literal","value":"review"},{"type":"literal","value":"done"}]},"optional":true},"priority":{"fieldType":{"type":"union","value":[{"type":"literal","value":"urgent"},{"type":"literal","value":"high"},{"type":"literal","value":"medium"},{"type":"literal","value":"low"}]},"optional":true},"assignee_id":{"fieldType":{"type":"union","value":[{"type":"string"},{"type":"null"}]},"optional":true},"reviewer_id":{"fieldType":{"type":"union","value":[{"type":"string"},{"type":"null"}]},"optional":true},"due_date":{"fieldType":{"type":"union","value":[{"type":"string"},{"type":"null"}]},"optional":true},"start_week":{"fieldType":{"type":"union","value":[{"type":"string"},{"type":"null"}]},"optional":true},"end_week":{"fieldType":{"type":"union","value":[{"type":"string"},{"type":"null"}]},"optional":true},"remaining_hours":{"fieldType":{"type":"union","value":[{"type":"number"},{"type":"null"}]},"optional":true},"paused":{"fieldType":{"type":"boolean"},"optional":true},"archived":{"fieldType":{"type":"boolean"},"optional":true},"archive_reason":{"fieldType":{"type":"string"},"optional":true},"project":{"fieldType":{"type":"string"},"optional":true},"sub_project":{"fieldType":{"type":"string"},"optional":true},"parent":{"fieldType":{"type":"union","value":[{"type":"string"},{"type":"null"}]},"optional":true},"add_labels":{"fieldType":{"type":"array","value":{"type":"string"}},"optional":true},"remove_labels":{"fieldType":{"type":"array","value":{"type":"string"}},"optional":true},"expected":{"fieldType":{"type":"record","keys":{"type":"string"},"values":{"fieldType":{"type":"union","value":[{"type":"string"},{"type":"number"},{"type":"boolean"},{"type":"null"}]},"optional":false}},"optional":true}}}
machine/mcp:updateUser mutation internal {"type":"object","value":{"callerId":{"fieldType":{"type":"string"},"optional":false},"access":{"fieldType":{"type":"union","value":[{"type":"literal","value":"read"},{"type":"literal","value":"write"}]},"optional":false},"user_id":{"fieldType":{"type":"string"},"optional":false},"plannable_hours":{"fieldType":{"type":"number"},"optional":false},"expected":{"fieldType":{"type":"record","keys":{"type":"string"},"values":{"fieldType":{"type":"union","value":[{"type":"string"},{"type":"number"},{"type":"boolean"},{"type":"null"}]},"optional":false}},"optional":true}}}
machine/projects:mcpCreateProject mutation internal {"type":"object","value":{"callerId":{"fieldType":{"type":"string"},"optional":false},"access":{"fieldType":{"type":"union","value":[{"type":"literal","value":"read"},{"type":"literal","value":"write"}]},"optional":false},"name":{"fieldType":{"type":"string"},"optional":false},"parent":{"fieldType":{"type":"string"},"optional":true},"lead_id":{"fieldType":{"type":"string"},"optional":true},"description":{"fieldType":{"type":"string"},"optional":true}}}
machine/projects:mcpDeleteMilestone mutation internal {"type":"object","value":{"callerId":{"fieldType":{"type":"string"},"optional":false},"access":{"fieldType":{"type":"union","value":[{"type":"literal","value":"read"},{"type":"literal","value":"write"}]},"optional":false},"project":{"fieldType":{"type":"string"},"optional":false},"milestone":{"fieldType":{"type":"string"},"optional":false},"expected":{"fieldType":{"type":"record","keys":{"type":"string"},"values":{"fieldType":{"type":"union","value":[{"type":"string"},{"type":"number"},{"type":"boolean"},{"type":"null"}]},"optional":false}},"optional":true}}}
machine/projects:mcpGetProject query internal {"type":"object","value":{"callerId":{"fieldType":{"type":"string"},"optional":false},"access":{"fieldType":{"type":"union","value":[{"type":"literal","value":"read"},{"type":"literal","value":"write"}]},"optional":false},"project":{"fieldType":{"type":"string"},"optional":false}}}
machine/projects:mcpSetMilestone mutation internal {"type":"object","value":{"callerId":{"fieldType":{"type":"string"},"optional":false},"access":{"fieldType":{"type":"union","value":[{"type":"literal","value":"read"},{"type":"literal","value":"write"}]},"optional":false},"project":{"fieldType":{"type":"string"},"optional":false},"milestone":{"fieldType":{"type":"string"},"optional":true},"name":{"fieldType":{"type":"string"},"optional":true},"date":{"fieldType":{"type":"string"},"optional":true},"expected":{"fieldType":{"type":"record","keys":{"type":"string"},"values":{"fieldType":{"type":"union","value":[{"type":"string"},{"type":"number"},{"type":"boolean"},{"type":"null"}]},"optional":false}},"optional":true}}}
machine/projects:mcpSetProjectAccess mutation internal {"type":"object","value":{"callerId":{"fieldType":{"type":"string"},"optional":false},"access":{"fieldType":{"type":"union","value":[{"type":"literal","value":"read"},{"type":"literal","value":"write"}]},"optional":false},"project":{"fieldType":{"type":"string"},"optional":false},"user_id":{"fieldType":{"type":"string"},"optional":true},"team_id":{"fieldType":{"type":"string"},"optional":true},"level":{"fieldType":{"type":"union","value":[{"type":"union","value":[{"type":"literal","value":"user"},{"type":"literal","value":"viewer"}]},{"type":"null"}]},"optional":false},"on_held_tasks":{"fieldType":{"type":"union","value":[{"type":"literal","value":"leave"},{"type":"literal","value":"keep_as_viewer"},{"type":"object","value":{"reassign_to":{"fieldType":{"type":"union","value":[{"type":"string"},{"type":"null"}]},"optional":false}}}]},"optional":true},"expected":{"fieldType":{"type":"record","keys":{"type":"string"},"values":{"fieldType":{"type":"union","value":[{"type":"string"},{"type":"number"},{"type":"boolean"},{"type":"null"}]},"optional":false}},"optional":true}}}
machine/projects:mcpUpdateProject mutation internal {"type":"object","value":{"callerId":{"fieldType":{"type":"string"},"optional":false},"access":{"fieldType":{"type":"union","value":[{"type":"literal","value":"read"},{"type":"literal","value":"write"}]},"optional":false},"project":{"fieldType":{"type":"string"},"optional":false},"name":{"fieldType":{"type":"string"},"optional":true},"description":{"fieldType":{"type":"string"},"optional":true},"review_hours":{"fieldType":{"type":"union","value":[{"type":"number"},{"type":"null"}]},"optional":true},"track_delay":{"fieldType":{"type":"boolean"},"optional":true},"lead_id":{"fieldType":{"type":"string"},"optional":true},"archived":{"fieldType":{"type":"boolean"},"optional":true},"expected":{"fieldType":{"type":"record","keys":{"type":"string"},"values":{"fieldType":{"type":"union","value":[{"type":"string"},{"type":"number"},{"type":"boolean"},{"type":"null"}]},"optional":false}},"optional":true}}}
machine/projects:restAddMilestone mutation internal {"type":"object","value":{"callerId":{"fieldType":{"type":"string"},"optional":false},"access":{"fieldType":{"type":"union","value":[{"type":"literal","value":"read"},{"type":"literal","value":"write"}]},"optional":false},"keyName":{"fieldType":{"type":"union","value":[{"type":"string"},{"type":"null"}]},"optional":false},"ref":{"fieldType":{"type":"string"},"optional":false},"body":{"fieldType":{"type":"string"},"optional":false}}}
machine/projects:restCreateProject mutation internal {"type":"object","value":{"callerId":{"fieldType":{"type":"string"},"optional":false},"access":{"fieldType":{"type":"union","value":[{"type":"literal","value":"read"},{"type":"literal","value":"write"}]},"optional":false},"keyName":{"fieldType":{"type":"union","value":[{"type":"string"},{"type":"null"}]},"optional":false},"body":{"fieldType":{"type":"string"},"optional":false}}}
machine/projects:restDeleteMilestone mutation internal {"type":"object","value":{"callerId":{"fieldType":{"type":"string"},"optional":false},"access":{"fieldType":{"type":"union","value":[{"type":"literal","value":"read"},{"type":"literal","value":"write"}]},"optional":false},"keyName":{"fieldType":{"type":"union","value":[{"type":"string"},{"type":"null"}]},"optional":false},"ref":{"fieldType":{"type":"string"},"optional":false},"milestone":{"fieldType":{"type":"string"},"optional":false},"body":{"fieldType":{"type":"string"},"optional":true}}}
machine/projects:restRemoveTeamAccess mutation internal {"type":"object","value":{"callerId":{"fieldType":{"type":"string"},"optional":false},"access":{"fieldType":{"type":"union","value":[{"type":"literal","value":"read"},{"type":"literal","value":"write"}]},"optional":false},"keyName":{"fieldType":{"type":"union","value":[{"type":"string"},{"type":"null"}]},"optional":false},"ref":{"fieldType":{"type":"string"},"optional":false},"subject":{"fieldType":{"type":"string"},"optional":false},"body":{"fieldType":{"type":"string"},"optional":false}}}
machine/projects:restRemoveUserAccess mutation internal {"type":"object","value":{"callerId":{"fieldType":{"type":"string"},"optional":false},"access":{"fieldType":{"type":"union","value":[{"type":"literal","value":"read"},{"type":"literal","value":"write"}]},"optional":false},"keyName":{"fieldType":{"type":"union","value":[{"type":"string"},{"type":"null"}]},"optional":false},"ref":{"fieldType":{"type":"string"},"optional":false},"subject":{"fieldType":{"type":"string"},"optional":false},"body":{"fieldType":{"type":"string"},"optional":false}}}
machine/projects:restSetTeamAccess mutation internal {"type":"object","value":{"callerId":{"fieldType":{"type":"string"},"optional":false},"access":{"fieldType":{"type":"union","value":[{"type":"literal","value":"read"},{"type":"literal","value":"write"}]},"optional":false},"keyName":{"fieldType":{"type":"union","value":[{"type":"string"},{"type":"null"}]},"optional":false},"ref":{"fieldType":{"type":"string"},"optional":false},"subject":{"fieldType":{"type":"string"},"optional":false},"body":{"fieldType":{"type":"string"},"optional":false}}}
machine/projects:restSetUserAccess mutation internal {"type":"object","value":{"callerId":{"fieldType":{"type":"string"},"optional":false},"access":{"fieldType":{"type":"union","value":[{"type":"literal","value":"read"},{"type":"literal","value":"write"}]},"optional":false},"keyName":{"fieldType":{"type":"union","value":[{"type":"string"},{"type":"null"}]},"optional":false},"ref":{"fieldType":{"type":"string"},"optional":false},"subject":{"fieldType":{"type":"string"},"optional":false},"body":{"fieldType":{"type":"string"},"optional":false}}}
machine/projects:restUpdateMilestone mutation internal {"type":"object","value":{"callerId":{"fieldType":{"type":"string"},"optional":false},"access":{"fieldType":{"type":"union","value":[{"type":"literal","value":"read"},{"type":"literal","value":"write"}]},"optional":false},"keyName":{"fieldType":{"type":"union","value":[{"type":"string"},{"type":"null"}]},"optional":false},"ref":{"fieldType":{"type":"string"},"optional":false},"milestone":{"fieldType":{"type":"string"},"optional":false},"body":{"fieldType":{"type":"string"},"optional":false}}}
machine/projects:restUpdateProject mutation internal {"type":"object","value":{"callerId":{"fieldType":{"type":"string"},"optional":false},"access":{"fieldType":{"type":"union","value":[{"type":"literal","value":"read"},{"type":"literal","value":"write"}]},"optional":false},"keyName":{"fieldType":{"type":"union","value":[{"type":"string"},{"type":"null"}]},"optional":false},"ref":{"fieldType":{"type":"string"},"optional":false},"body":{"fieldType":{"type":"string"},"optional":false}}}
machine/records:mcpAttachStoredText mutation internal {"type":"object","value":{"callerId":{"fieldType":{"type":"string"},"optional":false},"access":{"fieldType":{"type":"union","value":[{"type":"literal","value":"read"},{"type":"literal","value":"write"}]},"optional":false},"ref":{"fieldType":{"type":"string"},"optional":false},"name":{"fieldType":{"type":"string"},"optional":false},"content_type":{"fieldType":{"type":"string"},"optional":false},"size":{"fieldType":{"type":"number"},"optional":false},"storage_id":{"fieldType":{"type":"id","tableName":"_storage"},"optional":false}}}
machine/records:mcpAttachTextFile action internal {"type":"object","value":{"callerId":{"fieldType":{"type":"string"},"optional":false},"access":{"fieldType":{"type":"union","value":[{"type":"literal","value":"read"},{"type":"literal","value":"write"}]},"optional":false},"ref":{"fieldType":{"type":"string"},"optional":false},"name":{"fieldType":{"type":"string"},"optional":false},"text":{"fieldType":{"type":"string"},"optional":false},"content_type":{"fieldType":{"type":"string"},"optional":true}}}
machine/records:mcpCheckTextFile mutation internal {"type":"object","value":{"callerId":{"fieldType":{"type":"string"},"optional":false},"access":{"fieldType":{"type":"union","value":[{"type":"literal","value":"read"},{"type":"literal","value":"write"}]},"optional":false},"ref":{"fieldType":{"type":"string"},"optional":false},"name":{"fieldType":{"type":"string"},"optional":false},"content_type":{"fieldType":{"type":"string"},"optional":false},"size":{"fieldType":{"type":"number"},"optional":false}}}
machine/records:mcpConfirmUpload mutation internal {"type":"object","value":{"callerId":{"fieldType":{"type":"string"},"optional":false},"access":{"fieldType":{"type":"union","value":[{"type":"literal","value":"read"},{"type":"literal","value":"write"}]},"optional":false},"ref":{"fieldType":{"type":"string"},"optional":false},"ticket":{"fieldType":{"type":"string"},"optional":false},"storage_id":{"fieldType":{"type":"string"},"optional":false}}}
machine/records:mcpDeleteAttachment mutation internal {"type":"object","value":{"callerId":{"fieldType":{"type":"string"},"optional":false},"access":{"fieldType":{"type":"union","value":[{"type":"literal","value":"read"},{"type":"literal","value":"write"}]},"optional":false},"ref":{"fieldType":{"type":"string"},"optional":false},"attachment":{"fieldType":{"type":"string"},"optional":false}}}
machine/records:mcpStartUpload mutation internal {"type":"object","value":{"callerId":{"fieldType":{"type":"string"},"optional":false},"access":{"fieldType":{"type":"union","value":[{"type":"literal","value":"read"},{"type":"literal","value":"write"}]},"optional":false},"ref":{"fieldType":{"type":"string"},"optional":false},"name":{"fieldType":{"type":"string"},"optional":false},"size":{"fieldType":{"type":"number"},"optional":false},"content_type":{"fieldType":{"type":"string"},"optional":true}}}
machine/records:mcpTaskActivity query internal {"type":"object","value":{"callerId":{"fieldType":{"type":"string"},"optional":false},"access":{"fieldType":{"type":"union","value":[{"type":"literal","value":"read"},{"type":"literal","value":"write"}]},"optional":false},"ref":{"fieldType":{"type":"string"},"optional":false},"before":{"fieldType":{"type":"string"},"optional":true}}}
machine/records:mcpWorkload query internal {"type":"object","value":{"callerId":{"fieldType":{"type":"string"},"optional":false},"access":{"fieldType":{"type":"union","value":[{"type":"literal","value":"read"},{"type":"literal","value":"write"}]},"optional":false},"today":{"fieldType":{"type":"string"},"optional":false},"from_week":{"fieldType":{"type":"string"},"optional":true},"weeks":{"fieldType":{"type":"number"},"optional":true},"project":{"fieldType":{"type":"string"},"optional":true}}}
machine/records:restConfirmUpload mutation internal {"type":"object","value":{"callerId":{"fieldType":{"type":"string"},"optional":false},"access":{"fieldType":{"type":"union","value":[{"type":"literal","value":"read"},{"type":"literal","value":"write"}]},"optional":false},"keyName":{"fieldType":{"type":"union","value":[{"type":"string"},{"type":"null"}]},"optional":false},"ref":{"fieldType":{"type":"string"},"optional":false},"ticket":{"fieldType":{"type":"string"},"optional":false},"body":{"fieldType":{"type":"string"},"optional":false}}}
machine/records:restDeleteAttachment mutation internal {"type":"object","value":{"callerId":{"fieldType":{"type":"string"},"optional":false},"access":{"fieldType":{"type":"union","value":[{"type":"literal","value":"read"},{"type":"literal","value":"write"}]},"optional":false},"keyName":{"fieldType":{"type":"union","value":[{"type":"string"},{"type":"null"}]},"optional":false},"ref":{"fieldType":{"type":"string"},"optional":false},"id":{"fieldType":{"type":"string"},"optional":false},"body":{"fieldType":{"type":"string"},"optional":true}}}
machine/records:restListAttachments query internal {"type":"object","value":{"callerId":{"fieldType":{"type":"string"},"optional":false},"access":{"fieldType":{"type":"union","value":[{"type":"literal","value":"read"},{"type":"literal","value":"write"}]},"optional":false},"ref":{"fieldType":{"type":"string"},"optional":false}}}
machine/records:restStartUpload mutation internal {"type":"object","value":{"callerId":{"fieldType":{"type":"string"},"optional":false},"access":{"fieldType":{"type":"union","value":[{"type":"literal","value":"read"},{"type":"literal","value":"write"}]},"optional":false},"ref":{"fieldType":{"type":"string"},"optional":false},"body":{"fieldType":{"type":"string"},"optional":false}}}
machine/records:restTaskActivity query internal {"type":"object","value":{"callerId":{"fieldType":{"type":"string"},"optional":false},"access":{"fieldType":{"type":"union","value":[{"type":"literal","value":"read"},{"type":"literal","value":"write"}]},"optional":false},"ref":{"fieldType":{"type":"string"},"optional":false},"before":{"fieldType":{"type":"string"},"optional":true}}}
machine/records:restWorkload query internal {"type":"object","value":{"callerId":{"fieldType":{"type":"string"},"optional":false},"access":{"fieldType":{"type":"union","value":[{"type":"literal","value":"read"},{"type":"literal","value":"write"}]},"optional":false},"today":{"fieldType":{"type":"string"},"optional":false},"from_week":{"fieldType":{"type":"string"},"optional":true},"weeks":{"fieldType":{"type":"string"},"optional":true},"project":{"fieldType":{"type":"string"},"optional":true}}}
machine/rest:addComment mutation internal {"type":"object","value":{"callerId":{"fieldType":{"type":"string"},"optional":false},"access":{"fieldType":{"type":"union","value":[{"type":"literal","value":"read"},{"type":"literal","value":"write"}]},"optional":false},"ref":{"fieldType":{"type":"string"},"optional":false},"body":{"fieldType":{"type":"string"},"optional":false}}}
machine/rest:addLink mutation internal {"type":"object","value":{"callerId":{"fieldType":{"type":"string"},"optional":false},"access":{"fieldType":{"type":"union","value":[{"type":"literal","value":"read"},{"type":"literal","value":"write"}]},"optional":false},"keyName":{"fieldType":{"type":"union","value":[{"type":"string"},{"type":"null"}]},"optional":false},"ref":{"fieldType":{"type":"string"},"optional":false},"body":{"fieldType":{"type":"string"},"optional":false}}}
machine/rest:createIssue mutation internal {"type":"object","value":{"callerId":{"fieldType":{"type":"string"},"optional":false},"access":{"fieldType":{"type":"union","value":[{"type":"literal","value":"read"},{"type":"literal","value":"write"}]},"optional":false},"keyName":{"fieldType":{"type":"union","value":[{"type":"string"},{"type":"null"}]},"optional":false},"body":{"fieldType":{"type":"string"},"optional":false}}}
machine/rest:createLabel mutation internal {"type":"object","value":{"callerId":{"fieldType":{"type":"string"},"optional":false},"access":{"fieldType":{"type":"union","value":[{"type":"literal","value":"read"},{"type":"literal","value":"write"}]},"optional":false},"keyName":{"fieldType":{"type":"union","value":[{"type":"string"},{"type":"null"}]},"optional":false},"body":{"fieldType":{"type":"string"},"optional":false}}}
machine/rest:deleteIssue mutation internal {"type":"object","value":{"callerId":{"fieldType":{"type":"string"},"optional":false},"access":{"fieldType":{"type":"union","value":[{"type":"literal","value":"read"},{"type":"literal","value":"write"}]},"optional":false},"keyName":{"fieldType":{"type":"union","value":[{"type":"string"},{"type":"null"}]},"optional":false},"credential":{"fieldType":{"type":"object","value":{"profile_id":{"fieldType":{"type":"string"},"optional":false},"credential_table":{"fieldType":{"type":"union","value":[{"type":"literal","value":"agent_keys"},{"type":"literal","value":"mcp_tokens"},{"type":"literal","value":"oauth_connections"}]},"optional":false},"credential_id":{"fieldType":{"type":"string"},"optional":false},"credential_row_id":{"fieldType":{"type":"string"},"optional":false}}},"optional":false},"ref":{"fieldType":{"type":"string"},"optional":false},"body":{"fieldType":{"type":"string"},"optional":true}}}
machine/rest:getIssue query internal {"type":"object","value":{"callerId":{"fieldType":{"type":"string"},"optional":false},"access":{"fieldType":{"type":"union","value":[{"type":"literal","value":"read"},{"type":"literal","value":"write"}]},"optional":false},"today":{"fieldType":{"type":"string"},"optional":false},"ref":{"fieldType":{"type":"string"},"optional":false}}}
machine/rest:getMe query internal {"type":"object","value":{"callerId":{"fieldType":{"type":"string"},"optional":false},"access":{"fieldType":{"type":"union","value":[{"type":"literal","value":"read"},{"type":"literal","value":"write"}]},"optional":false},"credential":{"fieldType":{"type":"object","value":{"profile_id":{"fieldType":{"type":"string"},"optional":false},"credential_table":{"fieldType":{"type":"union","value":[{"type":"literal","value":"agent_keys"},{"type":"literal","value":"mcp_tokens"},{"type":"literal","value":"oauth_connections"}]},"optional":false},"credential_id":{"fieldType":{"type":"string"},"optional":false},"credential_row_id":{"fieldType":{"type":"string"},"optional":false}}},"optional":false}}}
machine/rest:getProject query internal {"type":"object","value":{"callerId":{"fieldType":{"type":"string"},"optional":false},"access":{"fieldType":{"type":"union","value":[{"type":"literal","value":"read"},{"type":"literal","value":"write"}]},"optional":false},"ref":{"fieldType":{"type":"string"},"optional":false}}}
machine/rest:getUser query internal {"type":"object","value":{"callerId":{"fieldType":{"type":"string"},"optional":false},"access":{"fieldType":{"type":"union","value":[{"type":"literal","value":"read"},{"type":"literal","value":"write"}]},"optional":false},"ref":{"fieldType":{"type":"string"},"optional":false}}}
machine/rest:listComments query internal {"type":"object","value":{"callerId":{"fieldType":{"type":"string"},"optional":false},"access":{"fieldType":{"type":"union","value":[{"type":"literal","value":"read"},{"type":"literal","value":"write"}]},"optional":false},"ref":{"fieldType":{"type":"string"},"optional":false},"limit":{"fieldType":{"type":"string"},"optional":true},"before":{"fieldType":{"type":"string"},"optional":true}}}
machine/rest:listIssues query internal {"type":"object","value":{"callerId":{"fieldType":{"type":"string"},"optional":false},"access":{"fieldType":{"type":"union","value":[{"type":"literal","value":"read"},{"type":"literal","value":"write"}]},"optional":false},"today":{"fieldType":{"type":"string"},"optional":false},"project":{"fieldType":{"type":"string"},"optional":true},"status":{"fieldType":{"type":"string"},"optional":true},"priority":{"fieldType":{"type":"string"},"optional":true},"assignee":{"fieldType":{"type":"string"},"optional":true},"owner":{"fieldType":{"type":"string"},"optional":true},"search":{"fieldType":{"type":"string"},"optional":true},"archived":{"fieldType":{"type":"string"},"optional":true},"limit":{"fieldType":{"type":"string"},"optional":true},"offset":{"fieldType":{"type":"string"},"optional":true},"cursor":{"fieldType":{"type":"string"},"optional":true}}}
machine/rest:listLabels query internal {"type":"object","value":{"callerId":{"fieldType":{"type":"string"},"optional":false},"access":{"fieldType":{"type":"union","value":[{"type":"literal","value":"read"},{"type":"literal","value":"write"}]},"optional":false}}}
machine/rest:listProjectUsers query internal {"type":"object","value":{"callerId":{"fieldType":{"type":"string"},"optional":false},"access":{"fieldType":{"type":"union","value":[{"type":"literal","value":"read"},{"type":"literal","value":"write"}]},"optional":false},"ref":{"fieldType":{"type":"string"},"optional":false}}}
machine/rest:listProjects query internal {"type":"object","value":{"callerId":{"fieldType":{"type":"string"},"optional":false},"access":{"fieldType":{"type":"union","value":[{"type":"literal","value":"read"},{"type":"literal","value":"write"}]},"optional":false},"archived":{"fieldType":{"type":"string"},"optional":true}}}
machine/rest:listUsers query internal {"type":"object","value":{"callerId":{"fieldType":{"type":"string"},"optional":false},"access":{"fieldType":{"type":"union","value":[{"type":"literal","value":"read"},{"type":"literal","value":"write"}]},"optional":false}}}
machine/rest:removeLink mutation internal {"type":"object","value":{"callerId":{"fieldType":{"type":"string"},"optional":false},"access":{"fieldType":{"type":"union","value":[{"type":"literal","value":"read"},{"type":"literal","value":"write"}]},"optional":false},"ref":{"fieldType":{"type":"string"},"optional":false},"kind":{"fieldType":{"type":"string"},"optional":false},"other":{"fieldType":{"type":"string"},"optional":false},"body":{"fieldType":{"type":"string"},"optional":true}}}
machine/rest:updateIssue mutation internal {"type":"object","value":{"callerId":{"fieldType":{"type":"string"},"optional":false},"access":{"fieldType":{"type":"union","value":[{"type":"literal","value":"read"},{"type":"literal","value":"write"}]},"optional":false},"keyName":{"fieldType":{"type":"union","value":[{"type":"string"},{"type":"null"}]},"optional":false},"ref":{"fieldType":{"type":"string"},"optional":false},"body":{"fieldType":{"type":"string"},"optional":false}}}
machine/rest:updateLabel mutation internal {"type":"object","value":{"callerId":{"fieldType":{"type":"string"},"optional":false},"access":{"fieldType":{"type":"union","value":[{"type":"literal","value":"read"},{"type":"literal","value":"write"}]},"optional":false},"ref":{"fieldType":{"type":"string"},"optional":false},"body":{"fieldType":{"type":"string"},"optional":false}}}
machine/rest:updateUser mutation internal {"type":"object","value":{"callerId":{"fieldType":{"type":"string"},"optional":false},"access":{"fieldType":{"type":"union","value":[{"type":"literal","value":"read"},{"type":"literal","value":"write"}]},"optional":false},"ref":{"fieldType":{"type":"string"},"optional":false},"body":{"fieldType":{"type":"string"},"optional":false}}}
machine/teams:mcpSetTeam mutation internal {"type":"object","value":{"callerId":{"fieldType":{"type":"string"},"optional":false},"access":{"fieldType":{"type":"union","value":[{"type":"literal","value":"read"},{"type":"literal","value":"write"}]},"optional":false},"team_id":{"fieldType":{"type":"string"},"optional":true},"name":{"fieldType":{"type":"string"},"optional":false},"expected":{"fieldType":{"type":"record","keys":{"type":"string"},"values":{"fieldType":{"type":"union","value":[{"type":"string"},{"type":"number"},{"type":"boolean"},{"type":"null"}]},"optional":false}},"optional":true}}}
machine/teams:mcpSetTeamMember mutation internal {"type":"object","value":{"callerId":{"fieldType":{"type":"string"},"optional":false},"access":{"fieldType":{"type":"union","value":[{"type":"literal","value":"read"},{"type":"literal","value":"write"}]},"optional":false},"team_id":{"fieldType":{"type":"string"},"optional":false},"user_id":{"fieldType":{"type":"string"},"optional":false},"member":{"fieldType":{"type":"boolean"},"optional":false},"leader":{"fieldType":{"type":"boolean"},"optional":true},"on_held_tasks":{"fieldType":{"type":"union","value":[{"type":"literal","value":"leave"},{"type":"literal","value":"keep_as_viewer"},{"type":"object","value":{"reassign_to":{"fieldType":{"type":"union","value":[{"type":"string"},{"type":"null"}]},"optional":false}}}]},"optional":true}}}
machine/teams:restCreateTeam mutation internal {"type":"object","value":{"callerId":{"fieldType":{"type":"string"},"optional":false},"access":{"fieldType":{"type":"union","value":[{"type":"literal","value":"read"},{"type":"literal","value":"write"}]},"optional":false},"body":{"fieldType":{"type":"string"},"optional":false}}}
machine/teams:restDeleteMember mutation internal {"type":"object","value":{"callerId":{"fieldType":{"type":"string"},"optional":false},"access":{"fieldType":{"type":"union","value":[{"type":"literal","value":"read"},{"type":"literal","value":"write"}]},"optional":false},"keyName":{"fieldType":{"type":"union","value":[{"type":"string"},{"type":"null"}]},"optional":false},"ref":{"fieldType":{"type":"string"},"optional":false},"user":{"fieldType":{"type":"string"},"optional":false},"body":{"fieldType":{"type":"string"},"optional":false}}}
machine/teams:restGetTeam query internal {"type":"object","value":{"callerId":{"fieldType":{"type":"string"},"optional":false},"access":{"fieldType":{"type":"union","value":[{"type":"literal","value":"read"},{"type":"literal","value":"write"}]},"optional":false},"ref":{"fieldType":{"type":"string"},"optional":false}}}
machine/teams:restListTeams query internal {"type":"object","value":{"callerId":{"fieldType":{"type":"string"},"optional":false},"access":{"fieldType":{"type":"union","value":[{"type":"literal","value":"read"},{"type":"literal","value":"write"}]},"optional":false}}}
machine/teams:restPutMember mutation internal {"type":"object","value":{"callerId":{"fieldType":{"type":"string"},"optional":false},"access":{"fieldType":{"type":"union","value":[{"type":"literal","value":"read"},{"type":"literal","value":"write"}]},"optional":false},"keyName":{"fieldType":{"type":"union","value":[{"type":"string"},{"type":"null"}]},"optional":false},"ref":{"fieldType":{"type":"string"},"optional":false},"user":{"fieldType":{"type":"string"},"optional":false},"body":{"fieldType":{"type":"string"},"optional":false}}}
machine/teams:restUpdateTeam mutation internal {"type":"object","value":{"callerId":{"fieldType":{"type":"string"},"optional":false},"access":{"fieldType":{"type":"union","value":[{"type":"literal","value":"read"},{"type":"literal","value":"write"}]},"optional":false},"ref":{"fieldType":{"type":"string"},"optional":false},"body":{"fieldType":{"type":"string"},"optional":false}}}
machine/testing:activateNamedCredentials mutation internal {"type":"object","value":{"profile_id":{"fieldType":{"type":"string"},"optional":false},"name":{"fieldType":{"type":"string"},"optional":false}}}
machine/testing:deleteCredential mutation internal {"type":"object","value":{"id":{"fieldType":{"type":"string"},"optional":false},"kind":{"fieldType":{"type":"union","value":[{"type":"literal","value":"agent_key"},{"type":"literal","value":"mcp_token"}]},"optional":false}}}
machine/testing:deleteNamedCredentials mutation internal {"type":"object","value":{"profile_id":{"fieldType":{"type":"string"},"optional":false},"name":{"fieldType":{"type":"string"},"optional":false}}}
machine/testing:deleteOldCredentials mutation internal {"type":"object","value":{"profile_id":{"fieldType":{"type":"string"},"optional":false},"name_prefix":{"fieldType":{"type":"string"},"optional":false},"created_before":{"fieldType":{"type":"string"},"optional":false}}}
machine/testing:mintCredential mutation internal {"type":"object","value":{"profile_id":{"fieldType":{"type":"string"},"optional":true},"email":{"fieldType":{"type":"string"},"optional":true},"agent_name":{"fieldType":{"type":"string"},"optional":true},"kind":{"fieldType":{"type":"union","value":[{"type":"literal","value":"agent_key"},{"type":"literal","value":"mcp_token"}]},"optional":false},"key_prefix":{"fieldType":{"type":"string"},"optional":false},"key_hash":{"fieldType":{"type":"string"},"optional":false},"name":{"fieldType":{"type":"string"},"optional":false},"access":{"fieldType":{"type":"union","value":[{"type":"literal","value":"read"},{"type":"literal","value":"write"}]},"optional":true},"expires_at":{"fieldType":{"type":"string"},"optional":true},"pending":{"fieldType":{"type":"literal","value":true},"optional":false}}}
machine/uploads:abandon mutation internal {"type":"object","value":{"ticket":{"fieldType":{"type":"string"},"optional":false},"minter":{"fieldType":{"type":"string"},"optional":false},"attempt":{"fieldType":{"type":"string"},"optional":false},"storage_id":{"fieldType":{"type":"id","tableName":"_storage"},"optional":true}}}
machine/uploads:begin mutation internal {"type":"object","value":{"ticket":{"fieldType":{"type":"string"},"optional":false},"minter":{"fieldType":{"type":"string"},"optional":false},"attempt":{"fieldType":{"type":"string"},"optional":false}}}
machine/uploads:finish mutation internal {"type":"object","value":{"ticket":{"fieldType":{"type":"string"},"optional":false},"minter":{"fieldType":{"type":"string"},"optional":false},"attempt":{"fieldType":{"type":"string"},"optional":false},"storage_id":{"fieldType":{"type":"id","tableName":"_storage"},"optional":false}}}
messages:bulkReach query public {"type":"object","value":{"action":{"fieldType":{"type":"union","value":[{"type":"literal","value":"read"},{"type":"literal","value":"remove"}]},"optional":false}}}
messages:markAllRead mutation public {"type":"object","value":{"before":{"fieldType":{"type":"number"},"optional":true},"org_id":{"fieldType":{"type":"string"},"optional":false}}}
messages:markRead mutation public {"type":"object","value":{"ids":{"fieldType":{"type":"array","value":{"type":"string"}},"optional":false},"org_id":{"fieldType":{"type":"string"},"optional":false}}}
messages:markUnread mutation public {"type":"object","value":{"ids":{"fieldType":{"type":"array","value":{"type":"string"}},"optional":false},"org_id":{"fieldType":{"type":"string"},"optional":false}}}
messages:notifyFollowers mutation internal {"type":"object","value":{"org_id":{"fieldType":{"type":"string"},"optional":false},"issue_id":{"fieldType":{"type":"string"},"optional":false},"task":{"fieldType":{"type":"id","tableName":"issues"},"optional":false},"project_id":{"fieldType":{"type":"string"},"optional":false},"actor_id":{"fieldType":{"type":"string"},"optional":true},"now":{"fieldType":{"type":"string"},"optional":false},"note":{"fieldType":{"type":"union","value":[{"type":"object","value":{"kind":{"fieldType":{"type":"literal","value":"comment"},"optional":false}}},{"type":"object","value":{"kind":{"fieldType":{"type":"literal","value":"change"},"optional":false},"parts":{"fieldType":{"type":"array","value":{"type":"string"}},"optional":false},"assigned":{"fieldType":{"type":"string"},"optional":true},"reviewer":{"fieldType":{"type":"string"},"optional":true},"handed":{"fieldType":{"type":"boolean"},"optional":false},"assignee_id":{"fieldType":{"type":"string"},"optional":true},"reviewer_id":{"fieldType":{"type":"string"},"optional":true},"parent":{"fieldType":{"type":"object","value":{"id":{"fieldType":{"type":"string"},"optional":false},"project_id":{"fieldType":{"type":"string"},"optional":false},"key":{"fieldType":{"type":"string"},"optional":false}}},"optional":true}}}]},"optional":false},"mentioned":{"fieldType":{"type":"array","value":{"type":"string"}},"optional":false},"after":{"fieldType":{"type":"string"},"optional":true}}}
messages:notifyMentions mutation internal {"type":"object","value":{"org_id":{"fieldType":{"type":"string"},"optional":false},"issue_id":{"fieldType":{"type":"string"},"optional":false},"task":{"fieldType":{"type":"id","tableName":"issues"},"optional":false},"project_id":{"fieldType":{"type":"string"},"optional":false},"actor_id":{"fieldType":{"type":"string"},"optional":true},"now":{"fieldType":{"type":"string"},"optional":false},"body":{"fieldType":{"type":"string"},"optional":false},"recipients":{"fieldType":{"type":"array","value":{"type":"string"}},"optional":false}}}
messages:readArchivedProject mutation internal {"type":"object","value":{"project_id":{"fieldType":{"type":"string"},"optional":false},"rest":{"fieldType":{"type":"array","value":{"type":"string"}},"optional":true},"cursor":{"fieldType":{"type":"string"},"optional":true},"batch":{"fieldType":{"type":"number"},"optional":true},"tasks":{"fieldType":{"type":"number"},"optional":true}}}
messages:readArchivedTasks mutation internal {"type":"object","value":{"issues":{"fieldType":{"type":"array","value":{"type":"string"}},"optional":false},"batch":{"fieldType":{"type":"number"},"optional":true}}}
messages:readItem mutation public {"type":"object","value":{"issue_id":{"fieldType":{"type":"string"},"optional":false},"through":{"fieldType":{"type":"number"},"optional":true},"org_id":{"fieldType":{"type":"string"},"optional":false}}}
messages:rekeyItems mutation internal {"type":"object","value":{"issues":{"fieldType":{"type":"array","value":{"type":"string"}},"optional":false}}}
messages:remove mutation public {"type":"object","value":{"ids":{"fieldType":{"type":"array","value":{"type":"string"}},"optional":false},"org_id":{"fieldType":{"type":"string"},"optional":false}}}
messages:removeItem mutation public {"type":"object","value":{"issue_id":{"fieldType":{"type":"string"},"optional":false},"through":{"fieldType":{"type":"number"},"optional":true},"org_id":{"fieldType":{"type":"string"},"optional":false}}}
messages:removeRead mutation public {"type":"object","value":{"org_id":{"fieldType":{"type":"string"},"optional":false}}}
messages:snooze mutation public {"type":"object","value":{"ids":{"fieldType":{"type":"array","value":{"type":"string"}},"optional":false},"until":{"fieldType":{"type":"union","value":[{"type":"string"},{"type":"null"}]},"optional":false},"org_id":{"fieldType":{"type":"string"},"optional":false}}}
messages:snoozeItem mutation public {"type":"object","value":{"issue_id":{"fieldType":{"type":"string"},"optional":false},"until":{"fieldType":{"type":"union","value":[{"type":"string"},{"type":"null"}]},"optional":false},"org_id":{"fieldType":{"type":"string"},"optional":false}}}
messages:trimItems mutation internal {"type":"object","value":{"issue_id":{"fieldType":{"type":"string"},"optional":false},"recipients":{"fieldType":{"type":"array","value":{"type":"string"}},"optional":false}}}
messages:unreadItem mutation public {"type":"object","value":{"issue_id":{"fieldType":{"type":"string"},"optional":false},"org_id":{"fieldType":{"type":"string"},"optional":false}}}
messages:wake mutation internal {"type":"object","value":{"recipient_id":{"fieldType":{"type":"string"},"optional":false},"issue_id":{"fieldType":{"type":"string"},"optional":false},"until":{"fieldType":{"type":"string"},"optional":false}}}
milestones:between query public {"type":"object","value":{"projects":{"fieldType":{"type":"array","value":{"type":"string"}},"optional":false},"from":{"fieldType":{"type":"string"},"optional":false},"to":{"fieldType":{"type":"string"},"optional":false},"after":{"fieldType":{"type":"object","value":{"week":{"fieldType":{"type":"string"},"optional":false},"key":{"fieldType":{"type":"string"},"optional":false},"id":{"fieldType":{"type":"string"},"optional":false}}},"optional":true}}}
milestones:get query public {"type":"object","value":{"id":{"fieldType":{"type":"string"},"optional":false}}}
milestones:section query public {"type":"object","value":{"projects":{"fieldType":{"type":"array","value":{"type":"string"}},"optional":false},"from":{"fieldType":{"type":"string"},"optional":false},"side":{"fieldType":{"type":"union","value":[{"type":"literal","value":"upcoming"},{"type":"literal","value":"past"}]},"optional":false},"search":{"fieldType":{"type":"string"},"optional":true},"after":{"fieldType":{"type":"object","value":{"week":{"fieldType":{"type":"string"},"optional":false},"key":{"fieldType":{"type":"string"},"optional":false},"id":{"fieldType":{"type":"string"},"optional":false}}},"optional":true},"limit":{"fieldType":{"type":"number"},"optional":false}}}
nameCopies:recover mutation internal {"type":"object","value":{}}
nameCopies:step mutation internal {"type":"object","value":{"source":{"fieldType":{"type":"union","value":[{"type":"literal","value":"profiles"},{"type":"literal","value":"teams"}]},"optional":false},"source_id":{"fieldType":{"type":"string"},"optional":false}}}
oauthAccess:lookupAccess query internal {"type":"object","value":{"tokenHash":{"fieldType":{"type":"string"},"optional":false},"resource":{"fieldType":{"type":"string"},"optional":false}}}
oauthAccess:refusedForDeletion query internal {"type":"object","value":{"tokenHash":{"fieldType":{"type":"string"},"optional":false},"resource":{"fieldType":{"type":"string"},"optional":false}}}
oauthAccess:touch mutation internal {"type":"object","value":{"id":{"fieldType":{"type":"string"},"optional":false}}}
oauthConnections:claimIssuance mutation internal {"type":"object","value":{"id":{"fieldType":{"type":"string"},"optional":false},"authUserId":{"fieldType":{"type":"string"},"optional":false},"clientId":{"fieldType":{"type":"string"},"optional":false},"resource":{"fieldType":{"type":"string"},"optional":false},"scopes":{"fieldType":{"type":"array","value":{"type":"string"}},"optional":false},"credentialHash":{"fieldType":{"type":"string"},"optional":false},"kind":{"fieldType":{"type":"union","value":[{"type":"literal","value":"authorization_code"},{"type":"literal","value":"refresh_token"}]},"optional":false}}}
oauthConnections:ensure mutation internal {"type":"object","value":{"authorizationHash":{"fieldType":{"type":"string"},"optional":false},"authUserId":{"fieldType":{"type":"string"},"optional":false},"clientId":{"fieldType":{"type":"string"},"optional":false},"clientName":{"fieldType":{"type":"string"},"optional":false},"resource":{"fieldType":{"type":"string"},"optional":false},"requestedScopes":{"fieldType":{"type":"array","value":{"type":"string"}},"optional":false},"scopes":{"fieldType":{"type":"array","value":{"type":"string"}},"optional":false},"approve":{"fieldType":{"type":"boolean"},"optional":false},"expiresAt":{"fieldType":{"type":"string"},"optional":false}}}
oauthConnections:forgetEndedSession mutation internal {"type":"object","value":{"id":{"fieldType":{"type":"id","tableName":"oauth_ended_sessions"},"optional":false}}}
oauthConnections:getContext mutation public {"type":"object","value":{"oauth_query":{"fieldType":{"type":"string"},"optional":false}}}
oauthConnections:hasHome query internal {"type":"object","value":{"authUserId":{"fieldType":{"type":"string"},"optional":false}}}
oauthConnections:list query public {"type":"object","value":{}}
oauthConnections:registerCode mutation internal {"type":"object","value":{"id":{"fieldType":{"type":"string"},"optional":false},"credentialHash":{"fieldType":{"type":"string"},"optional":false}}}
oauthConnections:revoke mutation public {"type":"object","value":{"id":{"fieldType":{"type":"string"},"optional":false}}}
oauthConnections:revokeReplay mutation internal {"type":"object","value":{"kind":{"fieldType":{"type":"union","value":[{"type":"literal","value":"authorization_code"},{"type":"literal","value":"refresh_token"}]},"optional":false},"credentialHash":{"fieldType":{"type":"string"},"optional":false},"clientId":{"fieldType":{"type":"string"},"optional":false}}}
oauthRegistrations:admit mutation internal {"type":"object","value":{"address":{"fieldType":{"type":"union","value":[{"type":"string"},{"type":"null"}]},"optional":false}}}
oauthRegistrations:sweepClients mutation internal {"type":"object","value":{"cursor":{"fieldType":{"type":"string"},"optional":true}}}
oauthRegistrations:sweepCounters mutation internal {"type":"object","value":{"after":{"fieldType":{"type":"string"},"optional":true}}}
orgExport:cancel mutation public {"type":"object","value":{"org_id":{"fieldType":{"type":"string"},"optional":false},"export_id":{"fieldType":{"type":"string"},"optional":false}}}
orgExport:commitFinish mutation internal {"type":"object","value":{"export_id":{"fieldType":{"type":"string"},"optional":false},"n":{"fieldType":{"type":"number"},"optional":false},"readme":{"fieldType":{"type":"object","value":{"storage_id":{"fieldType":{"type":"id","tableName":"_storage"},"optional":false},"raw_bytes":{"fieldType":{"type":"number"},"optional":false},"stored_bytes":{"fieldType":{"type":"number"},"optional":false},"crc32":{"fieldType":{"type":"number"},"optional":false}}},"optional":false},"manifest":{"fieldType":{"type":"object","value":{"storage_id":{"fieldType":{"type":"id","tableName":"_storage"},"optional":false},"raw_bytes":{"fieldType":{"type":"number"},"optional":false},"stored_bytes":{"fieldType":{"type":"number"},"optional":false},"crc32":{"fieldType":{"type":"number"},"optional":false}}},"optional":false}}}
orgExport:commitPart mutation internal {"type":"object","value":{"export_id":{"fieldType":{"type":"string"},"optional":false},"n":{"fieldType":{"type":"number"},"optional":false},"at":{"fieldType":{"type":"object","value":{"section":{"fieldType":{"type":"number"},"optional":false},"cursor":{"fieldType":{"type":"union","value":[{"type":"string"},{"type":"null"}]},"optional":false},"parents":{"fieldType":{"type":"object","value":{"ids":{"fieldType":{"type":"array","value":{"type":"string"}},"optional":false},"at":{"fieldType":{"type":"number"},"optional":false},"cursor":{"fieldType":{"type":"union","value":[{"type":"string"},{"type":"null"}]},"optional":false},"done":{"fieldType":{"type":"boolean"},"optional":false}}},"optional":true}}},"optional":false},"done":{"fieldType":{"type":"boolean"},"optional":false},"records":{"fieldType":{"type":"number"},"optional":false},"skipped":{"fieldType":{"type":"number"},"optional":false},"part":{"fieldType":{"type":"object","value":{"storage_id":{"fieldType":{"type":"id","tableName":"_storage"},"optional":false},"raw_bytes":{"fieldType":{"type":"number"},"optional":false},"stored_bytes":{"fieldType":{"type":"number"},"optional":false},"crc32":{"fieldType":{"type":"number"},"optional":false}}},"optional":true}}}
orgExport:erase mutation internal {"type":"object","value":{"export_id":{"fieldType":{"type":"string"},"optional":false}}}
orgExport:expire mutation internal {"type":"object","value":{"export_id":{"fieldType":{"type":"string"},"optional":false}}}
orgExport:finishInfo query internal {"type":"object","value":{"export_id":{"fieldType":{"type":"string"},"optional":false}}}
orgExport:page query public {"type":"object","value":{"section":{"fieldType":{"type":"union","value":[{"type":"literal","value":"organizations"},{"type":"literal","value":"teams"},{"type":"literal","value":"profiles"},{"type":"literal","value":"projects"},{"type":"literal","value":"issues"},{"type":"literal","value":"labels"},{"type":"literal","value":"activity_events"},{"type":"literal","value":"team_members"},{"type":"literal","value":"project_access"},{"type":"literal","value":"project_team_access"},{"type":"literal","value":"milestones"},{"type":"literal","value":"issue_links"},{"type":"literal","value":"issue_labels"},{"type":"literal","value":"issue_attachments"},{"type":"literal","value":"comments"},{"type":"literal","value":"agent_keys"}]},"optional":false},"parent_id":{"fieldType":{"type":"string"},"optional":true},"cursor":{"fieldType":{"type":"union","value":[{"type":"string"},{"type":"null"}]},"optional":false},"org_id":{"fieldType":{"type":"string"},"optional":false}}}
orgExport:readBatch query internal {"type":"object","value":{"org_id":{"fieldType":{"type":"string"},"optional":false},"at":{"fieldType":{"type":"object","value":{"section":{"fieldType":{"type":"number"},"optional":false},"cursor":{"fieldType":{"type":"union","value":[{"type":"string"},{"type":"null"}]},"optional":false},"parents":{"fieldType":{"type":"object","value":{"ids":{"fieldType":{"type":"array","value":{"type":"string"}},"optional":false},"at":{"fieldType":{"type":"number"},"optional":false},"cursor":{"fieldType":{"type":"union","value":[{"type":"string"},{"type":"null"}]},"optional":false},"done":{"fieldType":{"type":"boolean"},"optional":false}}},"optional":true}}},"optional":false}}}
orgExport:recover mutation internal {"type":"object","value":{}}
orgExport:request mutation public {"type":"object","value":{"org_id":{"fieldType":{"type":"string"},"optional":false}}}
orgExport:status query public {"type":"object","value":{"org_id":{"fieldType":{"type":"string"},"optional":false}}}
orgExport:step action internal {"type":"object","value":{"export_id":{"fieldType":{"type":"string"},"optional":false}}}
orgExport:stepState query internal {"type":"object","value":{"export_id":{"fieldType":{"type":"string"},"optional":false}}}
orgExport:sweep mutation internal {"type":"object","value":{}}
orgRemovals:abort mutation internal {"type":"object","value":{"org_id":{"fieldType":{"type":"string"},"optional":false}}}
orgRemovals:begin action internal {"type":"object","value":{"org_id":{"fieldType":{"type":"string"},"optional":false}}}
orgRemovals:beginDue query internal {"type":"object","value":{"org_id":{"fieldType":{"type":"string"},"optional":false}}}
orgRemovals:keep mutation public {"type":"object","value":{"org_id":{"fieldType":{"type":"string"},"optional":false}}}
orgRemovals:markDeleting mutation internal {"type":"object","value":{"org_id":{"fieldType":{"type":"string"},"optional":false}}}
orgRemovals:noCheckoutCandidate query internal {"type":"object","value":{"org_id":{"fieldType":{"type":"string"},"optional":false}}}
orgRemovals:noticeReady query internal {"type":"object","value":{"key":{"fieldType":{"type":"string"},"optional":false}}}
orgRemovals:noticeSent mutation internal {"type":"object","value":{"key":{"fieldType":{"type":"string"},"optional":false}}}
orgRemovals:recordExport mutation public {"type":"object","value":{"org_id":{"fieldType":{"type":"string"},"optional":false}}}
orgRemovals:recordRequest mutation internal {"type":"object","value":{"org_id":{"fieldType":{"type":"string"},"optional":false},"auth_user_id":{"fieldType":{"type":"string"},"optional":false}}}
orgRemovals:recover mutation internal {"type":"object","value":{}}
orgRemovals:request action public {"type":"object","value":{"confirm":{"fieldType":{"type":"string"},"optional":false},"org_id":{"fieldType":{"type":"string"},"optional":false}}}
orgRemovals:sendNotice action internal {"type":"object","value":{"notice_key":{"fieldType":{"type":"string"},"optional":false},"attempt":{"fieldType":{"type":"number"},"optional":true}}}
orgRemovals:startNoCheckout mutation internal {"type":"object","value":{"org_id":{"fieldType":{"type":"string"},"optional":false}}}
orgRemovals:state query public {"type":"object","value":{"org_id":{"fieldType":{"type":"string"},"optional":false}}}
orgRemovals:step mutation internal {"type":"object","value":{"org_id":{"fieldType":{"type":"string"},"optional":false}}}
orgRemovals:sweep mutation internal {"type":"object","value":{"lane":{"fieldType":{"type":"union","value":[{"type":"literal","value":"removals"},{"type":"literal","value":"due"},{"type":"literal","value":"unset"}]},"optional":true},"cursor":{"fieldType":{"type":"string"},"optional":true},"now":{"fieldType":{"type":"number"},"optional":true},"phase":{"fieldType":{"type":"string"},"optional":true}}}
orgRemovals:verifyNoCheckout action internal {"type":"object","value":{"org_id":{"fieldType":{"type":"string"},"optional":false}}}
orgs:setSlug mutation public {"type":"object","value":{"slug":{"fieldType":{"type":"string"},"optional":false},"expected":{"fieldType":{"type":"object","value":{"slug":{"fieldType":{"type":"string"},"optional":false}}},"optional":true},"org_id":{"fieldType":{"type":"string"},"optional":false}}}
orgs:update mutation public {"type":"object","value":{"patch":{"fieldType":{"type":"object","value":{"name":{"fieldType":{"type":"string"},"optional":true},"date_format":{"fieldType":{"type":"union","value":[{"type":"literal","value":"YYYY-MM-DD"},{"type":"literal","value":"DD/MM/YYYY"},{"type":"literal","value":"MM/DD/YYYY"},{"type":"literal","value":"DD.MM.YYYY"},{"type":"literal","value":"D MMM YYYY"},{"type":"literal","value":"MMM D, YYYY"}]},"optional":true},"week_start":{"fieldType":{"type":"number"},"optional":true},"week_one_rule":{"fieldType":{"type":"union","value":[{"type":"literal","value":"jan1"},{"type":"literal","value":"first4day"},{"type":"literal","value":"firstfull"}]},"optional":true},"default_plannable_hours":{"fieldType":{"type":"number"},"optional":true},"max_attachment_mb":{"fieldType":{"type":"number"},"optional":true},"project_creators":{"fieldType":{"type":"union","value":[{"type":"literal","value":"admins"},{"type":"literal","value":"users"},{"type":"literal","value":"selected"}]},"optional":true}}},"optional":false},"expected":{"fieldType":{"type":"object","value":{"name":{"fieldType":{"type":"string"},"optional":true},"date_format":{"fieldType":{"type":"string"},"optional":true},"week_start":{"fieldType":{"type":"number"},"optional":true},"week_one_rule":{"fieldType":{"type":"string"},"optional":true},"default_plannable_hours":{"fieldType":{"type":"number"},"optional":true},"max_attachment_mb":{"fieldType":{"type":"union","value":[{"type":"number"},{"type":"null"}]},"optional":true},"project_creators":{"fieldType":{"type":"union","value":[{"type":"string"},{"type":"null"}]},"optional":true},"slug":{"fieldType":{"type":"string"},"optional":true}}},"optional":true},"org_id":{"fieldType":{"type":"string"},"optional":false}}}
panoramaCuration:accept mutation public {"type":"object","value":{"id":{"fieldType":{"type":"string"},"optional":false},"expected_image_id":{"fieldType":{"type":"union","value":[{"type":"string"},{"type":"null"}]},"optional":false},"expected_agent_review_id":{"fieldType":{"type":"union","value":[{"type":"string"},{"type":"null"}]},"optional":true}}}
panoramaCuration:addLibraryFile action public {"type":"object","value":{"url":{"fieldType":{"type":"string"},"optional":false},"storage_id":{"fieldType":{"type":"id","tableName":"_storage"},"optional":false},"title":{"fieldType":{"type":"string"},"optional":false},"location":{"fieldType":{"type":"string"},"optional":true},"creator":{"fieldType":{"type":"string"},"optional":false},"license_confirmed":{"fieldType":{"type":"boolean"},"optional":false}}}
panoramaCuration:attachFile action public {"type":"object","value":{"submission_id":{"fieldType":{"type":"string"},"optional":false},"storage_id":{"fieldType":{"type":"id","tableName":"_storage"},"optional":false},"title":{"fieldType":{"type":"string"},"optional":false},"location":{"fieldType":{"type":"string"},"optional":true},"creator":{"fieldType":{"type":"string"},"optional":false},"license_confirmed":{"fieldType":{"type":"boolean"},"optional":false}}}
panoramaCuration:attachVerifiedFile mutation internal {"type":"object","value":{"submission_id":{"fieldType":{"type":"string"},"optional":false},"storage_id":{"fieldType":{"type":"id","tableName":"_storage"},"optional":false},"title":{"fieldType":{"type":"string"},"optional":false},"location":{"fieldType":{"type":"string"},"optional":true},"creator":{"fieldType":{"type":"string"},"optional":false},"license_confirmed":{"fieldType":{"type":"boolean"},"optional":false},"width":{"fieldType":{"type":"number"},"optional":false},"height":{"fieldType":{"type":"number"},"optional":false},"auth_user_id":{"fieldType":{"type":"string"},"optional":false}}}
panoramaCuration:authorize mutation internal {"type":"object","value":{"hash":{"fieldType":{"type":"string"},"optional":false}}}
panoramaCuration:decline mutation public {"type":"object","value":{"id":{"fieldType":{"type":"string"},"optional":false},"note":{"fieldType":{"type":"string"},"optional":true}}}
panoramaCuration:keys query public {"type":"object","value":{}}
panoramaCuration:libraryImage query public {"type":"object","value":{"id":{"fieldType":{"type":"string"},"optional":false}}}
panoramaCuration:machineImage query internal {"type":"object","value":{"key_id":{"fieldType":{"type":"string"},"optional":false},"id":{"fieldType":{"type":"string"},"optional":false}}}
panoramaCuration:machineImages query internal {"type":"object","value":{"key_id":{"fieldType":{"type":"string"},"optional":false},"cursor":{"fieldType":{"type":"string"},"optional":true},"status":{"fieldType":{"type":"union","value":[{"type":"literal","value":"pending"},{"type":"literal","value":"approved"},{"type":"literal","value":"removed"}]},"optional":true},"agent_review":{"fieldType":{"type":"union","value":[{"type":"literal","value":"unreviewed"},{"type":"literal","value":"approved"},{"type":"literal","value":"declined"}]},"optional":true}}}
panoramaCuration:machineReview mutation internal {"type":"object","value":{"key_id":{"fieldType":{"type":"string"},"optional":false},"id":{"fieldType":{"type":"string"},"optional":false},"decision":{"fieldType":{"type":"union","value":[{"type":"literal","value":"approved"},{"type":"literal","value":"declined"}]},"optional":false},"reason":{"fieldType":{"type":"string"},"optional":false},"day":{"fieldType":{"type":"string"},"optional":true}}}
panoramaCuration:machineReviewSubmission mutation internal {"type":"object","value":{"key_id":{"fieldType":{"type":"string"},"optional":false},"id":{"fieldType":{"type":"string"},"optional":false},"decision":{"fieldType":{"type":"union","value":[{"type":"literal","value":"approved"},{"type":"literal","value":"declined"}]},"optional":false},"reason":{"fieldType":{"type":"string"},"optional":false}}}
panoramaCuration:machineSubmission query internal {"type":"object","value":{"key_id":{"fieldType":{"type":"string"},"optional":false},"id":{"fieldType":{"type":"string"},"optional":false}}}
panoramaCuration:machineSubmissions query internal {"type":"object","value":{"key_id":{"fieldType":{"type":"string"},"optional":false},"cursor":{"fieldType":{"type":"string"},"optional":true}}}
panoramaCuration:machineSubmit mutation internal {"type":"object","value":{"key_id":{"fieldType":{"type":"string"},"optional":false},"request_id":{"fieldType":{"type":"string"},"optional":true},"input":{"fieldType":{"type":"object","value":{"url":{"fieldType":{"type":"string"},"optional":false},"date":{"fieldType":{"type":"string"},"optional":false},"title":{"fieldType":{"type":"string"},"optional":true},"creator":{"fieldType":{"type":"string"},"optional":true},"reason":{"fieldType":{"type":"string"},"optional":true}}},"optional":false}}}
panoramaCuration:mintKey mutation public {"type":"object","value":{"name":{"fieldType":{"type":"string"},"optional":false}}}
panoramaCuration:prepareLibraryUpload mutation public {"type":"object","value":{"url":{"fieldType":{"type":"string"},"optional":false}}}
panoramaCuration:retainLibraryFile mutation internal {"type":"object","value":{"source_url":{"fieldType":{"type":"string"},"optional":false},"source_id":{"fieldType":{"type":"string"},"optional":false},"storage_id":{"fieldType":{"type":"id","tableName":"_storage"},"optional":false},"title":{"fieldType":{"type":"string"},"optional":false},"location":{"fieldType":{"type":"string"},"optional":true},"creator":{"fieldType":{"type":"string"},"optional":false},"license_confirmed":{"fieldType":{"type":"boolean"},"optional":false},"width":{"fieldType":{"type":"number"},"optional":false},"height":{"fieldType":{"type":"number"},"optional":false},"auth_user_id":{"fieldType":{"type":"string"},"optional":false}}}
panoramaCuration:revokeKey mutation public {"type":"object","value":{"id":{"fieldType":{"type":"string"},"optional":false}}}
panoramaCuration:submissions query public {"type":"object","value":{"cursor":{"fieldType":{"type":"string"},"optional":true}}}
panoramaCuration:uploadUrl mutation public {"type":"object","value":{"submission_id":{"fieldType":{"type":"string"},"optional":false}}}
panoramaImages:approve mutation public {"type":"object","value":{"id":{"fieldType":{"type":"string"},"optional":false},"expected_agent_review_id":{"fieldType":{"type":"union","value":[{"type":"string"},{"type":"null"}]},"optional":true}}}
panoramaImages:assignDate mutation public {"type":"object","value":{"day":{"fieldType":{"type":"string"},"optional":false},"image_id":{"fieldType":{"type":"union","value":[{"type":"string"},{"type":"null"}]},"optional":false}}}
panoramaImages:calendar query public {"type":"object","value":{}}
panoramaImages:discardImport mutation internal {"type":"object","value":{"storage_id":{"fieldType":{"type":"id","tableName":"_storage"},"optional":false}}}
panoramaImages:forDate query internal {"type":"object","value":{"date":{"fieldType":{"type":"string"},"optional":false}}}
panoramaImages:library query public {"type":"object","value":{"status":{"fieldType":{"type":"union","value":[{"type":"literal","value":"pending"},{"type":"literal","value":"approved"},{"type":"literal","value":"removed"}]},"optional":true},"cursor":{"fieldType":{"type":"string"},"optional":true},"agent_review":{"fieldType":{"type":"union","value":[{"type":"literal","value":"unreviewed"},{"type":"literal","value":"approved"},{"type":"literal","value":"declined"}]},"optional":true}}}
panoramaImages:remove mutation public {"type":"object","value":{"id":{"fieldType":{"type":"string"},"optional":false},"note":{"fieldType":{"type":"string"},"optional":true}}}
panoramaImages:setDefaultImage mutation public {"type":"object","value":{"image_id":{"fieldType":{"type":"union","value":[{"type":"string"},{"type":"null"}]},"optional":false}}}
panoramaImages:summary query public {"type":"object","value":{}}
panoramaUploads:addFile action public {"type":"object","value":{"storage_id":{"fieldType":{"type":"id","tableName":"_storage"},"optional":false},"title":{"fieldType":{"type":"string"},"optional":false},"location":{"fieldType":{"type":"string"},"optional":true},"creator":{"fieldType":{"type":"string"},"optional":false},"rights_confirmed":{"fieldType":{"type":"boolean"},"optional":false},"source_url":{"fieldType":{"type":"string"},"optional":true}}}
panoramaUploads:retainFile mutation internal {"type":"object","value":{"storage_id":{"fieldType":{"type":"id","tableName":"_storage"},"optional":false},"title":{"fieldType":{"type":"string"},"optional":false},"location":{"fieldType":{"type":"string"},"optional":true},"creator":{"fieldType":{"type":"string"},"optional":false},"rights_confirmed":{"fieldType":{"type":"boolean"},"optional":false},"source_url":{"fieldType":{"type":"string"},"optional":true},"width":{"fieldType":{"type":"number"},"optional":false},"height":{"fieldType":{"type":"number"},"optional":false},"auth_user_id":{"fieldType":{"type":"string"},"optional":false}}}
panoramaUploads:uploadUrl mutation public {"type":"object","value":{}}
planning:assigneeLoad query public {"type":"object","value":{"assignee_id":{"fieldType":{"type":"string"},"optional":false}}}
prefs:get query public {"type":"object","value":{"profile_id":{"fieldType":{"type":"string"},"optional":true}}}
prefs:save mutation public {"type":"object","value":{"profile_id":{"fieldType":{"type":"string"},"optional":false},"prefs":{"fieldType":{"type":"any"},"optional":false}}}
profileRemovals:recover mutation internal {"type":"object","value":{}}
profileRemovals:step mutation internal {"type":"object","value":{"profile_id":{"fieldType":{"type":"string"},"optional":false}}}
profiles:create mutation public {"type":"object","value":{"id":{"fieldType":{"type":"string"},"optional":false},"name":{"fieldType":{"type":"string"},"optional":false},"email":{"fieldType":{"type":"union","value":[{"type":"string"},{"type":"null"}]},"optional":true},"org_role":{"fieldType":{"type":"union","value":[{"type":"literal","value":"admin"},{"type":"literal","value":"user"},{"type":"literal","value":"guest"},{"type":"literal","value":"viewer"}]},"optional":false},"kind":{"fieldType":{"type":"union","value":[{"type":"literal","value":"person"},{"type":"literal","value":"agent"}]},"optional":false},"color":{"fieldType":{"type":"string"},"optional":false},"teams":{"fieldType":{"type":"array","value":{"type":"string"}},"optional":true},"org_id":{"fieldType":{"type":"string"},"optional":false}}}
profiles:deactivate mutation public {"type":"object","value":{"id":{"fieldType":{"type":"string"},"optional":false},"org_id":{"fieldType":{"type":"string"},"optional":false}}}
profiles:remove mutation public {"type":"object","value":{"id":{"fieldType":{"type":"string"},"optional":false},"org_id":{"fieldType":{"type":"string"},"optional":false}}}
profiles:setDisplayName mutation public {"type":"object","value":{"name":{"fieldType":{"type":"string"},"optional":false},"expected":{"fieldType":{"type":"object","value":{"profile_id":{"fieldType":{"type":"string"},"optional":false},"name":{"fieldType":{"type":"string"},"optional":false}}},"optional":true}}}
profiles:setMessageRetention mutation public {"type":"object","value":{"days":{"fieldType":{"type":"union","value":[{"type":"number"},{"type":"null"}]},"optional":false}}}
profiles:setPlannableHours mutation public {"type":"object","value":{"profile_id":{"fieldType":{"type":"string"},"optional":false},"hours":{"fieldType":{"type":"number"},"optional":false},"expected":{"fieldType":{"type":"object","value":{"plannable_hours":{"fieldType":{"type":"union","value":[{"type":"number"},{"type":"null"}]},"optional":false}}},"optional":true},"org_id":{"fieldType":{"type":"string"},"optional":false}}}
profiles:update mutation public {"type":"object","value":{"id":{"fieldType":{"type":"string"},"optional":false},"patch":{"fieldType":{"type":"object","value":{"org_role":{"fieldType":{"type":"union","value":[{"type":"literal","value":"admin"},{"type":"literal","value":"user"},{"type":"literal","value":"guest"},{"type":"literal","value":"viewer"}]},"optional":true},"active":{"fieldType":{"type":"boolean"},"optional":true},"name":{"fieldType":{"type":"string"},"optional":true},"email":{"fieldType":{"type":"union","value":[{"type":"string"},{"type":"null"}]},"optional":true},"teams":{"fieldType":{"type":"array","value":{"type":"string"}},"optional":true},"can_create_projects":{"fieldType":{"type":"boolean"},"optional":true}}},"optional":false},"expected":{"fieldType":{"type":"object","value":{"org_role":{"fieldType":{"type":"string"},"optional":true},"active":{"fieldType":{"type":"boolean"},"optional":true},"name":{"fieldType":{"type":"union","value":[{"type":"string"},{"type":"null"}]},"optional":true},"email":{"fieldType":{"type":"union","value":[{"type":"string"},{"type":"null"}]},"optional":true},"can_create_projects":{"fieldType":{"type":"union","value":[{"type":"boolean"},{"type":"null"}]},"optional":true},"plannable_hours":{"fieldType":{"type":"union","value":[{"type":"number"},{"type":"null"}]},"optional":true},"avatar_storage_id":{"fieldType":{"type":"union","value":[{"type":"string"},{"type":"null"}]},"optional":true}}},"optional":true},"org_id":{"fieldType":{"type":"string"},"optional":false}}}
projects:addMilestone mutation public {"type":"object","value":{"id":{"fieldType":{"type":"string"},"optional":false},"project_id":{"fieldType":{"type":"string"},"optional":false},"name":{"fieldType":{"type":"string"},"optional":false},"week":{"fieldType":{"type":"string"},"optional":false},"org_id":{"fieldType":{"type":"string"},"optional":false}}}
projects:archive mutation public {"type":"object","value":{"id":{"fieldType":{"type":"string"},"optional":false},"org_id":{"fieldType":{"type":"string"},"optional":false}}}
projects:create mutation public {"type":"object","value":{"id":{"fieldType":{"type":"string"},"optional":false},"type":{"fieldType":{"type":"union","value":[{"type":"literal","value":"meta"},{"type":"literal","value":"project"}]},"optional":false},"team_id":{"fieldType":{"type":"union","value":[{"type":"string"},{"type":"null"}]},"optional":true},"parent_id":{"fieldType":{"type":"union","value":[{"type":"string"},{"type":"null"}]},"optional":true},"key":{"fieldType":{"type":"string"},"optional":false},"name":{"fieldType":{"type":"string"},"optional":false},"lead_id":{"fieldType":{"type":"union","value":[{"type":"string"},{"type":"null"}]},"optional":true},"description":{"fieldType":{"type":"union","value":[{"type":"string"},{"type":"null"}]},"optional":true},"sort_order":{"fieldType":{"type":"number"},"optional":false},"track_delay":{"fieldType":{"type":"boolean"},"optional":true},"access":{"fieldType":{"type":"record","keys":{"type":"string"},"values":{"fieldType":{"type":"union","value":[{"type":"union","value":[{"type":"literal","value":"user"},{"type":"literal","value":"viewer"}]},{"type":"literal","value":"lead"},{"type":"null"}]},"optional":false}},"optional":true},"team_access":{"fieldType":{"type":"record","keys":{"type":"string"},"values":{"fieldType":{"type":"union","value":[{"type":"literal","value":"user"},{"type":"literal","value":"viewer"}]},"optional":false}},"optional":true},"org_id":{"fieldType":{"type":"string"},"optional":false}}}
projects:deleteDeep mutation public {"type":"object","value":{"id":{"fieldType":{"type":"string"},"optional":false},"reason":{"fieldType":{"type":"string"},"optional":true},"org_id":{"fieldType":{"type":"string"},"optional":false}}}
projects:inviteGuest mutation public {"type":"object","value":{"project_id":{"fieldType":{"type":"string"},"optional":false},"email":{"fieldType":{"type":"string"},"optional":false},"level":{"fieldType":{"type":"string"},"optional":false},"expected":{"fieldType":{"type":"object","value":{"level":{"fieldType":{"type":"union","value":[{"type":"union","value":[{"type":"literal","value":"user"},{"type":"literal","value":"viewer"}]},{"type":"null"}]},"optional":false}}},"optional":true},"org_id":{"fieldType":{"type":"string"},"optional":false}}}
projects:removalSummary query public {"type":"object","value":{"id":{"fieldType":{"type":"string"},"optional":false},"org_id":{"fieldType":{"type":"string"},"optional":false}}}
projects:removeAccess mutation public {"type":"object","value":{"id":{"fieldType":{"type":"string"},"optional":false},"user_id":{"fieldType":{"type":"string"},"optional":true},"team_id":{"fieldType":{"type":"string"},"optional":true},"on_held_tasks":{"fieldType":{"type":"union","value":[{"type":"literal","value":"leave"},{"type":"literal","value":"keep_as_viewer"},{"type":"object","value":{"reassign_to":{"fieldType":{"type":"union","value":[{"type":"string"},{"type":"null"}]},"optional":false}}}]},"optional":false},"org_id":{"fieldType":{"type":"string"},"optional":false}}}
projects:removeMilestone mutation public {"type":"object","value":{"id":{"fieldType":{"type":"string"},"optional":false},"expected":{"fieldType":{"type":"object","value":{"name":{"fieldType":{"type":"string"},"optional":true},"week":{"fieldType":{"type":"string"},"optional":true}}},"optional":true},"org_id":{"fieldType":{"type":"string"},"optional":false}}}
projects:setAccess mutation public {"type":"object","value":{"id":{"fieldType":{"type":"string"},"optional":false},"user_id":{"fieldType":{"type":"string"},"optional":true},"team_id":{"fieldType":{"type":"string"},"optional":true},"level":{"fieldType":{"type":"union","value":[{"type":"literal","value":"user"},{"type":"literal","value":"viewer"}]},"optional":false},"expected":{"fieldType":{"type":"object","value":{"level":{"fieldType":{"type":"union","value":[{"type":"union","value":[{"type":"literal","value":"user"},{"type":"literal","value":"viewer"}]},{"type":"null"}]},"optional":false}}},"optional":true},"org_id":{"fieldType":{"type":"string"},"optional":false}}}
projects:unarchive mutation public {"type":"object","value":{"id":{"fieldType":{"type":"string"},"optional":false},"org_id":{"fieldType":{"type":"string"},"optional":false}}}
projects:update mutation public {"type":"object","value":{"id":{"fieldType":{"type":"string"},"optional":false},"patch":{"fieldType":{"type":"object","value":{"name":{"fieldType":{"type":"string"},"optional":true},"lead_id":{"fieldType":{"type":"union","value":[{"type":"string"},{"type":"null"}]},"optional":true},"description":{"fieldType":{"type":"union","value":[{"type":"string"},{"type":"null"}]},"optional":true},"key":{"fieldType":{"type":"string"},"optional":true},"track_delay":{"fieldType":{"type":"boolean"},"optional":true},"review_hours":{"fieldType":{"type":"union","value":[{"type":"number"},{"type":"null"}]},"optional":true},"access":{"fieldType":{"type":"record","keys":{"type":"string"},"values":{"fieldType":{"type":"union","value":[{"type":"union","value":[{"type":"literal","value":"user"},{"type":"literal","value":"viewer"}]},{"type":"literal","value":"lead"}]},"optional":false}},"optional":true},"team_access":{"fieldType":{"type":"record","keys":{"type":"string"},"values":{"fieldType":{"type":"union","value":[{"type":"literal","value":"user"},{"type":"literal","value":"viewer"}]},"optional":false}},"optional":true}}},"optional":false},"expected":{"fieldType":{"type":"object","value":{"name":{"fieldType":{"type":"string"},"optional":true},"description":{"fieldType":{"type":"union","value":[{"type":"string"},{"type":"null"}]},"optional":true},"key":{"fieldType":{"type":"string"},"optional":true},"track_delay":{"fieldType":{"type":"boolean"},"optional":true},"review_hours":{"fieldType":{"type":"union","value":[{"type":"number"},{"type":"null"}]},"optional":true},"lead_id":{"fieldType":{"type":"union","value":[{"type":"string"},{"type":"null"}]},"optional":true}}},"optional":true},"org_id":{"fieldType":{"type":"string"},"optional":false}}}
projects:updateMilestone mutation public {"type":"object","value":{"id":{"fieldType":{"type":"string"},"optional":false},"patch":{"fieldType":{"type":"object","value":{"name":{"fieldType":{"type":"string"},"optional":true},"week":{"fieldType":{"type":"string"},"optional":true}}},"optional":false},"expected":{"fieldType":{"type":"object","value":{"name":{"fieldType":{"type":"string"},"optional":true},"week":{"fieldType":{"type":"string"},"optional":true}}},"optional":true},"org_id":{"fieldType":{"type":"string"},"optional":false}}}
regroup:restoredStep mutation internal {"type":"object","value":{"projects":{"fieldType":{"type":"array","value":{"type":"string"}},"optional":false},"at":{"fieldType":{"type":"number"},"optional":true},"cursor":{"fieldType":{"type":"string"},"optional":true},"after":{"fieldType":{"type":"object","value":{"time":{"fieldType":{"type":"number"},"optional":false},"ids":{"fieldType":{"type":"array","value":{"type":"string"}},"optional":false}}},"optional":true},"restorer_id":{"fieldType":{"type":"string"},"optional":false}}}
roadmap:change mutation public {"type":"object","value":{"session_id":{"fieldType":{"type":"string"},"optional":false},"operations":{"fieldType":{"type":"array","value":{"type":"union","value":[{"type":"object","value":{"kind":{"fieldType":{"type":"literal","value":"task"},"optional":false},"id":{"fieldType":{"type":"string"},"optional":false},"patch":{"fieldType":{"type":"object","value":{"start_week":{"fieldType":{"type":"union","value":[{"type":"string"},{"type":"null"}]},"optional":true},"end_week":{"fieldType":{"type":"union","value":[{"type":"string"},{"type":"null"}]},"optional":true},"remaining_hours":{"fieldType":{"type":"union","value":[{"type":"number"},{"type":"null"}]},"optional":true}}},"optional":false},"expected":{"fieldType":{"type":"object","value":{"start_week":{"fieldType":{"type":"union","value":[{"type":"string"},{"type":"null"}]},"optional":true},"end_week":{"fieldType":{"type":"union","value":[{"type":"string"},{"type":"null"}]},"optional":true},"remaining_hours":{"fieldType":{"type":"union","value":[{"type":"number"},{"type":"null"}]},"optional":true}}},"optional":true}}},{"type":"object","value":{"kind":{"fieldType":{"type":"literal","value":"milestone_create"},"optional":false},"id":{"fieldType":{"type":"string"},"optional":false},"project_id":{"fieldType":{"type":"string"},"optional":false},"name":{"fieldType":{"type":"string"},"optional":false},"week":{"fieldType":{"type":"string"},"optional":false}}},{"type":"object","value":{"kind":{"fieldType":{"type":"literal","value":"milestone_update"},"optional":false},"id":{"fieldType":{"type":"string"},"optional":false},"patch":{"fieldType":{"type":"object","value":{"name":{"fieldType":{"type":"string"},"optional":true},"week":{"fieldType":{"type":"string"},"optional":true}}},"optional":false},"expected":{"fieldType":{"type":"object","value":{"name":{"fieldType":{"type":"string"},"optional":true},"week":{"fieldType":{"type":"string"},"optional":true}}},"optional":true}}},{"type":"object","value":{"kind":{"fieldType":{"type":"literal","value":"milestone_remove"},"optional":false},"id":{"fieldType":{"type":"string"},"optional":false},"expected":{"fieldType":{"type":"object","value":{"name":{"fieldType":{"type":"string"},"optional":true},"week":{"fieldType":{"type":"string"},"optional":true}}},"optional":true}}}]}},"optional":false}}}
roadmap:expire mutation internal {"type":"object","value":{"auth_user_id":{"fieldType":{"type":"string"},"optional":false},"session_id":{"fieldType":{"type":"string"},"optional":false},"expires_at":{"fieldType":{"type":"number"},"optional":false}}}
roadmap:undo mutation public {"type":"object","value":{"session_id":{"fieldType":{"type":"string"},"optional":false},"all":{"fieldType":{"type":"boolean"},"optional":false}}}
search:page query public {"type":"object","value":{"text":{"fieldType":{"type":"string"},"optional":false},"include_archived":{"fieldType":{"type":"boolean"},"optional":false},"scope":{"fieldType":{"type":"object","value":{"org_id":{"fieldType":{"type":"string"},"optional":false},"project_id":{"fieldType":{"type":"string"},"optional":true}}},"optional":true},"cursor":{"fieldType":{"type":"string"},"optional":true}}}
snapshot:commentsBefore query public {"type":"object","value":{"issue_id":{"fieldType":{"type":"string"},"optional":false},"before":{"fieldType":{"type":"string"},"optional":false},"org_id":{"fieldType":{"type":"string"},"optional":false}}}
snapshot:historyBefore query public {"type":"object","value":{"issue_id":{"fieldType":{"type":"string"},"optional":false},"before":{"fieldType":{"type":"string"},"optional":false},"org_id":{"fieldType":{"type":"string"},"optional":false}}}
snapshot:threadComments query public {"type":"object","value":{"issue_id":{"fieldType":{"type":"string"},"optional":false},"org_id":{"fieldType":{"type":"string"},"optional":false}}}
snapshot:threadHistory query public {"type":"object","value":{"issue_id":{"fieldType":{"type":"string"},"optional":false},"org_id":{"fieldType":{"type":"string"},"optional":false}}}
taskWindow:attachments query public {"type":"object","value":{"issue_id":{"fieldType":{"type":"string"},"optional":false},"org_id":{"fieldType":{"type":"string"},"optional":false}}}
taskWindow:links query public {"type":"object","value":{"issue_id":{"fieldType":{"type":"string"},"optional":false},"org_id":{"fieldType":{"type":"string"},"optional":false}}}
taskWindow:task query public {"type":"object","value":{"ref":{"fieldType":{"type":"string"},"optional":false},"org_id":{"fieldType":{"type":"string"},"optional":false}}}
teamSync:lastComments query public {"type":"object","value":{"owner_ids":{"fieldType":{"type":"array","value":{"type":"string"}},"optional":false},"org_id":{"fieldType":{"type":"string"},"optional":false}}}
teamSync:stamp mutation public {"type":"object","value":{"profile_id":{"fieldType":{"type":"string"},"optional":false},"first_since":{"fieldType":{"type":"string"},"optional":true},"org_id":{"fieldType":{"type":"string"},"optional":false}}}
teams:addMember mutation public {"type":"object","value":{"team_id":{"fieldType":{"type":"string"},"optional":false},"profile_id":{"fieldType":{"type":"string"},"optional":false},"org_id":{"fieldType":{"type":"string"},"optional":false}}}
teams:create mutation public {"type":"object","value":{"id":{"fieldType":{"type":"string"},"optional":false},"name":{"fieldType":{"type":"string"},"optional":false},"org_id":{"fieldType":{"type":"string"},"optional":false}}}
teams:deleteDeep mutation public {"type":"object","value":{"id":{"fieldType":{"type":"string"},"optional":false},"on_held_tasks":{"fieldType":{"type":"union","value":[{"type":"literal","value":"leave"},{"type":"literal","value":"keep_as_viewer"},{"type":"object","value":{"reassign_to":{"fieldType":{"type":"union","value":[{"type":"string"},{"type":"null"}]},"optional":false}}}]},"optional":true},"expected":{"fieldType":{"type":"object","value":{"name":{"fieldType":{"type":"string"},"optional":true},"track_delay_default":{"fieldType":{"type":"boolean"},"optional":true}}},"optional":true},"org_id":{"fieldType":{"type":"string"},"optional":false}}}
teams:removeMember mutation public {"type":"object","value":{"team_id":{"fieldType":{"type":"string"},"optional":false},"profile_id":{"fieldType":{"type":"string"},"optional":false},"on_held_tasks":{"fieldType":{"type":"union","value":[{"type":"literal","value":"leave"},{"type":"literal","value":"keep_as_viewer"},{"type":"object","value":{"reassign_to":{"fieldType":{"type":"union","value":[{"type":"string"},{"type":"null"}]},"optional":false}}}]},"optional":true},"org_id":{"fieldType":{"type":"string"},"optional":false}}}
teams:setLeader mutation public {"type":"object","value":{"team_id":{"fieldType":{"type":"string"},"optional":false},"profile_id":{"fieldType":{"type":"string"},"optional":false},"is_leader":{"fieldType":{"type":"boolean"},"optional":false},"org_id":{"fieldType":{"type":"string"},"optional":false}}}
teams:update mutation public {"type":"object","value":{"id":{"fieldType":{"type":"string"},"optional":false},"patch":{"fieldType":{"type":"object","value":{"name":{"fieldType":{"type":"string"},"optional":true},"track_delay_default":{"fieldType":{"type":"boolean"},"optional":true}}},"optional":false},"expected":{"fieldType":{"type":"object","value":{"name":{"fieldType":{"type":"string"},"optional":true},"track_delay_default":{"fieldType":{"type":"boolean"},"optional":true}}},"optional":true},"org_id":{"fieldType":{"type":"string"},"optional":false}}}
tokens:createAgentKey mutation public {"type":"object","value":{"id":{"fieldType":{"type":"string"},"optional":false},"agent_id":{"fieldType":{"type":"string"},"optional":false},"name":{"fieldType":{"type":"string"},"optional":false},"key_prefix":{"fieldType":{"type":"string"},"optional":false},"key_hash":{"fieldType":{"type":"string"},"optional":false},"org_id":{"fieldType":{"type":"string"},"optional":false}}}
tokens:createMcpToken mutation public {"type":"object","value":{"id":{"fieldType":{"type":"string"},"optional":false},"profile_id":{"fieldType":{"type":"string"},"optional":false},"name":{"fieldType":{"type":"string"},"optional":false},"token_prefix":{"fieldType":{"type":"string"},"optional":false},"token_hash":{"fieldType":{"type":"string"},"optional":false},"access":{"fieldType":{"type":"union","value":[{"type":"literal","value":"read"},{"type":"literal","value":"write"}]},"optional":false},"expires_at":{"fieldType":{"type":"string"},"optional":true}}}
tokens:deleteAgentKey mutation public {"type":"object","value":{"id":{"fieldType":{"type":"string"},"optional":false},"org_id":{"fieldType":{"type":"string"},"optional":false}}}
tokens:deleteMcpToken mutation public {"type":"object","value":{"id":{"fieldType":{"type":"string"},"optional":false}}}
tokens:listAgentKeys query public {"type":"object","value":{}}
tokens:listMcpTokens query public {"type":"object","value":{}}
tokens:revokeAgentKey mutation public {"type":"object","value":{"id":{"fieldType":{"type":"string"},"optional":false},"org_id":{"fieldType":{"type":"string"},"optional":false}}}
tokens:revokeMcpToken mutation public {"type":"object","value":{"id":{"fieldType":{"type":"string"},"optional":false}}}
usage:activity query internal {"type":"object","value":{"org_id":{"fieldType":{"type":"string"},"optional":false},"month":{"fieldType":{"type":"string"},"optional":false},"cursor":{"fieldType":{"type":"union","value":[{"type":"string"},{"type":"null"}]},"optional":false}}}
usage:api query internal {"type":"object","value":{"org_id":{"fieldType":{"type":"string"},"optional":false},"key":{"fieldType":{"type":"string"},"optional":false},"cursor":{"fieldType":{"type":"union","value":[{"type":"string"},{"type":"null"}]},"optional":false}}}
usage:backgrounds query internal {"type":"object","value":{"cursor":{"fieldType":{"type":"union","value":[{"type":"string"},{"type":"null"}]},"optional":false}}}
usage:claimStep mutation internal {"type":"object","value":{"month":{"fieldType":{"type":"string"},"optional":false},"run":{"fieldType":{"type":"string"},"optional":true},"fresh":{"fieldType":{"type":"boolean"},"optional":false},"now":{"fieldType":{"type":"number"},"optional":false}}}
usage:closeMonth action internal {"type":"object","value":{"month":{"fieldType":{"type":"string"},"optional":true},"run":{"fieldType":{"type":"string"},"optional":true}}}
usage:closeOrgMonth action internal {"type":"object","value":{"org_id":{"fieldType":{"type":"string"},"optional":false},"month":{"fieldType":{"type":"string"},"optional":false}}}
usage:comments query internal {"type":"object","value":{"org_id":{"fieldType":{"type":"string"},"optional":false},"month":{"fieldType":{"type":"string"},"optional":false},"cursor":{"fieldType":{"type":"union","value":[{"type":"string"},{"type":"null"}]},"optional":false}}}
usage:countPersonMail mutation internal {"type":"object","value":{"metric":{"fieldType":{"type":"union","value":[{"type":"literal","value":"mail_verification"},{"type":"literal","value":"mail_password_reset"},{"type":"literal","value":"mail_account_notes"}]},"optional":false}}}
usage:deleted query internal {"type":"object","value":{"org_id":{"fieldType":{"type":"string"},"optional":false},"cursor":{"fieldType":{"type":"union","value":[{"type":"string"},{"type":"null"}]},"optional":false}}}
usage:endStep mutation internal {"type":"object","value":{"month":{"fieldType":{"type":"string"},"optional":false},"run":{"fieldType":{"type":"string"},"optional":false},"cursor":{"fieldType":{"type":"union","value":[{"type":"string"},{"type":"null"}]},"optional":false},"saved":{"fieldType":{"type":"number"},"optional":false},"failed":{"fieldType":{"type":"number"},"optional":false},"background_bytes":{"fieldType":{"type":"union","value":[{"type":"number"},{"type":"null"}]},"optional":true},"held_file_bytes":{"fieldType":{"type":"union","value":[{"type":"number"},{"type":"null"}]},"optional":true}}}
usage:expire mutation internal {"type":"object","value":{}}
usage:files query internal {"type":"object","value":{"org_id":{"fieldType":{"type":"string"},"optional":false},"cursor":{"fieldType":{"type":"union","value":[{"type":"string"},{"type":"null"}]},"optional":false}}}
usage:forgetLogin mutation internal {"type":"object","value":{"auth_user_id":{"fieldType":{"type":"string"},"optional":false}}}
usage:head query internal {"type":"object","value":{"org_id":{"fieldType":{"type":"string"},"optional":false},"month":{"fieldType":{"type":"string"},"optional":false},"now":{"fieldType":{"type":"number"},"optional":false}}}
usage:heldFiles query internal {"type":"object","value":{"cursor":{"fieldType":{"type":"union","value":[{"type":"string"},{"type":"null"}]},"optional":false}}}
usage:keepSignIn mutation internal {"type":"object","value":{"auth_user_id":{"fieldType":{"type":"string"},"optional":false},"created_at":{"fieldType":{"type":"number"},"optional":false},"updated_at":{"fieldType":{"type":"number"},"optional":false}}}
usage:monthRows query internal {"type":"object","value":{"month":{"fieldType":{"type":"string"},"optional":false},"cursor":{"fieldType":{"type":"union","value":[{"type":"string"},{"type":"null"}]},"optional":false}}}
usage:monthTable action public {"type":"object","value":{"month":{"fieldType":{"type":"string"},"optional":false}}}
usage:orgMonths action public {"type":"object","value":{"org_id":{"fieldType":{"type":"string"},"optional":false}}}
usage:orgPage query internal {"type":"object","value":{"cursor":{"fieldType":{"type":"union","value":[{"type":"string"},{"type":"null"}]},"optional":false},"before":{"fieldType":{"type":"string"},"optional":false}}}
usage:orgPeople action public {"type":"object","value":{"org_id":{"fieldType":{"type":"string"},"optional":false},"month":{"fieldType":{"type":"string"},"optional":false}}}
usage:orgRows query internal {"type":"object","value":{"org_id":{"fieldType":{"type":"string"},"optional":false}}}
usage:profileNames query internal {"type":"object","value":{"org_id":{"fieldType":{"type":"string"},"optional":false},"ids":{"fieldType":{"type":"array","value":{"type":"string"}},"optional":false}}}
usage:profiles query internal {"type":"object","value":{"org_id":{"fieldType":{"type":"string"},"optional":false},"month":{"fieldType":{"type":"string"},"optional":false},"cursor":{"fieldType":{"type":"union","value":[{"type":"string"},{"type":"null"}]},"optional":false}}}
usage:retained query internal {"type":"object","value":{"org_id":{"fieldType":{"type":"string"},"optional":false},"month":{"fieldType":{"type":"string"},"optional":false}}}
usage:saveMonth mutation internal {"type":"object","value":{"org_id":{"fieldType":{"type":"string"},"optional":false},"month":{"fieldType":{"type":"string"},"optional":false},"counts":{"fieldType":{"type":"object","value":{"billable":{"fieldType":{"type":"number"},"optional":false},"guests":{"fieldType":{"type":"number"},"optional":false},"agents":{"fieldType":{"type":"number"},"optional":false},"active_people":{"fieldType":{"type":"number"},"optional":false},"active_tasks":{"fieldType":{"type":"union","value":[{"type":"number"},{"type":"null"}]},"optional":false},"live_projects":{"fieldType":{"type":"union","value":[{"type":"number"},{"type":"null"}]},"optional":false},"changes":{"fieldType":{"type":"number"},"optional":false},"comments":{"fieldType":{"type":"number"},"optional":false},"api_calls":{"fieldType":{"type":"number"},"optional":false},"file_bytes":{"fieldType":{"type":"number"},"optional":false},"image_bytes":{"fieldType":{"type":"number"},"optional":false},"deleted_file_bytes":{"fieldType":{"type":"number"},"optional":false},"avatar_bytes":{"fieldType":{"type":"number"},"optional":false},"webhook_deliveries":{"fieldType":{"type":"number"},"optional":false},"webhook_attempts":{"fieldType":{"type":"number"},"optional":false},"mail_invitations":{"fieldType":{"type":"number"},"optional":false},"mail_billing_reminders":{"fieldType":{"type":"number"},"optional":false},"mail_deletion_notices":{"fieldType":{"type":"number"},"optional":false}}},"optional":false},"api_estimated":{"fieldType":{"type":"boolean"},"optional":false},"run":{"fieldType":{"type":"string"},"optional":true}}}
usage:sessions query internal {"type":"object","value":{"auth_user_id":{"fieldType":{"type":"string"},"optional":false},"month":{"fieldType":{"type":"string"},"optional":false},"cursor":{"fieldType":{"type":"union","value":[{"type":"string"},{"type":"null"}]},"optional":false}}}
usage:status query internal {"type":"object","value":{"month":{"fieldType":{"type":"string"},"optional":false}}}
usage:statuses query internal {"type":"object","value":{}}
usage:taskComments query internal {"type":"object","value":{"task_id":{"fieldType":{"type":"string"},"optional":false},"month":{"fieldType":{"type":"string"},"optional":false},"cursor":{"fieldType":{"type":"union","value":[{"type":"string"},{"type":"null"}]},"optional":false}}}
usage:unattributed query internal {"type":"object","value":{"month":{"fieldType":{"type":"string"},"optional":false}}}
usage:webhooks query internal {"type":"object","value":{"org_id":{"fieldType":{"type":"string"},"optional":false},"month":{"fieldType":{"type":"string"},"optional":false},"cursor":{"fieldType":{"type":"union","value":[{"type":"string"},{"type":"null"}]},"optional":false}}}
webhookActions:deliver action internal {"type":"object","value":{"id":{"fieldType":{"type":"string"},"optional":false}}}
webhookActions:manage action internal {"type":"object","value":{"owner":{"fieldType":{"type":"object","value":{"profile_id":{"fieldType":{"type":"string"},"optional":false},"credential_table":{"fieldType":{"type":"union","value":[{"type":"literal","value":"agent_keys"},{"type":"literal","value":"mcp_tokens"},{"type":"literal","value":"oauth_connections"}]},"optional":false},"credential_id":{"fieldType":{"type":"string"},"optional":false},"credential_row_id":{"fieldType":{"type":"string"},"optional":false}}},"optional":false},"method":{"fieldType":{"type":"string"},"optional":false},"params_json":{"fieldType":{"type":"string"},"optional":false}}}
webhookQueue:dispatch mutation internal {"type":"object","value":{}}
webhookQueue:expand mutation internal {"type":"object","value":{}}
webhookQueue:run mutation internal {"type":"object","value":{"kind":{"fieldType":{"type":"union","value":[{"type":"literal","value":"expand"},{"type":"literal","value":"dispatch"}]},"optional":false},"generation":{"fieldType":{"type":"string"},"optional":false}}}
webhooks:authorize query internal {"type":"object","value":{"owner":{"fieldType":{"type":"object","value":{"profile_id":{"fieldType":{"type":"string"},"optional":false},"credential_table":{"fieldType":{"type":"union","value":[{"type":"literal","value":"agent_keys"},{"type":"literal","value":"mcp_tokens"},{"type":"literal","value":"oauth_connections"}]},"optional":false},"credential_id":{"fieldType":{"type":"string"},"optional":false},"credential_row_id":{"fieldType":{"type":"string"},"optional":false}}},"optional":false},"filters":{"fieldType":{"type":"object","value":{"task_id":{"fieldType":{"type":"string"},"optional":true},"project_id":{"fieldType":{"type":"string"},"optional":true}}},"optional":false}}}
webhooks:claim mutation internal {"type":"object","value":{"id":{"fieldType":{"type":"string"},"optional":false}}}
webhooks:finish mutation internal {"type":"object","value":{"id":{"fieldType":{"type":"string"},"optional":false},"attempt":{"fieldType":{"type":"number"},"optional":false},"status":{"fieldType":{"type":"number"},"optional":false}}}
webhooks:list query internal {"type":"object","value":{"owner":{"fieldType":{"type":"object","value":{"profile_id":{"fieldType":{"type":"string"},"optional":false},"credential_table":{"fieldType":{"type":"union","value":[{"type":"literal","value":"agent_keys"},{"type":"literal","value":"mcp_tokens"},{"type":"literal","value":"oauth_connections"}]},"optional":false},"credential_id":{"fieldType":{"type":"string"},"optional":false},"credential_row_id":{"fieldType":{"type":"string"},"optional":false}}},"optional":false}}}
webhooks:listOrganization query internal {"type":"object","value":{"owner":{"fieldType":{"type":"object","value":{"profile_id":{"fieldType":{"type":"string"},"optional":false},"credential_table":{"fieldType":{"type":"union","value":[{"type":"literal","value":"agent_keys"},{"type":"literal","value":"mcp_tokens"},{"type":"literal","value":"oauth_connections"}]},"optional":false},"credential_id":{"fieldType":{"type":"string"},"optional":false},"credential_row_id":{"fieldType":{"type":"string"},"optional":false}}},"optional":false}}}
webhooks:remove mutation internal {"type":"object","value":{"owner":{"fieldType":{"type":"object","value":{"profile_id":{"fieldType":{"type":"string"},"optional":false},"credential_table":{"fieldType":{"type":"union","value":[{"type":"literal","value":"agent_keys"},{"type":"literal","value":"mcp_tokens"},{"type":"literal","value":"oauth_connections"}]},"optional":false},"credential_id":{"fieldType":{"type":"string"},"optional":false},"credential_row_id":{"fieldType":{"type":"string"},"optional":false}}},"optional":false},"id":{"fieldType":{"type":"string"},"optional":false}}}
webhooks:removeOrganization mutation internal {"type":"object","value":{"owner":{"fieldType":{"type":"object","value":{"profile_id":{"fieldType":{"type":"string"},"optional":false},"credential_table":{"fieldType":{"type":"union","value":[{"type":"literal","value":"agent_keys"},{"type":"literal","value":"mcp_tokens"},{"type":"literal","value":"oauth_connections"}]},"optional":false},"credential_id":{"fieldType":{"type":"string"},"optional":false},"credential_row_id":{"fieldType":{"type":"string"},"optional":false}}},"optional":false},"id":{"fieldType":{"type":"string"},"optional":false}}}
webhooks:save mutation internal {"type":"object","value":{"owner":{"fieldType":{"type":"object","value":{"profile_id":{"fieldType":{"type":"string"},"optional":false},"credential_table":{"fieldType":{"type":"union","value":[{"type":"literal","value":"agent_keys"},{"type":"literal","value":"mcp_tokens"},{"type":"literal","value":"oauth_connections"}]},"optional":false},"credential_id":{"fieldType":{"type":"string"},"optional":false},"credential_row_id":{"fieldType":{"type":"string"},"optional":false}}},"optional":false},"id":{"fieldType":{"type":"string"},"optional":false},"name":{"fieldType":{"type":"union","value":[{"type":"literal","value":"task.created"},{"type":"literal","value":"task.updated"},{"type":"literal","value":"task.deleted"},{"type":"literal","value":"task.restored"},{"type":"literal","value":"comment.created"}]},"optional":false},"filters":{"fieldType":{"type":"object","value":{"task_id":{"fieldType":{"type":"string"},"optional":true},"project_id":{"fieldType":{"type":"string"},"optional":true}}},"optional":false},"url":{"fieldType":{"type":"string"},"optional":false},"encrypted_secret":{"fieldType":{"type":"string"},"optional":false},"secret_hash":{"fieldType":{"type":"string"},"optional":true},"legacy_secret_hash":{"fieldType":{"type":"string"},"optional":true},"expires_at":{"fieldType":{"type":"number"},"optional":true}}}
webhooks:sweep mutation internal {"type":"object","value":{}}
workspace:catalog query public {"type":"object","value":{"org_id":{"fieldType":{"type":"string"},"optional":false}}}
workspace:inbox query public {"type":"object","value":{"org_id":{"fieldType":{"type":"string"},"optional":false}}}
workspace:people query public {"type":"object","value":{"from":{"fieldType":{"type":"string"},"optional":false},"to":{"fieldType":{"type":"union","value":[{"type":"string"},{"type":"null"}]},"optional":false},"org_id":{"fieldType":{"type":"string"},"optional":false}}}
workspace:projects query public {"type":"object","value":{"from":{"fieldType":{"type":"string"},"optional":false},"to":{"fieldType":{"type":"union","value":[{"type":"string"},{"type":"null"}]},"optional":false},"org_id":{"fieldType":{"type":"string"},"optional":false}}}
workspace:root query public {"type":"object","value":{"seatless":{"fieldType":{"type":"literal","value":"all"},"optional":true}}}
workspace:tasks query public {"type":"object","value":{"from":{"fieldType":{"type":"string"},"optional":false},"to":{"fieldType":{"type":"union","value":[{"type":"string"},{"type":"null"}]},"optional":false},"org_id":{"fieldType":{"type":"string"},"optional":false}}}
`
  .trim()
  .split('\n')

describe('the function-surface manifest', () => {
  it('every registered function matches the committed row, byte for byte', () => {
    if (actual.join('\n') !== MANIFEST.join('\n')) {
      console.log(
        '--- actual surface (paste over the MANIFEST block) ---\n' +
          actual.join('\n') +
          '\n--- end ---',
      )
    }
    expect(actual).toEqual(MANIFEST)
  })
})

/* ------------------------------------------------------- the public subset */

/* Auth posture per public door, hand-grouped. `org*`/`adminMutation`/
 * `accessRemovalMutation`/`seatQuery` consume a wrapper-injected org_id
 * wire arg (`seatQuery` answers without a seat instead of refusing);
 * `accessRemovalMutation` lets an org admin past the billing gate for writes
 * that only take access away. `authed*` gate on a login only; `platform*`
 * gate on a platform_admins row. `query` marks the ONE deliberate bare
 * registration (see the wrapper rule below). */
type Wrapper =
  | 'orgAction'
  | 'orgQuery'
  | 'orgMutation'
  | 'adminMutation'
  | 'accessRemovalMutation'
  | 'authedQuery'
  | 'authedMutation'
  | 'seatQuery'
  | 'platformQuery'
  | 'platformMutation'
  | 'platformAction'
  | 'query'
  | 'demoConfigurationQuery'
  | 'demoLifecycleQuery'
  | 'demoBootstrapMutation'

const PUBLIC: Record<string, Record<string, Wrapper>> = {
  // Billing details/usage require an org admin; status reveals only the
  // caller's org entitlement. Checkout and portal re-check admin identity in
  // orgAction and remain available during billing recovery/read-only access.
  billing: { summary: 'orgQuery', usageReport: 'orgAction', status: 'orgQuery' },
  // API access pages every member's credentials, their period figures and
  // the person filter's people for an org admin (checked in the handlers)
  // and revokes any of them; revoking only takes access away, so it stays
  // open to admins during a billing pause.
  apiAccess: {
    summary: 'orgQuery',
    page: 'orgQuery',
    people: 'orgQuery',
    revoke: 'accessRemovalMutation',
  },
  billingActions: {
    checkout: 'orgAction',
    portal: 'orgAction',
    // An admin stops renewal, so the subscription ends with its paid period;
    // the action's internal query repeats the admin check, as for checkout
    // and the portal.
    cancelSubscription: 'orgAction',
    createPlan: 'platformAction',
    connectPlan: 'platformAction',
  },
  // Operators manage immutable plan versions, default future assignments and
  // complimentary grants. No normal customer can change commercial terms.
  adminBilling: {
    listPlans: 'platformQuery',
    orgBilling: 'platformQuery',
    setDefaultPlan: 'platformMutation',
    assignPlan: 'platformMutation',
    grantComplimentary: 'platformMutation',
  },
  // Aggregate demo usage is visible only to enrolled platform operators.
  adminDemo: { metrics: 'platformQuery' },
  // Configuration discloses only deployment mode/admission; lifecycle exposes
  // only the current identity; provisioning binds the server-created receipt.
  demo: {
    configuration: 'demoConfigurationQuery',
    current: 'demoLifecycleQuery',
    ensureMine: 'demoBootstrapMutation',
  },
  // Browser roadmap visits atomically record changes and replay only the
  // authenticated owner's receipts, rechecking current rights per project.
  roadmap: { change: 'authedMutation', undo: 'authedMutation' },
  // Self-service OAuth consent preparation freezes the displayed home seat;
  // listing and disconnection expose only the signed-in person's connections.
  oauthConnections: {
    getContext: 'authedMutation',
    list: 'authedQuery',
    revoke: 'authedMutation',
  },
  // Operator photo review and recurring calendar controls. These are
  // platform-wide editorial operations, never org-admin or ordinary-user doors.
  panoramaImages: {
    summary: 'platformQuery',
    library: 'platformQuery',
    calendar: 'platformQuery',
    approve: 'platformMutation',
    remove: 'platformMutation',
    assignDate: 'platformMutation',
    // Operator-selected approved fallback for otherwise empty calendar dates.
    setDefaultImage: 'platformMutation',
  },
  admin: {
    // bare on purpose — the AdminGate's fail-OPEN probe answers false, never
    // throws (admin.ts documents it); every real admin door below re-checks.
    isOperator: 'query',
    promoteOrgAdmin: 'platformMutation',
    auditLog: 'platformQuery',
  },
  // The organization table, platform totals and organization names page
  // through the data in actions, each page a bounded internal query
  // (adminStats.ts).
  adminStats: {
    listOrgs: 'platformAction',
    orgNames: 'platformAction',
    platformStats: 'platformAction',
  },
  // The Users page and an organization's page page through the data the same
  // way (adminPeople.ts).
  adminPeople: {
    userPage: 'platformAction',
    orgDetail: 'platformAction',
  },
  // The Usage page reads stored months and computes the current one and a
  // month's people the same way (usage.ts).
  usage: {
    monthTable: 'platformAction',
    orgMonths: 'platformAction',
    orgPeople: 'platformAction',
  },
  adminAuth: {
    recoveryLink: 'platformAction',
    banUser: 'platformAction',
    unbanUser: 'platformAction',
    createBreakGlass: 'platformAction',
  },
  // Operators create organizations and manage their invitations and roles.
  // Actions send the invitation email after the seat mutation commits.
  adminOrgs: {
    suggestAddress: 'platformQuery',
    checkAddress: 'platformQuery',
    checkPeople: 'platformQuery',
    createOrganization: 'platformAction',
    invitePeople: 'platformAction',
    resendInvite: 'platformAction',
    editInvite: 'platformAction',
    cancelInvite: 'platformMutation',
    setMemberRole: 'platformMutation',
  },
  comments: {
    create: 'orgMutation',
    update: 'orgMutation',
    remove: 'orgMutation',
    // starts a task's comment count after a post was refused while it counts
    countThread: 'orgMutation',
  },
  // Deleted items spans organizations like Archived projects: list, item
  // and matches read every active seat and judge each item with the seat in
  // its organization. restore acts in one organization; Delete now (purge) is
  // for its admins. Each loads items through the same not_found fence.
  deletedItems: {
    list: 'authedQuery',
    item: 'authedQuery',
    matches: 'authedQuery',
    restore: 'orgMutation',
    purge: 'adminMutation',
  },
  files: {
    uploadUrl: 'orgMutation',
    avatarUploadUrl: 'authedMutation',
    attach: 'orgMutation',
    removeAttachment: 'orgMutation',
    setAvatar: 'authedMutation',
    clearAvatar: 'authedMutation',
    mintUrls: 'orgQuery',
  },
  identity: {
    claimMySeats: 'authedMutation',
    whoami: 'authedQuery',
    createOrganization: 'authedMutation',
    acceptInvitation: 'authedMutation',
  },
  // The inbox reads over inbox_items, the capped unread summary across the
  // login's own seats and one task's own item in one organization, which is
  // null unless the caller is shown the task.
  inbox: { summary: 'authedQuery', item: 'orgQuery' },
  // Whether the invitation emails behind pending seats went out: an org admin
  // sees every pending seat, anyone else only the sends they caused.
  invites: { deliveries: 'orgQuery', sendAgain: 'orgMutation' },
  issues: {
    // the Archived tasks page: some projects of one organization or all of
    // them; ids the caller cannot see and an organization without their
    // seat answer an empty last page
    archivedPage: 'authedQuery',
    // the task window's own task in the archive, by id; null unless
    // archivedPage lists it for the caller
    archivedTask: 'authedQuery',
    create: 'orgMutation',
    update: 'orgMutation',
    move: 'orgMutation',
    // The Parent picker's Create new parent task: create and attach in one
    // write, so a refused attach leaves no new task.
    createParent: 'orgMutation',
    // The Link picker's Create new linked task: create and link in one
    // write, so a refused link leaves no new task.
    createLinked: 'orgMutation',
    // The Move window asks whether a move carries subtasks, archived ones
    // included; it answers false unless the caller can edit both ends.
    moveCarriesSubtasks: 'orgQuery',
    archive: 'orgMutation',
    unarchive: 'orgMutation',
    deleteDeep: 'orgMutation',
    addLink: 'orgMutation',
    removeLink: 'orgMutation',
    subscribe: 'orgMutation',
    unsubscribe: 'orgMutation',
    // The task popover reads its roster and lets managing-team leaders/admins
    // change other subscriptions, with current project visibility checked.
    subscribers: 'orgQuery',
    setSubscriber: 'orgMutation',
  },
  // Settings > Labels (settingsPage, organization admins only) and the task
  // label picker (picker, every seat) read the labels a batch at a time in
  // name order; byIds looks up the labels a task shows that no batch holds.
  labels: {
    create: 'orgMutation',
    update: 'orgMutation',
    remove: 'orgMutation',
    toggle: 'orgMutation',
    settingsPage: 'orgQuery',
    picker: 'orgQuery',
    byIds: 'orgQuery',
  },
  // removeRead clears current read rows in bounded batches beyond the Inbox display limit.
  // markAllRead reaches all own unread rows beyond the display cap and preserves later arrivals.
  // bulkReach, a read across the caller's seats, says how much those two have to do in
  // each seat before they start, from the caller's own rows only.
  // snooze hides an own item until a server-scheduled wake (messages:wake, internal).
  // Archiving schedules messages:readArchivedTasks and readArchivedProject (internal), and
  // a task archive also archiveMarks:markTasks; a restore archiveMarks:clearTasks (internal).
  // A comment or change past its first followers, and every bulk save, schedules
  // messages:notifyFollowers (internal) to tell the rest, and a write whose
  // notices fill its room schedules messages:notifyMentions (internal) for
  // the people it mentions past that.
  // The item actions act on the caller's own item about one task, up to the
  // newest message the caller saw (readItem, removeItem).
  messages: {
    bulkReach: 'authedQuery',
    markAllRead: 'orgMutation',
    markRead: 'orgMutation',
    markUnread: 'orgMutation',
    readItem: 'orgMutation',
    remove: 'orgMutation',
    removeItem: 'orgMutation',
    removeRead: 'orgMutation',
    snooze: 'orgMutation',
    snoozeItem: 'orgMutation',
    unreadItem: 'orgMutation',
  },
  // The app's bounded milestone reads span organizations like Deleted
  // items. Each named project is judged with the seat in its own
  // organization, and an unknown or invisible project or milestone reads as
  // absent, never refused.
  milestones: { between: 'authedQuery', get: 'authedQuery', section: 'authedQuery' },
  // Organization export for org admins. page is the browser export's
  // paginated read; orgQuery authenticates the active seat and the handler
  // positively requires admin on every page. status reads the export job;
  // request and cancel check the admin seat themselves, because the
  // read-only gate on orgMutation would refuse them while the organization
  // is read-only before deletion, when exports matter most.
  orgExport: {
    page: 'orgQuery',
    status: 'orgQuery',
    request: 'authedMutation',
    cancel: 'authedMutation',
  },
  // Admins delete the organization after its read-only period, stop a
  // deletion they asked for and record finished exports. keep and
  // recordExport check the admin seat themselves, because the read-only
  // gate on orgMutation would refuse them exactly when they matter.
  orgRemovals: {
    request: 'orgAction',
    keep: 'authedMutation',
    state: 'orgQuery',
    recordExport: 'authedMutation',
  },
  orgs: { update: 'adminMutation', setSlug: 'adminMutation' },
  planning: { assigneeLoad: 'authedQuery' },
  // Operator-only management of shared photo curation; org credentials cannot enter.
  panoramaCuration: {
    keys: 'platformQuery',
    mintKey: 'platformMutation',
    revokeKey: 'platformMutation',
    submissions: 'platformQuery',
    decline: 'platformMutation',
    accept: 'platformMutation',
    uploadUrl: 'platformMutation',
    attachFile: 'platformAction',
    // Manual additions need no agent key/date; their live review card stays operator-only.
    prepareLibraryUpload: 'platformMutation',
    addLibraryFile: 'platformAction',
    libraryImage: 'platformQuery',
  },
  // Operators upload owned/licensed files with no external-provider or date prerequisite.
  panoramaUploads: { uploadUrl: 'platformMutation', addFile: 'platformAction' },
  // Account-owned preparation settings and private custom files. No owner/org
  // arguments: only the signed-in login can save choices or mint capabilities.
  appearance: {
    get: 'authedQuery',
    // Approved calendar image and retained credit for the signed-in renderer.
    dailyImage: 'authedQuery',
    // Saves the theme and the Canvas background choice for the signed-in login.
    save: 'authedMutation',
    createUpload: 'authedMutation',
    cancelUpload: 'authedMutation',
    removeCustom: 'authedMutation',
    mintCustomUrl: 'authedQuery',
  },
  prefs: { get: 'authedQuery', save: 'authedMutation' },
  // Deactivate and remove stay open to org admins during a billing pause.
  profiles: {
    create: 'adminMutation',
    update: 'adminMutation',
    deactivate: 'accessRemovalMutation',
    remove: 'accessRemovalMutation',
    setPlannableHours: 'orgMutation',
    setDisplayName: 'authedMutation',
    setMessageRetention: 'authedMutation',
  },
  // The removal window's preview of the three removals below
  // (projects.removeAccess, teams.removeMember, teams.deleteDeep): a read
  // that runs the writes' own checks, read once, never subscribed.
  accessRemovals: { preview: 'orgQuery' },
  // Removing a person's or team's access stays open to org admins during a
  // billing pause; giving or changing access does not. A restore schedules
  // regroup:restoredStep (internal), which clears the own hours of parents
  // the restored tasks make groups again.
  projects: {
    create: 'orgMutation',
    update: 'orgMutation',
    setAccess: 'orgMutation',
    removeAccess: 'accessRemovalMutation',
    archive: 'orgMutation',
    unarchive: 'orgMutation',
    deleteDeep: 'orgMutation',
    // The Archive or delete window's counts, behind deleteDeep's Lead gate.
    removalSummary: 'orgQuery',
    inviteGuest: 'orgMutation',
    addMilestone: 'orgMutation',
    updateMilestone: 'orgMutation',
    removeMilestone: 'orgMutation',
  },
  // Main Search spans organizations like Deleted items: one page of task
  // results across every active seat, or one organization the caller
  // narrows it to, each candidate judged with the seat in its organization.
  search: { page: 'authedQuery' },
  // The task window's live comment page, its live history page (only
  // while it shows All) and the earlier pages of each.
  snapshot: {
    commentsBefore: 'orgQuery',
    historyBefore: 'orgQuery',
    threadComments: 'orgQuery',
    threadHistory: 'orgQuery',
  },
  // The task window's own reads: any member reads the opened task, its
  // links and its attachment list under ordinary access, and a task they
  // may not open answers unavailable.
  taskWindow: { task: 'orgQuery', links: 'orgQuery', attachments: 'orgQuery' },
  // Team sync: staff stamp the person a change was made on (often not
  // themselves); any member reads the latest comment per visible open task.
  teamSync: { lastComments: 'orgQuery', stamp: 'orgMutation' },
  // Removing a member stays open to org admins during a billing pause;
  // adding one does not.
  teams: {
    create: 'adminMutation',
    update: 'orgMutation',
    deleteDeep: 'orgMutation',
    addMember: 'orgMutation',
    removeMember: 'accessRemovalMutation',
    setLeader: 'orgMutation',
  },
  // Revoking and deleting an agent key stay open to org admins during a
  // billing pause; creating one does not.
  tokens: {
    listAgentKeys: 'authedQuery',
    createAgentKey: 'orgMutation',
    revokeAgentKey: 'accessRemovalMutation',
    deleteAgentKey: 'accessRemovalMutation',
    listMcpTokens: 'authedQuery',
    createMcpToken: 'authedMutation',
    revokeMcpToken: 'authedMutation',
    deleteMcpToken: 'authedMutation',
  },
  // The workspace in live parts. The root reads every seat of the login;
  // each other part takes one organization and answers gone,
  // without throwing, where the caller holds no seat.
  workspace: {
    root: 'authedQuery',
    catalog: 'seatQuery',
    people: 'seatQuery',
    projects: 'seatQuery',
    tasks: 'seatQuery',
    inbox: 'seatQuery',
  },
}

/* Public entries are counted from the pinned manifest below. */
const PUBLIC_COUNT = 202

describe('the public surface', () => {
  const publicRows = rows.filter((r) => r.vis === 'public')

  it('matches the hand-grouped PUBLIC map, in count and in membership', () => {
    const expected = Object.entries(PUBLIC)
      .flatMap(([m, fns]) => Object.keys(fns).map((f) => `${m}:${f}`))
      .sort()
    const got = publicRows.map((r) => `${r.module}:${r.name}`).sort()
    if (got.join('\n') !== expected.join('\n')) {
      console.log(`--- actual public surface ---\n${got.join('\n')}\n--- end ---`)
    }
    expect(got).toEqual(expected)
    expect(publicRows).toHaveLength(PUBLIC_COUNT)
  })

  /* No counter surface: numbering is server-owned (organizations.next_*),
   * mutated only inside create paths — a nextIssueNum-shaped public function
   * must never appear. (orgFence.test.ts leaves the cross-reference here.) */
  it('exposes no counter-shaped function', () => {
    for (const r of publicRows) {
      expect(/next.*num/i.test(r.name), `${r.module}:${r.name} looks counter-shaped`).toBe(false)
    }
  })
})

/* --------------------------------------------------------- the wrapper rule */

/* Source-text scan via the ?raw eager glob: vite resolves ?raw at transform
 * time, so no fs is needed at runtime — this file stays edge-runtime-safe
 * (the Convex Vitest project sends convex/**\/*.test.ts into @edge-runtime/vm,
 * where node:fs does not exist). */
const sources = import.meta.glob(
  ['../**/*.ts', '!../_generated/**', '!../betterAuth/**', '!../tests/**'],
  {
    eager: true,
    query: '?raw',
    import: 'default',
  },
) as Record<string, string>

/* admin.ts's isOperator is a BARE public query ON PURPOSE (documented at its
 * definition): the AdminGate probe must answer false — never throw — for
 * anonymous and non-operator callers alike, and every wrapper in
 * lib/functions.ts throws. The exception is name-tight: only `query`, only
 * in admin.ts; a bare mutation/action there still fails. */
const BARE_IMPORT_EXCEPTIONS: Record<string, string[]> = { 'admin.ts': ['query'] }

const BARE = new Set(['query', 'mutation', 'action'])
const IMPORT_RE = /import\s+(type\s+)?\{([^}]*)\}\s*from\s*['"]([^'"]*_generated\/server)['"]/g

/* The bare registration builders a file imports from _generated/server,
 * `import type` and inline `type` specifiers excluded, aliases resolved to
 * the ORIGINAL name (`query as q` is still bare query). */
const bareImports = (source: string): string[] => {
  const found: string[] = []
  for (const match of source.matchAll(IMPORT_RE)) {
    if (match[1] !== undefined) continue // `import type {...}` — types only
    for (const rawSpec of match[2].split(',')) {
      const spec = rawSpec.trim()
      if (spec === '' || spec.startsWith('type ')) continue
      const imported = spec.split(/\s+as\s+/)[0].trim()
      if (BARE.has(imported)) found.push(imported)
    }
  }
  return found.sort()
}

describe('the wrapper rule', () => {
  /* If the ?raw glob ever came back empty (or the regex rotted), the scan
   * below would pass vacuously — prove it sees the one file that DOES import
   * all three builders before trusting its silence. */
  it('positive control: the scanner sees lib/functions.ts importing all three builders', () => {
    const src = sources['../lib/functions.ts']
    expect(src).toBeDefined()
    expect(bareImports(src)).toEqual(['action', 'mutation', 'query'])
  })

  it('no module but lib/functions.ts imports bare query/mutation/action from _generated/server', () => {
    const violations: string[] = []
    for (const [path, source] of Object.entries(sources)) {
      const file = path.replace(/^\.\.\//, '')
      if (file === 'lib/functions.ts') continue
      for (const imported of bareImports(source)) {
        if (BARE_IMPORT_EXCEPTIONS[file]?.includes(imported)) continue
        violations.push(`${file} imports bare '${imported}' from _generated/server`)
      }
    }
    expect(violations).toEqual([])
  })

  /* The belt: registration flags cannot be dodged by re-exports. Every
   * public function must either carry the wrapper-injected org_id wire arg
   * or be a named non-org entry in the PUBLIC map — and the wrapper's kind
   * must agree with the registered kind. No inverse assertion: a non-org
   * door may legitimately take org_id as a TARGET argument (adminPeople:orgDetail
   * asks about an org, it is not scoped to one). */
  const ORG_WRAPPERS = new Set<Wrapper>([
    'orgQuery',
    'orgMutation',
    'adminMutation',
    'accessRemovalMutation',
    'orgAction',
    'seatQuery',
  ])
  const NON_ORG_ALLOWLIST = new Set(
    Object.entries(PUBLIC).flatMap(([m, fns]) =>
      Object.entries(fns)
        .filter(([, w]) => !ORG_WRAPPERS.has(w))
        .map(([f]) => `${m}:${f}`),
    ),
  )
  const KIND_OF: Record<Wrapper, 'query' | 'mutation' | 'action'> = {
    orgAction: 'action',
    demoConfigurationQuery: 'query',
    demoLifecycleQuery: 'query',
    demoBootstrapMutation: 'mutation',
    orgQuery: 'query',
    orgMutation: 'mutation',
    adminMutation: 'mutation',
    accessRemovalMutation: 'mutation',
    authedQuery: 'query',
    authedMutation: 'mutation',
    seatQuery: 'query',
    platformQuery: 'query',
    platformMutation: 'mutation',
    platformAction: 'action',
    query: 'query',
  }

  const argKeys = (argsJson: string): string[] => {
    const parsed = JSON.parse(argsJson) as { type?: string; value?: Record<string, unknown> }
    return parsed.type === 'object' && parsed.value !== undefined ? Object.keys(parsed.value) : []
  }

  it('every public function carries org_id or a named non-org wrapper', () => {
    for (const r of rows.filter((row) => row.vis === 'public')) {
      const wrapper = PUBLIC[r.module]?.[r.name]
      expect(
        wrapper,
        `${r.module}:${r.name} is public but absent from the PUBLIC map`,
      ).toBeDefined()
      if (wrapper === undefined) continue
      const hasOrgId = argKeys(r.args).includes('org_id')
      if (ORG_WRAPPERS.has(wrapper)) {
        expect(
          hasOrgId,
          `${r.module}:${r.name} says ${wrapper} but its wire args lack org_id`,
        ).toBe(true)
      }
      expect(
        hasOrgId || NON_ORG_ALLOWLIST.has(`${r.module}:${r.name}`),
        `${r.module}:${r.name} is public without org_id and without a named non-org wrapper`,
      ).toBe(true)
      expect(
        KIND_OF[wrapper],
        `${r.module}:${r.name} kind disagrees with its ${wrapper} wrapper`,
      ).toBe(r.kind)
    }
  })
})
