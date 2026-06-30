// Cmd-K command palette — types, command list, and a global keyboard hook.
//
// The palette is a familiar power-user affordance for jumping between
// dashboard surfaces without reaching for the nav. v1 ships a static
// list of page-jump commands plus a sign-out action; it does NOT yet
// search across incidents/users/etc — that's a v2 candidate when an
// operator asks for it.

import { useEffect, useState, useCallback } from "react";
import type { IconName } from "@/components/Icon";

export type CommandKind = "navigate" | "external" | "signout";

export interface Command {
  readonly id: string;
  readonly title: string;
  /** Optional secondary descriptor — shown in muted text right of the title. */
  readonly hint?: string;
  /** Icon glyph keyed off the existing IconName mapping. */
  readonly icon: IconName;
  readonly kind: CommandKind;
  /** Path for navigate, full URL for external. */
  readonly target: string;
  /** When true, only show the command to admins. */
  readonly adminOnly?: boolean;
  /** Searchable terms — name plus aliases the operator might try. */
  readonly keywords?: readonly string[];
}

/**
 * Static command list. Order matters — matches the AppHeader's mental
 * model (dashboard → incidents → users → admin) plus surface-specific
 * deep links and actions further down.
 */
export const COMMANDS: readonly Command[] = [
  {
    id: "nav-dashboard",
    title: "Dashboard",
    icon: "tile",
    kind: "navigate",
    target: "/",
    keywords: ["home", "overview"],
  },
  {
    id: "nav-incidents",
    title: "Incidents",
    icon: "alert",
    kind: "navigate",
    target: "/incidents",
    keywords: ["alerts", "events"],
  },
  {
    id: "nav-risky-users",
    title: "Risky users",
    icon: "user",
    kind: "navigate",
    target: "/risky-users",
    keywords: ["entra", "identity protection"],
  },
  {
    id: "nav-secure-score",
    title: "Microsoft Secure Score · trend",
    icon: "trend-up",
    kind: "navigate",
    target: "/secure-score",
    keywords: ["score", "chart", "90 day"],
  },
  {
    id: "nav-secure-score-controls",
    title: "Microsoft Secure Score · controls",
    icon: "shield",
    kind: "navigate",
    target: "/secure-score/controls",
    keywords: ["controls", "remediation", "backlog", "score"],
  },
  {
    id: "nav-history",
    title: "Narrative history",
    icon: "doc",
    kind: "navigate",
    target: "/history",
    keywords: ["brief", "posture", "compare", "diff"],
  },
  {
    id: "nav-admin",
    title: "Admin settings",
    icon: "settings",
    kind: "navigate",
    target: "/admin",
    adminOnly: true,
    keywords: ["tenant", "branding", "budget", "tile visibility"],
  },
  {
    id: "nav-admin-agents",
    title: "Agent observability",
    icon: "sparkle",
    kind: "navigate",
    target: "/admin/agents",
    adminOnly: true,
    keywords: ["agents", "circuit breaker", "live", "ai plane"],
  },
  {
    id: "ext-defender-portal",
    title: "Open Microsoft Defender portal",
    icon: "external",
    kind: "external",
    target: "https://security.microsoft.com",
    keywords: ["microsoft", "defender", "portal", "365"],
  },
  {
    id: "action-signout",
    title: "Sign out",
    icon: "lock",
    // ADR-0035 Phase D2 — sign-out via MSAL `logoutRedirect`. The handler in
    // CommandPalette dispatches signOut() from auth/authActions on this kind.
    kind: "signout",
    target: "",
    keywords: ["logout", "exit"],
  },
];

/**
 * Filter the command list against the user's role + a free-text query.
 * Empty query returns all visible commands; non-empty matches anything
 * where the title, hint, or any keyword contains the query
 * (case-insensitive, substring).
 */
export function filterCommands(
  query: string,
  isAdmin: boolean,
  list: readonly Command[] = COMMANDS,
): readonly Command[] {
  const visible = list.filter((c) => !c.adminOnly || isAdmin);
  const q = query.trim().toLowerCase();
  if (!q) return visible;
  return visible.filter((c) => {
    if (c.title.toLowerCase().includes(q)) return true;
    if (c.hint && c.hint.toLowerCase().includes(q)) return true;
    if (c.keywords) {
      for (const k of c.keywords) {
        if (k.toLowerCase().includes(q)) return true;
      }
    }
    return false;
  });
}

/**
 * Global keyboard hook — listens for ⌘K (Mac) / Ctrl+K (everywhere else)
 * and toggles the palette. Esc closes when open. Returns the state plus
 * setters so the caller can drive the rendered palette.
 *
 * The modifier-key gate (`metaKey || ctrlKey`) is sufficient to keep a
 * plain "k" keypress in any input/textarea from triggering the palette
 * — no input-focus check needed.
 */
export function useCommandPalette(): {
  open: boolean;
  setOpen: (next: boolean) => void;
  toggle: () => void;
} {
  const [open, setOpen] = useState(false);

  const toggle = useCallback(() => setOpen((v) => !v), []);

  useEffect(() => {
    const handler = (e: KeyboardEvent): void => {
      // ⌘K / Ctrl+K toggles the palette regardless of focus — feels right
      // for a global jump-anywhere shortcut.
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((v) => !v);
        return;
      }
      if (e.key === "Escape" && open) {
        setOpen(false);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [open]);

  return { open, setOpen, toggle };
}
