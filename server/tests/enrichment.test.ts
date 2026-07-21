import { describe, expect, it } from "vitest";
import { htmlToText } from "../src/integrations/enrichment.js";

describe("htmlToText", () => {
  it("strips tags and keeps readable text", () => {
    const html = `<html><body><h1>Acme Analytics</h1><p>Forecasting for <b>revenue teams</b>.</p></body></html>`;
    const text = htmlToText(html);
    expect(text).toContain("Acme Analytics");
    expect(text).toContain("Forecasting for revenue teams");
    expect(text).not.toContain("<");
  });

  it("removes script and style contents entirely", () => {
    const html = `<style>.x{color:red}</style><script>alert("pwn")</script><p>Visible</p>`;
    const text = htmlToText(html);
    expect(text).toBe("Visible");
  });

  it("decodes common entities", () => {
    expect(htmlToText("<p>Fish &amp; Chips &lt;fast&gt;</p>")).toBe(
      "Fish & Chips <fast>",
    );
  });

  it("collapses whitespace and turns block tags into newlines", () => {
    const text = htmlToText("<div>one</div>   <div>two</div>\n\n<li>three</li>");
    expect(text).toBe("one\ntwo\nthree");
  });
});
