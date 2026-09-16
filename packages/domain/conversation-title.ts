/** A context-based fallback while the native background naming service is unavailable. */
export function initialConversationTitle(message: string) {
  const text = message.replace(/^(?:Edition 3 owner message|Owner message):\s*/i, '').trim().split(/\n/)[0]
    .replace(/^(?:please\s+)?(?:can you|could you|would you)\s+/i, '')
    .replace(/^(?:please\s+)?(?:do (?:some )?research on|help me (?:with|to)|tell me about)\s+/i, '')
    .replace(/\s+/g, ' ').trim();
  const words = text.split(' ').slice(0, 8).join(' '), title = Array.from(words).slice(0, 60).join('').replace(/[.,;:!?]+$/, '');
  return title ? title[0].toLocaleUpperCase() + title.slice(1) : undefined;
}
