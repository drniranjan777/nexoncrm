-- CreateEnum
CREATE TYPE "ProformaStatus" AS ENUM ('DRAFT', 'SENT', 'VIEWED', 'ACCEPTED', 'REJECTED', 'EXPIRED', 'CONVERTED', 'CANCELLED');

-- AlterTable
ALTER TABLE "Quotation" ADD COLUMN     "otherTaxTotal" DECIMAL(14,2) NOT NULL DEFAULT 0,
ADD COLUMN     "taxBreakdown" JSONB;

-- AlterTable
ALTER TABLE "QuotationItem" ADD COLUMN     "discountAmount" DECIMAL(14,2) NOT NULL DEFAULT 0,
ADD COLUMN     "taxComponents" JSONB,
ADD COLUMN     "taxName" TEXT,
ADD COLUMN     "taxRateId" TEXT;

-- AlterTable
ALTER TABLE "Invoice" ADD COLUMN     "otherTaxTotal" DECIMAL(14,2) NOT NULL DEFAULT 0,
ADD COLUMN     "proformaInvoiceId" TEXT,
ADD COLUMN     "taxBreakdown" JSONB;

-- AlterTable
ALTER TABLE "InvoiceItem" ADD COLUMN     "discountAmount" DECIMAL(14,2) NOT NULL DEFAULT 0,
ADD COLUMN     "taxComponents" JSONB,
ADD COLUMN     "taxName" TEXT,
ADD COLUMN     "taxRateId" TEXT;

-- CreateTable
CREATE TABLE "TaxRate" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "taxType" TEXT NOT NULL DEFAULT 'GST',
    "rate" DECIMAL(5,2) NOT NULL,
    "components" JSONB NOT NULL,
    "jurisdiction" TEXT NOT NULL DEFAULT 'IN',
    "description" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "effectiveFrom" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "effectiveUntil" TIMESTAMP(3),
    "sortOrder" INTEGER NOT NULL DEFAULT 100,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TaxRate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProformaInvoice" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "referenceNumber" TEXT,
    "serviceReference" TEXT,
    "customerId" TEXT NOT NULL,
    "billTo" JSONB,
    "projectId" TEXT,
    "salespersonId" TEXT,
    "subject" TEXT,
    "status" "ProformaStatus" NOT NULL DEFAULT 'DRAFT',
    "issueDate" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "validUntil" TIMESTAMP(3),
    "paymentTerms" TEXT NOT NULL DEFAULT 'DUE_ON_RECEIPT',
    "placeOfSupply" TEXT,
    "isInterState" BOOLEAN NOT NULL DEFAULT false,
    "subtotal" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "discountType" TEXT NOT NULL DEFAULT 'PERCENT',
    "discountValue" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "discountTotal" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "taxableTotal" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "cgstTotal" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "sgstTotal" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "igstTotal" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "otherTaxTotal" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "taxBreakdown" JSONB,
    "withholdingType" TEXT,
    "withholdingRate" DECIMAL(5,2) NOT NULL DEFAULT 0,
    "withholdingAmount" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "adjustmentLabel" TEXT,
    "adjustment" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "roundOff" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "total" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "currency" TEXT NOT NULL DEFAULT 'INR',
    "exchangeRate" DECIMAL(18,8) NOT NULL DEFAULT 1,
    "authorization" JSONB,
    "emailRecipients" TEXT[],
    "notes" TEXT,
    "terms" TEXT,
    "sentAt" TIMESTAMP(3),
    "lastEmailedAt" TIMESTAMP(3),
    "acceptedAt" TIMESTAMP(3),
    "convertedInvoiceId" TEXT,
    "convertedAt" TIMESTAMP(3),
    "convertedById" TEXT,
    "cancelledAt" TIMESTAMP(3),
    "cancelReason" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProformaInvoice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProformaInvoiceItem" (
    "id" TEXT NOT NULL,
    "proformaInvoiceId" TEXT NOT NULL,
    "productId" TEXT,
    "description" TEXT NOT NULL,
    "hsnSac" TEXT,
    "quantity" DECIMAL(12,3) NOT NULL,
    "unit" TEXT,
    "rate" DECIMAL(14,2) NOT NULL,
    "discountPct" DECIMAL(5,2) NOT NULL DEFAULT 0,
    "discountAmount" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "taxRate" DECIMAL(5,2) NOT NULL,
    "taxRateId" TEXT,
    "taxName" TEXT,
    "taxComponents" JSONB,
    "taxable" DECIMAL(14,2) NOT NULL,
    "taxAmount" DECIMAL(14,2) NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "ProformaInvoiceItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EmailLog" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "to" TEXT[],
    "cc" TEXT[],
    "subject" TEXT NOT NULL,
    "attachments" TEXT[],
    "status" TEXT NOT NULL DEFAULT 'QUEUED',
    "error" TEXT,
    "providerMessageId" TEXT,
    "sentById" TEXT,
    "sentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EmailLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "TaxRate_tenantId_isActive_idx" ON "TaxRate"("tenantId", "isActive");

-- CreateIndex
CREATE UNIQUE INDEX "TaxRate_tenantId_code_key" ON "TaxRate"("tenantId", "code");

-- CreateIndex
CREATE UNIQUE INDEX "ProformaInvoice_convertedInvoiceId_key" ON "ProformaInvoice"("convertedInvoiceId");

-- CreateIndex
CREATE INDEX "ProformaInvoice_tenantId_status_idx" ON "ProformaInvoice"("tenantId", "status");

-- CreateIndex
CREATE INDEX "ProformaInvoice_tenantId_customerId_idx" ON "ProformaInvoice"("tenantId", "customerId");

-- CreateIndex
CREATE INDEX "ProformaInvoice_tenantId_issueDate_idx" ON "ProformaInvoice"("tenantId", "issueDate");

-- CreateIndex
CREATE UNIQUE INDEX "ProformaInvoice_tenantId_number_key" ON "ProformaInvoice"("tenantId", "number");

-- CreateIndex
CREATE INDEX "EmailLog_tenantId_entityType_entityId_idx" ON "EmailLog"("tenantId", "entityType", "entityId");

-- CreateIndex
CREATE UNIQUE INDEX "Invoice_proformaInvoiceId_key" ON "Invoice"("proformaInvoiceId");

-- AddForeignKey
ALTER TABLE "TaxRate" ADD CONSTRAINT "TaxRate_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProformaInvoice" ADD CONSTRAINT "ProformaInvoice_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProformaInvoice" ADD CONSTRAINT "ProformaInvoice_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProformaInvoice" ADD CONSTRAINT "ProformaInvoice_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProformaInvoiceItem" ADD CONSTRAINT "ProformaInvoiceItem_proformaInvoiceId_fkey" FOREIGN KEY ("proformaInvoiceId") REFERENCES "ProformaInvoice"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmailLog" ADD CONSTRAINT "EmailLog_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ───────────── Data backfill ─────────────

-- Default tax configurations for existing tenants (administrators can edit, add or deactivate them).
INSERT INTO "TaxRate" ("id", "tenantId", "name", "code", "taxType", "rate", "components", "description", "sortOrder", "effectiveFrom", "updatedAt")
SELECT 'tax' || substr(md5(random()::text || clock_timestamp()::text || t."id" || d.code), 1, 22), t."id", d.name, d.code, d.type, d.rate, d.components::jsonb, d.description, d.sort, '2017-07-01', CURRENT_TIMESTAMP
FROM "Tenant" t
CROSS JOIN (VALUES
  ('GST 0%', 'GST0', 'GST', 0, '{"intra":[],"inter":[]}', 'Nil-rated supplies', 10),
  ('GST 5%', 'GST5', 'GST', 5, '{"intra":[{"name":"CGST","rate":2.5},{"name":"SGST","rate":2.5}],"inter":[{"name":"IGST","rate":5}]}', NULL, 20),
  ('GST 12%', 'GST12', 'GST', 12, '{"intra":[{"name":"CGST","rate":6},{"name":"SGST","rate":6}],"inter":[{"name":"IGST","rate":12}]}', NULL, 30),
  ('GST 18%', 'GST18', 'GST', 18, '{"intra":[{"name":"CGST","rate":9},{"name":"SGST","rate":9}],"inter":[{"name":"IGST","rate":18}]}', NULL, 40),
  ('GST 28%', 'GST28', 'GST', 28, '{"intra":[{"name":"CGST","rate":14},{"name":"SGST","rate":14}],"inter":[{"name":"IGST","rate":28}]}', NULL, 50),
  ('Exempt', 'EXEMPT', 'EXEMPT', 0, '{"intra":[],"inter":[]}', 'Exempt supplies', 90)
) AS d(name, code, type, rate, components, description, sort)
ON CONFLICT ("tenantId", "code") DO NOTHING;

-- Proforma invoice permissions for the built-in roles. Custom roles are left for administrators to update.
UPDATE "Role" SET "permissions" = ARRAY(SELECT DISTINCT unnest("permissions" || ARRAY['proforma.read', 'proforma.create', 'proforma.send', 'proforma.convert']))
WHERE "isSystem" AND "key" IN ('owner', 'admin', 'accountant');
UPDATE "Role" SET "permissions" = ARRAY(SELECT DISTINCT unnest("permissions" || ARRAY['proforma.read', 'proforma.create', 'proforma.send']))
WHERE "isSystem" AND "key" IN ('crm_manager', 'sales');
UPDATE "Role" SET "permissions" = ARRAY(SELECT DISTINCT unnest("permissions" || ARRAY['proforma.read']))
WHERE "isSystem" AND "key" = 'auditor';
