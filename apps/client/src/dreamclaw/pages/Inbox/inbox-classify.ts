// Inbox bucket and category classification, labels, and visual tones.
// Pure functions with no React or workspace dependencies.
import type { InboxBucket, InboxCategoryFilter, InboxDensity, InboxProvider } from './index';

export function normalizeInboxBucket(value?: string | null): InboxBucket {
  return value === 'safe_review' || value === 'urgent' || value === 'needs_reply' || value === 'waiting' || value === 'fyi' ? value : 'all';
}

export function normalizeInboxDensity(value?: string | null): InboxDensity {
  return value === 'comfortable' || value === 'spacious' ? value : 'compact';
}

export function normalizeInboxCategoryFilter(value?: string | null): InboxCategoryFilter {
  return value === 'account_billing_action_required'
    || value === 'updates_tools'
    || value === 'personal_outreach'
    || value === 'calendar_logistics'
    || value === 'promo_social'
    || value === 'other' ? value : 'all';
}

export function bucketLabel(bucket: InboxBucket): string {
  switch (bucket) {
    case 'safe_review': return 'Safe review';
    case 'urgent': return 'Urgent';
    case 'needs_reply': return 'Needs reply';
    case 'waiting': return 'Waiting';
    case 'fyi': return 'FYI';
    default: return 'All';
  }
}

export function bucketDescription(bucket: InboxBucket): string {
  switch (bucket) {
    case 'safe_review': return 'Potential payment, sign-in, or sender risk';
    case 'urgent': return 'Needs attention now';
    case 'needs_reply': return 'Requires an outbound reply';
    case 'waiting': return 'Waiting on someone else';
    case 'fyi': return 'Read-only or low urgency';
    default: return 'Show every loaded conversation';
  }
}

export function bucketTone(bucket: InboxBucket): string {
  switch (bucket) {
    case 'safe_review': return 'bg-orange-500/10 border-orange-500/25 text-orange-300';
    case 'urgent': return 'bg-red-500/10 border-red-500/20 text-red-300';
    case 'needs_reply': return 'bg-amber-500/10 border-amber-500/20 text-amber-300';
    case 'waiting': return 'bg-sky-500/10 border-sky-500/20 text-sky-300';
    case 'fyi': return 'bg-[rgb(var(--aegis-overlay)/0.04)] border-aegis-border text-aegis-text-dim';
    default: return 'bg-aegis-primary/10 border-aegis-primary/20 text-aegis-primary';
  }
}

export function providerTone(provider: InboxProvider): string {
  return provider === 'gmail'
    ? 'border-red-400/20 bg-red-500/10 text-red-200'
    : 'border-sky-400/20 bg-sky-500/10 text-sky-200';
}

export function categoryLabel(category: InboxCategoryFilter): string {
  switch (category) {
    case 'account_billing_action_required': return 'Billing / action';
    case 'updates_tools': return 'Updates / tools';
    case 'personal_outreach': return 'Outreach';
    case 'calendar_logistics': return 'Calendar';
    case 'promo_social': return 'Promo / social';
    case 'other': return 'Other';
    default: return 'All categories';
  }
}

export function triageCategoryLabel(category: InboxCategoryFilter): string {
  return category === 'all' ? 'All triage' : categoryLabel(category);
}

export function categoryTone(category: InboxCategoryFilter): string {
  switch (category) {
    case 'account_billing_action_required': return 'border-red-500/20 bg-red-500/10 text-red-300';
    case 'updates_tools': return 'border-sky-500/20 bg-sky-500/10 text-sky-300';
    case 'personal_outreach': return 'border-fuchsia-500/20 bg-fuchsia-500/10 text-fuchsia-300';
    case 'calendar_logistics': return 'border-cyan-500/20 bg-cyan-500/10 text-cyan-300';
    case 'promo_social': return 'border-zinc-500/20 bg-zinc-500/10 text-zinc-300';
    case 'other': return 'border-aegis-border bg-[rgb(var(--aegis-overlay)/0.04)] text-aegis-text-dim';
    default: return 'border-aegis-border bg-[rgb(var(--aegis-overlay)/0.04)] text-aegis-text-dim';
  }
}
