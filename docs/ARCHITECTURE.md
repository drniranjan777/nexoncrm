# Nexonweb Business Platform — Architecture

## Shape
A **modular monolith** in an npm-workspaces repo:

```
apps/api   Express 5 + TypeScript + Prisma 6 + PostgreSQL   (REST under /api/v1)
apps/web   React 19 + Vite + TypeScript + Tailwind v4 + TanStack Query + RHF + Zod + Recharts
docs/      architecture and checklist
```

`apps/api/src/modules/<module>/` holds one router per business module. Shared
infrastructure lives in `apps/api/src/lib` (db, auth, rbac, audit, storage, mail,
pdf, gst, ai, queue, numbering).

## Multi-tenancy
* Shared database, shared schema. Every tenant-owned table has `tenantId`, and
  business numbers are unique per tenant (`@@unique([tenantId, number])`).
* Tenant context is resolved **only** from the authenticated session plus an
  active `Membership` row (`X-Tenant-Id` header selects among the user's
  memberships, it never grants access by itself). See `middleware/tenant.ts`.
* Every query in a tenant router filters by `req.ctx.tenantId`. Related ids sent
  by clients (customerId, projectId, assigneeId, …) are verified with
  `assertTenantRefs()` before writes.
* Files are stored under `tenants/<tenantId>/…` keys and only served through an
  authorised endpoint that re-checks tenant + permission.
* Background jobs carry `tenantId` in the payload and re-scope every query.
* Integration tests (`apps/api/test/tenant-isolation.test.ts`) attempt
  cross-tenant reads and writes and expect 404s.
* RLS: schema is RLS-compatible (all tables carry `tenantId`); enabling Postgres
  RLS policies is a planned hardening step (see checklist).

## Auth & RBAC
* Email + password (bcrypt). Opaque session tokens in an httpOnly, SameSite=Lax
  cookie; only a SHA-256 hash is stored (`Session`). Logout / logout-all revoke rows.
* Password reset via single-use hashed tokens with 1h expiry.
* Roles are per-tenant rows holding a permission list; system roles are seeded
  on tenant creation (Owner, Admin, CRM Manager, Sales Executive, Accountant,
  Project Manager, Support Agent, Developer, Customer, Read-Only Auditor).
* `requirePerm('invoices.issue')` guards each route on the server. The web app
  only hides navigation the user cannot use; it is not the enforcement layer.
* Row-scoping: Developers only see projects they are members of; Support agents
  with only `tickets.read_assigned` only see their tickets; Customers only see
  records linked to their own `Customer`.
* Platform super admin is a flag on `User` and uses `/api/v1/platform/*`;
  impersonation is not implemented — cross-tenant reads are audited.

## Finance (GST)
* Amounts are computed in integer paise (`lib/gst.ts`) and stored as Decimal(14,2).
* Intra-state supply (tenant state == place of supply) → CGST + SGST split;
  inter-state → IGST. Per-line HSN/SAC and tax rate.
* Tax rates are tenant data (`TaxRate`, managed under Settings → Tax Settings, API `/tax-rates`). Each has an
  intra-state and an inter-state component list (e.g. CGST 9 + SGST 9 / IGST 18, optionally + CESS). A line
  stores the chosen `taxRateId` plus a copy of its name, rate and components, so editing or deactivating a
  rate never changes saved documents. Rates in use cannot be deleted, only deactivated. Lines without a
  `taxRateId` (older documents and API clients sending `taxRate`) use the CGST/SGST/IGST rule above.
  `lib/taxes.ts` resolves and validates rates; documents store a `taxBreakdown` by component and rate.
* Proforma invoices (`/proforma-invoices`, `PI-` series) are not tax invoices. Only drafts are editable.
  Converting one creates a DRAFT invoice (invoice series, recalculated, linked by `proformaInvoiceId`); the
  proforma row is claimed with a conditional update inside the transaction, so a second conversion fails.
  No payment is recorded and the invoice is not issued. Deleting that draft invoice reopens the proforma.
* Document emails create an `EmailLog` (QUEUED → SENT when the SMTP server accepts it, FAILED, or
  NOT_CONFIGURED without SMTP). DELIVERED / BOUNCED exist for provider webhooks, which are not wired yet.
* Document numbers come from `DocumentSequence` rows incremented in a transaction.
* Issued invoices are immutable; corrections go through Credit Notes; cancelling
  requires `invoices.cancel` and no recorded payments.

## AI
`lib/ai` exposes a provider interface. `heuristic` (default, no network) gives
transparent lead scoring, keyword sentiment / classification and template
drafts. `anthropic` is used for drafting and summaries when `AI_PROVIDER=anthropic`
and `ANTHROPIC_API_KEY` are set. Lead scores are always labelled as heuristic.
Per-tenant monthly AI request limits come from the plan.

## Jobs
`lib/queue.ts` uses BullMQ when `REDIS_URL` is set (email delivery, daily
maintenance: overdue invoices, follow-up reminders, trial expiry), and falls back
to in-process execution otherwise.
