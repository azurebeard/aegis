// Cmd-K palette modal — search input + filterable list of commands
// (page jumps + sign out). Triggered by `useCommandPalette()`'s global
// ⌘K / Ctrl+K binding (see features/common/commandPalette.ts).
//
// Keyboard:
//   ⌘K / Ctrl+K  — toggle (handled in useCommandPalette)
//   ↑ / ↓        — move selection
//   Enter        — invoke selected
//   Esc          — close
//
// Visual:
//   Centered overlay over a dimmed scrim; rounded surface; search input
//   pinned at top; scrollable result list below; first match
//   auto-selected so Enter without an arrow press still does the right
//   thing.

import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { signOut } from "@/auth/authActions";
import { useCurrentUser } from "@/auth/useCurrentUser";
import { Icon } from "@/components/Icon";
import { COMMANDS, filterCommands, type Command } from "@/features/common/commandPalette";

interface CommandPaletteProps {
  readonly open: boolean;
  readonly onClose: () => void;
}

export function CommandPalette({ open, onClose }: CommandPaletteProps) {
  const user = useCurrentUser();
  const navigate = useNavigate();
  const inputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);

  const isAdmin = user.hasRole("admin");
  const visible = useMemo(() => filterCommands(query, isAdmin, COMMANDS), [query, isAdmin]);

  // Reset query + selection on every open so the operator starts clean.
  useEffect(() => {
    if (open) {
      setQuery("");
      setActiveIndex(0);
      // Defer focus until the input mounts.
      const id = window.setTimeout(() => inputRef.current?.focus(), 0);
      return () => window.clearTimeout(id);
    }
    return undefined;
  }, [open]);

  // Clamp activeIndex when the visible list shrinks below it.
  useEffect(() => {
    if (activeIndex >= visible.length) {
      setActiveIndex(Math.max(0, visible.length - 1));
    }
  }, [visible.length, activeIndex]);

  const invoke = (cmd: Command): void => {
    onClose();
    if (cmd.kind === "navigate") {
      navigate(cmd.target);
    } else if (cmd.kind === "signout") {
      // ADR-0035 Phase D2 — MSAL logoutRedirect. The redirect navigates the
      // entire page; React tree teardown is acceptable because the operator
      // is signing out anyway.
      void signOut();
    } else {
      // External — full-page nav for absolute-URL commands.
      window.location.href = cmd.target;
    }
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIndex((i) => Math.min(visible.length - 1, i + 1));
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIndex((i) => Math.max(0, i - 1));
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      const cmd = visible[activeIndex];
      if (cmd) invoke(cmd);
      return;
    }
    // Esc handled at the global hook layer, but ALSO close here so a
    // future change to the hook doesn't strand operators in the modal.
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    }
  };

  if (!open) return null;

  return (
    <div className="cmdk-scrim" role="presentation">
      <button
        type="button"
        aria-label="Close command palette"
        className="cmdk-backdrop"
        onClick={onClose}
      />
      <div className="cmdk" role="dialog" aria-modal="true" aria-label="Command palette">
        <div className="cmdk__head">
          <Icon name="search" size={14} style={{ color: "var(--fg-3)" }} />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setActiveIndex(0);
            }}
            onKeyDown={onKeyDown}
            placeholder="Jump to a page or run an action…"
            aria-label="Command query"
            className="cmdk__input"
          />
          <kbd className="cmdk__hint">Esc</kbd>
        </div>
        <ul className="cmdk__list" role="listbox">
          {visible.length === 0 && <li className="cmdk__empty t-body t-body--mute">No matches.</li>}
          {visible.map((cmd, i) => {
            const selected = i === activeIndex;
            return (
              <li key={cmd.id} role="option" aria-selected={selected}>
                <button
                  type="button"
                  className={`cmdk__item ${selected ? "is-active" : ""}`}
                  onMouseEnter={() => setActiveIndex(i)}
                  onClick={() => invoke(cmd)}
                >
                  <Icon name={cmd.icon} size={14} />
                  <span className="cmdk__item-title">{cmd.title}</span>
                  {cmd.hint && <span className="cmdk__item-hint t-body--mute">{cmd.hint}</span>}
                  {cmd.kind === "external" && (
                    <Icon name="external" size={11} className="cmdk__item-ext" />
                  )}
                </button>
              </li>
            );
          })}
        </ul>
        <div className="cmdk__foot">
          <span>
            <kbd className="cmdk__hint">↑</kbd> <kbd className="cmdk__hint">↓</kbd> navigate
          </span>
          <span>
            <kbd className="cmdk__hint">↵</kbd> open
          </span>
          <span>
            <kbd className="cmdk__hint">⌘K</kbd> toggle
          </span>
        </div>
      </div>
    </div>
  );
}
