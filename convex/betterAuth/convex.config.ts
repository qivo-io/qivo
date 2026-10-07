/* Local install of @convex-dev/better-auth (docs /features/local-install):
 * the component is defined in-repo so its schema can carry the admin
 * plugin's fields (user.role/banned/banReason/banExpires,
 * session.impersonatedBy), which the published component schema lacks. */
import { defineComponent } from 'convex/server'

const component = defineComponent('betterAuth')

export default component
