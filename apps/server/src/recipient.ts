function userDigits(wid: string): string {
  const at = wid.indexOf("@");
  const user = at === -1 ? wid : wid.slice(0, at);
  return user.replace(/\D/g, "");
}

export function recipientWidMatches(
  row: { to_jid: string | null; to_e164: string | null; needs_resolve: number },
  toJid: string,
  phoneJid: string | null,
): boolean {
  if (row.to_jid && row.to_jid === toJid) return true;
  if (row.needs_resolve !== 1 || !row.to_e164) return false;

  const expected = row.to_e164.replace(/\D/g, "");
  if (!expected) return false;
  if (userDigits(toJid).endsWith(expected)) return true;

  // WhatsApp send targets are often @lid. Accept that hidden id only when the
  // same phone lookup also returned a phone wid for this E.164.
  if (!toJid.endsWith("@lid") || !phoneJid) return false;
  return userDigits(phoneJid).endsWith(expected);
}
