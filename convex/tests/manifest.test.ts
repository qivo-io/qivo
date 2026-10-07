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
admin:addOperator mutation internal {"type":"object","value":{"email":{"fieldType":{"type":"string"},"optional":false},"note":{"fieldType":{"type":"string"},"optional":true}}}
admin:auditLog query public {"type":"object","value":{"limit":{"fieldType":{"type":"number"},"optional":true}}}
admin:isOperator query public {"type":"object","value":{}}
admin:listOrgs query public {"type":"object","value":{}}
admin:listUsers query public {"type":"object","value":{"search":{"fieldType":{"type":"string"},"optional":false}}}
admin:orgDetail query public {"type":"object","value":{"org_id":{"fieldType":{"type":"string"},"optional":false}}}
admin:platformStats query public {"type":"object","value":{}}
admin:promoteOrgAdmin mutation public {"type":"object","value":{"profile_id":{"fieldType":{"type":"string"},"optional":false}}}
admin:removeOperator mutation internal {"type":"object","value":{"email":{"fieldType":{"type":"string"},"optional":false}}}
adminAuth:banUser action public {"type":"object","value":{"email":{"fieldType":{"type":"string"},"optional":false}}}
adminAuth:createBreakGlass action public {"type":"object","value":{"org_id":{"fieldType":{"type":"string"},"optional":false},"email":{"fieldType":{"type":"string"},"optional":false},"name":{"fieldType":{"type":"string"},"optional":true}}}
adminAuth:deleteOrphanLogin mutation internal {"type":"object","value":{"email":{"fieldType":{"type":"string"},"optional":false}}}
adminAuth:insertBreakGlass mutation internal {"type":"object","value":{"org_id":{"fieldType":{"type":"string"},"optional":false},"email":{"fieldType":{"type":"string"},"optional":false},"name":{"fieldType":{"type":"string"},"optional":false},"auth_user_id":{"fieldType":{"type":"string"},"optional":false},"actor":{"fieldType":{"type":"object","value":{"auth_user_id":{"fieldType":{"type":"string"},"optional":false},"email":{"fieldType":{"type":"string"},"optional":false}}},"optional":false}}}
adminAuth:logAction mutation internal {"type":"object","value":{"actor_auth_id":{"fieldType":{"type":"string"},"optional":true},"actor_email":{"fieldType":{"type":"string"},"optional":false},"action":{"fieldType":{"type":"string"},"optional":false},"target_org_id":{"fieldType":{"type":"string"},"optional":true},"target_profile_id":{"fieldType":{"type":"string"},"optional":true},"detail":{"fieldType":{"type":"any"},"optional":false}}}
adminAuth:operatorCheck query internal {"type":"object","value":{}}
adminAuth:profilesByEmail query internal {"type":"object","value":{"email":{"fieldType":{"type":"string"},"optional":false}}}
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
appearance:save mutation public {"type":"object","value":{"mode":{"fieldType":{"type":"union","value":[{"type":"literal","value":"blue"},{"type":"literal","value":"dark"},{"type":"literal","value":"light"}]},"optional":false},"image_source":{"fieldType":{"type":"union","value":[{"type":"literal","value":"daily"},{"type":"literal","value":"custom"},{"type":"literal","value":"none"}]},"optional":false}}}
appearance:uploadContext query internal {"type":"object","value":{"id":{"fieldType":{"type":"string"},"optional":false},"minter":{"fieldType":{"type":"string"},"optional":false},"exp":{"fieldType":{"type":"number"},"optional":false}}}
backgroundPreviewProcessor:generate action internal {"type":"object","value":{"kind":{"fieldType":{"type":"union","value":[{"type":"literal","value":"library"},{"type":"literal","value":"custom"}]},"optional":false},"id":{"fieldType":{"type":"string"},"optional":false},"storage_id":{"fieldType":{"type":"id","tableName":"_storage"},"optional":false},"attempt":{"fieldType":{"type":"number"},"optional":true}}}
backgroundPreviews:attach mutation internal {"type":"object","value":{"kind":{"fieldType":{"type":"union","value":[{"type":"literal","value":"library"},{"type":"literal","value":"custom"}]},"optional":false},"id":{"fieldType":{"type":"string"},"optional":false},"storage_id":{"fieldType":{"type":"id","tableName":"_storage"},"optional":false},"preview_storage_id":{"fieldType":{"type":"id","tableName":"_storage"},"optional":false},"preview_version":{"fieldType":{"type":"number"},"optional":false},"demo_ticket_id":{"fieldType":{"type":"string"},"optional":true}}}
backgroundPreviews:backfill mutation internal {"type":"object","value":{"kind":{"fieldType":{"type":"union","value":[{"type":"literal","value":"library"},{"type":"literal","value":"custom"}]},"optional":false},"cursor":{"fieldType":{"type":"string"},"optional":true}}}
backgroundPreviews:beginDemoWork mutation internal {"type":"object","value":{"kind":{"fieldType":{"type":"union","value":[{"type":"literal","value":"library"},{"type":"literal","value":"custom"}]},"optional":false},"id":{"fieldType":{"type":"string"},"optional":false},"storage_id":{"fieldType":{"type":"id","tableName":"_storage"},"optional":false}}}
backgroundPreviews:source query internal {"type":"object","value":{"kind":{"fieldType":{"type":"union","value":[{"type":"literal","value":"library"},{"type":"literal","value":"custom"}]},"optional":false},"id":{"fieldType":{"type":"string"},"optional":false},"storage_id":{"fieldType":{"type":"id","tableName":"_storage"},"optional":false}}}
billing:adminContext query internal {"type":"object","value":{"org_id":{"fieldType":{"type":"string"},"optional":false}}}
billing:status query public {"type":"object","value":{"org_id":{"fieldType":{"type":"string"},"optional":false}}}
billing:summary query public {"type":"object","value":{"org_id":{"fieldType":{"type":"string"},"optional":false}}}
billing:usage query public {"type":"object","value":{"org_id":{"fieldType":{"type":"string"},"optional":false}}}
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
billingMetering:ingress mutation internal {"type":"object","value":{}}
billingMetering:oauthCall mutation internal {"type":"object","value":{"connection_id":{"fieldType":{"type":"string"},"optional":false}}}
billingSync:apply mutation internal {"type":"object","value":{"payload":{"fieldType":{"type":"string"},"optional":false},"event_id":{"fieldType":{"type":"string"},"optional":true}}}
billingSync:claim mutation internal {"type":"object","value":{"org_id":{"fieldType":{"type":"string"},"optional":false}}}
billingSync:eventReady mutation internal {"type":"object","value":{"id":{"fieldType":{"type":"string"},"optional":false}}}
billingSync:eventResult mutation internal {"type":"object","value":{"id":{"fieldType":{"type":"string"},"optional":false},"success":{"fieldType":{"type":"boolean"},"optional":false}}}
billingSync:organizations query internal {"type":"object","value":{}}
billingSync:pendingEvents query internal {"type":"object","value":{}}
billingSync:pump action internal {"type":"object","value":{}}
billingSync:reconcile action internal {"type":"object","value":{"org_id":{"fieldType":{"type":"string"},"optional":false}}}
billingSync:release mutation internal {"type":"object","value":{"org_id":{"fieldType":{"type":"string"},"optional":false},"token":{"fieldType":{"type":"string"},"optional":false},"seats":{"fieldType":{"type":"number"},"optional":true},"error":{"fieldType":{"type":"string"},"optional":true}}}
billingSync:reminders mutation internal {"type":"object","value":{}}
billingSync:sweep action internal {"type":"object","value":{}}
billingSync:webhook action internal {"type":"object","value":{"event_id":{"fieldType":{"type":"string"},"optional":false},"subscription_id":{"fieldType":{"type":"string"},"optional":false}}}
comments:create mutation public {"type":"object","value":{"id":{"fieldType":{"type":"string"},"optional":false},"issue_id":{"fieldType":{"type":"string"},"optional":false},"body":{"fieldType":{"type":"string"},"optional":false},"org_id":{"fieldType":{"type":"string"},"optional":false}}}
comments:remove mutation public {"type":"object","value":{"id":{"fieldType":{"type":"string"},"optional":false},"org_id":{"fieldType":{"type":"string"},"optional":false}}}
comments:update mutation public {"type":"object","value":{"id":{"fieldType":{"type":"string"},"optional":false},"body":{"fieldType":{"type":"string"},"optional":false},"org_id":{"fieldType":{"type":"string"},"optional":false}}}
demo:configuration query public {"type":"object","value":{}}
demo:current query public {"type":"object","value":{}}
demo:ensureMine mutation public {"type":"object","value":{}}
demo:expire mutation internal {"type":"object","value":{"id":{"fieldType":{"type":"string"},"optional":false}}}
demo:onCreate mutation internal {"type":"object","value":{"doc":{"fieldType":{"type":"any"},"optional":false},"model":{"fieldType":{"type":"string"},"optional":false}}}
demo:onDelete mutation internal {"type":"object","value":{"doc":{"fieldType":{"type":"any"},"optional":false},"model":{"fieldType":{"type":"string"},"optional":false}}}
demo:tokenDeadline query internal {"type":"object","value":{"auth_user_id":{"fieldType":{"type":"string"},"optional":false}}}
demoReporting:publish action internal {"type":"object","value":{}}
demoReporting:receive mutation internal {"type":"object","value":{"payload":{"fieldType":{"type":"string"},"optional":false}}}
demoUploads:abandon mutation internal {"type":"object","value":{"id":{"fieldType":{"type":"string"},"optional":false},"minter":{"fieldType":{"type":"string"},"optional":false},"storage_id":{"fieldType":{"type":"id","tableName":"_storage"},"optional":true}}}
demoUploads:admit mutation internal {"type":"object","value":{}}
demoUploads:begin mutation internal {"type":"object","value":{"id":{"fieldType":{"type":"string"},"optional":false},"minter":{"fieldType":{"type":"string"},"optional":false},"exp":{"fieldType":{"type":"number"},"optional":false}}}
demoUploads:finish mutation internal {"type":"object","value":{"id":{"fieldType":{"type":"string"},"optional":false},"minter":{"fieldType":{"type":"string"},"optional":false},"storage_id":{"fieldType":{"type":"id","tableName":"_storage"},"optional":false}}}
demoUploads:sweep mutation internal {"type":"object","value":{"cursor":{"fieldType":{"type":"string"},"optional":true}}}
demoVisitor:record mutation internal {"type":"object","value":{"auth_user_id":{"fieldType":{"type":"string"},"optional":false},"browser":{"fieldType":{"type":"string"},"optional":false},"os":{"fieldType":{"type":"string"},"optional":false},"country":{"fieldType":{"type":"string"},"optional":false}}}
files:attach mutation public {"type":"object","value":{"id":{"fieldType":{"type":"string"},"optional":false},"issue_id":{"fieldType":{"type":"string"},"optional":false},"storage_id":{"fieldType":{"type":"id","tableName":"_storage"},"optional":false},"name":{"fieldType":{"type":"string"},"optional":false},"mime":{"fieldType":{"type":"string"},"optional":true},"inline":{"fieldType":{"type":"boolean"},"optional":false},"org_id":{"fieldType":{"type":"string"},"optional":false}}}
files:avatarUploadUrl mutation public {"type":"object","value":{"profile_id":{"fieldType":{"type":"string"},"optional":false}}}
files:clearAvatar mutation public {"type":"object","value":{"profile_id":{"fieldType":{"type":"string"},"optional":false}}}
files:gatewayAttachment query internal {"type":"object","value":{"id":{"fieldType":{"type":"string"},"optional":false},"minter":{"fieldType":{"type":"string"},"optional":false}}}
files:gatewayAvatar query internal {"type":"object","value":{"id":{"fieldType":{"type":"string"},"optional":false},"minter":{"fieldType":{"type":"string"},"optional":false}}}
files:mintUrls query public {"type":"object","value":{"attachment_ids":{"fieldType":{"type":"array","value":{"type":"string"}},"optional":true},"profile_ids":{"fieldType":{"type":"array","value":{"type":"string"}},"optional":true},"org_id":{"fieldType":{"type":"string"},"optional":false}}}
files:reapOrphans mutation internal {"type":"object","value":{}}
files:removeAttachment mutation public {"type":"object","value":{"id":{"fieldType":{"type":"string"},"optional":false},"org_id":{"fieldType":{"type":"string"},"optional":false}}}
files:setAvatar mutation public {"type":"object","value":{"profile_id":{"fieldType":{"type":"string"},"optional":false},"storage_id":{"fieldType":{"type":"id","tableName":"_storage"},"optional":false}}}
files:uploadUrl mutation public {"type":"object","value":{"issue_id":{"fieldType":{"type":"string"},"optional":false},"org_id":{"fieldType":{"type":"string"},"optional":false}}}
identity:acceptInvitation mutation public {"type":"object","value":{"profile_id":{"fieldType":{"type":"string"},"optional":false}}}
identity:claimMySeats mutation public {"type":"object","value":{}}
identity:claimSeatsInternal mutation internal {"type":"object","value":{"userId":{"fieldType":{"type":"string"},"optional":false},"email":{"fieldType":{"type":"string"},"optional":false},"emailVerified":{"fieldType":{"type":"boolean"},"optional":false}}}
identity:createOrganization mutation public {"type":"object","value":{"name":{"fieldType":{"type":"string"},"optional":false}}}
identity:whoami query public {"type":"object","value":{}}
internal/demoCleanup:purge mutation internal {"type":"object","value":{"demo_id":{"fieldType":{"type":"string"},"optional":false}}}
internal/demoCleanup:recover mutation internal {"type":"object","value":{}}
internal/demoMetrics:sample mutation internal {"type":"object","value":{}}
internal/demoMetrics:samplePage mutation internal {"type":"object","value":{"run_id":{"fieldType":{"type":"string"},"optional":false},"step":{"fieldType":{"type":"number"},"optional":false}}}
internal/demoMetrics:snapshot query internal {"type":"object","value":{}}
internal/demoTest:expireOwned mutation internal {"type":"object","value":{"auth_user_id":{"fieldType":{"type":"string"},"optional":false},"expected_site_url":{"fieldType":{"type":"string"},"optional":false},"delay_ms":{"fieldType":{"type":"number"},"optional":false}}}
internal/demoTest:inspect query internal {"type":"object","value":{"auth_user_id":{"fieldType":{"type":"string"},"optional":false},"org_id":{"fieldType":{"type":"string"},"optional":true},"expected_site_url":{"fieldType":{"type":"string"},"optional":false}}}
internal/guestOrg:zzGuestOrg mutation internal {"type":"object","value":{}}
internal/marketingDemo:adoptAvatar mutation internal {"type":"object","value":{"expected_site_url":{"fieldType":{"type":"string"},"optional":false},"person":{"fieldType":{"type":"string"},"optional":false},"storage_id":{"fieldType":{"type":"id","tableName":"_storage"},"optional":false}}}
internal/marketingDemo:apply mutation internal {"type":"object","value":{"expected_site_url":{"fieldType":{"type":"string"},"optional":false},"anchor":{"fieldType":{"type":"string"},"optional":false},"mode":{"fieldType":{"type":"union","value":[{"type":"literal","value":"seed"},{"type":"literal","value":"wipe"}]},"optional":false}}}
internal/marketingDemo:avatarUpload mutation internal {"type":"object","value":{"expected_site_url":{"fieldType":{"type":"string"},"optional":false},"person":{"fieldType":{"type":"string"},"optional":false}}}
internal/marketingDemo:inspect query internal {"type":"object","value":{"expected_site_url":{"fieldType":{"type":"string"},"optional":false}}}
internal/marketingDemo:provision mutation internal {"type":"object","value":{"expected_site_url":{"fieldType":{"type":"string"},"optional":false},"credential_set_id":{"fieldType":{"type":"string"},"optional":false},"password_hashes":{"fieldType":{"type":"record","keys":{"type":"string"},"values":{"fieldType":{"type":"string"},"optional":false}},"optional":false},"sample_avatars":{"fieldType":{"type":"boolean"},"optional":true}}}
internal/oauthSmoke:cleanup mutation internal {"type":"object","value":{"expected_site_url":{"fieldType":{"type":"string"},"optional":false},"client_id":{"fieldType":{"type":"string"},"optional":false},"client_name":{"fieldType":{"type":"string"},"optional":false}}}
internal/operator:ensurePlatformAdmin mutation internal {"type":"object","value":{"auth_user_id":{"fieldType":{"type":"string"},"optional":false},"note":{"fieldType":{"type":"string"},"optional":false}}}
internal/operator:removePlatformAdmin mutation internal {"type":"object","value":{"auth_user_id":{"fieldType":{"type":"string"},"optional":false}}}
internal/operator:testOperator action internal {"type":"object","value":{}}
internal/previewSeed:seed action internal {"type":"object","value":{}}
issues:addLink mutation public {"type":"object","value":{"id":{"fieldType":{"type":"string"},"optional":false},"source_id":{"fieldType":{"type":"string"},"optional":false},"target_id":{"fieldType":{"type":"string"},"optional":false},"type":{"fieldType":{"type":"union","value":[{"type":"literal","value":"blocks"},{"type":"literal","value":"relates"}]},"optional":false},"org_id":{"fieldType":{"type":"string"},"optional":false}}}
issues:archive mutation public {"type":"object","value":{"id":{"fieldType":{"type":"string"},"optional":false},"reason":{"fieldType":{"type":"string"},"optional":true},"org_id":{"fieldType":{"type":"string"},"optional":false}}}
issues:archivedFor query public {"type":"object","value":{"project_ids":{"fieldType":{"type":"array","value":{"type":"string"}},"optional":false}}}
issues:create mutation public {"type":"object","value":{"id":{"fieldType":{"type":"string"},"optional":false},"project_id":{"fieldType":{"type":"string"},"optional":false},"title":{"fieldType":{"type":"string"},"optional":false},"description":{"fieldType":{"type":"union","value":[{"type":"string"},{"type":"null"}]},"optional":true},"status":{"fieldType":{"type":"union","value":[{"type":"union","value":[{"type":"literal","value":"backlog"},{"type":"literal","value":"todo"},{"type":"literal","value":"progress"},{"type":"literal","value":"review"},{"type":"literal","value":"done"}]},{"type":"null"}]},"optional":true},"priority":{"fieldType":{"type":"union","value":[{"type":"union","value":[{"type":"literal","value":"urgent"},{"type":"literal","value":"high"},{"type":"literal","value":"medium"},{"type":"literal","value":"low"}]},{"type":"null"}]},"optional":true},"assignee_id":{"fieldType":{"type":"union","value":[{"type":"string"},{"type":"null"}]},"optional":true},"reviewer_id":{"fieldType":{"type":"union","value":[{"type":"string"},{"type":"null"}]},"optional":true},"parent_id":{"fieldType":{"type":"union","value":[{"type":"string"},{"type":"null"}]},"optional":true},"start_week":{"fieldType":{"type":"union","value":[{"type":"string"},{"type":"null"}]},"optional":true},"end_week":{"fieldType":{"type":"union","value":[{"type":"string"},{"type":"null"}]},"optional":true},"due_date":{"fieldType":{"type":"union","value":[{"type":"string"},{"type":"null"}]},"optional":true},"remaining_hours":{"fieldType":{"type":"union","value":[{"type":"number"},{"type":"null"}]},"optional":true},"paused":{"fieldType":{"type":"union","value":[{"type":"boolean"},{"type":"null"}]},"optional":true},"org_id":{"fieldType":{"type":"string"},"optional":false}}}
issues:deleteDeep mutation public {"type":"object","value":{"id":{"fieldType":{"type":"string"},"optional":false},"org_id":{"fieldType":{"type":"string"},"optional":false}}}
issues:move mutation public {"type":"object","value":{"id":{"fieldType":{"type":"string"},"optional":false},"project_id":{"fieldType":{"type":"string"},"optional":false},"org_id":{"fieldType":{"type":"string"},"optional":false}}}
issues:removeLink mutation public {"type":"object","value":{"a":{"fieldType":{"type":"string"},"optional":false},"b":{"fieldType":{"type":"string"},"optional":false},"org_id":{"fieldType":{"type":"string"},"optional":false}}}
issues:setSubscriber mutation public {"type":"object","value":{"issue_id":{"fieldType":{"type":"string"},"optional":false},"profile_id":{"fieldType":{"type":"string"},"optional":false},"subscribed":{"fieldType":{"type":"boolean"},"optional":false},"org_id":{"fieldType":{"type":"string"},"optional":false}}}
issues:subscribe mutation public {"type":"object","value":{"issue_id":{"fieldType":{"type":"string"},"optional":false},"org_id":{"fieldType":{"type":"string"},"optional":false}}}
issues:subscribers query public {"type":"object","value":{"issue_id":{"fieldType":{"type":"string"},"optional":false},"org_id":{"fieldType":{"type":"string"},"optional":false}}}
issues:unarchive mutation public {"type":"object","value":{"id":{"fieldType":{"type":"string"},"optional":false},"org_id":{"fieldType":{"type":"string"},"optional":false}}}
issues:unsubscribe mutation public {"type":"object","value":{"issue_id":{"fieldType":{"type":"string"},"optional":false},"org_id":{"fieldType":{"type":"string"},"optional":false}}}
issues:update mutation public {"type":"object","value":{"id":{"fieldType":{"type":"string"},"optional":false},"patch":{"fieldType":{"type":"object","value":{"title":{"fieldType":{"type":"string"},"optional":true},"description":{"fieldType":{"type":"union","value":[{"type":"string"},{"type":"null"}]},"optional":true},"status":{"fieldType":{"type":"union","value":[{"type":"literal","value":"backlog"},{"type":"literal","value":"todo"},{"type":"literal","value":"progress"},{"type":"literal","value":"review"},{"type":"literal","value":"done"}]},"optional":true},"priority":{"fieldType":{"type":"union","value":[{"type":"literal","value":"urgent"},{"type":"literal","value":"high"},{"type":"literal","value":"medium"},{"type":"literal","value":"low"}]},"optional":true},"assignee_id":{"fieldType":{"type":"union","value":[{"type":"string"},{"type":"null"}]},"optional":true},"reviewer_id":{"fieldType":{"type":"union","value":[{"type":"string"},{"type":"null"}]},"optional":true},"parent_id":{"fieldType":{"type":"union","value":[{"type":"string"},{"type":"null"}]},"optional":true},"start_week":{"fieldType":{"type":"union","value":[{"type":"string"},{"type":"null"}]},"optional":true},"end_week":{"fieldType":{"type":"union","value":[{"type":"string"},{"type":"null"}]},"optional":true},"due_date":{"fieldType":{"type":"union","value":[{"type":"string"},{"type":"null"}]},"optional":true},"remaining_hours":{"fieldType":{"type":"union","value":[{"type":"number"},{"type":"null"}]},"optional":true},"paused":{"fieldType":{"type":"boolean"},"optional":true}}},"optional":false},"org_id":{"fieldType":{"type":"string"},"optional":false}}}
jobs:archiveDoneIssues mutation internal {"type":"object","value":{}}
jobs:sweepReadMessages mutation internal {"type":"object","value":{}}
labels:create mutation public {"type":"object","value":{"id":{"fieldType":{"type":"string"},"optional":false},"name":{"fieldType":{"type":"string"},"optional":false},"color":{"fieldType":{"type":"string"},"optional":false},"org_id":{"fieldType":{"type":"string"},"optional":false}}}
labels:remove mutation public {"type":"object","value":{"id":{"fieldType":{"type":"string"},"optional":false},"org_id":{"fieldType":{"type":"string"},"optional":false}}}
labels:toggle mutation public {"type":"object","value":{"issue_id":{"fieldType":{"type":"string"},"optional":false},"label_id":{"fieldType":{"type":"string"},"optional":false},"org_id":{"fieldType":{"type":"string"},"optional":false}}}
labels:update mutation public {"type":"object","value":{"id":{"fieldType":{"type":"string"},"optional":false},"patch":{"fieldType":{"type":"object","value":{"name":{"fieldType":{"type":"string"},"optional":true},"color":{"fieldType":{"type":"string"},"optional":true}}},"optional":false},"org_id":{"fieldType":{"type":"string"},"optional":false}}}
machine/auth:lookupCredential query internal {"type":"object","value":{"hash":{"fieldType":{"type":"string"},"optional":false},"isAgent":{"fieldType":{"type":"boolean"},"optional":false}}}
machine/auth:touchCredential mutation internal {"type":"object","value":{"table":{"fieldType":{"type":"union","value":[{"type":"literal","value":"agent_keys"},{"type":"literal","value":"mcp_tokens"}]},"optional":false},"tokenId":{"fieldType":{"type":"string"},"optional":false},"rowId":{"fieldType":{"type":"string"},"optional":false},"profileId":{"fieldType":{"type":"string"},"optional":false},"now":{"fieldType":{"type":"string"},"optional":false}}}
machine/mcp:addComment mutation internal {"type":"object","value":{"callerId":{"fieldType":{"type":"string"},"optional":false},"ref":{"fieldType":{"type":"string"},"optional":false},"body":{"fieldType":{"type":"string"},"optional":false}}}
machine/mcp:createIssue mutation internal {"type":"object","value":{"callerId":{"fieldType":{"type":"string"},"optional":false},"project":{"fieldType":{"type":"string"},"optional":false},"sub_project":{"fieldType":{"type":"string"},"optional":true},"title":{"fieldType":{"type":"string"},"optional":false},"description":{"fieldType":{"type":"string"},"optional":true},"status":{"fieldType":{"type":"union","value":[{"type":"literal","value":"backlog"},{"type":"literal","value":"todo"},{"type":"literal","value":"progress"},{"type":"literal","value":"review"},{"type":"literal","value":"done"}]},"optional":true},"priority":{"fieldType":{"type":"union","value":[{"type":"literal","value":"urgent"},{"type":"literal","value":"high"},{"type":"literal","value":"medium"},{"type":"literal","value":"low"}]},"optional":true},"assignee_id":{"fieldType":{"type":"union","value":[{"type":"string"},{"type":"null"}]},"optional":true},"reviewer_id":{"fieldType":{"type":"union","value":[{"type":"string"},{"type":"null"}]},"optional":true},"reporter_id":{"fieldType":{"type":"string"},"optional":true},"due_date":{"fieldType":{"type":"union","value":[{"type":"string"},{"type":"null"}]},"optional":true},"remaining_hours":{"fieldType":{"type":"union","value":[{"type":"number"},{"type":"null"}]},"optional":true},"archived":{"fieldType":{"type":"boolean"},"optional":true}}}
machine/mcp:deleteIssue mutation internal {"type":"object","value":{"callerId":{"fieldType":{"type":"string"},"optional":false},"ref":{"fieldType":{"type":"string"},"optional":false}}}
machine/mcp:getIssue query internal {"type":"object","value":{"callerId":{"fieldType":{"type":"string"},"optional":false},"ref":{"fieldType":{"type":"string"},"optional":false}}}
machine/mcp:listComments query internal {"type":"object","value":{"callerId":{"fieldType":{"type":"string"},"optional":false},"ref":{"fieldType":{"type":"string"},"optional":false}}}
machine/mcp:listIssues query internal {"type":"object","value":{"callerId":{"fieldType":{"type":"string"},"optional":false},"project":{"fieldType":{"type":"string"},"optional":true},"status":{"fieldType":{"type":"union","value":[{"type":"literal","value":"backlog"},{"type":"literal","value":"todo"},{"type":"literal","value":"progress"},{"type":"literal","value":"review"},{"type":"literal","value":"done"}]},"optional":true},"priority":{"fieldType":{"type":"union","value":[{"type":"literal","value":"urgent"},{"type":"literal","value":"high"},{"type":"literal","value":"medium"},{"type":"literal","value":"low"}]},"optional":true},"assignee_id":{"fieldType":{"type":"string"},"optional":true},"search":{"fieldType":{"type":"string"},"optional":true},"archived":{"fieldType":{"type":"boolean"},"optional":true},"limit":{"fieldType":{"type":"number"},"optional":true}}}
machine/mcp:listProjectUsers query internal {"type":"object","value":{"callerId":{"fieldType":{"type":"string"},"optional":false},"project":{"fieldType":{"type":"string"},"optional":false}}}
machine/mcp:listProjects query internal {"type":"object","value":{"callerId":{"fieldType":{"type":"string"},"optional":false},"archived":{"fieldType":{"type":"boolean"},"optional":true}}}
machine/mcp:listTeams query internal {"type":"object","value":{"callerId":{"fieldType":{"type":"string"},"optional":false}}}
machine/mcp:listUsers query internal {"type":"object","value":{"callerId":{"fieldType":{"type":"string"},"optional":false}}}
machine/mcp:updateIssue mutation internal {"type":"object","value":{"callerId":{"fieldType":{"type":"string"},"optional":false},"ref":{"fieldType":{"type":"string"},"optional":false},"title":{"fieldType":{"type":"string"},"optional":true},"description":{"fieldType":{"type":"string"},"optional":true},"status":{"fieldType":{"type":"union","value":[{"type":"literal","value":"backlog"},{"type":"literal","value":"todo"},{"type":"literal","value":"progress"},{"type":"literal","value":"review"},{"type":"literal","value":"done"}]},"optional":true},"priority":{"fieldType":{"type":"union","value":[{"type":"literal","value":"urgent"},{"type":"literal","value":"high"},{"type":"literal","value":"medium"},{"type":"literal","value":"low"}]},"optional":true},"assignee_id":{"fieldType":{"type":"union","value":[{"type":"string"},{"type":"null"}]},"optional":true},"reviewer_id":{"fieldType":{"type":"union","value":[{"type":"string"},{"type":"null"}]},"optional":true},"due_date":{"fieldType":{"type":"union","value":[{"type":"string"},{"type":"null"}]},"optional":true},"remaining_hours":{"fieldType":{"type":"union","value":[{"type":"number"},{"type":"null"}]},"optional":true},"paused":{"fieldType":{"type":"boolean"},"optional":true},"archived":{"fieldType":{"type":"boolean"},"optional":true}}}
machine/mcp:updateUser mutation internal {"type":"object","value":{"callerId":{"fieldType":{"type":"string"},"optional":false},"user_id":{"fieldType":{"type":"string"},"optional":false},"plannable_hours":{"fieldType":{"type":"number"},"optional":false}}}
machine/rest:addComment mutation internal {"type":"object","value":{"callerId":{"fieldType":{"type":"string"},"optional":false},"ref":{"fieldType":{"type":"string"},"optional":false},"body":{"fieldType":{"type":"string"},"optional":false}}}
machine/rest:createIssue mutation internal {"type":"object","value":{"callerId":{"fieldType":{"type":"string"},"optional":false},"keyName":{"fieldType":{"type":"string"},"optional":false},"body":{"fieldType":{"type":"string"},"optional":false}}}
machine/rest:deleteIssue mutation internal {"type":"object","value":{"callerId":{"fieldType":{"type":"string"},"optional":false},"keyName":{"fieldType":{"type":"string"},"optional":false},"ref":{"fieldType":{"type":"string"},"optional":false}}}
machine/rest:getIssue query internal {"type":"object","value":{"callerId":{"fieldType":{"type":"string"},"optional":false},"ref":{"fieldType":{"type":"string"},"optional":false}}}
machine/rest:getProject query internal {"type":"object","value":{"callerId":{"fieldType":{"type":"string"},"optional":false},"ref":{"fieldType":{"type":"string"},"optional":false}}}
machine/rest:getUser query internal {"type":"object","value":{"callerId":{"fieldType":{"type":"string"},"optional":false},"ref":{"fieldType":{"type":"string"},"optional":false}}}
machine/rest:listComments query internal {"type":"object","value":{"callerId":{"fieldType":{"type":"string"},"optional":false},"ref":{"fieldType":{"type":"string"},"optional":false}}}
machine/rest:listIssues query internal {"type":"object","value":{"callerId":{"fieldType":{"type":"string"},"optional":false},"project":{"fieldType":{"type":"string"},"optional":true},"status":{"fieldType":{"type":"string"},"optional":true},"priority":{"fieldType":{"type":"string"},"optional":true},"assignee":{"fieldType":{"type":"string"},"optional":true},"search":{"fieldType":{"type":"string"},"optional":true},"archived":{"fieldType":{"type":"string"},"optional":true},"limit":{"fieldType":{"type":"string"},"optional":true},"offset":{"fieldType":{"type":"string"},"optional":true}}}
machine/rest:listProjectUsers query internal {"type":"object","value":{"callerId":{"fieldType":{"type":"string"},"optional":false},"ref":{"fieldType":{"type":"string"},"optional":false}}}
machine/rest:listProjects query internal {"type":"object","value":{"callerId":{"fieldType":{"type":"string"},"optional":false},"archived":{"fieldType":{"type":"string"},"optional":true}}}
machine/rest:listUsers query internal {"type":"object","value":{"callerId":{"fieldType":{"type":"string"},"optional":false}}}
machine/rest:updateIssue mutation internal {"type":"object","value":{"callerId":{"fieldType":{"type":"string"},"optional":false},"keyName":{"fieldType":{"type":"string"},"optional":false},"ref":{"fieldType":{"type":"string"},"optional":false},"body":{"fieldType":{"type":"string"},"optional":false}}}
machine/testing:deleteCredential mutation internal {"type":"object","value":{"id":{"fieldType":{"type":"string"},"optional":false},"kind":{"fieldType":{"type":"union","value":[{"type":"literal","value":"agent_key"},{"type":"literal","value":"mcp_token"}]},"optional":false}}}
machine/testing:mintCredential mutation internal {"type":"object","value":{"profile_id":{"fieldType":{"type":"string"},"optional":true},"email":{"fieldType":{"type":"string"},"optional":true},"agent_name":{"fieldType":{"type":"string"},"optional":true},"kind":{"fieldType":{"type":"union","value":[{"type":"literal","value":"agent_key"},{"type":"literal","value":"mcp_token"}]},"optional":false},"key_prefix":{"fieldType":{"type":"string"},"optional":false},"key_hash":{"fieldType":{"type":"string"},"optional":false},"name":{"fieldType":{"type":"string"},"optional":false}}}
mail:send action internal {"type":"object","value":{"to":{"fieldType":{"type":"string"},"optional":false},"intent":{"fieldType":{"type":"union","value":[{"type":"literal","value":"verify"},{"type":"literal","value":"reset"}]},"optional":false},"url":{"fieldType":{"type":"string"},"optional":false}}}
messages:markAllRead mutation public {"type":"object","value":{"before":{"fieldType":{"type":"number"},"optional":true},"org_id":{"fieldType":{"type":"string"},"optional":false}}}
messages:markRead mutation public {"type":"object","value":{"ids":{"fieldType":{"type":"array","value":{"type":"string"}},"optional":false},"org_id":{"fieldType":{"type":"string"},"optional":false}}}
messages:markUnread mutation public {"type":"object","value":{"ids":{"fieldType":{"type":"array","value":{"type":"string"}},"optional":false},"org_id":{"fieldType":{"type":"string"},"optional":false}}}
messages:remove mutation public {"type":"object","value":{"ids":{"fieldType":{"type":"array","value":{"type":"string"}},"optional":false},"org_id":{"fieldType":{"type":"string"},"optional":false}}}
messages:removeRead mutation public {"type":"object","value":{"org_id":{"fieldType":{"type":"string"},"optional":false}}}
messages:snooze mutation public {"type":"object","value":{"ids":{"fieldType":{"type":"array","value":{"type":"string"}},"optional":false},"until":{"fieldType":{"type":"union","value":[{"type":"string"},{"type":"null"}]},"optional":false},"org_id":{"fieldType":{"type":"string"},"optional":false}}}
messages:wake mutation internal {"type":"object","value":{"recipient_id":{"fieldType":{"type":"string"},"optional":false},"issue_id":{"fieldType":{"type":"string"},"optional":false},"until":{"fieldType":{"type":"string"},"optional":false}}}
oauthConnections:claimIssuance mutation internal {"type":"object","value":{"id":{"fieldType":{"type":"string"},"optional":false},"authUserId":{"fieldType":{"type":"string"},"optional":false},"clientId":{"fieldType":{"type":"string"},"optional":false},"resource":{"fieldType":{"type":"string"},"optional":false},"scopes":{"fieldType":{"type":"array","value":{"type":"string"}},"optional":false},"credentialHash":{"fieldType":{"type":"string"},"optional":false},"kind":{"fieldType":{"type":"union","value":[{"type":"literal","value":"authorization_code"},{"type":"literal","value":"refresh_token"}]},"optional":false}}}
oauthConnections:ensure mutation internal {"type":"object","value":{"authorizationHash":{"fieldType":{"type":"string"},"optional":false},"authUserId":{"fieldType":{"type":"string"},"optional":false},"clientId":{"fieldType":{"type":"string"},"optional":false},"clientName":{"fieldType":{"type":"string"},"optional":false},"resource":{"fieldType":{"type":"string"},"optional":false},"requestedScopes":{"fieldType":{"type":"array","value":{"type":"string"}},"optional":false},"scopes":{"fieldType":{"type":"array","value":{"type":"string"}},"optional":false},"approve":{"fieldType":{"type":"boolean"},"optional":false},"expiresAt":{"fieldType":{"type":"string"},"optional":false}}}
oauthConnections:getContext mutation public {"type":"object","value":{"oauth_query":{"fieldType":{"type":"string"},"optional":false}}}
oauthConnections:list query public {"type":"object","value":{}}
oauthConnections:lookupAccess query internal {"type":"object","value":{"tokenHash":{"fieldType":{"type":"string"},"optional":false},"resource":{"fieldType":{"type":"string"},"optional":false}}}
oauthConnections:registerCode mutation internal {"type":"object","value":{"id":{"fieldType":{"type":"string"},"optional":false},"credentialHash":{"fieldType":{"type":"string"},"optional":false}}}
oauthConnections:revoke mutation public {"type":"object","value":{"id":{"fieldType":{"type":"string"},"optional":false}}}
oauthConnections:revokeReplay mutation internal {"type":"object","value":{"kind":{"fieldType":{"type":"union","value":[{"type":"literal","value":"authorization_code"},{"type":"literal","value":"refresh_token"}]},"optional":false},"credentialHash":{"fieldType":{"type":"string"},"optional":false},"clientId":{"fieldType":{"type":"string"},"optional":false}}}
oauthConnections:touch mutation internal {"type":"object","value":{"id":{"fieldType":{"type":"string"},"optional":false}}}
orgExport:page query public {"type":"object","value":{"section":{"fieldType":{"type":"union","value":[{"type":"literal","value":"organizations"},{"type":"literal","value":"teams"},{"type":"literal","value":"profiles"},{"type":"literal","value":"projects"},{"type":"literal","value":"issues"},{"type":"literal","value":"labels"},{"type":"literal","value":"activity_events"},{"type":"literal","value":"team_members"},{"type":"literal","value":"project_access"},{"type":"literal","value":"project_team_access"},{"type":"literal","value":"milestones"},{"type":"literal","value":"issue_links"},{"type":"literal","value":"issue_labels"},{"type":"literal","value":"issue_attachments"},{"type":"literal","value":"comments"},{"type":"literal","value":"agent_keys"}]},"optional":false},"parent_id":{"fieldType":{"type":"string"},"optional":true},"cursor":{"fieldType":{"type":"union","value":[{"type":"string"},{"type":"null"}]},"optional":false},"org_id":{"fieldType":{"type":"string"},"optional":false}}}
orgs:setSlug mutation public {"type":"object","value":{"slug":{"fieldType":{"type":"string"},"optional":false},"org_id":{"fieldType":{"type":"string"},"optional":false}}}
orgs:update mutation public {"type":"object","value":{"patch":{"fieldType":{"type":"object","value":{"name":{"fieldType":{"type":"string"},"optional":true},"date_format":{"fieldType":{"type":"union","value":[{"type":"literal","value":"YYYY-MM-DD"},{"type":"literal","value":"DD/MM/YYYY"},{"type":"literal","value":"MM/DD/YYYY"},{"type":"literal","value":"DD.MM.YYYY"},{"type":"literal","value":"D MMM YYYY"},{"type":"literal","value":"MMM D, YYYY"}]},"optional":true},"week_start":{"fieldType":{"type":"number"},"optional":true},"week_one_rule":{"fieldType":{"type":"union","value":[{"type":"literal","value":"jan1"},{"type":"literal","value":"first4day"},{"type":"literal","value":"firstfull"}]},"optional":true},"default_plannable_hours":{"fieldType":{"type":"number"},"optional":true},"gravatar_avatars":{"fieldType":{"type":"boolean"},"optional":true},"max_attachment_mb":{"fieldType":{"type":"number"},"optional":true},"only_team_leads_manage_project_users":{"fieldType":{"type":"boolean"},"optional":true}}},"optional":false},"org_id":{"fieldType":{"type":"string"},"optional":false}}}
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
profiles:create mutation public {"type":"object","value":{"id":{"fieldType":{"type":"string"},"optional":false},"name":{"fieldType":{"type":"string"},"optional":false},"email":{"fieldType":{"type":"union","value":[{"type":"string"},{"type":"null"}]},"optional":true},"org_role":{"fieldType":{"type":"union","value":[{"type":"literal","value":"admin"},{"type":"literal","value":"user"},{"type":"literal","value":"guest"},{"type":"literal","value":"viewer"}]},"optional":false},"kind":{"fieldType":{"type":"union","value":[{"type":"literal","value":"person"},{"type":"literal","value":"agent"}]},"optional":false},"color":{"fieldType":{"type":"string"},"optional":false},"teams":{"fieldType":{"type":"array","value":{"type":"string"}},"optional":true},"org_id":{"fieldType":{"type":"string"},"optional":false}}}
profiles:remove mutation public {"type":"object","value":{"id":{"fieldType":{"type":"string"},"optional":false},"org_id":{"fieldType":{"type":"string"},"optional":false}}}
profiles:setDisplayName mutation public {"type":"object","value":{"name":{"fieldType":{"type":"string"},"optional":false}}}
profiles:setMessageRetention mutation public {"type":"object","value":{"days":{"fieldType":{"type":"union","value":[{"type":"number"},{"type":"null"}]},"optional":false}}}
profiles:setPlannableHours mutation public {"type":"object","value":{"profile_id":{"fieldType":{"type":"string"},"optional":false},"hours":{"fieldType":{"type":"number"},"optional":false},"org_id":{"fieldType":{"type":"string"},"optional":false}}}
profiles:update mutation public {"type":"object","value":{"id":{"fieldType":{"type":"string"},"optional":false},"patch":{"fieldType":{"type":"object","value":{"org_role":{"fieldType":{"type":"union","value":[{"type":"literal","value":"admin"},{"type":"literal","value":"user"},{"type":"literal","value":"guest"},{"type":"literal","value":"viewer"}]},"optional":true},"active":{"fieldType":{"type":"boolean"},"optional":true},"name":{"fieldType":{"type":"string"},"optional":true},"email":{"fieldType":{"type":"union","value":[{"type":"string"},{"type":"null"}]},"optional":true},"teams":{"fieldType":{"type":"array","value":{"type":"string"}},"optional":true}}},"optional":false},"org_id":{"fieldType":{"type":"string"},"optional":false}}}
projects:addMilestone mutation public {"type":"object","value":{"id":{"fieldType":{"type":"string"},"optional":false},"project_id":{"fieldType":{"type":"string"},"optional":false},"name":{"fieldType":{"type":"string"},"optional":false},"week":{"fieldType":{"type":"string"},"optional":false},"org_id":{"fieldType":{"type":"string"},"optional":false}}}
projects:archive mutation public {"type":"object","value":{"id":{"fieldType":{"type":"string"},"optional":false},"org_id":{"fieldType":{"type":"string"},"optional":false}}}
projects:create mutation public {"type":"object","value":{"id":{"fieldType":{"type":"string"},"optional":false},"type":{"fieldType":{"type":"union","value":[{"type":"literal","value":"meta"},{"type":"literal","value":"project"}]},"optional":false},"team_id":{"fieldType":{"type":"union","value":[{"type":"string"},{"type":"null"}]},"optional":true},"parent_id":{"fieldType":{"type":"union","value":[{"type":"string"},{"type":"null"}]},"optional":true},"key":{"fieldType":{"type":"string"},"optional":false},"name":{"fieldType":{"type":"string"},"optional":false},"icon":{"fieldType":{"type":"union","value":[{"type":"string"},{"type":"null"}]},"optional":true},"icon_color":{"fieldType":{"type":"union","value":[{"type":"string"},{"type":"null"}]},"optional":true},"lead_id":{"fieldType":{"type":"union","value":[{"type":"string"},{"type":"null"}]},"optional":true},"description":{"fieldType":{"type":"union","value":[{"type":"string"},{"type":"null"}]},"optional":true},"sort_order":{"fieldType":{"type":"number"},"optional":false},"track_delay":{"fieldType":{"type":"boolean"},"optional":true},"access":{"fieldType":{"type":"record","keys":{"type":"string"},"values":{"fieldType":{"type":"union","value":[{"type":"union","value":[{"type":"literal","value":"user"},{"type":"literal","value":"viewer"}]},{"type":"literal","value":"lead"}]},"optional":false}},"optional":true},"team_access":{"fieldType":{"type":"record","keys":{"type":"string"},"values":{"fieldType":{"type":"union","value":[{"type":"literal","value":"user"},{"type":"literal","value":"viewer"}]},"optional":false}},"optional":true},"org_id":{"fieldType":{"type":"string"},"optional":false}}}
projects:deleteDeep mutation public {"type":"object","value":{"id":{"fieldType":{"type":"string"},"optional":false},"org_id":{"fieldType":{"type":"string"},"optional":false}}}
projects:inviteGuest mutation public {"type":"object","value":{"project_id":{"fieldType":{"type":"string"},"optional":false},"email":{"fieldType":{"type":"string"},"optional":false},"level":{"fieldType":{"type":"string"},"optional":false},"org_id":{"fieldType":{"type":"string"},"optional":false}}}
projects:removeMilestone mutation public {"type":"object","value":{"id":{"fieldType":{"type":"string"},"optional":false},"org_id":{"fieldType":{"type":"string"},"optional":false}}}
projects:unarchive mutation public {"type":"object","value":{"id":{"fieldType":{"type":"string"},"optional":false},"org_id":{"fieldType":{"type":"string"},"optional":false}}}
projects:update mutation public {"type":"object","value":{"id":{"fieldType":{"type":"string"},"optional":false},"patch":{"fieldType":{"type":"object","value":{"name":{"fieldType":{"type":"string"},"optional":true},"icon":{"fieldType":{"type":"union","value":[{"type":"string"},{"type":"null"}]},"optional":true},"icon_color":{"fieldType":{"type":"union","value":[{"type":"string"},{"type":"null"}]},"optional":true},"lead_id":{"fieldType":{"type":"union","value":[{"type":"string"},{"type":"null"}]},"optional":true},"description":{"fieldType":{"type":"union","value":[{"type":"string"},{"type":"null"}]},"optional":true},"key":{"fieldType":{"type":"string"},"optional":true},"track_delay":{"fieldType":{"type":"boolean"},"optional":true},"review_hours":{"fieldType":{"type":"union","value":[{"type":"number"},{"type":"null"}]},"optional":true},"access":{"fieldType":{"type":"record","keys":{"type":"string"},"values":{"fieldType":{"type":"union","value":[{"type":"union","value":[{"type":"literal","value":"user"},{"type":"literal","value":"viewer"}]},{"type":"literal","value":"lead"}]},"optional":false}},"optional":true},"team_access":{"fieldType":{"type":"record","keys":{"type":"string"},"values":{"fieldType":{"type":"union","value":[{"type":"literal","value":"user"},{"type":"literal","value":"viewer"}]},"optional":false}},"optional":true}}},"optional":false},"org_id":{"fieldType":{"type":"string"},"optional":false}}}
projects:updateMilestone mutation public {"type":"object","value":{"id":{"fieldType":{"type":"string"},"optional":false},"patch":{"fieldType":{"type":"object","value":{"name":{"fieldType":{"type":"string"},"optional":true},"week":{"fieldType":{"type":"string"},"optional":true}}},"optional":false},"org_id":{"fieldType":{"type":"string"},"optional":false}}}
roadmap:change mutation public {"type":"object","value":{"session_id":{"fieldType":{"type":"string"},"optional":false},"operations":{"fieldType":{"type":"array","value":{"type":"union","value":[{"type":"object","value":{"kind":{"fieldType":{"type":"literal","value":"task"},"optional":false},"id":{"fieldType":{"type":"string"},"optional":false},"patch":{"fieldType":{"type":"object","value":{"start_week":{"fieldType":{"type":"union","value":[{"type":"string"},{"type":"null"}]},"optional":true},"end_week":{"fieldType":{"type":"union","value":[{"type":"string"},{"type":"null"}]},"optional":true},"remaining_hours":{"fieldType":{"type":"union","value":[{"type":"number"},{"type":"null"}]},"optional":true}}},"optional":false}}},{"type":"object","value":{"kind":{"fieldType":{"type":"literal","value":"milestone_create"},"optional":false},"id":{"fieldType":{"type":"string"},"optional":false},"project_id":{"fieldType":{"type":"string"},"optional":false},"name":{"fieldType":{"type":"string"},"optional":false},"week":{"fieldType":{"type":"string"},"optional":false}}},{"type":"object","value":{"kind":{"fieldType":{"type":"literal","value":"milestone_update"},"optional":false},"id":{"fieldType":{"type":"string"},"optional":false},"patch":{"fieldType":{"type":"object","value":{"name":{"fieldType":{"type":"string"},"optional":true},"week":{"fieldType":{"type":"string"},"optional":true}}},"optional":false}}},{"type":"object","value":{"kind":{"fieldType":{"type":"literal","value":"milestone_remove"},"optional":false},"id":{"fieldType":{"type":"string"},"optional":false}}}]}},"optional":false}}}
roadmap:expire mutation internal {"type":"object","value":{"auth_user_id":{"fieldType":{"type":"string"},"optional":false},"session_id":{"fieldType":{"type":"string"},"optional":false},"expires_at":{"fieldType":{"type":"number"},"optional":false}}}
roadmap:undo mutation public {"type":"object","value":{"session_id":{"fieldType":{"type":"string"},"optional":false},"all":{"fieldType":{"type":"boolean"},"optional":false}}}
snapshot:commentsForIssue query public {"type":"object","value":{"issue_id":{"fieldType":{"type":"string"},"optional":false},"org_id":{"fieldType":{"type":"string"},"optional":false}}}
snapshot:forMe query public {"type":"object","value":{}}
teamSync:lastComments query public {"type":"object","value":{"org_id":{"fieldType":{"type":"string"},"optional":false}}}
teamSync:stamp mutation public {"type":"object","value":{"profile_id":{"fieldType":{"type":"string"},"optional":false},"first_since":{"fieldType":{"type":"string"},"optional":true},"org_id":{"fieldType":{"type":"string"},"optional":false}}}
teams:addMember mutation public {"type":"object","value":{"team_id":{"fieldType":{"type":"string"},"optional":false},"profile_id":{"fieldType":{"type":"string"},"optional":false},"org_id":{"fieldType":{"type":"string"},"optional":false}}}
teams:create mutation public {"type":"object","value":{"id":{"fieldType":{"type":"string"},"optional":false},"name":{"fieldType":{"type":"string"},"optional":false},"org_id":{"fieldType":{"type":"string"},"optional":false}}}
teams:deleteDeep mutation public {"type":"object","value":{"id":{"fieldType":{"type":"string"},"optional":false},"org_id":{"fieldType":{"type":"string"},"optional":false}}}
teams:removeMember mutation public {"type":"object","value":{"team_id":{"fieldType":{"type":"string"},"optional":false},"profile_id":{"fieldType":{"type":"string"},"optional":false},"org_id":{"fieldType":{"type":"string"},"optional":false}}}
teams:setLeader mutation public {"type":"object","value":{"team_id":{"fieldType":{"type":"string"},"optional":false},"profile_id":{"fieldType":{"type":"string"},"optional":false},"is_leader":{"fieldType":{"type":"boolean"},"optional":false},"org_id":{"fieldType":{"type":"string"},"optional":false}}}
teams:update mutation public {"type":"object","value":{"id":{"fieldType":{"type":"string"},"optional":false},"patch":{"fieldType":{"type":"object","value":{"name":{"fieldType":{"type":"string"},"optional":true},"icon":{"fieldType":{"type":"union","value":[{"type":"string"},{"type":"null"}]},"optional":true},"icon_color":{"fieldType":{"type":"union","value":[{"type":"string"},{"type":"null"}]},"optional":true},"stale_days":{"fieldType":{"type":"number"},"optional":true},"archive_days":{"fieldType":{"type":"number"},"optional":true},"track_delay_default":{"fieldType":{"type":"boolean"},"optional":true}}},"optional":false},"org_id":{"fieldType":{"type":"string"},"optional":false}}}
tokens:createAgentKey mutation public {"type":"object","value":{"id":{"fieldType":{"type":"string"},"optional":false},"agent_id":{"fieldType":{"type":"string"},"optional":false},"name":{"fieldType":{"type":"string"},"optional":false},"key_prefix":{"fieldType":{"type":"string"},"optional":false},"key_hash":{"fieldType":{"type":"string"},"optional":false},"org_id":{"fieldType":{"type":"string"},"optional":false}}}
tokens:createMcpToken mutation public {"type":"object","value":{"id":{"fieldType":{"type":"string"},"optional":false},"profile_id":{"fieldType":{"type":"string"},"optional":false},"name":{"fieldType":{"type":"string"},"optional":false},"token_prefix":{"fieldType":{"type":"string"},"optional":false},"token_hash":{"fieldType":{"type":"string"},"optional":false}}}
tokens:deleteAgentKey mutation public {"type":"object","value":{"id":{"fieldType":{"type":"string"},"optional":false},"org_id":{"fieldType":{"type":"string"},"optional":false}}}
tokens:deleteMcpToken mutation public {"type":"object","value":{"id":{"fieldType":{"type":"string"},"optional":false}}}
tokens:listAgentKeys query public {"type":"object","value":{}}
tokens:listMcpTokens query public {"type":"object","value":{}}
tokens:revokeAgentKey mutation public {"type":"object","value":{"id":{"fieldType":{"type":"string"},"optional":false},"org_id":{"fieldType":{"type":"string"},"optional":false}}}
tokens:revokeMcpToken mutation public {"type":"object","value":{"id":{"fieldType":{"type":"string"},"optional":false}}}
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
webhooks:save mutation internal {"type":"object","value":{"owner":{"fieldType":{"type":"object","value":{"profile_id":{"fieldType":{"type":"string"},"optional":false},"credential_table":{"fieldType":{"type":"union","value":[{"type":"literal","value":"agent_keys"},{"type":"literal","value":"mcp_tokens"},{"type":"literal","value":"oauth_connections"}]},"optional":false},"credential_id":{"fieldType":{"type":"string"},"optional":false},"credential_row_id":{"fieldType":{"type":"string"},"optional":false}}},"optional":false},"id":{"fieldType":{"type":"string"},"optional":false},"name":{"fieldType":{"type":"union","value":[{"type":"literal","value":"task.created"},{"type":"literal","value":"task.updated"},{"type":"literal","value":"task.deleted"},{"type":"literal","value":"comment.created"}]},"optional":false},"filters":{"fieldType":{"type":"object","value":{"task_id":{"fieldType":{"type":"string"},"optional":true},"project_id":{"fieldType":{"type":"string"},"optional":true}}},"optional":false},"url":{"fieldType":{"type":"string"},"optional":false},"encrypted_secret":{"fieldType":{"type":"string"},"optional":false},"secret_hash":{"fieldType":{"type":"string"},"optional":true},"legacy_secret_hash":{"fieldType":{"type":"string"},"optional":true},"expires_at":{"fieldType":{"type":"number"},"optional":true}}}
webhooks:sweep mutation internal {"type":"object","value":{}}
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

/* Auth posture per public door, hand-grouped. `org*`/`adminMutation` consume
 * a wrapper-injected org_id wire arg; `authed*` gate on a login only;
 * `platform*` gate on a platform_admins row. `query` marks the ONE deliberate
 * bare registration (see the wrapper rule below). */
type Wrapper =
  | 'orgAction'
  | 'orgQuery'
  | 'orgMutation'
  | 'adminMutation'
  | 'authedQuery'
  | 'authedMutation'
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
  billing: { summary: 'orgQuery', usage: 'orgQuery', status: 'orgQuery' },
  billingActions: {
    checkout: 'orgAction',
    portal: 'orgAction',
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
    listOrgs: 'platformQuery',
    orgDetail: 'platformQuery',
    listUsers: 'platformQuery',
    promoteOrgAdmin: 'platformMutation',
    platformStats: 'platformQuery',
    auditLog: 'platformQuery',
  },
  adminAuth: {
    recoveryLink: 'platformAction',
    banUser: 'platformAction',
    unbanUser: 'platformAction',
    createBreakGlass: 'platformAction',
  },
  comments: { create: 'orgMutation', update: 'orgMutation', remove: 'orgMutation' },
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
  issues: {
    archivedFor: 'authedQuery',
    create: 'orgMutation',
    update: 'orgMutation',
    move: 'orgMutation',
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
  labels: {
    create: 'orgMutation',
    update: 'orgMutation',
    remove: 'orgMutation',
    toggle: 'orgMutation',
  },
  // removeRead clears current read rows in bounded batches beyond the Inbox display limit.
  // markAllRead reaches all own unread rows beyond the display cap and preserves later arrivals.
  // snooze hides an own item until a server-scheduled wake (messages:wake, internal).
  messages: {
    markAllRead: 'orgMutation',
    markRead: 'orgMutation',
    markUnread: 'orgMutation',
    remove: 'orgMutation',
    removeRead: 'orgMutation',
    snooze: 'orgMutation',
  },
  // Paginated ZIP export for org admins. orgQuery authenticates the active
  // seat; the handler positively requires admin on every page.
  orgExport: { page: 'orgQuery' },
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
    // The Blue theme persists Canvas's image-free palette as an account choice.
    save: 'authedMutation',
    createUpload: 'authedMutation',
    cancelUpload: 'authedMutation',
    removeCustom: 'authedMutation',
    mintCustomUrl: 'authedQuery',
  },
  prefs: { get: 'authedQuery', save: 'authedMutation' },
  profiles: {
    create: 'adminMutation',
    update: 'adminMutation',
    remove: 'orgMutation',
    setPlannableHours: 'orgMutation',
    setDisplayName: 'authedMutation',
    setMessageRetention: 'authedMutation',
  },
  projects: {
    create: 'orgMutation',
    update: 'orgMutation',
    archive: 'orgMutation',
    unarchive: 'orgMutation',
    deleteDeep: 'orgMutation',
    inviteGuest: 'orgMutation',
    addMilestone: 'orgMutation',
    updateMilestone: 'orgMutation',
    removeMilestone: 'orgMutation',
  },
  snapshot: { forMe: 'authedQuery', commentsForIssue: 'orgQuery' },
  // Team sync: staff stamp the person a change was made on (often not
  // themselves); any member reads the latest comment per visible open task.
  teamSync: { lastComments: 'orgQuery', stamp: 'orgMutation' },
  teams: {
    create: 'adminMutation',
    update: 'orgMutation',
    deleteDeep: 'orgMutation',
    addMember: 'orgMutation',
    removeMember: 'orgMutation',
    setLeader: 'orgMutation',
  },
  tokens: {
    listAgentKeys: 'authedQuery',
    createAgentKey: 'orgMutation',
    revokeAgentKey: 'orgMutation',
    deleteAgentKey: 'orgMutation',
    listMcpTokens: 'authedQuery',
    createMcpToken: 'authedMutation',
    revokeMcpToken: 'authedMutation',
    deleteMcpToken: 'authedMutation',
  },
}

/* Public entries are counted from the pinned manifest below. */
const PUBLIC_COUNT = 135

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
   * door may legitimately take org_id as a TARGET argument (admin:orgDetail
   * asks about an org, it is not scoped to one). */
  const ORG_WRAPPERS = new Set<Wrapper>(['orgQuery', 'orgMutation', 'adminMutation', 'orgAction'])
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
    authedQuery: 'query',
    authedMutation: 'mutation',
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
