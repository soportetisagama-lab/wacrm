import { describe, expect, it } from "vitest";
import {
  classifyTypedPhone,
  extractTypedPhone,
  isRecipientNotAllowedError,
  isValidE164,
  normalizePhone,
  phoneVariants,
  phonesMatch,
  sanitizePhoneForMeta,
} from "./phone-utils";

describe("sanitizePhoneForMeta", () => {
  it("strips +, spaces, and dashes leaving only digits", () => {
    expect(sanitizePhoneForMeta("+370 639 49836")).toBe("37063949836");
    expect(sanitizePhoneForMeta("+1 (415) 555-1212")).toBe("14155551212");
  });

  it("returns an empty string for falsy input", () => {
    expect(sanitizePhoneForMeta("")).toBe("");
    // Defensive: existing call sites occasionally pass through nullable
    // contact phones. The function early-returns on the falsy check.
    expect(sanitizePhoneForMeta(undefined as unknown as string)).toBe("");
  });

  it("is idempotent on already-sanitized input", () => {
    const cleaned = "14155551212";
    expect(sanitizePhoneForMeta(cleaned)).toBe(cleaned);
  });
});

describe("normalizePhone", () => {
  it("matches sanitizePhoneForMeta byte-for-byte (shared canonical form)", () => {
    const samples = ["+370 12345", "abc-555-DEF", "", "0044 7000 0000 0000"];
    for (const s of samples) {
      expect(normalizePhone(s)).toBe(sanitizePhoneForMeta(s));
    }
  });
});

describe("phonesMatch", () => {
  it("returns true for exact digit matches", () => {
    expect(phonesMatch("+37063949836", "37063949836")).toBe(true);
  });

  it("matches across trunk-prefix variants by last-8 fallback", () => {
    // Lithuanian trunk-0 variant. Last 8 digits ("63949836") collide.
    expect(phonesMatch("370063949836", "37063949836")).toBe(true);
  });

  it("rejects mismatched numbers", () => {
    expect(phonesMatch("+37063949836", "+37063949837")).toBe(false);
  });

  it("rejects very short inputs that would false-positive on tail match", () => {
    // Only 7 digits — the last-8 fallback is gated to len>=8 on both
    // sides to avoid declaring "12345" and "67890-12345" a match.
    expect(phonesMatch("1234567", "1234567")).toBe(true);
    expect(phonesMatch("1234567", "9991234567")).toBe(false);
  });

  it("ignores formatting noise on both sides", () => {
    expect(phonesMatch("+370 6 394 9836", "37063949836")).toBe(true);
    expect(phonesMatch("(415) 555-1212", "+1 415-555-1212")).toBe(true);
  });
});

describe("isValidE164", () => {
  it("accepts numbers 7–15 digits with optional + and non-zero start", () => {
    expect(isValidE164("+37063949836")).toBe(true);
    expect(isValidE164("37063949836")).toBe(true);
    expect(isValidE164("+1234567")).toBe(true); // 7 digits — lower bound
    expect(isValidE164("+123456789012345")).toBe(true); // 15 digits — upper bound
  });

  it("rejects numbers that start with 0 in international form", () => {
    expect(isValidE164("+0123456")).toBe(false);
    expect(isValidE164("0044700000000")).toBe(false);
  });

  it("rejects too-short and too-long inputs", () => {
    expect(isValidE164("+123456")).toBe(false); // 6 digits
    expect(isValidE164("+1234567890123456")).toBe(false); // 16 digits
  });

  it("rejects strings with non-digit characters", () => {
    expect(isValidE164("+1-415-555-1212")).toBe(false);
    expect(isValidE164("+1 4155551212")).toBe(false);
    expect(isValidE164("abc12345678")).toBe(false);
  });

  it("rejects the empty string", () => {
    expect(isValidE164("")).toBe(false);
  });
});

describe("phoneVariants", () => {
  it("returns an empty list for empty input", () => {
    expect(phoneVariants("")).toEqual([]);
  });

  it("always lists the original number first", () => {
    const out = phoneVariants("37063949836");
    expect(out[0]).toBe("37063949836");
  });

  it("inserts a trunk 0 after each plausible country-code length", () => {
    // Input "37063949836" — CC-1 → "3" + "0" + "7063949836",
    //                       CC-3 → "370" + "0" + "63949836".
    // CC-2 is skipped because "063949836" already starts with 0.
    const out = phoneVariants("37063949836");
    expect(out).toEqual(
      expect.arrayContaining([
        "37063949836",
        "307063949836",
        "370063949836",
      ]),
    );
  });

  it("removes a leading 0 after the country code when present", () => {
    // Input "370063949836" — CC-2 strips one leading 0 from
    // "0063949836" → "37" + "063949836" = "37063949836". Only one zero
    // comes off per pass; that's what the live retry loop needs.
    const out = phoneVariants("370063949836");
    expect(out).toContain("370063949836");
    expect(out).toContain("37063949836");
  });

  it("deduplicates variants that collapse to the same digits", () => {
    const out = phoneVariants("37063949836");
    expect(new Set(out).size).toBe(out.length);
  });

  it("returns just the original when the number is too short for any CC slice", () => {
    // 1-char input is shorter than all ccLen values; both loops skip.
    expect(phoneVariants("1")).toEqual(["1"]);
  });
});

describe("isRecipientNotAllowedError", () => {
  it("matches Meta error code 131030", () => {
    expect(
      isRecipientNotAllowedError(
        "(#131030) Recipient phone number not in allowed list",
      ),
    ).toBe(true);
  });

  it("matches the human-readable English variants", () => {
    expect(isRecipientNotAllowedError("not in allowed list")).toBe(true);
    expect(isRecipientNotAllowedError("recipient not in the allowed list")).toBe(
      true,
    );
    // Case-insensitive on the human text.
    expect(isRecipientNotAllowedError("NOT IN ALLOWED LIST")).toBe(true);
  });

  it("does not false-positive on unrelated Meta errors", () => {
    expect(isRecipientNotAllowedError("(#100) Invalid parameter")).toBe(false);
    expect(isRecipientNotAllowedError("template name does not exist")).toBe(
      false,
    );
    expect(isRecipientNotAllowedError("")).toBe(false);
  });
});

describe("extractTypedPhone", () => {
  it("accepts a Peruvian mobile typed on its own, in common formats", () => {
    expect(extractTypedPhone("974 710 551")).toBe("51974710551");
    expect(extractTypedPhone("974710551")).toBe("51974710551");
    expect(extractTypedPhone("974-710-551")).toBe("51974710551");
    expect(extractTypedPhone("+51 974 710 551")).toBe("51974710551");
    expect(extractTypedPhone("51974710551")).toBe("51974710551");
  });

  it("accepts a short lead-in around the number", () => {
    expect(extractTypedPhone("mi número es 974 710 551")).toBe("51974710551");
    expect(extractTypedPhone("Este es mi celular: 974710551 gracias")).toBe("51974710551");
  });

  it("accepts an explicit international number with a leading +", () => {
    expect(extractTypedPhone("+34 612 345 678")).toBe("34612345678");
    expect(extractTypedPhone("+1 (415) 555-1212")).toBe("14155551212");
  });

  it("rejects numbers that aren't clearly a phone", () => {
    expect(extractTypedPhone("")).toBeNull();
    expect(extractTypedPhone("hola")).toBeNull();
    expect(extractTypedPhone("01 4567890")).toBeNull(); // landline, no +
    expect(extractTypedPhone("123456789")).toBeNull(); // 9 digits not starting with 9
    expect(extractTypedPhone("34612345678")).toBeNull(); // foreign without +
  });

  it("rejects messages where the number is buried in longer text", () => {
    expect(
      extractTypedPhone("mi pedido 974710551 llegó mal y quiero saber qué pasó con el envío"),
    ).toBeNull();
  });

  it("rejects messages with more than one number", () => {
    expect(extractTypedPhone("974710551 o 987654321")).toBeNull();
    expect(extractTypedPhone("974710551 somos 3")).toBeNull();
  });
});

describe("classifyTypedPhone", () => {
  it("returns the phone for a valid number", () => {
    expect(classifyTypedPhone("mi número es 974 710 551")).toEqual({
      kind: "phone",
      phone: "51974710551",
    });
  });

  it("flags a Peruvian mobile with missing or extra digits as incomplete", () => {
    expect(classifyTypedPhone("974 710 55")).toEqual({ kind: "incomplete" });
    expect(classifyTypedPhone("9747105")).toEqual({ kind: "incomplete" });
    expect(classifyTypedPhone("9747105511")).toEqual({ kind: "incomplete" });
    expect(classifyTypedPhone("mi celular es 97471055")).toEqual({ kind: "incomplete" });
    expect(classifyTypedPhone("+51 974 710 55")).toEqual({ kind: "incomplete" });
  });

  it("flags two or more mobile numbers as multiple", () => {
    expect(classifyTypedPhone("974710551 o 987654321")).toEqual({ kind: "multiple" });
    expect(classifyTypedPhone("974 710 551 / 987 654 321")).toEqual({ kind: "multiple" });
  });

  it("stays silent on things that aren't a phone attempt", () => {
    expect(classifyTypedPhone("hola, precio?")).toEqual({ kind: "none" });
    expect(classifyTypedPhone("mi DNI es 45678912")).toEqual({ kind: "none" });
    expect(classifyTypedPhone("RUC 20123456789")).toEqual({ kind: "none" });
    expect(classifyTypedPhone("quiero 2 mesas de 120x60")).toEqual({ kind: "none" });
    expect(
      classifyTypedPhone("mi pedido 97471055 llegó mal y quiero saber qué pasó con el envío"),
    ).toEqual({ kind: "none" });
  });
});
