import { Router } from 'express';
import { requireModule } from '../middleware/tenant.js';
import { customersRouter } from './customers.js';
import { crmRouter } from './crm.js';
import { tasksRouter } from './tasks.js';
import { projectsRouter } from './projects.js';
import { feedbackRouter } from './feedback.js';
import { supportRouter } from './support.js';
import { filesRouter } from './files.js';
import { financeRouter } from './finance.js';
import { reportsRouter } from './reports.js';
import { settingsRouter } from './settings.js';
import { portalRouter } from './portal.js';
import { notificationsRouter } from './notifications.js';
import { billingRouter } from './billing.js';
import { commsRouter } from './comms.js';
import { insightsRouter } from './insights.js';
import { companyFinanceRouter } from './companyFinance.js';
import { proformaRouter } from './proforma.js';
import { taxesRouter } from './taxes.js';

// Every router mounted here runs after requireTenant, so req.ctx is always set.
export const tenantRouter = Router();

// Subscription entitlements: plans list the modules they include (an empty list means all).
tenantRouter.use(['/leads', '/activities'], requireModule('crm'));
tenantRouter.use(['/feedback', '/feedback-links'], requireModule('feedback'));
tenantRouter.use(['/projects', '/milestones', '/team-assignments'], requireModule('projects'));
tenantRouter.use(['/tickets', '/ticket-categories', '/kb'], requireModule('support'));
tenantRouter.use(['/products', '/quotations', '/proforma-invoices', '/tax-rates', '/invoices', '/payments', '/credit-notes', '/recurring-invoices', '/expenses', '/expense-categories'], requireModule('finance'));
tenantRouter.use(['/reports', '/reports-center', '/gst'], requireModule('reports'));

tenantRouter.use(customersRouter);
tenantRouter.use(crmRouter);
tenantRouter.use(tasksRouter);
tenantRouter.use(projectsRouter);
tenantRouter.use(feedbackRouter);
tenantRouter.use(supportRouter);
tenantRouter.use(filesRouter);
tenantRouter.use(financeRouter);
tenantRouter.use(proformaRouter);
tenantRouter.use(taxesRouter);
tenantRouter.use(reportsRouter);
tenantRouter.use(settingsRouter);
tenantRouter.use(companyFinanceRouter);
tenantRouter.use(portalRouter);
tenantRouter.use(notificationsRouter);
tenantRouter.use(billingRouter);
tenantRouter.use(commsRouter);
tenantRouter.use(insightsRouter);
