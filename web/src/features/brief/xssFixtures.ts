// 11-case XSS fixture for SafeMarkdown — every case must render inert.
//
// Each fixture asserts the cleaned-output assertion: the offending tag /
// attribute / scheme MUST NOT survive the SafeMarkdown render. We don't
// censor the surrounding text; the user can still see what the model emitted.

export interface XssFixture {
  readonly name: string;
  readonly input: string;
  /** Substrings that MUST NOT appear in the rendered HTML. */
  readonly mustNotContain: readonly string[];
  /** Tags that MUST NOT appear as elements in the rendered DOM. */
  readonly mustNotRenderTags: readonly string[];
}

export const XSS_FIXTURES: readonly XssFixture[] = [
  {
    name: "raw <script> tag",
    input: "<script>alert(1)</script>",
    mustNotContain: ["<script", "alert(1)"],
    mustNotRenderTags: ["script"],
  },
  {
    name: "javascript: link",
    input: "[click](javascript:alert(1))",
    mustNotContain: ["javascript:", "javascript%3a"],
    mustNotRenderTags: [],
  },
  {
    name: "data:text/html image",
    input: "![img](data:text/html,<script>alert(1)</script>)",
    mustNotContain: ["data:text/html", "<script"],
    mustNotRenderTags: ["script"],
  },
  {
    name: "<iframe>",
    input: '<iframe src="https://evil.example.com"></iframe>',
    mustNotContain: ["<iframe"],
    mustNotRenderTags: ["iframe"],
  },
  {
    name: "<a> with onclick",
    input: '<a onclick="alert(1)" href="#">x</a>',
    mustNotContain: ["onclick"],
    mustNotRenderTags: [],
  },
  {
    name: "<img> with onerror",
    input: '<img src=x onerror="alert(1)">',
    mustNotContain: ["onerror", "alert(1)"],
    mustNotRenderTags: ["img"],
  },
  {
    name: "<svg> with onload",
    input: '<svg onload="alert(1)"></svg>',
    mustNotContain: ["onload", "alert(1)"],
    mustNotRenderTags: ["svg"],
  },
  {
    name: "<object>",
    input: '<object data="evil.swf"></object>',
    mustNotContain: ["<object"],
    mustNotRenderTags: ["object"],
  },
  {
    name: "<embed>",
    input: '<embed src="evil">',
    mustNotContain: ["<embed"],
    mustNotRenderTags: ["embed"],
  },
  {
    name: "<style> tag",
    input: "<style>body{display:none}</style>",
    mustNotContain: ["<style", "display:none"],
    mustNotRenderTags: ["style"],
  },
  {
    name: "U+202E bidi override",
    input: "malicious \u202E legitimate",
    // Either stripped or rendered inert — the renderer must not let the
    // bidi flip the visual order in a way that affects security tokens.
    // SafeMarkdown does not strip bidi itself (that's the prompt-builder's
    // job server-side), so the assertion is that NO script/iframe lands.
    mustNotContain: ["<script", "<iframe"],
    mustNotRenderTags: ["script", "iframe"],
  },
];
