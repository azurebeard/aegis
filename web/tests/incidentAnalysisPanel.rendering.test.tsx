// Pins the post-mutation refetch behaviour of IncidentAnalysisPanel.
//
// Symptom this test guards against: operator clicks "Analyse now" on a fresh
// alert, "Analysing…" appears, the POST resolves after ~10–30s, then the
// panel briefly reverts to the "No analysis yet" + button state instead of
// showing the just-committed analysis. The only way out was a hard reload.
//
// Cause: React Query v5 flips `mutation.isPending` to `false` the moment the
// mutationFn resolves — *before* the `onSuccess` callback runs
// `invalidateQueries()` and the refetch lands. The panel previously
// branched purely on `analyse.isPending`, so the ~100–500ms refetch window
// rendered the "no analysis" branch with stale GET data.
//
// Fix verified here: the "Analysing…" UI MUST stay visible from the click
// through to the moment the new envelope is in the cache. We exercise that
// timeline by holding the GET refetch open after the POST resolves.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { FluentProvider, webLightTheme } from "@fluentui/react-components";

vi.mock("@/api/client", async () => {
  const actual = await vi.importActual<typeof import("@/api/client")>(
    "@/api/client",
  );
  return {
    ...actual,
    api: {
      get: vi.fn(),
      post: vi.fn(),
      patch: vi.fn(),
      delete: vi.fn(),
      upload: vi.fn(),
    },
  };
});

// File-scope override of the setup.ts default useCurrentUser mock. The
// setup.ts version reads from `qc.getQueryData(["auth","me"])` but the
// timing of qc.setQueryData vs the IncidentAnalysisPanel's first render
// is brittle for this test — pin the admin role explicitly.
vi.mock("@/auth/useCurrentUser", () => ({
  useCurrentUser: () => ({
    isLoading: false,
    isAuthenticated: true,
    principal: {
      identityProvider: "aad",
      userId: "operator",
      userDetails: "operator@contoso",
      userRoles: ["authenticated", "admin"],
    },
    roles: ["authenticated", "admin"] as readonly string[],
    hasRole: (r: string) => r === "admin" || r === "authenticated",
  }),
}));

import { api } from "@/api/client";
import { IncidentAnalysisPanel } from "@/features/incidents/IncidentAnalysisPanel";
import type { IncidentAnalysisResponse } from "@/features/incidents/analysisTypes";

const apiGet = api.get as unknown as ReturnType<typeof vi.fn>;
const apiPost = api.post as unknown as ReturnType<typeof vi.fn>;

const INCIDENT_ID = "incident-fresh-001";

// Lets us hold a promise open until we explicitly resolve it — simulates a
// slow network roundtrip without faking timers (jsdom + RQ + faked timers
// interact poorly with microtask scheduling).
function deferred<T>(): {
  promise: Promise<T>;
  resolve: (v: T) => void;
  reject: (err: unknown) => void;
} {
  let resolve!: (v: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function awaitingFirstRun(): IncidentAnalysisResponse {
  return {
    schemaVersion: 1,
    analysis: null,
    health: { status: "awaiting_first_run" },
  } as unknown as IncidentAnalysisResponse;
}

function committedAnalysis(): IncidentAnalysisResponse {
  return {
    schemaVersion: 1,
    incidentId: INCIDENT_ID,
    headline: "Fresh analysis just landed",
    severity: "notable",
    sections: {
      attackNarrative: "Narrative body.",
      impactAssessment: "Impact body.",
      suggestedNextSteps: "Next steps body.",
    },
    runId: "run-fresh-001",
    generatedAt: "2026-06-22T12:00:00Z",
    outputSha256: "x".repeat(64),
    modelDeployment: "aegis-small",
    analysedIncidentLastUpdateDateTime: "2026-06-22T11:59:00Z",
    redactionLock: { active: false, until: null },
  } as unknown as IncidentAnalysisResponse;
}

function renderPanel(qc: QueryClient) {
  // useCurrentUser is mocked at file scope — no auth/me cache wiring needed.
  return render(
    <QueryClientProvider client={qc}>
      <FluentProvider theme={webLightTheme}>
        <IncidentAnalysisPanel incidentId={INCIDENT_ID} />
      </FluentProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  apiGet.mockReset();
  apiPost.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("IncidentAnalysisPanel — analyse-now refetch window", () => {
  it("keeps the Analysing… UI visible from click through to the refetch landing", async () => {
    const user = userEvent.setup();
    const qc = new QueryClient({
      defaultOptions: {
        queries: { retry: false, gcTime: 0, staleTime: 0 },
        mutations: { retry: false },
      },
    });

    // Initial GET — resolves immediately with awaiting_first_run.
    // First call: initial query mount. Second call: post-mutation refetch
    // — that one we hold open with the deferred so the test can observe
    // the in-flight refetch window.
    const refetchGate = deferred<IncidentAnalysisResponse>();
    apiGet
      .mockResolvedValueOnce(awaitingFirstRun())
      .mockReturnValueOnce(refetchGate.promise);

    // POST resolves quickly — simulates the agent run wrapping up.
    const postGate = deferred<{ status: string; incidentId: string }>();
    apiPost.mockReturnValueOnce(postGate.promise);

    renderPanel(qc);

    // Initial state: button visible, no Analysing… text.
    const button = await screen.findByRole("button", { name: /Analyse now/i });
    expect(screen.queryByText(/Analysing this incident/i)).not.toBeInTheDocument();

    await user.click(button);

    // After click: Analysing… text shows (mutation in flight).
    await waitFor(() => {
      expect(screen.getByText(/Analysing this incident/i)).toBeInTheDocument();
    });

    // The mutation resolves — but the refetch is still in flight (held by
    // the deferred). The panel MUST keep showing the "Analysing…" text;
    // before the fix this is where it would briefly revert to the button.
    await act(async () => {
      postGate.resolve({ status: "committed", incidentId: INCIDENT_ID });
      // Let microtasks flush so RQ runs the onSuccess + starts the refetch.
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(screen.getByText(/Analysing this incident/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Analyse now/i })).not.toBeInTheDocument();

    // Refetch lands with the committed analysis — now we render the body.
    await act(async () => {
      refetchGate.resolve(committedAnalysis());
      await Promise.resolve();
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(screen.getByText(/Fresh analysis just landed/i)).toBeInTheDocument();
    });
    expect(screen.queryByText(/Analysing this incident/i)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Analyse now/i })).not.toBeInTheDocument();
  });

  it("invalidates the analysis query even when the panel unmounts mid-mutation", async () => {
    // The user-visible bug this guards against: operator clicks "Analyse
    // now", switches tabs / closes the drawer during the agent run, then
    // returns to the AI tab. The cache row is committed but the stale GET
    // stays cached and the panel shows "No analysis yet" + button. Cause:
    // `invalidateQueries` was previously in `useMutation`'s `onSuccess`
    // option which only fires while the component is mounted. Fix moves
    // it into `mutationFn` so it runs at the MutationCache level.
    //
    // Test models the unmount via `unmount()` after click but before the
    // POST resolves, then asserts the cached `awaiting_first_run` row was
    // invalidated (next mount would refetch from the network).
    const user = userEvent.setup();
    const qc = new QueryClient({
      defaultOptions: {
        // staleTime > 0 so we can distinguish "stayed fresh-but-stale" from
        // "was invalidated by the mutation".
        queries: { retry: false, gcTime: Infinity, staleTime: 60_000 },
        mutations: { retry: false },
      },
    });

    apiGet.mockResolvedValueOnce(awaitingFirstRun());
    const postGate = deferred<{ status: string; incidentId: string }>();
    apiPost.mockReturnValueOnce(postGate.promise);

    const { unmount } = renderPanel(qc);
    await user.click(await screen.findByRole("button", { name: /Analyse now/i }));

    // Simulate the operator closing the drawer / switching tabs DURING the
    // agent run, before the POST resolves.
    unmount();

    // POST resolves AFTER the panel is gone.
    await act(async () => {
      postGate.resolve({ status: "committed", incidentId: INCIDENT_ID });
      await Promise.resolve();
      await Promise.resolve();
    });

    // The cached row must now be stale, even though no component was mounted
    // when the response came in. `getQueryState().isInvalidated === true` is
    // the cache-level invariant; the next mount's useQuery will refetch.
    const state = qc.getQueryState(["incidents", "analysis", INCIDENT_ID]);
    expect(state?.isInvalidated).toBe(true);
  });

  it("falls back to the button if the refetch lands with awaiting_first_run (e.g. superseded run)", async () => {
    // Defensive case: the agent returned without committing a new row
    // (status=superseded with no superseding row visible yet). The user
    // should see the button again, NOT be stuck on Analysing… forever.
    const user = userEvent.setup();
    const qc = new QueryClient({
      defaultOptions: {
        queries: { retry: false, gcTime: 0, staleTime: 0 },
        mutations: { retry: false },
      },
    });

    apiGet
      .mockResolvedValueOnce(awaitingFirstRun())
      .mockResolvedValueOnce(awaitingFirstRun());
    apiPost.mockResolvedValueOnce({ status: "superseded", incidentId: INCIDENT_ID });

    renderPanel(qc);
    await user.click(await screen.findByRole("button", { name: /Analyse now/i }));

    // Wait for the mutation + refetch to fully settle.
    await waitFor(() => {
      expect(apiGet).toHaveBeenCalledTimes(2);
    });
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /Analyse now/i })).toBeInTheDocument();
    });
    expect(screen.queryByText(/Analysing this incident/i)).not.toBeInTheDocument();
  });
});
