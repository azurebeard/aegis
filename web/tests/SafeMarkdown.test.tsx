// XSS-fixture matrix for SafeMarkdown.
//
// 11 hostile-input cases (xssFixtures.ts). Each one is rendered, then we
// assert the rendered DOM contains no script / iframe / on-handler / unsafe
// URL scheme. Failure here = a security-critical regression.

import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { SafeMarkdown } from "@/features/brief/SafeMarkdown";
import { XSS_FIXTURES } from "@/features/brief/xssFixtures";

describe("SafeMarkdown — XSS fixtures", () => {
  for (const f of XSS_FIXTURES) {
    it(`${f.name}: renders inert`, () => {
      const { container } = render(<SafeMarkdown>{f.input}</SafeMarkdown>);
      const html = container.innerHTML;
      for (const forbidden of f.mustNotContain) {
        expect(
          html.toLowerCase().includes(forbidden.toLowerCase()),
          `rendered HTML should not contain "${forbidden}" — got: ${html}`,
        ).toBe(false);
      }
      for (const tag of f.mustNotRenderTags) {
        expect(
          container.querySelector(tag),
          `rendered DOM should not contain <${tag}>`,
        ).toBeNull();
      }
      // Defence-in-depth: assert no on* attributes survived ANY tag.
      for (const el of Array.from(container.querySelectorAll("*"))) {
        for (const attr of Array.from(el.attributes)) {
          expect(
            attr.name.toLowerCase().startsWith("on"),
            `rendered element <${el.tagName.toLowerCase()}> should not carry on* attribute "${attr.name}"`,
          ).toBe(false);
        }
      }
    });
  }
});

describe("SafeMarkdown — benign Markdown still renders", () => {
  it("renders **bold** and *emphasis*", () => {
    const { container } = render(
      <SafeMarkdown>{"This is **bold** and *italic* text."}</SafeMarkdown>,
    );
    expect(container.querySelector("strong")?.textContent).toBe("bold");
    expect(container.querySelector("em")?.textContent).toBe("italic");
  });
  it("preserves http/https links", () => {
    const { container } = render(
      <SafeMarkdown>{"[Microsoft](https://microsoft.com)"}</SafeMarkdown>,
    );
    const a = container.querySelector("a");
    expect(a?.getAttribute("href")).toBe("https://microsoft.com");
  });
  it("renders unordered lists", () => {
    const { container } = render(
      <SafeMarkdown>{"- one\n- two\n- three"}</SafeMarkdown>,
    );
    expect(container.querySelectorAll("li")).toHaveLength(3);
  });
});
