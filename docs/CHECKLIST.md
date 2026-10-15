# Implementation checklist

Status as of 2026-10-15. "Verified" means covered by automated tests or exercised in the running app.

## Done

| Area | Notes |
| --- | --- |
| Multi-tenant foundation | `tenantId` on all tenant data, per-tenant unique numbers, membership-based context. Cross-tenant access tests pass. |
| Auth | Register (creates workspace), login, logout, logout everywhere, session list/revoke, change password, forgot/reset password, invitations. |
| RBAC | 39 permissions, 10 system roles seeded per tenant, custom roles with escalation guard, server-side enforcement, row scoping for developer/support/customer. |
| Feedback portal | Public + secure project links, 10 service categories with conditional questions, ratings, attachments, honeypot, consent, reference number, tracking page with customer replies, confirmation email. |
| Feedback management | Filters, status workflow (7 statuses), assignment, internal notes, customer replies, create task/ticket, CSV export, heuristic sentiment/urgency/topics. |
| CRM | Leads table + Kanban pipeline (drag and drop), duplicate detection, activity timeline, CSV import/export, conversion to customer/project without duplicates, follow-up tasks. |
| Lead scoring | Transparent heuristic (8 weighted factors, reasons, missing info, priority, fit, trend, next action, follow-up date, historical win rate when ≥5 closed leads). |
| AI | Provider abstraction (heuristic templates or Claude), monthly per-plan quota, drafts only, never auto-sent. |
| Customers | Customers, contacts, onboarding checklist with templates, activity history, files. |
| Projects | Projects, members/team assignments, milestones, tasks (list + board), files, feedback links. |
| Support | Tickets with SLA by category/priority, internal notes vs replies, my tickets, categories, knowledge base. |
| Finance | Products/services with HSN/SAC, quotations (send/accept/reject/convert), draft → issued invoices, payments with reversal, credit notes, CGST/SGST vs IGST, PDFs, overdue job. |
| Customer portal | Overview, projects/milestones/shared files, invoices + PDFs, quotations accept/decline, tickets, feedback. |
| Reports | CRM, feedback, projects, support, sales, financial (GST summary, aging, collections). |
| Settings | Company/branding/logo, users & roles, tax, documents & numbering, onboarding template, notifications & CRM automation, subscription usage, integrations status, audit logs. |
| Platform admin | Overview, tenants (create with owner invite, suspend/reactivate, plan, trial), tenant admins, plans & module entitlements, platform settings, cross-tenant audit log (tenant views are audited). |
| Jobs | BullMQ (email retries, hourly maintenance) with in-process fallback. |
| Tests | 41 passing across unit, integration and billing suites. |

## Invoicing parity (added 2026-10-15)

| Area | Notes |
| --- | --- |
| Customers | Business/Individual, salutation, first/last name, display name, currency, work/mobile phone, language, GST treatment, GSTIN (auto state + PAN), place of supply, PAN, tax preference with exemption reason, payment terms, portal access invite, billing + shipping address, contact persons, custom fields, remarks. List shows receivables and unused credits. Transactions and Statement tabs (PDF, email). |
| Items | Goods/service, SKU, unit, HSN/SAC, taxable/exempt, GST rate, selling price, active flag. |
| Quotes & invoices | Auto or manual numbering, reference#/order number, terms with computed due date, salesperson, project, subject, item picker and bulk add, line discount, document discount (% or ₹, before tax), TDS/TCS, editable adjustment, optional round-off, customer notes, terms, email recipients, Save as Draft / Save and Send, Make Recurring, clone, void, write-off, delete draft. Exempt customers billed at 0% GST. |
| Recurring invoices | Profile name, frequency (week to 3 years), start, end or never expires, payment terms, create as draft or sent; scheduler catch-up; stop/resume/create now; child invoices. |
| Payments received | One payment across many invoices, auto-apply oldest first, bank charges, TDS deducted, excess kept as customer credit, apply credit later, remove an allocation, refunds, receipt email. |
| Expenses | Categories, GST on expense, paid through, vendor, reference, customer/project, billable with mark-up, receipts. |
| Time tracking | Timer and manual entries, billable flag, project hourly rate, invoice unbilled time + expenses into a draft. |
| Email | Compose screen with From/To/Cc/Bcc, editable subject and rich-text body, attach document PDF, customer statement and files; sending a draft marks it sent. |
| Home | Total receivables with aging, sales/receipts/expenses by month for the financial year, projects, top expenses, sales/receipts/dues table, recent updates. |
| Reports Center | 34 reports in Sales, Receivables, Payments, Recurring, Expenses, Taxes, Projects and Activity with favourites, date range, CSV and print. |
| GST filing | GSTR-1 sections (B2B, B2CL, B2CS, CDNR, HSN) with CSV export and GSTR-3B 3.1/3.2 summary per month. |
| Edit & delete | Row menus (Edit, PDF, Delete) on quotes, invoices, recurring profiles and expenses. Sent invoices can be edited (not below the amount received, not while a credit note is issued) and deleted when nothing is applied. Quotes editable until converted. Payments editable (not below the amount applied/refunded). Credit notes can be deleted. Expense categories can be renamed and deleted when unused. |
| Organizations | My Organizations page with organization ID, created date, role, default organization, New Organization. |

## Multi-currency, seal & signature (added 2026-10-15)

| Area | Notes |
| --- | --- |
| Currency catalog | Global `Currency` table (INR, USD, GBP, EUR, AUD, AED, CAD, SGD seeded) managed by the platform admin under Platform → Currencies; new codes need no code change. |
| Tenant currencies | Settings → Currencies: enable/disable per tenant, default currency (INR initially), base (reporting) currency INR, exchange rates with history. Disabling or changing the default never alters existing documents. |
| Documents | Quotes, invoices, recurring profiles, payments and credit notes store `currency` + `exchangeRate` (to base). New documents start in the default currency; per-document override; foreign currencies need a rate (last rate pre-filled). Quote → invoice keeps currency and rate. Clone keeps them. |
| Conversion | Changing currency never converts amounts. Explicit conversion with rate, date and confirmation: in the editor ("Convert amounts") and on quotes / draft invoices ("Convert currency"). |
| Calculations | Integer minor-unit arithmetic (no floating sums); 0-decimal currencies round the total to whole units. Item prices (kept in base) are converted at the document rate when picked. |
| Tax | Tax follows GST treatment and place of supply, not currency. Overseas and SEZ customers are zero rated (LUT), place of supply 96 (foreign country), IGST. |
| Payments | Payment currency = invoice currency; mixed-currency allocations are rejected. |
| Reporting | Reports Center, dashboards, customer balances and GST returns convert foreign documents to INR at each document's rate. GSTR-1 gains an Exports/SEZ section; GSTR-3B 3.1(b) zero-rated filled. Statements are per currency. |
| Seal & signature | Company Profile → Branding & authorization: upload/replace/remove seal and signature (PNG/JPG/WebP ≤ 2 MB, normalized to PNG, private storage, settings.manage only), signatory name/designation, separate invoice/quote visibility toggles, live preview. |
| PDFs | Currency code/name, exchange-rate line, amounts and words in the document currency, payment instructions section, balance-due highlight, "For <company>" block with seal + signature + signatory at bottom right; nothing reserved when not configured. Issued invoices / sent quotes use a snapshot of the authorization taken at that moment; replaced images are kept so old PDFs still render. |
| Tests | `test/currency.test.ts` (10 scenarios incl. tenant isolation, invalid uploads, default change, conversion, payments, GST, catalog). |

## Not done / follow-ups

- **Currency symbols in PDFs**: resolved. Bundled Noto Sans + Noto Sans Arabic (OFL, `apps/api/assets/fonts/`) print ₹, $, £, €, A$, C$, S$ and د.إ; `PDF_FONT_REGULAR`/`PDF_FONT_BOLD` override the body font.
- **Live exchange rates**: rates are entered manually (no rate-feed integration). Foreign-exchange gain/loss between invoice and payment rates is not posted.
- **Exports with IGST payment** (instead of LUT) and per-customer LUT numbers are not modelled.
- **Expenses and time** are recorded in the base currency only.

- **GSTIN prefill from the GST portal**: needs a GSP/GSTN API subscription. Today the state and PAN are derived from the GSTIN.
- **Online payment gateway** (Razorpay/Stripe "pay now" links) and **email domain authentication**.
- **Multiple PDF templates** and the **Simplified View** toggle on editors.
- **Purchases / input tax credit**: GST Filing covers outward supplies only.

- **PostgreSQL Row-Level Security** policies as a second isolation layer (schema is ready; policies not written).
- **Online billing** (Razorpay/Stripe) for subscriptions; plan changes are currently requested from the platform admin.
- **WhatsApp / outbound automation**: not connected. Integration requires WhatsApp Business API credentials and opt-in.
- **E-invoicing (IRN/QR) and e-way bills**: not implemented; the GST report is a summary, not a GSTR export.
- **Email templates**: emails are plain text.
- **Frontend tests** (component / end-to-end) are not written yet; only the API has automated tests.
- **Impersonation / support access** for super admins is intentionally not implemented.
- **2FA / SSO** not implemented.
- Production deployment (Docker, CI, HTTPS cookie settings, backups) is not set up.
