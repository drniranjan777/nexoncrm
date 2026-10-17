import type { LucideIcon } from 'lucide-react';
import {
  Activity, BarChart3, BookOpen, Briefcase, Building2, CalendarClock, CheckSquare, ClipboardCheck, CreditCard, FileMinus, FileText,
  FolderKanban, FolderOpen, Gauge, Headphones, Inbox, KanbanSquare, LayoutDashboard, LifeBuoy, ListChecks, MessageSquareHeart,
  Milestone, Package, PieChart, Plug, Receipt, ScrollText, Settings2, Shield, Tags, Target, TrendingUp, UserCog, Users, UsersRound, Wallet, Bell,
  Repeat, ReceiptIndianRupee, Landmark, Timer, LibraryBig, Building, Coins, FileCheck2, Percent, Mail,
} from 'lucide-react';

export interface NavItem {
  label: string;
  to: string;
  icon: LucideIcon;
  /** Shown when the member has ANY of these permissions. */
  perms?: string[];
  module?: string;
}

export interface NavGroup {
  label: string;
  items: NavItem[];
  /** 'bottom': shown as a menu pinned to the bottom of the sidebar instead of in the scrolling list. */
  placement?: 'bottom';
  /** Always expanded, without a collapsible header (e.g. Overview). */
  fixed?: boolean;
}

export const NAV: NavGroup[] = [
  { label: 'Overview', fixed: true, items: [{ label: 'Home', to: '/', icon: LayoutDashboard, perms: ['dashboard.read'] }] },
  {
    label: 'Sales & Billing',
    items: [
      { label: 'Items', to: '/products', icon: Package, perms: ['products.manage'], module: 'finance' },
      { label: 'Quotes', to: '/quotations', icon: FileText, perms: ['quotations.read'], module: 'finance' },
      { label: 'Proforma Invoices', to: '/proforma-invoices', icon: FileCheck2, perms: ['proforma.read'], module: 'finance' },
      { label: 'Invoices', to: '/invoices', icon: Receipt, perms: ['invoices.read'], module: 'finance' },
      { label: 'Recurring Invoices', to: '/recurring-invoices', icon: Repeat, perms: ['invoices.read'], module: 'finance' },
      { label: 'Payments Received', to: '/payments', icon: Wallet, perms: ['payments.read'], module: 'finance' },
      { label: 'Credit Notes', to: '/credit-notes', icon: FileMinus, perms: ['invoices.read'], module: 'finance' },
      { label: 'Expenses', to: '/expenses', icon: ReceiptIndianRupee, perms: ['invoices.read'], module: 'finance' },
      { label: 'Tax Settings', to: '/settings/tax', icon: Percent, perms: ['settings.manage'], module: 'finance' },
      { label: 'GST Filing', to: '/gst-filing', icon: Landmark, perms: ['reports.financial'], module: 'reports' },
    ],
  },
  {
    label: 'CRM & Sales',
    items: [
      { label: 'CRM Dashboard', to: '/crm-dashboard', icon: Gauge, perms: ['dashboard.read'] },
      { label: 'Leads', to: '/leads', icon: Target, perms: ['leads.read'], module: 'crm' },
      { label: 'Sales Pipeline', to: '/pipeline', icon: KanbanSquare, perms: ['leads.read'], module: 'crm' },
      { label: 'Follow-ups', to: '/follow-ups', icon: CalendarClock, perms: ['leads.read'], module: 'crm' },
      { label: 'Activities', to: '/activities', icon: Activity, perms: ['leads.read'], module: 'crm' },
    ],
  },
  {
    label: 'Customers',
    items: [
      { label: 'Customers', to: '/customers', icon: Building2, perms: ['customers.read'] },
      { label: 'Contacts', to: '/contacts', icon: UsersRound, perms: ['customers.read'] },
      { label: 'Customer Onboarding', to: '/onboarding', icon: ClipboardCheck, perms: ['customers.read'] },
      { label: 'Feedback', to: '/feedback', icon: MessageSquareHeart, perms: ['feedback.read'], module: 'feedback' },
    ],
  },
  {
    label: 'Projects',
    items: [
      { label: 'Projects', to: '/projects', icon: FolderKanban, perms: ['projects.read', 'projects.read_assigned'], module: 'projects' },
      { label: 'Tasks', to: '/tasks', icon: CheckSquare, perms: ['tasks.read'] },
      { label: 'Time Tracking', to: '/time-tracking', icon: Timer, perms: ['tasks.read', 'projects.read', 'projects.read_assigned'], module: 'projects' },
      { label: 'Milestones', to: '/milestones', icon: Milestone, perms: ['projects.read', 'projects.read_assigned'], module: 'projects' },
      { label: 'Team Assignments', to: '/team', icon: Users, perms: ['projects.read'], module: 'projects' },
      { label: 'Files', to: '/files', icon: FolderOpen, perms: ['files.read'] },
    ],
  },
  {
    label: 'Support',
    items: [
      { label: 'Support Tickets', to: '/tickets', icon: LifeBuoy, perms: ['tickets.read'], module: 'support' },
      { label: 'My Tickets', to: '/my-tickets', icon: Headphones, perms: ['tickets.read', 'tickets.read_assigned'], module: 'support' },
      { label: 'Categories', to: '/ticket-categories', icon: Tags, perms: ['kb.manage', 'settings.manage'], module: 'support' },
      { label: 'Knowledge Base', to: '/kb', icon: BookOpen, perms: ['tickets.read', 'tickets.read_assigned', 'kb.manage'], module: 'support' },
    ],
  },
  {
    label: 'Reports',
    items: [
      { label: 'Reports Center', to: '/reports-center', icon: LibraryBig, perms: ['reports.financial', 'reports.read', 'audit.read'], module: 'reports' },
      { label: 'CRM Reports', to: '/reports/crm', icon: TrendingUp, perms: ['reports.read'], module: 'reports' },
      { label: 'Feedback Reports', to: '/reports/feedback', icon: MessageSquareHeart, perms: ['reports.read'], module: 'reports' },
      { label: 'Project Reports', to: '/reports/projects', icon: Briefcase, perms: ['reports.read'], module: 'reports' },
      { label: 'Support Reports', to: '/reports/support', icon: Inbox, perms: ['reports.read'], module: 'reports' },
      { label: 'Sales Reports', to: '/reports/sales', icon: BarChart3, perms: ['reports.financial'], module: 'reports' },
      { label: 'Financial Reports', to: '/reports/financial', icon: PieChart, perms: ['reports.financial'], module: 'reports' },
    ],
  },
  {
    label: 'Settings',
    placement: 'bottom',
    items: [
      { label: 'Company Profile', to: '/settings/company', icon: Building2, perms: ['settings.manage'] },
      { label: 'Organizations', to: '/organizations', icon: Building },
      { label: 'Users & Roles', to: '/settings/users', icon: UserCog, perms: ['users.manage'] },
      { label: 'Tax Settings', to: '/settings/tax', icon: ScrollText, perms: ['settings.manage'] },
      { label: 'Currencies', to: '/settings/currencies', icon: Coins, perms: ['settings.manage'], module: 'finance' },
      { label: 'Document Settings', to: '/settings/documents', icon: FileText, perms: ['settings.manage'] },
      { label: 'Subscription', to: '/settings/subscription', icon: CreditCard, perms: ['subscription.manage', 'settings.manage'] },
      { label: 'Notifications', to: '/settings/notifications', icon: Bell, perms: ['settings.manage'] },
      { label: 'Email (SMTP)', to: '/settings/email', icon: Mail, perms: ['settings.manage'] },
      { label: 'Integrations', to: '/settings/integrations', icon: Plug, perms: ['settings.manage'] },
      { label: 'Audit Logs', to: '/settings/audit', icon: Shield, perms: ['audit.read'] },
    ],
  },
];

export const PORTAL_NAV: NavGroup[] = [
  {
    label: 'Customer portal',
    items: [
      { label: 'Overview', to: '/portal', icon: Gauge },
      { label: 'Invoices', to: '/portal/invoices', icon: Receipt },
      { label: 'Quotations', to: '/portal/quotations', icon: FileText },
      { label: 'Support', to: '/portal/tickets', icon: LifeBuoy },
      { label: 'Feedback', to: '/portal/feedback', icon: MessageSquareHeart },
      { label: 'Help articles', to: '/kb', icon: BookOpen },
    ],
  },
];

export const PLATFORM_NAV: NavGroup[] = [
  {
    label: 'Platform',
    items: [
      { label: 'Overview', to: '/platform', icon: Gauge },
      { label: 'Tenants', to: '/platform/tenants', icon: Building2 },
      { label: 'Plans', to: '/platform/plans', icon: ListChecks },
      { label: 'Currencies', to: '/platform/currencies', icon: Coins },
      { label: 'Settings', to: '/platform/settings', icon: Settings2 },
      { label: 'Audit Logs', to: '/platform/audit', icon: Shield },
    ],
  },
];
