import { describe, expect, it } from "vitest";
import { normalizeLeadPayload } from "../src/services/leads.js";

describe("normalizeLeadPayload", () => {
  it("accepts a canonical payload", () => {
    const result = normalizeLeadPayload({
      name: "Ada Lovelace",
      email: "Ada@Example.com",
      company: "Analytical Engines Ltd",
      website: "analyticalengines.example",
      message: "We need better pipeline forecasting.",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.lead.email).toBe("ada@example.com");
    expect(result.lead.companyWebsite).toBe("https://analyticalengines.example");
    expect(result.lead.source).toBe("webhook");
  });

  it("maps alternate field names (Zapier/n8n style)", () => {
    const result = normalizeLeadPayload({
      first_name: "Grace",
      last_name: "Hopper",
      email_address: "grace@navy.example",
      company_name: "US Navy",
      url: "https://navy.example",
      notes: "Interested in a demo",
      utm_source: "zapier",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.lead.name).toBe("Grace Hopper");
    expect(result.lead.company).toBe("US Navy");
    expect(result.lead.message).toBe("Interested in a demo");
    expect(result.lead.source).toBe("zapier");
  });

  it("falls back to the email local part when no name is given", () => {
    const result = normalizeLeadPayload({ email: "sam.jones@acme.example" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.lead.name).toBe("sam.jones");
  });

  it("rejects missing or malformed emails", () => {
    expect(normalizeLeadPayload({ name: "No Email" }).ok).toBe(false);
    expect(normalizeLeadPayload({ email: "not-an-email" }).ok).toBe(false);
    expect(normalizeLeadPayload({ email: "a b@c.d" }).ok).toBe(false);
  });

  it("rejects non-object payloads", () => {
    expect(normalizeLeadPayload(null).ok).toBe(false);
    expect(normalizeLeadPayload("email=x@y.z").ok).toBe(false);
    expect(normalizeLeadPayload([{ email: "x@y.zz" }]).ok).toBe(false);
  });

  it("drops non-http(s) website values instead of storing junk", () => {
    const result = normalizeLeadPayload({
      email: "x@y.zz",
      website: "javascript:alert(1)",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.lead.companyWebsite).toBeUndefined();
  });

  it("truncates oversized free-text fields", () => {
    const result = normalizeLeadPayload({
      email: "x@y.zz",
      message: "a".repeat(10_000),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.lead.message?.length).toBe(4000);
  });
});
