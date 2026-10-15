import Anthropic from '@anthropic-ai/sdk';
import { config } from '../config.js';
import { prisma } from '../db.js';
import { HttpError } from '../errors.js';

// ── Feedback analysis (always heuristic: cheap, deterministic, runs on every submission) ──

const POSITIVE = ['great', 'excellent', 'happy', 'good', 'love', 'amazing', 'satisfied', 'fast', 'helpful', 'professional', 'smooth', 'impressed', 'thank'];
const NEGATIVE = ['bad', 'poor', 'slow', 'delay', 'delayed', 'late', 'broken', 'bug', 'issue', 'problem', 'unhappy', 'disappointed', 'error', 'crash', 'not working', 'frustrat', 'worse', 'missing'];
const URGENT = ['urgent', 'asap', 'immediately', 'down', 'outage', 'not working', 'broken', 'crash', 'security', 'hacked', 'payment failing', 'checkout', 'critical', 'emergency', 'data loss'];

const CATEGORIES: Record<string, string[]> = {
  Design: ['design', 'layout', 'color', 'colour', 'font', 'ui', 'look', 'logo', 'banner'],
  Performance: ['slow', 'speed', 'performance', 'load', 'lag', 'timeout'],
  Functionality: ['bug', 'broken', 'not working', 'error', 'feature', 'function', 'form', 'crash'],
  Communication: ['communication', 'response', 'reply', 'update', 'call', 'email', 'informed'],
  Timeline: ['delay', 'deadline', 'late', 'timeline', 'schedule', 'on time'],
  Content: ['content', 'copy', 'text', 'image', 'blog', 'article'],
  SEO: ['ranking', 'keyword', 'traffic', 'seo', 'google', 'backlink'],
  Billing: ['invoice', 'payment', 'billing', 'price', 'cost', 'refund'],
  Mobile: ['mobile', 'responsive', 'android', 'ios', 'phone', 'tablet'],
};

export interface FeedbackAnalysis {
  sentiment: 'positive' | 'neutral' | 'negative';
  sentimentScore: number; // -1..1
  categories: string[];
  isUrgent: boolean;
  method: 'heuristic';
}

export function analyzeFeedback(input: {
  ratingOverall: number;
  ratings?: (number | null | undefined)[];
  texts: (string | null | undefined)[];
  urgentIssues?: string | null;
}): FeedbackAnalysis {
  const text = input.texts.filter(Boolean).join(' \n ').toLowerCase();
  const count = (words: string[]) => words.reduce((n, w) => n + (text.includes(w) ? 1 : 0), 0);
  const pos = count(POSITIVE);
  const neg = count(NEGATIVE);
  const ratings = [input.ratingOverall, ...(input.ratings ?? [])].filter((r): r is number => typeof r === 'number');
  const avg = ratings.reduce((s, r) => s + r, 0) / ratings.length;
  const ratingSignal = (avg - 3) / 2; // -1..1
  const textSignal = pos + neg === 0 ? 0 : (pos - neg) / (pos + neg);
  const score = Math.max(-1, Math.min(1, ratingSignal * 0.65 + textSignal * 0.35));
  const sentiment = score > 0.2 ? 'positive' : score < -0.2 ? 'negative' : 'neutral';
  const categories = Object.entries(CATEGORIES)
    .filter(([, words]) => words.some((w) => text.includes(w)))
    .map(([k]) => k);
  const urgentText = (input.urgentIssues ?? '').trim();
  const isUrgent =
    input.ratingOverall <= 1 ||
    (urgentText.length > 3 && !/^(no|none|n\/a|na|nil|nothing)\.?$/i.test(urgentText)) ||
    URGENT.some((w) => text.includes(w));
  return { sentiment, sentimentScore: Math.round(score * 100) / 100, categories, isUrgent, method: 'heuristic' };
}

// ── Generative features (provider-backed, with heuristic templates as fallback) ──

export type AiFeature = 'followup_draft' | 'summary' | 'feedback_reply' | 'next_actions';

export async function assertAiQuota(tenantId: string) {
  const tenant = await prisma.tenant.findUnique({ where: { id: tenantId }, include: { plan: true } });
  const limit = tenant?.plan?.aiRequests ?? 100;
  const since = new Date();
  since.setUTCDate(1);
  since.setUTCHours(0, 0, 0, 0);
  const used = await prisma.aiUsage.count({ where: { tenantId, createdAt: { gte: since } } });
  if (used >= limit) throw new HttpError(429, `Monthly AI request limit reached (${limit}). Upgrade your plan to continue.`);
  return { used, limit };
}

let client: Anthropic | null = null;

async function generate(system: string, prompt: string): Promise<string | null> {
  if (config.ai.provider !== 'anthropic' || !config.ai.anthropicKey) return null;
  client ??= new Anthropic({ apiKey: config.ai.anthropicKey, timeout: 60_000, maxRetries: 2 });
  try {
    const res = await client.messages.create({
      model: config.ai.anthropicModel,
      max_tokens: 2000,
      output_config: { effort: 'low' },
      system,
      messages: [{ role: 'user', content: prompt }],
    });
    if (res.stop_reason === 'refusal') return null;
    const text = res.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('\n').trim();
    return text || null;
  } catch (err) {
    if (err instanceof Anthropic.RateLimitError) console.warn('[ai] rate limited, using template fallback');
    else if (err instanceof Anthropic.APIError) console.error(`[ai] API error ${err.status}: ${err.message}`);
    else console.error('[ai] request failed', err);
    return null; // degrade gracefully to the template
  }
}

const SYSTEM =
  'You write concise, professional business communication for a digital services agency in India. ' +
  'Never invent facts, prices, dates or commitments that are not in the provided context. ' +
  'Output only the requested text, with no preamble.';

export async function runAi(
  tenantId: string,
  userId: string,
  feature: AiFeature,
  context: Record<string, unknown>,
  template: () => string,
): Promise<{ text: string; provider: 'anthropic' | 'template'; requiresApproval: true }> {
  await assertAiQuota(tenantId);
  const prompts: Record<AiFeature, string> = {
    followup_draft: 'Draft a short follow-up email (subject line, then body under 150 words) for this sales lead.',
    summary: 'Summarise this interaction history in 4-6 bullet points: current status, customer needs, open questions, next step.',
    feedback_reply: 'Draft a short, empathetic reply to this customer feedback. Acknowledge specific points and state the next step without promising dates that are not given.',
    next_actions: 'Suggest the 3 most useful next sales actions as a numbered list, each with a one-line reason.',
  };
  const generated = await generate(SYSTEM, `${prompts[feature]}\n\nContext (JSON):\n${JSON.stringify(context, null, 2)}`);
  const provider = generated ? 'anthropic' : 'template';
  await prisma.aiUsage.create({ data: { tenantId, userId, feature, provider } });
  // Every AI output is a draft. Sending anything externally requires a human action.
  return { text: generated ?? template(), provider, requiresApproval: true };
}
