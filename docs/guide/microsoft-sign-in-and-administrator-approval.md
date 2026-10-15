Use **Sign in with Microsoft** at [Qivo](https://qivo.io/app) with your
Microsoft work or school account. Organizations that use Microsoft 365 or
Microsoft Entra ID may require an administrator to approve Qivo before
people can sign in.

If Microsoft shows **Need admin approval** or says administrator approval is
required, send this guide to your organization's Microsoft administrator.
Being a Qivo organization admin does not give you permission to approve apps
in Microsoft Entra ID.

## Approve Qivo for your organization

An administrator authorized to grant organization-wide consent in your
Microsoft Entra tenant must complete these steps. Microsoft documents the
[administrator roles that can grant consent](https://learn.microsoft.com/en-us/entra/identity/enterprise-apps/grant-admin-consent#prerequisites).

1. Open [Approve Qivo for your Microsoft organization](https://login.microsoftonline.com/organizations/adminconsent?client_id=65decab1-4111-4a47-b321-2368c4e8262b&redirect_uri=https%3A%2F%2Fqivo.io%2Fapp).
2. Sign in with your administrator account for the organization that needs
   access. The link uses that account's home tenant. If you administer several
   organizations, use an account whose home tenant is the organization you
   want to approve Qivo for.
3. Confirm that the application is **Qivo**, review the permissions Microsoft
   displays, and accept them on behalf of your organization if they meet your
   organization's requirements. The Qivo application ID is
   `65decab1-4111-4a47-b321-2368c4e8262b`.
4. Microsoft redirects you to `https://qivo.io/app`. Ask the person who was
   blocked to return to Qivo and choose **Sign in with Microsoft** again.

The approval link is for Microsoft work or school organizations, not personal
Microsoft accounts. It grants consent for the permissions shown by Microsoft
in that tenant. Opening the link alone does not grant approval.

## After approval

Microsoft approval does not add everyone in your Microsoft organization to
Qivo, assign Qivo roles or grant access to projects. A Qivo admin still
[invites people](./working-together.md#who-a-person-is) and manages
[project access](./who-sees-what-the-access-model.md). Sign in with the email
address invited to Qivo and complete Qivo's email confirmation when prompted.

Connecting an AI assistant has a separate approval in Qivo. After Microsoft
sign-in works, continue the assistant's connection flow and review its Qivo
organization and access before choosing **Connect**. See
[connecting an assistant](./automation-ai-the-rest-api-and-the-mcp-server.md#mcp-server-for-ai-assistants)
or the [agent authentication guide](https://qivo.io/auth.md).

## If sign-in is still blocked

- **Microsoft still asks for admin approval.** Ask your Microsoft
  administrator to check that consent completed in the same tenant as the
  person's work or school account. An account without the required Microsoft
  role cannot approve Qivo for the organization.
- **Microsoft says you are not assigned or access is blocked.** Ask the
  administrator to check Qivo under **Entra ID → Enterprise apps**, including
  user assignment and Conditional Access policies. Consent does not override
  those policies.
- **Qivo asks you to confirm your email.** Complete Qivo's confirmation email.
  Microsoft sign-in still requires this step, even after administrator approval.
- **You can sign in but cannot see your organization's work.** Ask a Qivo
  organization admin to check your invitation, account email and project
  access. Microsoft approval does not change these permissions.

For Microsoft-side details, see
[Grant tenant-wide admin consent to an application](https://learn.microsoft.com/en-us/entra/identity/enterprise-apps/grant-admin-consent).
