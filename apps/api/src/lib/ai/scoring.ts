// Transparent, rule-based lead scoring. This is a HEURISTIC, not a calibrated conversion probability.

export interface ScoringWeights {
  budget: number;
  serviceFit: number;
  engagement: number;
  meetings: number;
  proposal: number;
  recency: number;
  timeline: number;
  completeness: number;
}

export const DEFAULT_WEIGHTS: ScoringWeights = {
  budget: 20,
  serviceFit: 10,
  engagement: 15,
  meetings: 15,
  proposal: 15,
  recency: 10,
  timeline: 10,
  completeness: 5,
};

export interface LeadForScoring {
  email?: string | null;
  phone?: string | null;
  company?: string | null;
  serviceInterest?: string | null;
  budgetRange?: string | null;
  estimatedValue?: number | null;
  expectedDecisionAt?: Date | null;
  lastContactAt?: Date | null;
  stage: string;
  proposalStatus?: string | null;
  createdAt: Date;
}

export interface ActivityForScoring {
  type: string;
  occurredAt: Date;
  completed: boolean;
}

export interface ScoreFactor {
  key: keyof ScoringWeights;
  label: string;
  points: number;
  max: number;
  reason: string;
}

export interface ScoreResult {
  score: number;
  priority: 'Low' | 'Medium' | 'High' | 'Very High';
  fit: 'Poor' | 'Fair' | 'Good' | 'Strong';
  engagementTrend: 'Rising' | 'Stable' | 'Declining' | 'No activity';
  factors: ScoreFactor[];
  missing: string[];
  nextAction: string;
  suggestedFollowUp: string; // ISO date
  model: 'heuristic-v1';
  /** Historical win rate for the same service interest, when at least 5 closed leads exist. */
  historicalWinRate?: number;
}

const DAY = 24 * 60 * 60 * 1000;

function budgetFraction(lead: LeadForScoring): number {
  const value = lead.estimatedValue ?? 0;
  if (value >= 500_000) return 1;
  if (value >= 200_000) return 0.85;
  if (value >= 75_000) return 0.65;
  if (value >= 25_000) return 0.45;
  if (value > 0) return 0.25;
  if (lead.budgetRange) return 0.35;
  return 0;
}

export function scoreLead(
  lead: LeadForScoring,
  activities: ActivityForScoring[],
  opts: { weights?: ScoringWeights; coreServices?: string[]; historicalWinRate?: number; now?: Date } = {},
): ScoreResult {
  const w = opts.weights ?? DEFAULT_WEIGHTS;
  const now = opts.now ?? new Date();
  const factors: ScoreFactor[] = [];
  const add = (key: keyof ScoringWeights, label: string, fraction: number, reason: string) =>
    factors.push({ key, label, points: Math.round(w[key] * Math.max(0, Math.min(1, fraction))), max: w[key], reason });

  const bf = budgetFraction(lead);
  add('budget', 'Budget', bf,
    lead.estimatedValue ? `Estimated deal value Rs ${lead.estimatedValue.toLocaleString('en-IN')}`
      : lead.budgetRange ? `Budget range ${lead.budgetRange}` : 'No budget information');

  const core = opts.coreServices ?? [];
  const fits = !!lead.serviceInterest && (core.length === 0 || core.includes(lead.serviceInterest));
  add('serviceFit', 'Service fit', lead.serviceInterest ? (fits ? 1 : 0.4) : 0,
    lead.serviceInterest ? `Interested in ${lead.serviceInterest}` : 'Service interest unknown');

  const interactions = activities.filter((a) => ['CALL', 'EMAIL', 'MEETING', 'WHATSAPP'].includes(a.type));
  const recent30 = interactions.filter((a) => now.getTime() - a.occurredAt.getTime() <= 30 * DAY).length;
  const prior30 = interactions.filter((a) => {
    const age = now.getTime() - a.occurredAt.getTime();
    return age > 30 * DAY && age <= 60 * DAY;
  }).length;
  add('engagement', 'Engagement', recent30 / 5, `${recent30} interaction(s) in the last 30 days`);

  const meetings = activities.filter((a) => a.type === 'MEETING' && a.completed).length;
  add('meetings', 'Meetings', meetings / 2, `${meetings} meeting(s) completed`);

  const stageProposal: Record<string, number> = { PROPOSAL_SENT: 0.6, NEGOTIATION: 1, WON: 1 };
  let pf = stageProposal[lead.stage] ?? 0;
  if (lead.proposalStatus && /accept|review|discuss/i.test(lead.proposalStatus)) pf = Math.max(pf, 0.8);
  add('proposal', 'Proposal', pf,
    lead.proposalStatus ? `Proposal: ${lead.proposalStatus}` : pf ? `Stage ${lead.stage.replace('_', ' ').toLowerCase()}` : 'No proposal yet');

  const last = lead.lastContactAt ?? interactions.map((a) => a.occurredAt).sort((a, b) => b.getTime() - a.getTime())[0];
  const daysSince = last ? Math.floor((now.getTime() - last.getTime()) / DAY) : null;
  const rf = daysSince === null ? 0 : daysSince <= 3 ? 1 : daysSince <= 7 ? 0.8 : daysSince <= 14 ? 0.5 : daysSince <= 30 ? 0.25 : 0;
  add('recency', 'Recency', rf, daysSince === null ? 'Never contacted' : `Last contact ${daysSince} day(s) ago`);

  let tf = 0;
  let treason = 'No expected decision date';
  if (lead.expectedDecisionAt) {
    const d = Math.floor((lead.expectedDecisionAt.getTime() - now.getTime()) / DAY);
    tf = d < 0 ? 0.3 : d <= 14 ? 1 : d <= 45 ? 0.7 : d <= 90 ? 0.4 : 0.2;
    treason = d < 0 ? `Decision date passed ${-d} day(s) ago` : `Decision expected in ${d} day(s)`;
  }
  add('timeline', 'Timeline', tf, treason);

  const missing: string[] = [];
  if (!lead.email) missing.push('Email');
  if (!lead.phone) missing.push('Phone');
  if (!lead.company) missing.push('Company');
  if (!lead.serviceInterest) missing.push('Service interest');
  if (!lead.budgetRange && !lead.estimatedValue) missing.push('Budget');
  if (!lead.expectedDecisionAt) missing.push('Expected decision date');
  add('completeness', 'Data completeness', 1 - missing.length / 6,
    missing.length ? `${missing.length} field(s) missing` : 'Profile complete');

  const maxTotal = factors.reduce((s, f) => s + f.max, 0);
  let score = Math.round((factors.reduce((s, f) => s + f.points, 0) / maxTotal) * 100);
  if (lead.stage === 'WON') score = 100;
  if (lead.stage === 'LOST') score = 0;

  const priority = score >= 75 ? 'Very High' : score >= 55 ? 'High' : score >= 35 ? 'Medium' : 'Low';
  const fitPts =
    (factors.find((f) => f.key === 'budget')!.points / w.budget +
      factors.find((f) => f.key === 'serviceFit')!.points / w.serviceFit) / 2;
  const fit = fitPts >= 0.8 ? 'Strong' : fitPts >= 0.55 ? 'Good' : fitPts >= 0.3 ? 'Fair' : 'Poor';
  const engagementTrend =
    recent30 + prior30 === 0 ? 'No activity' : recent30 > prior30 ? 'Rising' : recent30 < prior30 ? 'Declining' : 'Stable';

  let nextAction: string;
  let followDays: number;
  switch (lead.stage) {
    case 'NEW': nextAction = 'Make first contact and qualify requirements'; followDays = 1; break;
    case 'CONTACTED':
      nextAction = missing.length ? `Qualify the lead and capture: ${missing.slice(0, 3).join(', ')}` : 'Qualify budget and decision process';
      followDays = 3; break;
    case 'QUALIFIED': nextAction = 'Schedule a discovery meeting'; followDays = 2; break;
    case 'MEETING_SCHEDULED': nextAction = 'Hold the meeting, then prepare a proposal'; followDays = 2; break;
    case 'PROPOSAL_SENT': nextAction = 'Follow up on the proposal and address questions'; followDays = 3; break;
    case 'NEGOTIATION': nextAction = 'Resolve open terms and send the final quotation'; followDays = 2; break;
    case 'ON_HOLD': nextAction = 'Check in to see whether priorities have changed'; followDays = 21; break;
    default: nextAction = lead.stage === 'WON' ? 'Start customer onboarding' : 'No action, lead closed'; followDays = 0;
  }
  if (daysSince !== null && daysSince > 14 && !['WON', 'LOST'].includes(lead.stage)) {
    nextAction = `Re-engage: no contact for ${daysSince} days. ${nextAction}`;
    followDays = Math.min(followDays, 1);
  }
  if (priority === 'Very High') followDays = Math.min(followDays, 1);

  return {
    score, priority, fit, engagementTrend, factors, missing, nextAction,
    suggestedFollowUp: new Date(now.getTime() + followDays * DAY).toISOString(),
    model: 'heuristic-v1',
    ...(opts.historicalWinRate !== undefined ? { historicalWinRate: opts.historicalWinRate } : {}),
  };
}
