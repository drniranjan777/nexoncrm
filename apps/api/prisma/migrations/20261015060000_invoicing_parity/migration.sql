-- CreateEnum
CREATE TYPE "RecurrenceFrequency" AS ENUM ('WEEK', 'TWO_WEEKS', 'MONTH', 'TWO_MONTHS', 'THREE_MONTHS', 'SIX_MONTHS', 'YEAR', 'TWO_YEARS', 'THREE_YEARS');

-- CreateEnum
CREATE TYPE "RecurringStatus" AS ENUM ('ACTIVE', 'STOPPED', 'EXPIRED');

-- AlterEnum
ALTER TYPE "InvoiceStatus" ADD VALUE 'WRITTEN_OFF';

-- DropForeignKey
ALTER TABLE "Payment" DROP CONSTRAINT "Payment_invoiceId_fkey";

-- AlterTable
ALTER TABLE "Customer" ADD COLUMN     "billingAttention" TEXT,
ADD COLUMN     "currency" TEXT NOT NULL DEFAULT 'INR',
ADD COLUMN     "customFields" JSONB NOT NULL DEFAULT '{}',
ADD COLUMN     "customerType" TEXT NOT NULL DEFAULT 'BUSINESS',
ADD COLUMN     "exemptionReason" TEXT,
ADD COLUMN     "firstName" TEXT,
ADD COLUMN     "gstTreatment" TEXT,
ADD COLUMN     "language" TEXT NOT NULL DEFAULT 'en',
ADD COLUMN     "lastName" TEXT,
ADD COLUMN     "mobile" TEXT,
ADD COLUMN     "pan" TEXT,
ADD COLUMN     "paymentTerms" TEXT NOT NULL DEFAULT 'DUE_ON_RECEIPT',
ADD COLUMN     "salutation" TEXT,
ADD COLUMN     "shippingAddress" TEXT,
ADD COLUMN     "shippingAttention" TEXT,
ADD COLUMN     "shippingCity" TEXT,
ADD COLUMN     "shippingCountry" TEXT,
ADD COLUMN     "shippingPostalCode" TEXT,
ADD COLUMN     "shippingState" TEXT,
ADD COLUMN     "taxPreference" TEXT NOT NULL DEFAULT 'TAXABLE';

-- AlterTable
ALTER TABLE "Invoice" ADD COLUMN     "adjustment" DECIMAL(14,2) NOT NULL DEFAULT 0,
ADD COLUMN     "adjustmentLabel" TEXT,
ADD COLUMN     "discountType" TEXT NOT NULL DEFAULT 'PERCENT',
ADD COLUMN     "discountValue" DECIMAL(14,2) NOT NULL DEFAULT 0,
ADD COLUMN     "emailRecipients" TEXT[],
ADD COLUMN     "lastEmailedAt" TIMESTAMP(3),
ADD COLUMN     "orderNumber" TEXT,
ADD COLUMN     "paymentTerms" TEXT NOT NULL DEFAULT 'DUE_ON_RECEIPT',
ADD COLUMN     "recurringProfileId" TEXT,
ADD COLUMN     "roundOff" DECIMAL(14,2) NOT NULL DEFAULT 0,
ADD COLUMN     "salespersonId" TEXT,
ADD COLUMN     "subject" TEXT,
ADD COLUMN     "withholdingAmount" DECIMAL(14,2) NOT NULL DEFAULT 0,
ADD COLUMN     "withholdingRate" DECIMAL(5,2) NOT NULL DEFAULT 0,
ADD COLUMN     "withholdingType" TEXT,
ADD COLUMN     "writeOffAmount" DECIMAL(14,2) NOT NULL DEFAULT 0,
ADD COLUMN     "writtenOffAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "Payment" ADD COLUMN     "bankCharges" DECIMAL(14,2) NOT NULL DEFAULT 0,
ADD COLUMN     "customerId" TEXT,
ADD COLUMN     "refundedAmount" DECIMAL(14,2) NOT NULL DEFAULT 0,
ADD COLUMN     "taxDeducted" DECIMAL(14,2) NOT NULL DEFAULT 0,
ADD COLUMN     "unusedAmount" DECIMAL(14,2) NOT NULL DEFAULT 0,
ALTER COLUMN "invoiceId" DROP NOT NULL;

-- AlterTable
ALTER TABLE "Product" ADD COLUMN     "sku" TEXT,
ADD COLUMN     "taxPreference" TEXT NOT NULL DEFAULT 'TAXABLE';

-- AlterTable
ALTER TABLE "Project" ADD COLUMN     "billingMethod" TEXT NOT NULL DEFAULT 'FIXED',
ADD COLUMN     "hourlyRate" DECIMAL(14,2);

-- AlterTable
ALTER TABLE "Quotation" ADD COLUMN     "adjustment" DECIMAL(14,2) NOT NULL DEFAULT 0,
ADD COLUMN     "adjustmentLabel" TEXT,
ADD COLUMN     "discountType" TEXT NOT NULL DEFAULT 'PERCENT',
ADD COLUMN     "discountValue" DECIMAL(14,2) NOT NULL DEFAULT 0,
ADD COLUMN     "projectId" TEXT,
ADD COLUMN     "referenceNumber" TEXT,
ADD COLUMN     "roundOff" DECIMAL(14,2) NOT NULL DEFAULT 0,
ADD COLUMN     "salespersonId" TEXT,
ADD COLUMN     "subject" TEXT,
ADD COLUMN     "withholdingAmount" DECIMAL(14,2) NOT NULL DEFAULT 0,
ADD COLUMN     "withholdingRate" DECIMAL(5,2) NOT NULL DEFAULT 0,
ADD COLUMN     "withholdingType" TEXT;

-- AlterTable
ALTER TABLE "Tenant" ADD COLUMN     "fiscalYearStartMonth" INTEGER NOT NULL DEFAULT 4,
ADD COLUMN     "orgCode" TEXT;

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "defaultTenantId" TEXT;

-- CreateTable
CREATE TABLE "PaymentAllocation" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "paymentId" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "appliedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PaymentAllocation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PaymentRefund" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "paymentId" TEXT NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "refundedAt" TIMESTAMP(3) NOT NULL,
    "method" TEXT NOT NULL,
    "reference" TEXT,
    "notes" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PaymentRefund_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RecurringProfile" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "profileName" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "projectId" TEXT,
    "orderNumber" TEXT,
    "frequency" "RecurrenceFrequency" NOT NULL DEFAULT 'MONTH',
    "startDate" TIMESTAMP(3) NOT NULL,
    "endDate" TIMESTAMP(3),
    "nextRunDate" TIMESTAMP(3) NOT NULL,
    "lastRunDate" TIMESTAMP(3),
    "paymentTerms" TEXT NOT NULL DEFAULT 'DUE_ON_RECEIPT',
    "salespersonId" TEXT,
    "subject" TEXT,
    "placeOfSupply" TEXT,
    "discountType" TEXT NOT NULL DEFAULT 'PERCENT',
    "discountValue" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "withholdingType" TEXT,
    "withholdingRate" DECIMAL(5,2) NOT NULL DEFAULT 0,
    "adjustmentLabel" TEXT,
    "adjustment" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "items" JSONB NOT NULL,
    "notes" TEXT,
    "terms" TEXT,
    "createAs" TEXT NOT NULL DEFAULT 'DRAFT',
    "status" "RecurringStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RecurringProfile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExpenseCategory" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ExpenseCategory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Expense" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "categoryId" TEXT,
    "amount" DECIMAL(14,2) NOT NULL,
    "taxRate" DECIMAL(5,2) NOT NULL DEFAULT 0,
    "taxAmount" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "total" DECIMAL(14,2) NOT NULL,
    "paidThrough" TEXT NOT NULL DEFAULT 'CASH',
    "vendor" TEXT,
    "reference" TEXT,
    "notes" TEXT,
    "customerId" TEXT,
    "projectId" TEXT,
    "billable" BOOLEAN NOT NULL DEFAULT false,
    "markupPct" DECIMAL(5,2) NOT NULL DEFAULT 0,
    "invoiceId" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Expense_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TimeEntry" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "taskId" TEXT,
    "userId" TEXT NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "minutes" INTEGER NOT NULL DEFAULT 0,
    "timerStartedAt" TIMESTAMP(3),
    "notes" TEXT,
    "billable" BOOLEAN NOT NULL DEFAULT true,
    "invoiceId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TimeEntry_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PaymentAllocation_tenantId_invoiceId_idx" ON "PaymentAllocation"("tenantId", "invoiceId");

-- CreateIndex
CREATE INDEX "PaymentAllocation_paymentId_idx" ON "PaymentAllocation"("paymentId");

-- CreateIndex
CREATE INDEX "PaymentRefund_tenantId_refundedAt_idx" ON "PaymentRefund"("tenantId", "refundedAt");

-- CreateIndex
CREATE INDEX "RecurringProfile_tenantId_status_nextRunDate_idx" ON "RecurringProfile"("tenantId", "status", "nextRunDate");

-- CreateIndex
CREATE UNIQUE INDEX "ExpenseCategory_tenantId_name_key" ON "ExpenseCategory"("tenantId", "name");

-- CreateIndex
CREATE INDEX "Expense_tenantId_date_idx" ON "Expense"("tenantId", "date");

-- CreateIndex
CREATE INDEX "Expense_tenantId_customerId_idx" ON "Expense"("tenantId", "customerId");

-- CreateIndex
CREATE INDEX "TimeEntry_tenantId_projectId_date_idx" ON "TimeEntry"("tenantId", "projectId", "date");

-- CreateIndex
CREATE INDEX "TimeEntry_tenantId_userId_date_idx" ON "TimeEntry"("tenantId", "userId", "date");

-- CreateIndex
CREATE INDEX "Payment_tenantId_customerId_idx" ON "Payment"("tenantId", "customerId");

-- CreateIndex
CREATE UNIQUE INDEX "Tenant_orgCode_key" ON "Tenant"("orgCode");

-- AddForeignKey
ALTER TABLE "Quotation" ADD CONSTRAINT "Quotation_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_recurringProfileId_fkey" FOREIGN KEY ("recurringProfileId") REFERENCES "RecurringProfile"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "Invoice"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentAllocation" ADD CONSTRAINT "PaymentAllocation_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentAllocation" ADD CONSTRAINT "PaymentAllocation_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "Payment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentAllocation" ADD CONSTRAINT "PaymentAllocation_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "Invoice"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentRefund" ADD CONSTRAINT "PaymentRefund_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentRefund" ADD CONSTRAINT "PaymentRefund_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "Payment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecurringProfile" ADD CONSTRAINT "RecurringProfile_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecurringProfile" ADD CONSTRAINT "RecurringProfile_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecurringProfile" ADD CONSTRAINT "RecurringProfile_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExpenseCategory" ADD CONSTRAINT "ExpenseCategory_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Expense" ADD CONSTRAINT "Expense_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Expense" ADD CONSTRAINT "Expense_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "ExpenseCategory"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Expense" ADD CONSTRAINT "Expense_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Expense" ADD CONSTRAINT "Expense_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Expense" ADD CONSTRAINT "Expense_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "Invoice"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TimeEntry" ADD CONSTRAINT "TimeEntry_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TimeEntry" ADD CONSTRAINT "TimeEntry_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TimeEntry" ADD CONSTRAINT "TimeEntry_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "Invoice"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- ── Data backfill ──────────────────────────────────────────────────────────

-- Payments: record the customer and turn each single-invoice payment into an allocation.
UPDATE "Payment" p SET "customerId" = i."customerId" FROM "Invoice" i WHERE p."invoiceId" = i."id" AND p."customerId" IS NULL;
INSERT INTO "PaymentAllocation" ("id", "tenantId", "paymentId", "invoiceId", "amount", "appliedAt")
SELECT 'alloc_' || p."id", p."tenantId", p."id", p."invoiceId", p."amount", p."paidAt"
FROM "Payment" p WHERE p."invoiceId" IS NOT NULL
ON CONFLICT DO NOTHING;

-- Invoices: describe existing due dates as terms.
UPDATE "Invoice" SET "paymentTerms" = 'CUSTOM' WHERE "dueDate" IS NOT NULL AND "dueDate"::date <> "issueDate"::date;

-- Customers: GST treatment from GSTIN presence; first payment terms default stays Due on Receipt.
UPDATE "Customer" SET "gstTreatment" = CASE WHEN "gstin" IS NOT NULL AND "gstin" <> '' THEN 'REGISTERED_REGULAR' ELSE 'UNREGISTERED' END WHERE "gstTreatment" IS NULL;

-- Organizations: 11-digit public organization IDs.
UPDATE "Tenant" t SET "orgCode" = sub.code
FROM (SELECT "id", (60000000000 + row_number() OVER (ORDER BY "createdAt") * 1000 + floor(random() * 900)::int)::text AS code FROM "Tenant") sub
WHERE t."id" = sub."id" AND t."orgCode" IS NULL;
