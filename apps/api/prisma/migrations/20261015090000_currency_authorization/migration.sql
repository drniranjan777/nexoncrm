-- AlterTable
ALTER TABLE "CreditNote" ADD COLUMN     "currency" TEXT NOT NULL DEFAULT 'INR',
ADD COLUMN     "exchangeRate" DECIMAL(18,8) NOT NULL DEFAULT 1;

-- AlterTable
ALTER TABLE "Invoice" ADD COLUMN     "authorization" JSONB,
ADD COLUMN     "currency" TEXT NOT NULL DEFAULT 'INR',
ADD COLUMN     "exchangeRate" DECIMAL(18,8) NOT NULL DEFAULT 1;

-- AlterTable
ALTER TABLE "Payment" ADD COLUMN     "currency" TEXT NOT NULL DEFAULT 'INR',
ADD COLUMN     "exchangeRate" DECIMAL(18,8) NOT NULL DEFAULT 1;

-- AlterTable
ALTER TABLE "Quotation" ADD COLUMN     "authorization" JSONB,
ADD COLUMN     "currency" TEXT NOT NULL DEFAULT 'INR',
ADD COLUMN     "exchangeRate" DECIMAL(18,8) NOT NULL DEFAULT 1;

-- AlterTable
ALTER TABLE "RecurringProfile" ADD COLUMN     "currency" TEXT NOT NULL DEFAULT 'INR',
ADD COLUMN     "exchangeRate" DECIMAL(18,8) NOT NULL DEFAULT 1;

-- AlterTable
ALTER TABLE "Tenant" ADD COLUMN     "defaultCurrency" TEXT NOT NULL DEFAULT 'INR',
ADD COLUMN     "sealFileId" TEXT,
ADD COLUMN     "showSealOnInvoice" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "showSealOnQuote" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "showSignatureOnInvoice" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "showSignatureOnQuote" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "signatoryDesignation" TEXT,
ADD COLUMN     "signatoryName" TEXT,
ADD COLUMN     "signatureFileId" TEXT;

-- CreateTable
CREATE TABLE "Currency" (
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "decimals" INTEGER NOT NULL DEFAULT 2,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 100,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Currency_pkey" PRIMARY KEY ("code")
);

-- CreateTable
CREATE TABLE "TenantCurrency" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "currencyCode" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TenantCurrency_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExchangeRate" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "currencyCode" TEXT NOT NULL,
    "baseCurrency" TEXT NOT NULL,
    "rate" DECIMAL(18,8) NOT NULL,
    "rateDate" TIMESTAMP(3) NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'manual',
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ExchangeRate_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "TenantCurrency_tenantId_currencyCode_key" ON "TenantCurrency"("tenantId", "currencyCode");

-- CreateIndex
CREATE INDEX "ExchangeRate_tenantId_currencyCode_rateDate_idx" ON "ExchangeRate"("tenantId", "currencyCode", "rateDate");

-- AddForeignKey
ALTER TABLE "TenantCurrency" ADD CONSTRAINT "TenantCurrency_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TenantCurrency" ADD CONSTRAINT "TenantCurrency_currencyCode_fkey" FOREIGN KEY ("currencyCode") REFERENCES "Currency"("code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExchangeRate" ADD CONSTRAINT "ExchangeRate_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ───────────── Data: currency catalog and backfill (non-destructive) ─────────────

-- Supported currencies. Existing rows are left untouched.
INSERT INTO "Currency" ("code", "name", "symbol", "decimals", "isActive", "sortOrder", "updatedAt") VALUES
  ('INR', 'Indian Rupee', '₹', 2, true, 1, CURRENT_TIMESTAMP),
  ('USD', 'US Dollar', '$', 2, true, 2, CURRENT_TIMESTAMP),
  ('GBP', 'British Pound', '£', 2, true, 3, CURRENT_TIMESTAMP),
  ('EUR', 'Euro', '€', 2, true, 4, CURRENT_TIMESTAMP),
  ('AUD', 'Australian Dollar', 'A$', 2, true, 5, CURRENT_TIMESTAMP),
  ('AED', 'UAE Dirham', 'د.إ', 2, true, 6, CURRENT_TIMESTAMP),
  ('CAD', 'Canadian Dollar', 'C$', 2, true, 7, CURRENT_TIMESTAMP),
  ('SGD', 'Singapore Dollar', 'S$', 2, true, 8, CURRENT_TIMESTAMP)
ON CONFLICT ("code") DO NOTHING;

-- Every existing workspace issued documents in its base currency (INR) until now:
-- document currency defaults to that, with an exchange rate of 1.
UPDATE "Tenant" SET "defaultCurrency" = "currency";
UPDATE "Quotation" q SET "currency" = t."currency" FROM "Tenant" t WHERE q."tenantId" = t."id";
UPDATE "Invoice" i SET "currency" = t."currency" FROM "Tenant" t WHERE i."tenantId" = t."id";
UPDATE "Payment" p SET "currency" = t."currency" FROM "Tenant" t WHERE p."tenantId" = t."id";
UPDATE "CreditNote" c SET "currency" = t."currency" FROM "Tenant" t WHERE c."tenantId" = t."id";
UPDATE "RecurringProfile" r SET "currency" = t."currency" FROM "Tenant" t WHERE r."tenantId" = t."id";

-- Enable the catalog for existing workspaces (each tenant can switch currencies off later).
INSERT INTO "TenantCurrency" ("id", "tenantId", "currencyCode", "isActive")
SELECT 'tc_' || md5(t."id" || c."code"), t."id", c."code", true
FROM "Tenant" t CROSS JOIN "Currency" c
ON CONFLICT ("tenantId", "currencyCode") DO NOTHING;
