/* Development seed: plans, a platform super admin, the Nexonweb tenant with one user per role, and
 * realistic sample data. Idempotent for plans/users; skips tenant data if the tenant already exists.
 * Demo password for every seeded account: SEED_PASSWORD env var, default below (local development only). */
import fs from 'node:fs';
import path from 'node:path';
import bcrypt from 'bcryptjs';
import { buildKey, putObject } from '../src/lib/storage.js';
import { PrismaClient } from '@prisma/client';
import { provisionTenant } from '../src/lib/tenants.js';
import { nextNumber } from '../src/lib/numbering.js';
import { computeDocument } from '../src/lib/gst.js';
import { randomToken, sha256 } from '../src/lib/crypto.js';
import { analyzeFeedback } from '../src/lib/ai/index.js';
import { rescoreLead } from '../src/modules/crm.js';
import { refreshInvoiceBalance } from '../src/modules/finance.js';

const prisma = new PrismaClient();
const PASSWORD = process.env.SEED_PASSWORD ?? 'Nexonweb@Demo2026';
const DAY = 86_400_000;
const ago = (d: number) => new Date(Date.now() - d * DAY);
const ahead = (d: number) => new Date(Date.now() + d * DAY);

async function main() {
  const hash = await bcrypt.hash(PASSWORD, 12);

  const plans = [
    { code: 'starter', name: 'Starter', priceMonthly: 1999, maxUsers: 5, maxCustomers: 300, storageMb: 2048, aiRequests: 200, modules: ['crm', 'feedback', 'projects', 'support', 'finance', 'reports'] },
    { code: 'growth', name: 'Growth', priceMonthly: 4999, maxUsers: 20, maxCustomers: 3000, storageMb: 20480, aiRequests: 2000, modules: [] as string[] },
    { code: 'enterprise', name: 'Enterprise', priceMonthly: 14999, maxUsers: 200, maxCustomers: 100000, storageMb: 204800, aiRequests: 20000, modules: [] as string[] },
  ];
  for (const p of plans) await prisma.plan.upsert({ where: { code: p.code }, create: p, update: p });

  const user = (email: string, name: string, isSuperAdmin = false) =>
    prisma.user.upsert({ where: { email }, create: { email, name, passwordHash: hash, isSuperAdmin }, update: {} });

  await user('superadmin@nexonweb.com', 'Platform Admin', true);
  const owner = await user('owner@nexonweb.com', 'Ranjan Owner');

  const existing = await prisma.tenant.findUnique({ where: { slug: 'nexonweb' } });
  if (existing) {
    console.log('Tenant "nexonweb" already exists; skipping sample data.');
    return;
  }

  const tenant = await provisionTenant({ name: 'Nexonweb Solution', slug: 'nexonweb', ownerUserId: owner.id, planCode: 'growth', status: 'ACTIVE' });
  await prisma.tenant.update({
    where: { id: tenant.id },
    data: {
      legalName: 'Nexonweb Solution', email: 'hello@nexonweb.com', phone: '+91 98765 43210', website: 'https://nexonweb.com',
      addressLine1: '4th Floor, Tech Park', city: 'Pune', state: 'Maharashtra', stateCode: '27', postalCode: '411057',
      gstin: '27ABCDE1234F1Z5', pan: 'ABCDE1234F',
    },
  });
  // Brand logo (shared with the web app's static assets)
  const logoPath = path.resolve('../web/public/brand/nexonweb-logo.png');
  if (fs.existsSync(logoPath)) {
    const buf = fs.readFileSync(logoPath);
    const key = buildKey(tenant.id, 'nexonweb-logo.png');
    await putObject(key, buf, 'image/png');
    const logo = await prisma.fileObject.create({ data: { tenantId: tenant.id, storageKey: key, originalName: 'nexonweb-logo.png', mimeType: 'image/png', sizeBytes: buf.length, entityType: 'branding' } });
    await prisma.tenant.update({ where: { id: tenant.id }, data: { logoFileId: logo.id, storageUsedBytes: { increment: buf.length } } });
  }
  await prisma.platformSetting.upsert({ where: { key: 'defaultFeedbackTenant' }, create: { key: 'defaultFeedbackTenant', value: 'nexonweb' }, update: {} });

  const roles = Object.fromEntries((await prisma.role.findMany({ where: { tenantId: tenant.id } })).map((r) => [r.key, r.id]));
  const staff: Record<string, { id: string }> = {};
  for (const [key, email, name] of [
    ['admin', 'admin@nexonweb.com', 'Asha Admin'],
    ['crm_manager', 'crm@nexonweb.com', 'Vikram CRM'],
    ['sales', 'sales@nexonweb.com', 'Priya Sales'],
    ['accountant', 'accounts@nexonweb.com', 'Anil Accounts'],
    ['project_manager', 'pm@nexonweb.com', 'Meera PM'],
    ['support', 'support@nexonweb.com', 'Sameer Support'],
    ['developer', 'dev@nexonweb.com', 'Dev Kumar'],
    ['auditor', 'auditor@nexonweb.com', 'Ira Auditor'],
  ] as const) {
    const u = await user(email, name);
    await prisma.membership.create({ data: { tenantId: tenant.id, userId: u.id, roleId: roles[key] } });
    staff[key] = u;
  }

  const t = tenant.id;
  const cust = async (data: { name: string; company: string; email: string; phone: string; city: string; state: string; stateCode: string; gstin?: string }) =>
    prisma.$transaction(async (tx) => tx.customer.create({ data: { ...data, tenantId: t, code: await nextNumber(tx, t, 'CUSTOMER'), billingAddress: `${data.city} business district`, ownerId: staff.crm_manager.id } }));

  const acme = await cust({ name: 'Rohit Sharma', company: 'Acme Retail Pvt Ltd', email: 'rohit@acmeretail.in', phone: '+91 90000 11111', city: 'Mumbai', state: 'Maharashtra', stateCode: '27', gstin: '27AAACA1234B1Z2' });
  const green = await cust({ name: 'Kavya Nair', company: 'GreenLeaf Organics', email: 'kavya@greenleaf.co.in', phone: '+91 90000 22222', city: 'Bengaluru', state: 'Karnataka', stateCode: '29', gstin: '29AAFCG5678K1Z9' });
  const zen = await cust({ name: 'Arjun Mehta', company: 'ZenFit Studios', email: 'arjun@zenfit.in', phone: '+91 90000 33333', city: 'Pune', state: 'Maharashtra', stateCode: '27' });

  await prisma.contact.createMany({
    data: [
      { tenantId: t, customerId: acme.id, name: 'Rohit Sharma', email: acme.email, phone: acme.phone, designation: 'Director', isPrimary: true },
      { tenantId: t, customerId: acme.id, name: 'Neha Iyer', email: 'neha@acmeretail.in', designation: 'Marketing Manager' },
      { tenantId: t, customerId: green.id, name: 'Kavya Nair', email: green.email, designation: 'Founder', isPrimary: true },
      { tenantId: t, customerId: zen.id, name: 'Arjun Mehta', email: zen.email, designation: 'Owner', isPrimary: true },
    ],
  });

  // Customer portal user for Acme
  const portal = await user('client@acmeretail.in', 'Rohit Sharma (Client)');
  await prisma.membership.create({ data: { tenantId: t, userId: portal.id, roleId: roles.customer, customerId: acme.id } });

  // Projects
  const proj = async (name: string, customerId: string, serviceCategory: string, status: 'IN_PROGRESS' | 'PLANNING' | 'COMPLETED', start: number, due: number, budget: number) =>
    prisma.$transaction(async (tx) => tx.project.create({
      data: { tenantId: t, code: await nextNumber(tx, t, 'PROJECT'), name, customerId, serviceCategory, status, startDate: ago(start), dueDate: ahead(due), budget, managerId: staff.project_manager.id },
    }));
  const p1 = await proj('Acme eCommerce Revamp', acme.id, 'eCommerce', 'IN_PROGRESS', 40, 30, 450000);
  const p2 = await proj('GreenLeaf SEO Retainer', green.id, 'SEO and Digital Marketing', 'IN_PROGRESS', 90, 90, 240000);
  const p3 = await proj('ZenFit Booking App', zen.id, 'Mobile App Development', 'PLANNING', 5, 75, 600000);
  for (const p of [p1, p2, p3]) {
    await prisma.projectMember.createMany({ data: [{ projectId: p.id, userId: staff.project_manager.id, role: 'Project Manager' }, { projectId: p.id, userId: staff.developer.id, role: 'Developer' }].slice(0, p === p2 ? 1 : 2) });
  }
  const ms = await prisma.milestone.create({ data: { tenantId: t, projectId: p1.id, title: 'Checkout & payments', dueDate: ahead(10), status: 'IN_PROGRESS' } });
  await prisma.milestone.createMany({ data: [
    { tenantId: t, projectId: p1.id, title: 'Design sign-off', dueDate: ago(20), status: 'DONE' },
    { tenantId: t, projectId: p1.id, title: 'Go-live', dueDate: ahead(30) },
    { tenantId: t, projectId: p3.id, title: 'Wireframes', dueDate: ahead(14) },
  ] });
  await prisma.task.createMany({ data: [
    { tenantId: t, type: 'PROJECT', title: 'Integrate Razorpay checkout', projectId: p1.id, milestoneId: ms.id, assigneeId: staff.developer.id, createdById: staff.project_manager.id, priority: 'HIGH', status: 'IN_PROGRESS', dueDate: ahead(4) },
    { tenantId: t, type: 'PROJECT', title: 'Fix product filter on mobile', projectId: p1.id, assigneeId: staff.developer.id, createdById: staff.project_manager.id, priority: 'MEDIUM', dueDate: ahead(2) },
    { tenantId: t, type: 'PROJECT', title: 'Monthly SEO report - October', projectId: p2.id, assigneeId: staff.project_manager.id, createdById: staff.project_manager.id, dueDate: ahead(6) },
    { tenantId: t, type: 'PROJECT', title: 'Booking flow wireframes', projectId: p3.id, assigneeId: staff.developer.id, createdById: staff.project_manager.id, dueDate: ahead(12), status: 'TODO' },
    { tenantId: t, type: 'PROJECT', title: 'Product catalogue import', projectId: p1.id, assigneeId: staff.developer.id, createdById: staff.project_manager.id, status: 'DONE', completedAt: ago(8) },
  ] });

  // Onboarding
  await prisma.customer.update({ where: { id: zen.id }, data: { onboardingStatus: 'IN_PROGRESS' } });
  const template = ['Kick-off call completed', 'Project scope and deliverables confirmed', 'Access and credentials shared securely', 'Brand assets and content received', 'Billing details and GSTIN verified'];
  await prisma.onboardingItem.createMany({ data: template.map((title, i) => ({ tenantId: t, customerId: zen.id, title, sortOrder: i, doneAt: i < 2 ? ago(3) : null })) });

  // Leads
  const leads = [
    { name: 'Sanjay Gupta', company: 'Gupta Jewellers', email: 'sanjay@guptajewels.in', phone: '+91 91111 00001', source: 'Website', serviceInterest: 'Shopify Development', budgetRange: '2-5 Lakh', estimatedValue: 350000, stage: 'PROPOSAL_SENT' as const, expectedDecisionAt: ahead(10), lastContactAt: ago(2) },
    { name: 'Fatima Khan', company: 'Khan Logistics', email: 'fatima@khanlogistics.com', phone: '+91 91111 00002', source: 'Referral', serviceInterest: 'Custom Software', budgetRange: '10 Lakh+', estimatedValue: 1200000, stage: 'NEGOTIATION' as const, expectedDecisionAt: ahead(7), lastContactAt: ago(1) },
    { name: 'Deepak Rao', company: 'Rao Dental Clinic', email: 'deepak@raodental.in', source: 'Google Ads', serviceInterest: 'SEO and Digital Marketing', budgetRange: '50k-1 Lakh', estimatedValue: 80000, stage: 'CONTACTED' as const, lastContactAt: ago(9) },
    { name: 'Lisa Fernandes', company: 'Coastal Cafe', email: 'lisa@coastalcafe.in', source: 'Instagram', serviceInterest: 'Website Design and Development', stage: 'NEW' as const },
    { name: 'Harish Patel', company: 'Patel Textiles', email: 'harish@pateltextiles.com', phone: '+91 91111 00005', source: 'Trade show', serviceInterest: 'eCommerce', budgetRange: '5-10 Lakh', estimatedValue: 650000, stage: 'MEETING_SCHEDULED' as const, expectedDecisionAt: ahead(30), lastContactAt: ago(4) },
    { name: 'Ritu Singh', company: 'EduSpark', email: 'ritu@eduspark.in', source: 'LinkedIn', serviceInterest: 'Mobile App Development', budgetRange: '5-10 Lakh', estimatedValue: 700000, stage: 'LOST' as const, lostReason: 'Chose a cheaper vendor' },
    { name: 'Manoj Verma', company: 'Verma Auto Parts', email: 'manoj@vermaauto.in', phone: '+91 91111 00007', source: 'Website', serviceInterest: 'WordPress Development', budgetRange: '1-2 Lakh', estimatedValue: 150000, stage: 'QUALIFIED' as const, lastContactAt: ago(20) },
  ];
  for (const l of leads) {
    const lead = await prisma.lead.create({ data: { ...l, tenantId: t, assignedToId: l.stage === 'NEW' ? staff.sales.id : staff.crm_manager.id } });
    await prisma.activity.create({ data: { tenantId: t, leadId: lead.id, type: 'SYSTEM', subject: 'Lead created', occurredAt: ago(25) } });
    if (l.lastContactAt) {
      await prisma.activity.create({ data: { tenantId: t, leadId: lead.id, type: 'CALL', subject: 'Discovery call', body: 'Discussed requirements and timelines.', occurredAt: l.lastContactAt, userId: staff.crm_manager.id } });
    }
    if (['NEGOTIATION', 'PROPOSAL_SENT', 'MEETING_SCHEDULED'].includes(l.stage)) {
      await prisma.activity.create({ data: { tenantId: t, leadId: lead.id, type: 'MEETING', subject: 'Requirements workshop', occurredAt: ago(6), userId: staff.crm_manager.id } });
    }
    const score = await rescoreLead(t, lead.id);
    if (!['WON', 'LOST'].includes(l.stage)) {
      await prisma.lead.update({ where: { id: lead.id }, data: { nextFollowUpAt: new Date(score.suggestedFollowUp) } });
      await prisma.task.create({ data: { tenantId: t, type: 'FOLLOW_UP', title: `Follow up: ${l.name} (${l.company})`, description: score.nextAction, dueDate: new Date(score.suggestedFollowUp), assigneeId: lead.assignedToId, leadId: lead.id, automated: true } });
    }
  }

  // Products
  const products = await Promise.all([
    prisma.product.create({ data: { tenantId: t, name: 'Website Design & Development', hsnSac: '998314', unit: 'Project', rate: 85000, taxRate: 18 } }),
    prisma.product.create({ data: { tenantId: t, name: 'SEO Retainer (monthly)', hsnSac: '998365', unit: 'Month', rate: 20000, taxRate: 18 } }),
    prisma.product.create({ data: { tenantId: t, name: 'Shopify Store Setup', hsnSac: '998314', unit: 'Project', rate: 65000, taxRate: 18 } }),
    prisma.product.create({ data: { tenantId: t, name: 'Website Maintenance (annual)', hsnSac: '998316', unit: 'Year', rate: 36000, taxRate: 18 } }),
    prisma.product.create({ data: { tenantId: t, name: 'Mobile App Development', hsnSac: '998314', unit: 'Project', rate: 450000, taxRate: 18 } }),
  ]);
  const line = (p: (typeof products)[number], quantity: number, discountPct = 0) => ({ productId: p.id, description: p.name, hsnSac: p.hsnSac, quantity, unit: p.unit, rate: Number(p.rate), discountPct, taxRate: Number(p.taxRate) });

  // Invoices: intra-state (Acme, MH) and inter-state (GreenLeaf, KA)
  const makeInvoice = async (customer: typeof acme, projectId: string, lines: ReturnType<typeof line>[], daysAgo: number, inter: boolean, paid: number) => {
    const d = computeDocument(lines, inter);
    const inv = await prisma.$transaction(async (tx) => tx.invoice.create({
      data: {
        tenantId: t, customerId: customer.id, projectId, status: 'ISSUED', number: await nextNumber(tx, t, 'INVOICE'), issuedAt: ago(daysAgo),
        issueDate: ago(daysAgo), dueDate: ago(daysAgo - 15), placeOfSupply: customer.stateCode, isInterState: inter, ...d.totals, balanceDue: d.totals.total,
        terms: 'Payment due within 15 days of invoice date.', items: { create: d.lines.map(({ productId, description, hsnSac, quantity, unit, rate, discountPct, taxRate, taxable, taxAmount, amount, sortOrder }) => ({ productId, description, hsnSac, quantity, unit, rate, discountPct, taxRate, taxable, taxAmount, amount, sortOrder })) },
      },
    }));
    if (paid > 0) {
      await prisma.$transaction(async (tx) => {
        const amt = Math.min(paid, d.totals.total);
        await tx.payment.create({ data: { tenantId: t, customerId: customer.id, invoiceId: inv.id, number: await nextNumber(tx, t, 'PAYMENT'), amount: amt, paidAt: ago(Math.max(1, daysAgo - 10)), method: 'BANK_TRANSFER', reference: `UTR${randomToken(5).toUpperCase()}`, allocations: { create: [{ tenantId: t, invoiceId: inv.id, amount: amt }] } } });
        await refreshInvoiceBalance(tx, inv.id);
      });
    } else {
      await prisma.$transaction((tx) => refreshInvoiceBalance(tx, inv.id));
    }
  };
  await makeInvoice(acme, p1.id, [line(products[0], 1), line(products[3], 1, 10)], 45, false, 1e9);
  await makeInvoice(acme, p1.id, [line(products[0], 2)], 10, false, 50000);
  await makeInvoice(green, p2.id, [line(products[1], 3)], 60, true, 1e9);
  await makeInvoice(green, p2.id, [line(products[1], 1)], 25, true, 0);

  // Quotation for a lead
  const gupta = await prisma.lead.findFirstOrThrow({ where: { tenantId: t, email: 'sanjay@guptajewels.in' } });
  const qd = computeDocument([line(products[2], 1), line(products[3], 1)], false);
  await prisma.$transaction(async (tx) => tx.quotation.create({
    data: {
      tenantId: t, number: await nextNumber(tx, t, 'QUOTATION'), leadId: gupta.id, status: 'SENT', sentAt: ago(3), issueDate: ago(3), validUntil: ahead(27),
      placeOfSupply: '27', isInterState: false, ...qd.totals, terms: 'This quotation is valid for 30 days.',
      items: { create: qd.lines.map(({ productId, description, hsnSac, quantity, unit, rate, discountPct, taxRate, taxable, taxAmount, amount, sortOrder }) => ({ productId, description, hsnSac, quantity, unit, rate, discountPct, taxRate, taxable, taxAmount, amount, sortOrder })) },
    },
  }));

  // Feedback
  const fb = async (data: { name: string; company: string; email: string; customerId: string; projectId: string; serviceCategory: string; ratingOverall: number; ratingCommunication: number; ratingQuality: number; ratingTimeliness: number; workingWell?: string; needsImprovement?: string; urgentIssues?: string; status: 'NEW' | 'IN_PROGRESS' | 'RESOLVED'; daysAgo: number }) => {
    const { daysAgo, ...rest } = data;
    const a = analyzeFeedback({ ratingOverall: rest.ratingOverall, ratings: [rest.ratingCommunication, rest.ratingQuality, rest.ratingTimeliness], texts: [rest.workingWell, rest.needsImprovement, rest.urgentIssues], urgentIssues: rest.urgentIssues });
    return prisma.$transaction(async (tx) => {
      const f = await tx.feedback.create({
        data: {
          ...rest, tenantId: t, referenceNo: await nextNumber(tx, t, 'FEEDBACK'), trackingTokenHash: sha256(randomToken()), projectStatus: 'In progress',
          sentiment: a.sentiment, sentimentScore: a.sentimentScore, aiCategories: a.categories, isUrgent: a.isUrgent, createdAt: ago(daysAgo),
          assignedToId: rest.status === 'NEW' ? null : staff.project_manager.id, resolvedAt: rest.status === 'RESOLVED' ? ago(daysAgo - 2) : null,
        },
      });
      await tx.feedbackEvent.create({ data: { feedbackId: f.id, kind: 'SYSTEM', body: 'Feedback submitted', isInternal: false, createdAt: ago(daysAgo) } });
      return f;
    });
  };
  await fb({ name: 'Rohit Sharma', company: 'Acme Retail Pvt Ltd', email: acme.email!, customerId: acme.id, projectId: p1.id, serviceCategory: 'eCommerce', ratingOverall: 2, ratingCommunication: 3, ratingQuality: 2, ratingTimeliness: 2, needsImprovement: 'Checkout is slow and payment sometimes fails on mobile.', urgentIssues: 'Payment failing for some customers at checkout', status: 'NEW', daysAgo: 1 });
  await fb({ name: 'Kavya Nair', company: 'GreenLeaf Organics', email: green.email!, customerId: green.id, projectId: p2.id, serviceCategory: 'SEO and Digital Marketing', ratingOverall: 5, ratingCommunication: 5, ratingQuality: 5, ratingTimeliness: 4, workingWell: 'Great improvement in keyword rankings and organic traffic. Reports are clear and helpful.', status: 'RESOLVED', daysAgo: 20 });
  await fb({ name: 'Kavya Nair', company: 'GreenLeaf Organics', email: green.email!, customerId: green.id, projectId: p2.id, serviceCategory: 'SEO and Digital Marketing', ratingOverall: 4, ratingCommunication: 4, ratingQuality: 4, ratingTimeliness: 3, workingWell: 'Good content quality.', needsImprovement: 'Monthly report was delayed by a week.', status: 'IN_PROGRESS', daysAgo: 6 });

  // Support
  const cats = await prisma.ticketCategory.findMany({ where: { tenantId: t } });
  const bug = cats.find((c) => c.name.startsWith('Bug'))!;
  await prisma.$transaction(async (tx) => {
    const tk = await tx.ticket.create({ data: { tenantId: t, number: await nextNumber(tx, t, 'TICKET'), subject: 'Order confirmation emails not sent', description: 'Customers are not receiving order confirmation emails since yesterday.', customerId: acme.id, projectId: p1.id, categoryId: bug.id, priority: 'HIGH', assigneeId: staff.support.id, createdById: portal.id, dueAt: ahead(1) } });
    await tx.ticketComment.create({ data: { ticketId: tk.id, body: 'Thanks for reporting. We are checking the SMTP logs now.', userId: staff.support.id } });
    await tx.ticket.create({ data: { tenantId: t, number: await nextNumber(tx, t, 'TICKET'), subject: 'Update banner for Diwali sale', description: 'Please replace the homepage banner with the attached creative.', customerId: acme.id, categoryId: cats.find((c) => c.name === 'Change Request')!.id, priority: 'MEDIUM', createdById: portal.id, dueAt: ahead(2) } });
  });
  await prisma.knowledgeArticle.create({ data: { tenantId: t, title: 'How to request a website change', slug: 'how-to-request-a-website-change', body: 'Open a support ticket from your customer portal and choose "Change Request". Attach screenshots and describe the change. Our team responds within one business day.', categoryId: cats.find((c) => c.name === 'Change Request')!.id, published: true } });

  // Second tenant to demonstrate isolation
  const otherOwner = await user('owner@abcdigital.in', 'ABC Owner');
  const abc = await provisionTenant({ name: 'ABC Digital Agency', slug: 'abc-digital', ownerUserId: otherOwner.id, planCode: 'starter' });
  await prisma.$transaction(async (tx) => tx.customer.create({ data: { tenantId: abc.id, code: await nextNumber(tx, abc.id, 'CUSTOMER'), name: 'ABC Private Client', email: 'private@abcclient.in' } }));

  console.log(`Seed complete. Accounts use the password from SEED_PASSWORD (default in prisma/seed.ts).`);
}

main().catch((e) => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
