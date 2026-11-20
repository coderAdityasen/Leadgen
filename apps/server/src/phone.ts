import parsePhoneNumberFromString, { type CountryCode } from "libphonenumber-js";

export function parseAndNormalizePhone(rawPhone: string, defaultCountry: string | null): { e164: string } {
  if (!rawPhone || typeof rawPhone !== "string") {
    throw Object.assign(new Error("Phone number is required."), { code: "validation" });
  }

  const trimmed = rawPhone.trim();
  // Extensions (ext, x123, ;ext=) are rejected
  if (/[;,\s]*(?:ext|x|ext=)\s*\d+/i.test(trimmed)) {
    throw Object.assign(new Error("Extensions are not supported."), { code: "validation" });
  }

  if (trimmed.startsWith("+")) {
    const parsed = parsePhoneNumberFromString(trimmed);
    if (!parsed || !parsed.isValid() || parsed.ext) {
      throw Object.assign(new Error("Invalid phone number."), { code: "validation" });
    }
    return { e164: parsed.number };
  }

  if (!defaultCountry) {
    throw Object.assign(new Error("Country required to parse national number."), { code: "country_required" });
  }

  const parsed = parsePhoneNumberFromString(trimmed, defaultCountry as CountryCode);
  if (!parsed || !parsed.isValid() || parsed.ext) {
    throw Object.assign(new Error("Invalid phone number."), { code: "validation" });
  }
  return { e164: parsed.number };
}
