export type MailSafetyLevel = 'normal' | 'caution' | 'suspicious';

export interface MailSafetyInput {
  subject: string;
  from: string;
  summary?: string;
  latestBody?: string;
  labels?: string[];
  providerTags?: string[];
}

export interface MailSafetyAssessment {
  level: MailSafetyLevel;
  protected: boolean;
  label: string;
  reasons: string[];
  guidance: string;
}

const PROVIDER_WARNING_LABELS = new Set([
  'JUNK',
  'JUNKEMAIL',
  'PHISHING',
  'QUARANTINE',
  'SPAM',
  'SUSPICIOUS',
]);

const PRESSURE_LANGUAGE = /\b(action required|required action|act now|immediately|urgent|asap|final notice|within \d+ hours?|account (?:will be )?(?:closed|disabled|locked|restricted|suspended)|avoid (?:a )?(?:fee|penalty|restriction|suspension))\b/i;
const PAYMENT_LANGUAGE = /\b(payment|billing|credit card|debit card|card (?:declined|expired)|payment (?:declined|failed|didn'?t go through)|update (?:your )?(?:billing|card|payment)|bank account|wire transfer|gift card|cryptocurrency|crypto)\b/i;
const PAYMENT_REMEDIATION_LANGUAGE = /(?:\b(?:payment|billing|card|credit card|debit card)\b.{0,80}\b(?:declined|failed|failure|failures|rejected|expired|update|verify|retry|required|issue|problem|didn['’]?t go through|wasn['’]?t processed)\b|\b(?:declined|failed|failure|failures|rejected|expired|update|verify|retry|couldn['’]?t process|unable to process|wasn['’]?t processed)\b.{0,80}\b(?:payment|billing|card|credit card|debit card)\b)/i;
const CREDENTIAL_LANGUAGE = /\b(password|passcode|security code|one[- ]time code|login|log in|sign in|verify (?:your )?(?:account|identity)|confirm (?:your )?(?:account|identity)|social security|ssn)\b/i;
const LINK_PROMPT_LANGUAGE = /\b(click|open|follow|use|visit)\s+(?:the\s+|this\s+)?(?:button|link|portal)|\b(?:log|sign) in here\b/i;

const BRAND_DOMAINS: Array<{ brand: RegExp; domains: string[] }> = [
  { brand: /\bamazon\b/i, domains: ['amazon.com', 'amazon.co.uk', 'amazon.ca'] },
  { brand: /\bapple\b/i, domains: ['apple.com'] },
  { brand: /\bdistrokid\b/i, domains: ['distrokid.com'] },
  { brand: /\bdocusign\b/i, domains: ['docusign.com', 'docusign.net'] },
  { brand: /\bdropbox\b/i, domains: ['dropbox.com', 'dropboxmail.com'] },
  { brand: /\bgoogle\b|\bgmail\b/i, domains: ['google.com', 'gmail.com'] },
  { brand: /\blinktree\b/i, domains: ['linktr.ee', 'linktree.com'] },
  { brand: /\bmicrosoft\b|\boutlook\b|\boffice 365\b/i, domains: ['microsoft.com', 'office.com', 'outlook.com', 'live.com'] },
  { brand: /\bnetflix\b/i, domains: ['netflix.com'] },
  { brand: /\bpaypal\b/i, domains: ['paypal.com'] },
  { brand: /\bspotify\b/i, domains: ['spotify.com'] },
];

const NORMAL_ASSESSMENT: MailSafetyAssessment = {
  level: 'normal',
  protected: false,
  label: 'Normal review',
  reasons: [],
  guidance: '',
};

function senderAddress(value: string): string {
  const bracketed = String(value || '').match(/<([^<>\s]+@[^<>\s]+)>/);
  if (bracketed?.[1]) return bracketed[1].trim().toLowerCase();
  const plain = String(value || '').match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
  return plain?.[0]?.trim().toLowerCase() || '';
}

function senderDomain(value: string): string {
  return senderAddress(value).split('@')[1] || '';
}

function domainMatches(domain: string, expected: string): boolean {
  return domain === expected || domain.endsWith(`.${expected}`);
}

function namedBrandDomainMismatch(subject: string, from: string): boolean {
  const domain = senderDomain(from);
  if (!domain) return false;
  const identity = `${from}\n${subject}`;
  return BRAND_DOMAINS.some(({ brand, domains }) => (
    brand.test(identity) && !domains.some((expected) => domainMatches(domain, expected))
  ));
}

export function assessMailSafety(input: MailSafetyInput): MailSafetyAssessment {
  const labels = new Set([...(input.labels || []), ...(input.providerTags || [])]
    .map((label) => String(label || '').trim().toUpperCase()));
  const corpus = `${input.subject || ''}\n${input.summary || ''}\n${input.latestBody || ''}`;
  const providerWarning = [...labels].some((label) => PROVIDER_WARNING_LABELS.has(label));
  const pressured = PRESSURE_LANGUAGE.test(corpus);
  const paymentRequest = PAYMENT_LANGUAGE.test(corpus);
  const paymentRemediation = PAYMENT_REMEDIATION_LANGUAGE.test(corpus);
  const credentialRequest = CREDENTIAL_LANGUAGE.test(corpus);
  const linkPrompt = LINK_PROMPT_LANGUAGE.test(corpus);
  const brandMismatch = namedBrandDomainMismatch(input.subject || '', input.from || '');
  const encodedDomain = senderDomain(input.from || '').startsWith('xn--') || senderDomain(input.from || '').includes('.xn--');
  const reasons: string[] = [];
  let riskScore = 0;

  if (providerWarning) {
    reasons.push('Your mail provider marked this message as junk or suspicious.');
    riskScore += 5;
  }
  if (brandMismatch) {
    reasons.push('The sender domain does not match the organization named in the message.');
    riskScore += 4;
  }
  if (encodedDomain) {
    reasons.push('The sender uses an encoded domain that deserves extra verification.');
    riskScore += 4;
  }
  if (paymentRemediation) {
    reasons.push('It asks you to repair, retry, verify, or update payment or billing information.');
    riskScore += 2;
  }
  if (pressured && paymentRequest) {
    reasons.push('It combines urgent pressure with a payment or billing request.');
    riskScore += paymentRemediation ? 1 : 3;
  } else if (pressured && credentialRequest) {
    reasons.push('It combines urgent pressure with a sign-in or identity request.');
    riskScore += 3;
  } else if (pressured) {
    reasons.push('It uses pressure or threat language designed to prompt immediate action.');
    riskScore += 1;
  }
  if (credentialRequest && linkPrompt) {
    reasons.push('It asks you to use a link or button for sign-in or identity information.');
    riskScore += 2;
  }

  if (riskScore < 2) return NORMAL_ASSESSMENT;

  const level: MailSafetyLevel = riskScore >= 5 ? 'suspicious' : 'caution';
  return {
    level,
    protected: true,
    label: level === 'suspicious' ? 'Potentially suspicious' : 'Review safely',
    reasons,
    guidance: level === 'suspicious'
      ? 'Do not follow links, open attachments, or share credentials. Verify the request through the organization\'s official app, website, or phone number, then report it if it is fraudulent.'
      : 'Pause before acting. Open the organization\'s official app or website directly to verify the request instead of using links or attachments in this email.',
  };
}
