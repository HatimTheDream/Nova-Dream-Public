// Original Dream Claw mail digest/reader transformations; source provenance in docs.
export type MicrosoftMailThreadDigest = {
  id: string;
  conversationId: string;
  sourceMessageId?: string;
  subject: string;
  from: string;
  date: string;
  labels: string[];
  providerTags: string[];
  messageCount: number;
  category: string;
  summary: string;
  latestBody: string;
  latestSnippet: string;
  attentionScore: number;
};

export type MicrosoftMailMessageView = {
  id: string;
  idType?: 'immutable' | 'legacy';
  conversationId: string;
  from: string;
  to: string;
  cc: string;
  subject: string;
  date: string;
  bodyText: string;
  isDraft?: boolean;
  bodyHtml?: string;
  attachments?: Array<{
    id: string;
    name: string;
    mimeType: string;
    size?: number;
    contentId?: string;
    isInline: boolean;
    base64?: string;
    dataUrl?: string;
  }>;
  snippet: string;
  isRead: boolean;
};

function isMicrosoftMessageFlagged(message: any): boolean {
  const status = String(message?.flag?.flagStatus || '').trim().toLowerCase();
  return status === 'flagged' || status === 'complete';
}

export function htmlToText(value: string): string {
  return String(value || '')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/\r/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function escapeODataString(value: string): string {
  return String(value || '').replace(/'/g, "''");
}

function addressListFromGraph(values: any[] | undefined): string {
  if (!Array.isArray(values)) return '';
  return values
    .map((entry) => {
      const email = String(entry?.emailAddress?.address || '').trim();
      const name = String(entry?.emailAddress?.name || '').trim();
      if (!email) return '';
      return name ? `${name} <${email}>` : email;
    })
    .filter(Boolean)
    .join(', ');
}

function attentionScoreForText(subject: string, latestBody: string, latestSnippet: string, labels: string[]): number {
  const corpus = `${subject}\n${latestBody}\n${latestSnippet}`.toLowerCase();
  let score = 0;
  if (labels.includes('UNREAD')) score += 8;
  if (/\b(urgent|asap|deadline|overdue|payment|action required|statement ready|confirm|approve)\b/.test(corpus)) score += 18;
  if (/\b(reply|respond|let me know|availability|follow up|follow-up)\b/.test(corpus)) score += 10;
  if (/\b(invoice|billing|receipt|renewal|subscription|trial ending)\b/.test(corpus)) score += 8;
  return score;
}

function deriveCategory(subject: string, latestBody: string): string {
  const corpus = `${subject}\n${latestBody}`.toLowerCase();
  if (/\b(invoice|billing|payment|statement|trial ending|receipt|renewal|subscription)\b/.test(corpus)) {
    return 'account_billing_action_required';
  }
  if (/\b(reminder|calendar|meeting|availability|schedule|reschedule)\b/.test(corpus)) {
    return 'calendar_logistics';
  }
  if (/\b(update|release|launch|newsletter|digest|weekly|product update|tool)\b/.test(corpus)) {
    return 'updates_tools';
  }
  if (/\b(campaign|donate|special offer|discount|webinar|promo|promotion)\b/.test(corpus)) {
    return 'promo_social';
  }
  if (/\b(reply|respond|follow up|follow-up|intro|introduction|can you|please)\b/.test(corpus)) {
    return 'personal_outreach';
  }
  return 'other';
}

export function originalMicrosoftThreadDigests(raw: { value: any[] }): MicrosoftMailThreadDigest[] {
  const messages = Array.isArray(raw?.value) ? raw.value : [];
  const grouped = new Map<string, any[]>();
  for (const message of messages) {
    const key = String(message?.conversationId || message?.id || '').trim();
    if (!key) continue;
    const bucket = grouped.get(key) || [];
    bucket.push(message);
    grouped.set(key, bucket);
  }

  const threads = [...grouped.entries()].map(([conversationId, bucket]) => {
    const messageDate = (message: any) => message?.receivedDateTime || message?.sentDateTime || message?.lastModifiedDateTime || message?.createdDateTime || 0;
    const sorted = bucket.slice().sort((a, b) => new Date(messageDate(a)).getTime() - new Date(messageDate(b)).getTime());
    const latest = sorted[sorted.length - 1] || {};
    const latestBody = String(latest?.bodyPreview || '');
    const subject = String(latest?.subject || sorted[0]?.subject || '(no subject)').trim() || '(no subject)';
    const labels = [
      ...(latest?.isRead ? [] : ['UNREAD']),
      ...(isMicrosoftMessageFlagged(latest) ? ['FLAGGED'] : []),
    ];
    const summary = String(latest?.bodyPreview || latestBody || '').trim().slice(0, 220);
    return {
      id: conversationId,
      conversationId,
      sourceMessageId: String(latest?.id || '').trim() || undefined,
      subject,
      from: addressListFromGraph(latest?.from ? [latest.from] : []),
      date: String(messageDate(latest) || ''),
      labels,
      providerTags: Array.isArray(latest?.categories)
        ? latest.categories
            .map((value: any) => String(value || '').trim())
            .filter(Boolean)
        : [],
      messageCount: sorted.length,
      category: deriveCategory(subject, latestBody),
      summary,
      latestBody: latestBody.slice(0, 1200),
      latestSnippet: String(latest?.bodyPreview || '').trim().slice(0, 400),
      attentionScore: attentionScoreForText(subject, latestBody, String(latest?.bodyPreview || ''), labels),
    } satisfies MicrosoftMailThreadDigest;
  }).sort((a, b) => b.attentionScore - a.attentionScore || (Date.parse(b.date || '') - Date.parse(a.date || '')));

  return threads;
}

export function originalMicrosoftMessageViews(rawMessages: unknown[], conversationId: string, attachmentSets: NonNullable<MicrosoftMailMessageView['attachments']>[] = []): MicrosoftMailMessageView[] {
  const idType = 'immutable' as const;
  const messages = rawMessages.map((message: any, index: number) => ({
    id: String(message?.id || ''),
    idType,
    isDraft: typeof message?.isDraft === 'boolean' ? message.isDraft : undefined,
    conversationId: String(message?.conversationId || conversationId),
    from: addressListFromGraph(message?.from ? [message.from] : []),
    to: addressListFromGraph(message?.toRecipients),
    cc: addressListFromGraph(message?.ccRecipients),
    subject: String(message?.subject || '').trim(),
    date: String(message?.receivedDateTime || message?.sentDateTime || message?.lastModifiedDateTime || message?.createdDateTime || ''),
    bodyText: String(message?.body?.contentType || '').toLowerCase() === 'html'
      ? htmlToText(String(message?.body?.content || '')) || String(message?.bodyPreview || '')
      : String(message?.body?.content || message?.bodyPreview || ''),
    bodyHtml: String(message?.body?.contentType || '').toLowerCase() === 'html'
      ? String(message?.body?.content || '').trim() || undefined
      : undefined,
    attachments: attachmentSets[index],
    snippet: String(message?.bodyPreview || '').trim(),
    isRead: Boolean(message?.isRead),
  } satisfies MicrosoftMailMessageView)).sort((a: MicrosoftMailMessageView, b: MicrosoftMailMessageView) => Date.parse(a.date || '') - Date.parse(b.date || ''));

  return messages;
}
