import { lazy, Suspense, type ReactNode } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { useAuth } from './lib/auth';
import { AppShell } from './components/AppShell';
import { EmptyState, Spinner } from './components/ui';

// Lazy-load a named page export so each module becomes its own chunk.
const L = <T,>(loader: () => Promise<T>, name: keyof T) =>
  lazy(() => loader().then((m) => ({ default: m[name] as unknown as React.ComponentType })));

const auth = () => import('./pages/auth');
const Login = L(auth, 'Login');
const Register = L(auth, 'Register');
const ForgotPassword = L(auth, 'ForgotPassword');
const ResetPassword = L(auth, 'ResetPassword');
const AcceptInvite = L(auth, 'AcceptInvite');
const Account = L(auth, 'Account');

const pub = () => import('./pages/publicFeedback');
const PublicFeedbackForm = L(pub, 'PublicFeedbackForm');
const TrackFeedback = L(pub, 'TrackFeedback');

const Dashboard = L(() => import('./pages/Dashboard'), 'Dashboard');
const CrmDashboard = L(() => import('./pages/Dashboard'), 'CrmDashboard');
const cust = () => import('./pages/customers');
const CustomersList = L(cust, 'CustomersList');
const CustomerDetail = L(cust, 'CustomerDetail');
const ContactsPage = L(cust, 'ContactsPage');
const OnboardingPage = L(cust, 'OnboardingPage');

const crm = () => import('./pages/crm');
const LeadsList = L(crm, 'LeadsList');
const LeadDetail = L(crm, 'LeadDetail');
const Pipeline = L(crm, 'Pipeline');
const FollowUps = L(crm, 'FollowUps');
const ActivitiesPage = L(crm, 'ActivitiesPage');

const fb = () => import('./pages/feedback');
const FeedbackList = L(fb, 'FeedbackList');
const FeedbackDetail = L(fb, 'FeedbackDetail');

const prj = () => import('./pages/projects');
const ProjectsList = L(prj, 'ProjectsList');
const ProjectDetail = L(prj, 'ProjectDetail');
const MilestonesPage = L(prj, 'MilestonesPage');
const TeamPage = L(prj, 'TeamPage');
const FilesPage = L(prj, 'FilesPage');
const TasksPage = L(() => import('./pages/tasks'), 'TasksPage');

const sup = () => import('./pages/support');
const TicketsPage = L(sup, 'TicketsPage');
const MyTicketsPage = L(sup, 'MyTicketsPage');
const TicketDetail = L(sup, 'TicketDetail');
const CategoriesPage = L(sup, 'CategoriesPage');
const KnowledgeBase = L(sup, 'KnowledgeBase');
const ArticlePage = L(sup, 'ArticlePage');

const fin = () => import('./pages/finance');
const QuotationsList = L(fin, 'QuotationsList');
const QuotationDetail = L(fin, 'QuotationDetail');
const QuotationEditor = L(fin, 'QuotationEditor');
const pro = () => import('./pages/proforma');
const ProformaList = L(pro, 'ProformaList');
const ProformaDetail = L(pro, 'ProformaDetail');
const ProformaEditor = L(pro, 'ProformaEditor');
const InvoicesList = L(fin, 'InvoicesList');
const InvoiceDetail = L(fin, 'InvoiceDetail');
const InvoiceEditor = L(fin, 'InvoiceEditor');
const CreditNotesPage = L(fin, 'CreditNotesPage');
const ProductsPage = L(fin, 'ProductsPage');

const ReportsPage = L(() => import('./pages/reports'), 'ReportsPage');

const pay = () => import('./pages/payments');
const PaymentsPage = L(pay, 'PaymentsPage');
const PaymentForm = L(pay, 'PaymentForm');
const PaymentDetail = L(pay, 'PaymentDetail');
const bil = () => import('./pages/billing');
const RecurringList = L(bil, 'RecurringList');
const RecurringEditor = L(bil, 'RecurringEditor');
const RecurringDetail = L(bil, 'RecurringDetail');
const ExpensesPage = L(bil, 'ExpensesPage');
const TimeTrackingPage = L(() => import('./pages/time'), 'TimeTrackingPage');
const EmailComposePage = L(() => import('./pages/email'), 'EmailComposePage');
const rc = () => import('./pages/reportsCenter');
const ReportsCenterPage = L(rc, 'ReportsCenterPage');
const ReportViewerPage = L(rc, 'ReportViewerPage');
const GstFilingPage = L(() => import('./pages/gst'), 'GstFilingPage');
const OrganizationsPage = L(() => import('./pages/organizations'), 'OrganizationsPage');

const set = () => import('./pages/settings');
const CompanySettings = L(set, 'CompanySettings');
const UsersSettings = L(set, 'UsersSettings');
const TaxSettings = L(set, 'TaxSettings');
const DocumentSettings = L(set, 'DocumentSettings');
const SubscriptionSettings = L(set, 'SubscriptionSettings');
const NotificationSettings = L(set, 'NotificationSettings');
const IntegrationsSettings = L(set, 'IntegrationsSettings');
const mail = () => import('./pages/mailSettings');
const EmailSettings = L(mail, 'EmailSettings');
const AuditLogsPage = L(set, 'AuditLogsPage');

const por = () => import('./pages/portal');
const PortalHome = L(por, 'PortalHome');
const PortalInvoices = L(por, 'PortalInvoices');
const PortalQuotations = L(por, 'PortalQuotations');
const PortalTickets = L(por, 'PortalTickets');
const PortalTicketDetail = L(por, 'PortalTicketDetail');
const PortalFeedback = L(por, 'PortalFeedback');
const PortalProject = L(por, 'PortalProject');

const plat = () => import('./pages/platform');
const PlatformOverview = L(plat, 'PlatformOverview');
const PlatformTenants = L(plat, 'PlatformTenants');
const PlatformTenantDetail = L(plat, 'PlatformTenantDetail');
const PlatformPlans = L(plat, 'PlatformPlans');
const finSet = () => import('./pages/financeSettings');
const CurrencySettings = L(finSet, 'CurrencySettings');
const PlatformCurrencies = L(finSet, 'PlatformCurrencies');
const PlatformSettings = L(plat, 'PlatformSettings');
const PlatformAudit = L(plat, 'PlatformAudit');

const FullPageSpinner = () => <div className="flex h-full min-h-[50vh] items-center justify-center"><Spinner className="size-6" /></div>;

function RequireAuth({ children }: { children: ReactNode }) {
  const { me } = useAuth();
  const location = useLocation();
  if (me === undefined) return <FullPageSpinner />;
  if (!me) return <Navigate to="/login" replace state={{ from: location.pathname + location.search }} />;
  return <>{children}</>;
}

function TenantGate() {
  const { me, membership, isPortal } = useAuth();
  if (!membership) {
    if (me?.isSuperAdmin) return <Navigate to="/platform" replace />;
    return (
      <div className="flex min-h-full items-center justify-center p-6">
        <EmptyState title="No workspace yet" description="Your account is not a member of any workspace. Ask an administrator to invite you." />
      </div>
    );
  }
  if (isPortal) return <AppShell mode="portal" />;
  return <AppShell mode="tenant" />;
}

function PortalOnly({ children }: { children: ReactNode }) {
  const { isPortal } = useAuth();
  return isPortal ? <>{children}</> : <Navigate to="/" replace />;
}

function StaffOnly({ children }: { children: ReactNode }) {
  const { isPortal } = useAuth();
  return isPortal ? <Navigate to="/portal" replace /> : <>{children}</>;
}

function PlatformGate() {
  const { me } = useAuth();
  if (!me?.isSuperAdmin) return <Navigate to="/" replace />;
  return <AppShell mode="platform" />;
}

const NotFound = () => <EmptyState title="Page not found" description="The page you are looking for does not exist or you do not have access to it." />;

// On the dedicated feedback domain (e.g. feedback.nexonweb.com) the root serves the public form.
const isFeedbackHost = typeof window !== 'undefined' && window.location.hostname.startsWith('feedback.');

export default function App() {
  if (isFeedbackHost) {
    return (
      <Suspense fallback={<FullPageSpinner />}>
        <Routes>
          <Route path="/" element={<PublicFeedbackForm />} />
          <Route path="/f/:token" element={<PublicFeedbackForm />} />
          <Route path="/track" element={<TrackFeedback />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </Suspense>
    );
  }
  return (
    <Suspense fallback={<FullPageSpinner />}>
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="/register" element={<Register />} />
        <Route path="/forgot-password" element={<ForgotPassword />} />
        <Route path="/reset-password" element={<ResetPassword />} />
        <Route path="/accept-invite" element={<AcceptInvite />} />
        <Route path="/submit-feedback" element={<PublicFeedbackForm />} />
        <Route path="/f/:token" element={<PublicFeedbackForm />} />
        <Route path="/track" element={<TrackFeedback />} />

        <Route path="/platform" element={<RequireAuth><PlatformGate /></RequireAuth>}>
          <Route index element={<PlatformOverview />} />
          <Route path="tenants" element={<PlatformTenants />} />
          <Route path="tenants/:id" element={<PlatformTenantDetail />} />
          <Route path="plans" element={<PlatformPlans />} />
          <Route path="currencies" element={<PlatformCurrencies />} />
          <Route path="settings" element={<PlatformSettings />} />
          <Route path="audit" element={<PlatformAudit />} />
          <Route path="account" element={<Account />} />
        </Route>

        <Route element={<RequireAuth><TenantGate /></RequireAuth>}>
          <Route path="/account" element={<Account />} />
          <Route path="/organizations" element={<OrganizationsPage />} />
          <Route path="/kb" element={<KnowledgeBase />} />
          <Route path="/kb/:id" element={<ArticlePage />} />

          <Route path="/portal" element={<PortalOnly><PortalHome /></PortalOnly>} />
          <Route path="/portal/invoices" element={<PortalOnly><PortalInvoices /></PortalOnly>} />
          <Route path="/portal/quotations" element={<PortalOnly><PortalQuotations /></PortalOnly>} />
          <Route path="/portal/tickets" element={<PortalOnly><PortalTickets /></PortalOnly>} />
          <Route path="/portal/tickets/:id" element={<PortalOnly><PortalTicketDetail /></PortalOnly>} />
          <Route path="/portal/feedback" element={<PortalOnly><PortalFeedback /></PortalOnly>} />
          <Route path="/portal/projects/:id" element={<PortalOnly><PortalProject /></PortalOnly>} />

          <Route path="/" element={<StaffOnly><Dashboard /></StaffOnly>} />
          <Route path="/crm-dashboard" element={<StaffOnly><CrmDashboard /></StaffOnly>} />
          <Route path="/customers" element={<StaffOnly><CustomersList /></StaffOnly>} />
          <Route path="/customers/:id" element={<StaffOnly><CustomerDetail /></StaffOnly>} />
          <Route path="/contacts" element={<StaffOnly><ContactsPage /></StaffOnly>} />
          <Route path="/onboarding" element={<StaffOnly><OnboardingPage /></StaffOnly>} />
          <Route path="/feedback" element={<StaffOnly><FeedbackList /></StaffOnly>} />
          <Route path="/feedback/:id" element={<StaffOnly><FeedbackDetail /></StaffOnly>} />
          <Route path="/leads" element={<StaffOnly><LeadsList /></StaffOnly>} />
          <Route path="/leads/:id" element={<StaffOnly><LeadDetail /></StaffOnly>} />
          <Route path="/pipeline" element={<StaffOnly><Pipeline /></StaffOnly>} />
          <Route path="/follow-ups" element={<StaffOnly><FollowUps /></StaffOnly>} />
          <Route path="/activities" element={<StaffOnly><ActivitiesPage /></StaffOnly>} />
          <Route path="/quotations" element={<StaffOnly><QuotationsList /></StaffOnly>} />
          <Route path="/quotations/new" element={<StaffOnly><QuotationEditor /></StaffOnly>} />
          <Route path="/quotations/:id" element={<StaffOnly><QuotationDetail /></StaffOnly>} />
          <Route path="/quotations/:id/edit" element={<StaffOnly><QuotationEditor /></StaffOnly>} />
          <Route path="/proforma-invoices" element={<StaffOnly><ProformaList /></StaffOnly>} />
          <Route path="/proforma-invoices/new" element={<StaffOnly><ProformaEditor /></StaffOnly>} />
          <Route path="/proforma-invoices/:id" element={<StaffOnly><ProformaDetail /></StaffOnly>} />
          <Route path="/proforma-invoices/:id/edit" element={<StaffOnly><ProformaEditor /></StaffOnly>} />
          <Route path="/invoices" element={<StaffOnly><InvoicesList /></StaffOnly>} />
          <Route path="/invoices/new" element={<StaffOnly><InvoiceEditor /></StaffOnly>} />
          <Route path="/invoices/:id" element={<StaffOnly><InvoiceDetail /></StaffOnly>} />
          <Route path="/invoices/:id/edit" element={<StaffOnly><InvoiceEditor /></StaffOnly>} />
          <Route path="/payments" element={<StaffOnly><PaymentsPage /></StaffOnly>} />
          <Route path="/payments/new" element={<StaffOnly><PaymentForm /></StaffOnly>} />
          <Route path="/payments/:id" element={<StaffOnly><PaymentDetail /></StaffOnly>} />
          <Route path="/recurring-invoices" element={<StaffOnly><RecurringList /></StaffOnly>} />
          <Route path="/recurring-invoices/new" element={<StaffOnly><RecurringEditor /></StaffOnly>} />
          <Route path="/recurring-invoices/:id" element={<StaffOnly><RecurringDetail /></StaffOnly>} />
          <Route path="/recurring-invoices/:id/edit" element={<StaffOnly><RecurringEditor /></StaffOnly>} />
          <Route path="/expenses" element={<StaffOnly><ExpensesPage /></StaffOnly>} />
          <Route path="/time-tracking" element={<StaffOnly><TimeTrackingPage /></StaffOnly>} />
          <Route path="/email/:kind/:id" element={<StaffOnly><EmailComposePage /></StaffOnly>} />
          <Route path="/reports-center" element={<StaffOnly><ReportsCenterPage /></StaffOnly>} />
          <Route path="/reports-center/:key" element={<StaffOnly><ReportViewerPage /></StaffOnly>} />
          <Route path="/gst-filing" element={<StaffOnly><GstFilingPage /></StaffOnly>} />
          <Route path="/credit-notes" element={<StaffOnly><CreditNotesPage /></StaffOnly>} />
          <Route path="/products" element={<StaffOnly><ProductsPage /></StaffOnly>} />
          <Route path="/projects" element={<StaffOnly><ProjectsList /></StaffOnly>} />
          <Route path="/projects/:id" element={<StaffOnly><ProjectDetail /></StaffOnly>} />
          <Route path="/tasks" element={<StaffOnly><TasksPage /></StaffOnly>} />
          <Route path="/milestones" element={<StaffOnly><MilestonesPage /></StaffOnly>} />
          <Route path="/team" element={<StaffOnly><TeamPage /></StaffOnly>} />
          <Route path="/files" element={<StaffOnly><FilesPage /></StaffOnly>} />
          <Route path="/tickets" element={<StaffOnly><TicketsPage /></StaffOnly>} />
          <Route path="/my-tickets" element={<StaffOnly><MyTicketsPage /></StaffOnly>} />
          <Route path="/tickets/:id" element={<StaffOnly><TicketDetail /></StaffOnly>} />
          <Route path="/ticket-categories" element={<StaffOnly><CategoriesPage /></StaffOnly>} />
          <Route path="/reports/:type" element={<StaffOnly><ReportsPage /></StaffOnly>} />
          <Route path="/settings" element={<Navigate to="/settings/company" replace />} />
          <Route path="/settings/company" element={<StaffOnly><CompanySettings /></StaffOnly>} />
          <Route path="/settings/users" element={<StaffOnly><UsersSettings /></StaffOnly>} />
          <Route path="/settings/tax" element={<StaffOnly><TaxSettings /></StaffOnly>} />
          <Route path="/settings/currencies" element={<StaffOnly><CurrencySettings /></StaffOnly>} />
          <Route path="/settings/documents" element={<StaffOnly><DocumentSettings /></StaffOnly>} />
          <Route path="/settings/subscription" element={<StaffOnly><SubscriptionSettings /></StaffOnly>} />
          <Route path="/settings/notifications" element={<StaffOnly><NotificationSettings /></StaffOnly>} />
          <Route path="/settings/integrations" element={<StaffOnly><IntegrationsSettings /></StaffOnly>} />
          <Route path="/settings/email" element={<StaffOnly><EmailSettings /></StaffOnly>} />
          <Route path="/settings/audit" element={<StaffOnly><AuditLogsPage /></StaffOnly>} />
          <Route path="*" element={<NotFound />} />
        </Route>
      </Routes>
    </Suspense>
  );
}
