/* The fields some REST bodies take, in the order a refusal of an unknown
 * field lists them (shared.ts refuseUnknownFields). scripts/staging-check.mjs
 * expects the same lists in the sentences the routes answer, and its test
 * holds them equal to these, so the end-to-end check cannot drift from the
 * contract. */

/** PUT /v1/projects/{ref}/access/{users|teams}/{id}. */
export const ACCESS_PUT_FIELDS = ['level', 'expected'] as const

/** DELETE /v1/projects/{ref}/access/{users|teams}/{id} and DELETE
 * /v1/teams/{ref}/members/{user}. */
export const HELD_TASKS_FIELDS = ['on_held_tasks'] as const

/** PUT /v1/teams/{ref}/members/{user}. */
export const MEMBER_PUT_FIELDS = ['leader'] as const
