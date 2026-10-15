// Service-specific feedback questions. The web form renders these conditionally and the API validates
// answers against them, so both sides stay in sync from this single definition.

export type Question =
  | { id: string; label: string; type: 'rating' }
  | { id: string; label: string; type: 'choice'; options: string[] }
  | { id: string; label: string; type: 'text' };

export const SERVICE_CATEGORIES = [
  'SEO and Digital Marketing',
  'Website Design and Development',
  'WordPress Development',
  'Shopify Development',
  'eCommerce',
  'Mobile App Development',
  'Custom Software',
  'AI/ML',
  'Website Maintenance',
  'Other',
] as const;

const yesPartlyNo = ['Yes', 'Partly', 'No', 'Not sure'];

const websiteQs: Question[] = [
  { id: 'designQuality', label: 'Design quality', type: 'rating' },
  { id: 'responsive', label: 'Does the site work well on mobile and tablet?', type: 'choice', options: yesPartlyNo },
  { id: 'performance', label: 'Site speed and performance', type: 'rating' },
  { id: 'functionality', label: 'Do all features and forms work as expected?', type: 'choice', options: yesPartlyNo },
  { id: 'changeRequests', label: 'Specific pages or elements that need changes', type: 'text' },
];

export const SERVICE_QUESTIONS: Record<string, Question[]> = {
  'SEO and Digital Marketing': [
    { id: 'campaignProgress', label: 'Campaign progress so far', type: 'rating' },
    { id: 'keywordPerformance', label: 'Keyword ranking performance', type: 'rating' },
    { id: 'reporting', label: 'Are reports clear and delivered on time?', type: 'choice', options: yesPartlyNo },
    { id: 'trafficChange', label: 'Change in traffic or leads you have noticed', type: 'choice', options: ['Increased', 'No change', 'Decreased', 'Not sure'] },
    { id: 'goals', label: 'Keywords, markets or goals to focus on next', type: 'text' },
  ],
  'Website Design and Development': websiteQs,
  'WordPress Development': [
    ...websiteQs,
    { id: 'adminEase', label: 'How easy is it to update content in WordPress?', type: 'rating' },
  ],
  'Shopify Development': [
    { id: 'storeDesign', label: 'Store design and branding', type: 'rating' },
    { id: 'checkout', label: 'Is the checkout working smoothly?', type: 'choice', options: yesPartlyNo },
    { id: 'apps', label: 'Shopify apps and integrations working as expected?', type: 'choice', options: yesPartlyNo },
    { id: 'products', label: 'Product setup, variants and collections', type: 'rating' },
  ],
  eCommerce: [
    { id: 'checkout', label: 'Checkout experience', type: 'rating' },
    { id: 'products', label: 'Product catalogue and search', type: 'rating' },
    { id: 'payments', label: 'Are payments processing correctly?', type: 'choice', options: yesPartlyNo },
    { id: 'orders', label: 'Order workflow (confirmation, shipping, notifications)', type: 'rating' },
    { id: 'orderIssues', label: 'Any order or payment issues you have seen', type: 'text' },
  ],
  'Mobile App Development': [
    { id: 'appUx', label: 'App usability and design', type: 'rating' },
    { id: 'stability', label: 'Stability (crashes, freezes)', type: 'rating' },
    { id: 'platforms', label: 'Platforms tested', type: 'choice', options: ['Android', 'iOS', 'Both'] },
    { id: 'storeRelease', label: 'App store release status as expected?', type: 'choice', options: yesPartlyNo },
  ],
  'Custom Software': [
    { id: 'requirements', label: 'How well does the software meet your requirements?', type: 'rating' },
    { id: 'usability', label: 'Ease of use for your team', type: 'rating' },
    { id: 'documentation', label: 'Documentation and training', type: 'rating' },
    { id: 'integrations', label: 'Integrations with your other systems working?', type: 'choice', options: yesPartlyNo },
  ],
  'AI/ML': [
    { id: 'accuracy', label: 'Accuracy and usefulness of the model output', type: 'rating' },
    { id: 'explainability', label: 'Clarity of how results are produced', type: 'rating' },
    { id: 'dataHandling', label: 'Are you comfortable with how your data is handled?', type: 'choice', options: yesPartlyNo },
    { id: 'useCases', label: 'Additional use cases you would like to explore', type: 'text' },
  ],
  'Website Maintenance': [
    { id: 'responseTime', label: 'Response time to maintenance requests', type: 'rating' },
    { id: 'uptime', label: 'Website uptime and reliability', type: 'rating' },
    { id: 'updates', label: 'Are updates and backups done regularly?', type: 'choice', options: yesPartlyNo },
  ],
  Other: [],
};

export const PROJECT_STATUSES = ['Not started', 'In progress', 'Delivered', 'Live / Ongoing', 'On hold'];
export const EXPECTATION_STATUSES = ['Exceeded expectations', 'Met expectations', 'Partly met expectations', 'Did not meet expectations'];
export const TECHNICAL_SERVICES = new Set([
  'Website Design and Development', 'WordPress Development', 'Shopify Development', 'eCommerce',
  'Mobile App Development', 'Custom Software', 'AI/ML', 'Website Maintenance',
]);

/** Keeps only known answers with valid values for the chosen service. */
export function sanitizeServiceAnswers(category: string, raw: unknown): Record<string, string | number> {
  const qs = SERVICE_QUESTIONS[category] ?? [];
  const input = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const out: Record<string, string | number> = {};
  for (const q of qs) {
    const v = input[q.id];
    if (v === undefined || v === null || v === '') continue;
    if (q.type === 'rating') {
      const n = Number(v);
      if (Number.isInteger(n) && n >= 1 && n <= 5) out[q.id] = n;
    } else if (q.type === 'choice') {
      if (q.options.includes(String(v))) out[q.id] = String(v);
    } else {
      out[q.id] = String(v).slice(0, 2000);
    }
  }
  return out;
}
