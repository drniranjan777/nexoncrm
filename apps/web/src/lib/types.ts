// Shapes returned by the API (Decimals arrive as strings).
type Money = string | number;

export interface Customer {
  id: string; code: string; name: string; company: string | null; email: string | null; phone: string | null; website: string | null;
  customerType: string; salutation: string | null; firstName: string | null; lastName: string | null; mobile: string | null;
  currency: string; language: string; gstTreatment: string | null; pan: string | null; taxPreference: string; exemptionReason: string | null; paymentTerms: string;
  billingAttention: string | null; shippingAttention: string | null; shippingAddress: string | null; shippingCity: string | null; shippingState: string | null;
  shippingPostalCode: string | null; shippingCountry: string | null; customFields: Record<string, string>; country: string;
  receivables?: number; unusedCredits?: number; portalEnabled?: boolean;
  gstin: string | null; billingAddress: string | null; city: string | null; state: string | null; stateCode: string | null; postalCode: string | null;
  status: string; onboardingStatus: string; ownerId: string | null; notes: string | null; createdAt: string;
  _count?: { projects: number; invoices: number; tickets: number; feedback?: number; quotations?: number };
}

export interface Contact { id: string; customerId: string; name: string; email: string | null; phone: string | null; designation: string | null; isPrimary: boolean; customer?: { id: string; name: string; company: string | null } }

export interface Activity { id: string; type: string; subject: string; body: string | null; occurredAt: string; completed: boolean; userId: string | null; leadId: string | null; customerId: string | null; lead?: { id: string; name: string; company: string | null } | null; customer?: { id: string; name: string } | null }

export interface ScoreDetails {
  score: number; priority: string; fit: string; engagementTrend: string; nextAction: string; suggestedFollowUp: string; model: string; historicalWinRate?: number;
  missing: string[]; factors: { key: string; label: string; points: number; max: number; reason: string }[];
}

export interface Lead {
  id: string; name: string; company: string | null; email: string | null; phone: string | null; source: string | null; serviceInterest: string | null;
  budgetRange: string | null; estimatedValue: Money | null; expectedDecisionAt: string | null; assignedToId: string | null; stage: string;
  lastContactAt: string | null; nextFollowUpAt: string | null; proposalStatus: string | null; notes: string | null; lostReason: string | null;
  convertedAt: string | null; customerId: string | null; score: number; scoreDetails: ScoreDetails | Record<string, never>; createdAt: string;
}

export interface Task {
  id: string; title: string; description: string | null; type: string; status: string; priority: string; dueDate: string | null; assigneeId: string | null;
  createdById: string | null; projectId: string | null; milestoneId: string | null; leadId: string | null; customerId: string | null; feedbackId: string | null; automated: boolean;
  project?: { id: string; code: string; name: string } | null; lead?: { id: string; name: string; company: string | null } | null; customer?: { id: string; name: string } | null; milestone?: { id: string; title: string } | null;
}

export interface Project {
  id: string; code: string; name: string; customerId: string | null; serviceCategory: string | null; status: string; description: string | null;
  startDate: string | null; dueDate: string | null; budget: Money | null; managerId: string | null; createdAt: string; progress?: number;
  billingMethod?: string; hourlyRate?: Money | null;
  customer?: { id: string; name: string; company: string | null; email?: string | null } | null;
  _count?: { tasks: number; members: number; milestones: number; tickets?: number; feedback?: number };
}

export interface Milestone { id: string; projectId: string; title: string; dueDate: string | null; status: string; taskCount?: number; doneCount?: number; project?: { id: string; code: string; name: string } }

export interface Feedback {
  id: string; referenceNo: string; name: string; company: string | null; email: string; phone: string | null; serviceCategory: string; projectStatus: string | null;
  ratingOverall: number; ratingCommunication: number | null; ratingQuality: number | null; ratingTimeliness: number | null; ratingTechnical: number | null;
  serviceAnswers: Record<string, string | number>; workingWell: string | null; needsImprovement: string | null; requestedChanges: string | null; urgentIssues: string | null;
  expectationStatus: string | null; comments: string | null; status: string; assignedToId: string | null; sentiment: string | null; sentimentScore: number | null;
  aiCategories: string[]; isUrgent: boolean; createdAt: string; resolvedAt: string | null; customerId: string | null; projectId: string | null;
  project?: { id: string; code: string; name: string } | null; customer?: { id: string; name: string; company?: string | null; code?: string } | null;
}

export interface Ticket {
  id: string; number: string; subject: string; description: string; customerId: string | null; projectId: string | null; categoryId: string | null;
  priority: string; status: string; assigneeId: string | null; createdById: string | null; dueAt: string | null; resolvedAt: string | null; createdAt: string; updatedAt: string;
  customer?: { id: string; name: string; company?: string | null; email?: string | null; phone?: string | null } | null; category?: { id: string; name: string } | null;
  project?: { id: string; code: string; name: string } | null; _count?: { comments: number };
}

export interface Product { id: string; name: string; description: string | null; type: string; sku: string | null; hsnSac: string | null; unit: string; rate: Money; taxPreference: string; taxRate: Money; active: boolean }

export interface RecurringProfile {
  id: string; profileName: string; customerId: string; projectId: string | null; orderNumber: string | null; frequency: string; startDate: string; endDate: string | null;
  nextRunDate: string; lastRunDate: string | null; paymentTerms: string; salespersonId: string | null; subject: string | null; placeOfSupply: string | null;
  discountType: string; discountValue: Money; withholdingType: string | null; withholdingRate: Money; adjustmentLabel: string | null; adjustment: Money;
  items: LineItem[]; notes: string | null; terms: string | null; createAs: string; status: string; amount?: number; currency: string; exchangeRate: Money;
  customer?: { id: string; name: string; company?: string | null; email?: string | null }; _count?: { invoices: number };
}

export interface Expense {
  id: string; date: string; categoryId: string | null; amount: Money; taxRate: Money; taxAmount: Money; total: Money; paidThrough: string; vendor: string | null; reference: string | null;
  notes: string | null; customerId: string | null; projectId: string | null; billable: boolean; markupPct: Money; invoiceId: string | null;
  category?: { id: string; name: string } | null; customer?: { id: string; name: string } | null; project?: { id: string; name: string } | null; invoice?: { id: string; number: string | null } | null;
}

export interface TimeEntry {
  id: string; projectId: string; taskId: string | null; userId: string; date: string; minutes: number; timerStartedAt: string | null; notes: string | null; billable: boolean; invoiceId: string | null;
  project?: { id: string; code: string; name: string; customerId: string | null; hourlyRate: Money | null }; invoice?: { id: string; number: string | null } | null;
}

export interface LineItem {
  id?: string; productId: string | null; description: string; hsnSac: string | null; quantity: Money; unit: string | null; rate: Money; discountPct: Money; taxRate: Money;
  /** Fixed line discount (used instead of discountPct when non-zero). */
  discountAmount?: Money;
  /** Tax configuration chosen for the line and its values as saved. */
  taxRateId?: string | null; taxName?: string | null; taxComponents?: TaxComponents | null;
  taxable?: Money; taxAmount?: Money; amount?: Money;
}

export interface TaxComponent { name: string; rate: number }
export interface TaxComponents { intra: TaxComponent[]; inter: TaxComponent[] }
export interface TaxBreakdownRow { name: string; rate: number; taxable: number; amount: number }
/** A tax configuration offered on document lines. */
export interface TaxOption { id: string; name: string; code: string; taxType: string; rate: Money; components: TaxComponents }
export interface TaxRate extends TaxOption {
  jurisdiction: string; description: string | null; isActive: boolean; effectiveFrom: string; effectiveUntil: string | null; sortOrder: number; usage?: number;
}

interface DocTotals {
  subtotal: Money; discountTotal: Money; taxableTotal: Money; cgstTotal: Money; sgstTotal: Money; igstTotal: Money; total: Money;
  /** Other components such as cess, and the tax summary by component and rate (absent on older documents). */
  otherTaxTotal?: Money; taxBreakdown?: TaxBreakdownRow[] | null;
  discountType: string; discountValue: Money; withholdingType: string | null; withholdingRate: Money; withholdingAmount: Money;
  adjustmentLabel: string | null; adjustment: Money; roundOff: Money; subject: string | null; salespersonId: string | null; salespersonName?: string | null;
  /** Document currency (ISO code) and its rate to the base currency. */
  currency: string; exchangeRate: Money;
}

export interface Quotation extends DocTotals {
  id: string; number: string; customerId: string | null; leadId: string | null; status: string; issueDate: string; validUntil: string | null; placeOfSupply: string | null;
  referenceNumber: string | null; projectId: string | null; project?: { id: string; code: string; name: string } | null;
  isInterState: boolean; notes: string | null; terms: string | null; convertedInvoiceId: string | null; items?: LineItem[];
  customer?: Customer | { id: string; name: string; company: string | null } | null; lead?: { id: string; name: string; company: string | null; email?: string | null } | null;
}

export interface Payment {
  id: string; number: string; invoiceId: string | null; customerId: string | null; amount: Money; bankCharges: Money; taxDeducted: Money; unusedAmount: Money; refundedAmount: Money;
  paidAt: string; method: string; reference: string | null; notes: string | null; invoiceNumbers?: string[]; currency: string; exchangeRate: Money;
  customer?: { id: string; name: string; company?: string | null; email?: string | null } | null;
  invoice?: { id: string; number: string | null; customer: { id: string; name: string } | null } | null;
  allocations?: { id: string; amount: Money; appliedAt: string; invoice: { id: string; number: string | null; issueDate: string; total: Money; balanceDue: Money } }[];
  refunds?: { id: string; amount: Money; refundedAt: string; method: string; reference: string | null }[];
}
export interface CreditNote { id: string; number: string; invoiceId: string; reason: string; status: string; issueDate: string; currency: string; taxableTotal: Money; cgstTotal: Money; sgstTotal: Money; igstTotal: Money; total: Money; invoice?: { id: string; number: string | null; customer: { id: string; name: string } } }

export interface Invoice extends DocTotals {
  id: string; number: string | null; customerId: string; projectId: string | null; quotationId: string | null; status: string; issueDate: string; dueDate: string | null;
  orderNumber: string | null; paymentTerms: string; emailRecipients: string[]; writeOffAmount: Money; lastEmailedAt: string | null; recurringProfile?: { id: string; profileName: string } | null;
  allocations?: { id: string; amount: Money; appliedAt: string; payment: { id: string; number: string; paidAt: string; method: string; reference: string | null } }[];
  placeOfSupply: string | null; isInterState: boolean; amountPaid: Money; creditedTotal: Money; balanceDue: Money; notes: string | null; terms: string | null; cancelReason: string | null;
  items?: LineItem[]; customer?: Customer | { id: string; name: string; company: string | null }; project?: { id: string; code: string; name: string } | null;
  payments?: Payment[]; creditNotes?: CreditNote[]; quotation?: { id: string; number: string } | null;
  proformaInvoiceId?: string | null; proforma?: { id: string; number: string } | null;
}

export interface BillTo { name: string; company?: string | null; address?: string | null; city?: string | null; state?: string | null; stateCode?: string | null; postalCode?: string | null; gstin?: string | null; email?: string | null; phone?: string | null }

export interface Proforma extends DocTotals {
  id: string; number: string; customerId: string; projectId: string | null; status: string; issueDate: string; validUntil: string | null; paymentTerms: string;
  referenceNumber: string | null; serviceReference: string | null; billTo: BillTo | null; placeOfSupply: string | null; isInterState: boolean;
  notes: string | null; terms: string | null; emailRecipients: string[]; sentAt: string | null; lastEmailedAt: string | null; acceptedAt: string | null;
  convertedInvoiceId: string | null; convertedAt: string | null; cancelledAt: string | null; cancelReason: string | null; items?: LineItem[];
  customer?: Customer | { id: string; name: string; company: string | null }; project?: { id: string; code: string; name: string } | null;
  convertedInvoice?: { id: string; number: string | null; status: string } | null;
}

export interface EmailLogEntry {
  id: string; to: string[]; cc: string[]; subject: string; attachments: string[]; status: string; error: string | null; sentAt: string | null; createdAt: string; sentByName: string | null;
}

export interface FileItem { id: string; originalName: string; mimeType: string; sizeBytes: number; createdAt: string; entityType?: string | null; entityId?: string | null; uploadedById?: string | null; visibility?: string }

export interface AuditLog { id: string; action: string; actorEmail: string | null; actorId: string | null; entityType: string | null; entityId: string | null; meta: Record<string, unknown>; ip: string | null; createdAt: string; tenant?: { name: string; slug: string } | null }

export interface CurrencyDef { code: string; name: string; symbol: string; decimals: number }
