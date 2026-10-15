import type { Tx } from './db.js';

export type SequenceType =
  | 'QUOTATION' | 'PROFORMA' | 'INVOICE' | 'CREDIT_NOTE' | 'PAYMENT' | 'TICKET' | 'FEEDBACK' | 'CUSTOMER' | 'PROJECT';

export const DEFAULT_PREFIXES: Record<SequenceType, string> = {
  QUOTATION: 'QT-',
  PROFORMA: 'PI-',
  INVOICE: 'INV-',
  CREDIT_NOTE: 'CN-',
  PAYMENT: 'PAY-',
  TICKET: 'TKT-',
  FEEDBACK: 'FB-',
  CUSTOMER: 'CUS-',
  PROJECT: 'PRJ-',
};

/**
 * Atomically allocates the next number for a tenant document series.
 * Must run inside a transaction so a rolled-back document does not burn a number.
 */
export async function nextNumber(tx: Tx, tenantId: string, type: SequenceType): Promise<string> {
  const seq = await tx.documentSequence.upsert({
    where: { tenantId_type: { tenantId, type } },
    create: { tenantId, type, prefix: DEFAULT_PREFIXES[type], next: 2 },
    update: { next: { increment: 1 } },
  });
  const value = seq.next - 1;
  return `${seq.prefix}${String(value).padStart(seq.padding, '0')}`;
}
