import { describe, expect, it } from "vitest";
import { scrub } from "../src/scrub/index.js";

describe("secret scrubbing", () => {
  it.each([
    ["anthropic", "key is sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789", "key is [redacted:anthropic]"],
    ["openai", "OPENAI sk-proj-AbCdEfGhIjKlMnOpQrStUvWx12", "OPENAI [redacted:openai]"],
    ["github", "token ghp_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789", "token [redacted:github]"],
    ["slack", "xoxb-1234567890-abcdefghij", "[redacted:slack]"],
    ["aws", "id AKIAIOSFODNN7EXAMPLE here", "id [redacted:aws] here"],
    ["bearer", "Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.payload.sig", "Authorization: Bearer [redacted:bearer]"],
    ["connection string", "postgres://admin:hunter2pass@db.local:5432/app", "postgres://admin:[redacted:password]@db.local:5432/app"],
    ["assignment", "API_KEY=abcd1234efgh5678", "API_KEY=[redacted:secret]"],
  ])("removes %s", (_kind, input, expected) => {
    expect(scrub(input)).toBe(expected);
  });

  it("removes private key blocks", () => {
    const pem = "-----BEGIN RSA PRIVATE KEY-----\nMIIEow\nabc\n-----END RSA PRIVATE KEY-----";
    expect(scrub(`before\n${pem}\nafter`)).toBe("before\n[redacted:private-key]\nafter");
  });

  it("leaves ordinary text alone", () => {
    const text = "Decided the token budget is 30k and the password reset flow stays as is.";
    expect(scrub(text)).toBe(text);
  });

  it("applies extra patterns from config", () => {
    expect(scrub("ticket ACME-SECRET-42", [{ name: "acme", pattern: "ACME-SECRET-\\d+" }])).toBe(
      "ticket [redacted:acme]",
    );
  });
});
