# Nexonweb Business Platform

Multi-tenant business management SaaS: customer feedback portal, CRM with heuristic lead scoring,
onboarding, projects and tasks, support tickets, GST-ready quotations/proforma invoices/invoices/payments/credit notes
with configurable tax rates (Settings → Tax Settings),
reports, and a platform super-admin area.

- `apps/api`: Express 5 + TypeScript + Prisma 6 + PostgreSQL (REST under `/api/v1`)
- `apps/web`: React 19 + Vite + Tailwind v4 + TanStack Query + React Hook Form + Zod + Recharts
- Architecture notes: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) · Status: [docs/CHECKLIST.md](docs/CHECKLIST.md)

## Requirements

- Node.js 22+ (developed on 24)
- PostgreSQL 14+ (developed on 18)
- Redis (optional): background jobs use BullMQ when `REDIS_URL` is set, otherwise they run in-process

## Setup

```bash
npm install
```

Copy `apps/api/.env.example` to `apps/api/.env` and fill in `DATABASE_URL` and `TEST_DATABASE_URL`.
Percent-encode special characters in the password (`/` → `%2F`, `@` → `%40`, `#` → `%23`).
`TEST_DATABASE_URL` must point to a separate database whose name contains `test`.

```bash
npm run db:migrate
npm run db:seed
npm run dev
```

- Web app: http://localhost:5174
- API: http://localhost:4000/api/v1/health
- Public feedback form: http://localhost:5174/submit-feedback (on a `feedback.*` host it is served at `/`)

### Demo accounts (seed)

The seed creates one user per role for the **Nexonweb Solution** tenant (`owner@`, `admin@`, `crm@`, `sales@`,
`accounts@`, `pm@`, `support@`, `dev@`, `auditor@` at `nexonweb.com`), a customer portal user
(`client@acmeretail.in`), a platform super admin (`superadmin@nexonweb.com`) and a second tenant
(**ABC Digital Agency**, `owner@abcdigital.in`) to demonstrate isolation. All share the demo password
defined in `apps/api/prisma/seed.ts` (override with `SEED_PASSWORD`). For local development only.

## Scripts

| Command | What it does |
| --- | --- |
| `npm run dev` | API (tsx watch) + web (Vite) together |
| `npm test` | API unit and integration tests (Vitest + Supertest against `TEST_DATABASE_URL`) |
| `npm run typecheck` | TypeScript checks for both apps |
| `npm run build` | Production builds |
| `npm run db:migrate` | `prisma migrate dev` |
| `npm run db:seed` | Seed demo data (skips if the tenant already exists) |

## Configuration

See `apps/api/.env.example`. Notable switches:

- `SMTP_*`: without SMTP, emails are printed to the API console and invite links are shown in the UI.
- `STORAGE_DRIVER=s3` + `S3_*`: private S3-compatible storage; default is `./storage` on disk.
- `AI_PROVIDER=anthropic` + `ANTHROPIC_API_KEY`: AI drafts and summaries via Claude. The default
  `heuristic` mode makes no external calls and uses templates. Lead scoring and feedback sentiment are
  always rule-based and labelled as heuristic.
- PDF fonts: PDFs use the bundled Noto Sans in `apps/api/assets/fonts/` (SIL Open Font License, see `OFL.txt` and
  `OFL-NotoSansArabic.txt` there), so every currency symbol prints: ₹59,000.00, $, £, €, A$, C$, S$. Arabic-script
  symbols such as د.إ (AED) are drawn with the bundled Noto Sans Arabic. `PDF_FONT_REGULAR` / `PDF_FONT_BOLD`
  override the body font with paths to other TTFs. If no Unicode font is found, PDFs fall back to Helvetica, which
  prints $, £ and € and the ISO code for the rest (e.g. "INR 59,000.00"). Keep `assets/` next to `dist/` when deploying.

## Security model (summary)

- httpOnly session cookies (hashed in the database), CSRF header check on mutations, rate-limited auth.
- Tenant context comes only from the session plus an active membership. `X-Tenant-Id` selects a workspace;
  it never grants access on its own.
- Every tenant query filters by `tenantId`; client-supplied foreign keys are verified to belong to the tenant.
- Permissions are enforced on the server per route; developers, support agents and customers get row-level scoping.
- Files are private and served only through authorised endpoints; uploads are type-checked by magic bytes.
- Integration tests attempt cross-tenant reads/writes and privilege escalation.
