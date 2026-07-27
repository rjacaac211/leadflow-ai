import { describe, expect, it } from "vitest";
import { isRetriableError } from "../src/agent/errors.js";

describe("isRetriableError", () => {
  it("retries HubSpot 429s", () => {
    expect(isRetriableError(new Error("HubSpot PATCH /crm/v3/objects/contacts/x failed (429): rate limited"))).toBe(true);
  });

  it("retries HubSpot 5xx", () => {
    expect(isRetriableError(new Error("HubSpot POST /crm/v3/objects/contacts failed (503): unavailable"))).toBe(true);
  });

  it("does not retry HubSpot 4xx other than 429", () => {
    expect(isRetriableError(new Error("HubSpot PATCH /crm/v3/objects/contacts/x failed (404): not found"))).toBe(false);
  });

  it("retries Resend 5xx", () => {
    expect(isRetriableError(new Error('Resend send failed (500): {"message":"internal error"}'))).toBe(true);
  });

  it("does not retry Resend validation errors (422)", () => {
    expect(isRetriableError(new Error('Resend send failed (422): {"message":"invalid to field"}'))).toBe(false);
  });

  it("retries errors exposing a numeric 429/5xx status property", () => {
    const error = Object.assign(new Error("rate limited"), { status: 429 });
    expect(isRetriableError(error)).toBe(true);
    const serverError = Object.assign(new Error("boom"), { status: 500 });
    expect(isRetriableError(serverError)).toBe(true);
  });

  it("does not retry errors with a 4xx status property", () => {
    const error = Object.assign(new Error("bad request"), { status: 400 });
    expect(isRetriableError(error)).toBe(false);
  });

  it("retries AbortError/TimeoutError", () => {
    const abort = new Error("aborted");
    abort.name = "AbortError";
    expect(isRetriableError(abort)).toBe(true);
    const timeout = new Error("timed out");
    timeout.name = "TimeoutError";
    expect(isRetriableError(timeout)).toBe(true);
  });

  it("retries known transient network error codes", () => {
    const error = Object.assign(new Error("connection reset"), { code: "ECONNRESET" });
    expect(isRetriableError(error)).toBe(true);
  });

  it("does not retry plain unrecognized errors", () => {
    expect(isRetriableError(new Error("something unexpected happened"))).toBe(false);
  });

  it("does not retry non-Error values", () => {
    expect(isRetriableError("just a string")).toBe(false);
    expect(isRetriableError(null)).toBe(false);
    expect(isRetriableError(undefined)).toBe(false);
  });
});
