import { describe, expect, it } from "vitest";
import { extractLinks, htmlToText, rankCandidateLinks } from "../src/integrations/enrichment.js";

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

describe("extractLinks", () => {
  it("resolves relative hrefs to absolute URLs", () => {
    const html = `<a href="/pricing">Pricing</a>`;
    const links = extractLinks(html, "https://acme.com/home");
    expect(links).toEqual([{ href: "https://acme.com/pricing", text: "Pricing" }]);
  });

  it("strips nested tags from the link text", () => {
    const html = `<a href="/about"><span>About</span> us</a>`;
    const links = extractLinks(html, "https://acme.com");
    expect(links[0].text).toBe("About us");
  });

  it("skips pure in-page fragment links", () => {
    const html = `<a href="#top">Top</a><a href="/product">Product</a>`;
    const links = extractLinks(html, "https://acme.com");
    expect(links).toHaveLength(1);
    expect(links[0].href).toBe("https://acme.com/product");
  });

  it("skips non-http(s) links like mailto", () => {
    const html = `<a href="mailto:hi@acme.com">Email us</a>`;
    expect(extractLinks(html, "https://acme.com")).toHaveLength(0);
  });

  it("returns an empty array when there are no links", () => {
    expect(extractLinks("<p>no links here</p>", "https://acme.com")).toEqual([]);
  });
});

describe("rankCandidateLinks", () => {
  it("ranks relevant same-domain links above irrelevant ones", () => {
    const links = [
      { href: "https://acme.com/random-page", text: "Random" },
      { href: "https://acme.com/pricing", text: "See our pricing" },
      { href: "https://acme.com/about", text: "About the company" },
    ];
    const ranked = rankCandidateLinks(links, "https://acme.com");
    expect(ranked).toContain("https://acme.com/pricing");
    expect(ranked).toContain("https://acme.com/about");
    expect(ranked).not.toContain("https://acme.com/random-page");
  });

  it("excludes off-domain links", () => {
    const links = [{ href: "https://evil.com/pricing", text: "Pricing" }];
    expect(rankCandidateLinks(links, "https://acme.com")).toEqual([]);
  });

  it("treats www. and bare domain as the same site", () => {
    const links = [{ href: "https://www.acme.com/pricing", text: "Pricing" }];
    expect(rankCandidateLinks(links, "https://acme.com")).toEqual(["https://www.acme.com/pricing"]);
  });

  it("dedupes repeated links", () => {
    const links = [
      { href: "https://acme.com/pricing", text: "Pricing" },
      { href: "https://acme.com/pricing", text: "Pricing again" },
    ];
    expect(rankCandidateLinks(links, "https://acme.com")).toHaveLength(1);
  });

  it("caps results at the given limit", () => {
    const links = Array.from({ length: 20 }, (_, i) => ({
      href: `https://acme.com/product-${i}`,
      text: "Product",
    }));
    expect(rankCandidateLinks(links, "https://acme.com", 5)).toHaveLength(5);
  });
});
