// Shared refresh-now button for populated dashboard tiles. Consumes the
// state machine from `useAdminTileRefresh` and renders:
//   - Fluent UI `Button` with subtle appearance (fits next to "Last ingested"
//     footers without dominating the tile).
//   - Inline spinner while running.
//   - Error line in red on failure (kind + message).
//   - Transient "refreshing…" line on success (React Query takes over shortly).
// The button + messages are rendered only when `canRefresh` is true; the tile
// passes the hook result through unchanged.

import { Body1, Button, Spinner, tokens } from "@fluentui/react-components";
import { ArrowClockwiseRegular } from "@fluentui/react-icons";
import type { AdminTileRefreshResult } from "./useAdminTileRefresh";

export interface RefreshNowButtonProps {
  readonly refresh: AdminTileRefreshResult;
  /** Accessible label — each tile passes its own for distinct screen-reader announcement. */
  readonly ariaLabel: string;
}

export function RefreshNowButton({ refresh, ariaLabel }: RefreshNowButtonProps) {
  if (!refresh.canRefresh) return null;
  const running = refresh.state.status === "running";
  return (
    <div style={{ marginTop: tokens.spacingVerticalS }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: tokens.spacingHorizontalS,
        }}
      >
        <Button
          appearance="subtle"
          size="small"
          icon={<ArrowClockwiseRegular />}
          onClick={() => void refresh.refresh()}
          disabled={running}
          aria-label={ariaLabel}
        >
          {running ? "Refreshing…" : "Refresh now"}
        </Button>
        {running && <Spinner size="tiny" />}
      </div>
      {refresh.state.status === "error" && (
        <Body1
          block
          role="alert"
          aria-live="assertive"
          style={{
            marginTop: tokens.spacingVerticalXS,
            color: tokens.colorPaletteRedForeground1,
            fontSize: tokens.fontSizeBase200,
          }}
        >
          Refresh failed ({refresh.state.kind}): {refresh.state.message}
        </Body1>
      )}
      {refresh.state.status === "success" && (
        <Body1
          block
          role="status"
          aria-live="polite"
          style={{
            marginTop: tokens.spacingVerticalXS,
            color: tokens.colorPaletteGreenForeground1,
            fontSize: tokens.fontSizeBase200,
          }}
        >
          Refreshed — loading new data…
        </Body1>
      )}
    </div>
  );
}
