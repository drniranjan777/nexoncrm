// Single source of truth for permissions and the system roles seeded into every tenant.

export const PERMISSIONS = {
  'dashboard.read': 'View dashboard',
  'customers.read': 'View customers and contacts',
  'customers.update': 'Create and edit customers, contacts and onboarding',
  'leads.read': 'View leads, pipeline and activities',
  'leads.update': 'Create and edit leads and activities',
  'feedback.read': 'View feedback submissions',
  'feedback.resolve': 'Assign, reply to and resolve feedback',
  'projects.read': 'View all projects',
  'projects.read_assigned': 'View projects the user is a member of',
  'projects.update': 'Create and edit projects and milestones',
  'tasks.read': 'View tasks',
  'tasks.assign': 'Create and assign tasks to others',
  'tickets.read': 'View all support tickets',
  'tickets.read_assigned': 'View tickets assigned to the user',
  'tickets.update': 'Reply to and update tickets',
  'tickets.assign': 'Assign tickets',
  'kb.manage': 'Manage knowledge base and ticket categories',
  'files.read': 'View files',
  'files.upload': 'Upload and delete files',
  'products.manage': 'Manage products and services',
  'quotations.read': 'View quotations',
  'quotations.create': 'Create and edit quotations',
  'quotations.send': 'Mark quotations as sent / accepted / rejected',
  'quotations.convert': 'Convert quotations to invoices',
  'proforma.read': 'View proforma invoices',
  'proforma.create': 'Create, edit, duplicate and cancel proforma invoices',
  'proforma.send': 'Send proforma invoices and mark them accepted / rejected',
  'proforma.convert': 'Convert proforma invoices to invoices',
  'invoices.read': 'View invoices',
  'invoices.create': 'Create and edit draft invoices',
  'invoices.issue': 'Issue invoices',
  'invoices.cancel': 'Cancel invoices',
  'payments.read': 'View payments',
  'payments.record': 'Record payments',
  'creditnotes.create': 'Issue credit notes',
  'reports.read': 'View CRM, feedback, project and support reports',
  'reports.financial': 'View financial and sales reports',
  'ai.use': 'Use AI drafting and summaries',
  'users.manage': 'Invite users and manage roles',
  'settings.manage': 'Manage company, tax, document and notification settings',
  'subscription.manage': 'Manage subscription',
  'audit.read': 'View audit logs',
  'portal.access': 'Customer portal access (own records only)',
} as const;

export type Permission = keyof typeof PERMISSIONS;
export const ALL_PERMISSIONS = Object.keys(PERMISSIONS) as Permission[];

const readAllBusiness: Permission[] = [
  'dashboard.read', 'customers.read', 'leads.read', 'feedback.read', 'projects.read', 'tasks.read',
  'tickets.read', 'files.read', 'quotations.read', 'proforma.read', 'invoices.read', 'payments.read', 'reports.read',
  'reports.financial', 'audit.read',
];

export const SYSTEM_ROLES: { key: string; name: string; description: string; permissions: Permission[] }[] = [
  {
    key: 'owner', name: 'Tenant Owner', description: 'Full access including subscription',
    permissions: ALL_PERMISSIONS.filter((p) => p !== 'portal.access'),
  },
  {
    key: 'admin', name: 'Tenant Admin', description: 'Full access except subscription',
    permissions: ALL_PERMISSIONS.filter((p) => p !== 'portal.access' && p !== 'subscription.manage'),
  },
  {
    key: 'crm_manager', name: 'CRM Manager', description: 'Leads, customers, feedback and sales documents',
    permissions: ['dashboard.read', 'customers.read', 'customers.update', 'leads.read', 'leads.update', 'feedback.read',
      'feedback.resolve', 'projects.read', 'tasks.read', 'tasks.assign', 'files.read', 'files.upload', 'products.manage',
      'quotations.read', 'quotations.create', 'quotations.send', 'quotations.convert', 'proforma.read', 'proforma.create', 'proforma.send',
      'invoices.read', 'reports.read',
      'reports.financial', 'ai.use'],
  },
  {
    key: 'sales', name: 'Sales Executive', description: 'Leads, follow-ups and quotations',
    permissions: ['dashboard.read', 'customers.read', 'customers.update', 'leads.read', 'leads.update', 'tasks.read',
      'files.read', 'files.upload', 'quotations.read', 'quotations.create', 'quotations.send', 'proforma.read', 'proforma.create',
      'proforma.send', 'ai.use'],
  },
  {
    key: 'accountant', name: 'Accountant', description: 'Invoices, payments, credit notes and financial reports',
    permissions: ['dashboard.read', 'customers.read', 'products.manage', 'quotations.read', 'quotations.convert',
      'proforma.read', 'proforma.create', 'proforma.send', 'proforma.convert',
      'invoices.read', 'invoices.create', 'invoices.issue', 'invoices.cancel', 'payments.read', 'payments.record',
      'creditnotes.create', 'reports.financial', 'files.read', 'files.upload'],
  },
  {
    key: 'project_manager', name: 'Project Manager', description: 'Projects, tasks, milestones and team assignment',
    permissions: ['dashboard.read', 'customers.read', 'projects.read', 'projects.update', 'tasks.read', 'tasks.assign',
      'feedback.read', 'feedback.resolve', 'tickets.read', 'tickets.update', 'tickets.assign', 'files.read', 'files.upload',
      'reports.read', 'ai.use'],
  },
  {
    key: 'support', name: 'Support Agent', description: 'Assigned tickets and knowledge base',
    permissions: ['dashboard.read', 'tickets.read_assigned', 'tickets.update', 'kb.manage', 'files.read', 'files.upload',
      'tasks.read'],
  },
  {
    key: 'developer', name: 'Developer', description: 'Assigned projects and technical tasks only',
    permissions: ['dashboard.read', 'projects.read_assigned', 'tasks.read', 'files.read', 'files.upload'],
  },
  { key: 'customer', name: 'Customer', description: 'Portal access to own records', permissions: ['portal.access'] },
  {
    key: 'auditor', name: 'Read-Only Auditor', description: 'Read-only access to business records and audit logs',
    permissions: readAllBusiness,
  },
];
