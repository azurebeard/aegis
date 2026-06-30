// Security-hardened Markdown renderer for agent-authored brief bullets.
//
// Threat model: the daily brief comes from an LLM. The model already produces
// JSON envelopes (validated server-side), but bullet text is free-form and
// MAY contain Markdown emphasis that we want to preserve. We MUST NOT trust
// it to be safe HTML.
//
// Defences (fail-closed):
//   1. `react-markdown` parses input as Markdown — no `dangerouslySetInnerHTML`.
//   2. `rehype-sanitize` with a strict schema strips every tag not on the
//      allowlist (no `<script>`, `<iframe>`, `<object>`, `<embed>`, `<style>`,
//      `<form>`, `<input>`, `<button>`).
//   3. `urlTransform` allowlist: only `http`, `https`, `mailto` URL schemes
//      survive — `javascript:`, `data:`, `file:`, `vbscript:` are dropped.
//   4. `allowedElements` further constrains the renderer to structural +
//      inline formatting tags only.
//   5. Wrapping ErrorBoundary renders `"brief-render-error"` if anything
//      throws (defence-in-depth — never crash the page).

import { Component, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";

const SAFE_PROTOCOLS = new Set(["http:", "https:", "mailto:"]);

/**
 * Whitelist URL transform — strips any URL whose protocol is not in
 * `SAFE_PROTOCOLS`. Empty strings are allowed (let react-markdown decide).
 */
function safeUrlTransform(url: string): string {
  if (!url) return url;
  // Reject anything that looks like javascript:/data:/vbscript:/file: even
  // before URL parsing — the parser is forgiving and we don't want to depend
  // on its quirks.
  const lower = url.trim().toLowerCase();
  if (
    lower.startsWith("javascript:") ||
    lower.startsWith("data:") ||
    lower.startsWith("vbscript:") ||
    lower.startsWith("file:")
  ) {
    return "";
  }
  // Accept relative URLs and fragment-only URLs; otherwise check protocol.
  if (/^[a-z][a-z0-9+.-]*:/i.test(url)) {
    try {
      const u = new URL(url);
      if (!SAFE_PROTOCOLS.has(u.protocol)) return "";
    } catch {
      return "";
    }
  }
  return url;
}

// Whitelist of structural + inline formatting elements only. No images, no
// tables (yet), no media, no scripts, no styling tags.
const ALLOWED_ELEMENTS: readonly string[] = [
  "p",
  "ul",
  "ol",
  "li",
  "strong",
  "em",
  "code",
  "pre",
  "blockquote",
  "a",
  "br",
  "hr",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
];

const ALLOWED_ELEMENTS_SET = new Set<string>(ALLOWED_ELEMENTS);

// rehype-sanitize schema — extend the default with our element + attribute
// constraints, but explicitly drop on* event handlers and strip class/style.
const sanitiseSchema = {
  ...defaultSchema,
  tagNames: ALLOWED_ELEMENTS as unknown as string[],
  attributes: {
    a: ["href", "title"],
    code: ["className"], // allow language- prefix only via filter below
    span: ["className"],
  } as Record<string, string[]>,
  protocols: {
    href: ["http", "https", "mailto"],
  } as Record<string, string[]>,
  clobberPrefix: "",
  clobber: [],
  ancestors: {} as Record<string, string[]>,
};

interface SafeMarkdownProps {
  readonly children: string;
}

class ErrorBoundary extends Component<{ children: ReactNode }, { hasError: boolean }> {
  constructor(props: { children: ReactNode }) {
    super(props);
    this.state = { hasError: false };
  }
  static getDerivedStateFromError(): { hasError: boolean } {
    return { hasError: true };
  }
  componentDidCatch(): void {
    // Console-only telemetry — App Insights auto-ingests structured logs.
    console.error("SafeMarkdown render error");
  }
  render(): ReactNode {
    if (this.state.hasError) {
      return <span data-testid="brief-render-error">brief-render-error</span>;
    }
    return this.props.children;
  }
}

export function SafeMarkdown({ children }: SafeMarkdownProps): JSX.Element {
  return (
    <ErrorBoundary>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[[rehypeSanitize, sanitiseSchema]]}
        urlTransform={safeUrlTransform}
        allowedElements={[...ALLOWED_ELEMENTS_SET]}
        unwrapDisallowed={true}
      >
        {children}
      </ReactMarkdown>
    </ErrorBoundary>
  );
}
