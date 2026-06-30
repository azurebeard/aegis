// ADR-0033 — optimistic cache update for KEV suppression mutations.
//
// Operator-surfaced bug (HANDOVER §6.3): changing a KEV row's status
// didn't update the rendered table until React Query's invalidate
// round-trip landed. Fix is `onMutate`/`onError` rollback on
// `useSetKevSuppression` + `useClearKevSuppression`. These tests pin
// the fix in place.

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { renderHook, waitFor, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import {
  useClearKevSuppression,
  useSetKevSuppression,
} from "@/features/kev/queries";
import { STACK_ITEMS_KEY } from "@/features/stack/queries";
import type { StackItem, StackItemsResponse } from "@/features/stack/types";

const ITEM_ID = "550e8400-e29b-41d4-a716-446655440000";
const CVE_A = "CVE-2024-AAA";
const CVE_B = "CVE-2024-BBB";

function makeItem(): StackItem {
  return {
    id: ITEM_ID,
    vendor: "Microsoft",
    product: "Windows Server 2022",
    version: "21H2",
    category: "os",
    environment: "production",
    notes: "",
    tags: [],
    canonical: true,
    addedAt: "2026-04-28T10:00:00.000Z",
    addedBy: "admin-oid",
    updatedAt: "2026-04-28T10:00:00.000Z",
    updatedBy: "admin-oid",
    kevMatches: [
      {
        cveID: CVE_A,
        vendorProject: "Microsoft",
        product: "Windows Server 2022",
        vulnerabilityName: "A",
        dateAdded: "",
        dueDate: "2024-12-31",
        knownRansomwareCampaignUse: "Unknown",
        requiredAction: "",
        status: "open",
        notes: null,
        expiresAt: null,
        updatedAt: null,
        updatedBy: null,
      },
      {
        cveID: CVE_B,
        vendorProject: "Microsoft",
        product: "Windows Server 2022",
        vulnerabilityName: "B",
        dateAdded: "",
        dueDate: "2024-12-31",
        knownRansomwareCampaignUse: "Unknown",
        requiredAction: "",
        status: "open",
        notes: null,
        expiresAt: null,
        updatedAt: null,
        updatedBy: null,
      },
    ],
  };
}

function makeCache(): StackItemsResponse {
  return { schemaVersion: 1, items: [makeItem()], cap: 100 };
}

function harness() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  qc.setQueryData(STACK_ITEMS_KEY, makeCache());
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
  return { qc, wrapper };
}

function readMatch(qc: QueryClient, cveID: string) {
  const cache = qc.getQueryData<StackItemsResponse>(STACK_ITEMS_KEY);
  return cache?.items[0]?.kevMatches?.find((m) => m.cveID === cveID);
}

// Hold the fetch promise so we can observe the cache MID-FLIGHT (i.e. while
// the network is still pending) — that's exactly the window the optimistic
// update covers.
function deferredFetch(): {
  fetch: ReturnType<typeof vi.fn>;
  resolve: (value: Response) => void;
  reject: (err: Error) => void;
} {
  let resolveFn: (value: Response) => void = () => {};
  let rejectFn: (err: Error) => void = () => {};
  const promise = new Promise<Response>((res, rej) => {
    resolveFn = res;
    rejectFn = rej;
  });
  const fetchMock = vi.fn(() => promise);
  return { fetch: fetchMock, resolve: resolveFn, reject: rejectFn };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

let originalFetch: typeof globalThis.fetch;
beforeEach(() => {
  originalFetch = globalThis.fetch;
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe("useSetKevSuppression — optimistic cache update", () => {
  it("patches the matching CVE in StackItemsResponse before the network resolves", async () => {
    const { qc, wrapper } = harness();
    const d = deferredFetch();
    globalThis.fetch = d.fetch as unknown as typeof globalThis.fetch;

    const { result } = renderHook(() => useSetKevSuppression(), { wrapper });

    act(() => {
      result.current.mutate({
        stackItemId: ITEM_ID,
        cveID: CVE_A,
        status: "remediated",
        notes: "patched",
      });
    });

    // Mid-flight: cache reflects the optimistic patch on the targeted row only.
    await waitFor(() => {
      expect(readMatch(qc, CVE_A)?.status).toBe("remediated");
    });
    expect(readMatch(qc, CVE_A)?.notes).toBe("patched");
    // Sibling row untouched.
    expect(readMatch(qc, CVE_B)?.status).toBe("open");

    // Resolve the network — onSettled fires invalidate but the cache shape
    // is still consistent with the patch (no refetch wired in this harness).
    d.resolve(jsonResponse({ ok: true }));
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(readMatch(qc, CVE_A)?.status).toBe("remediated");
  });

  it("rolls back the optimistic patch when the network errors", async () => {
    const { qc, wrapper } = harness();
    const d = deferredFetch();
    globalThis.fetch = d.fetch as unknown as typeof globalThis.fetch;

    const { result } = renderHook(() => useSetKevSuppression(), { wrapper });

    act(() => {
      result.current.mutate({
        stackItemId: ITEM_ID,
        cveID: CVE_A,
        status: "risk_accepted",
      });
    });

    // Confirm the patch landed first.
    await waitFor(() => {
      expect(readMatch(qc, CVE_A)?.status).toBe("risk_accepted");
    });

    // Server returns 409 — onError must roll the cache back to "open".
    d.resolve(jsonResponse({ error: "conflict" }, 409));
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(readMatch(qc, CVE_A)?.status).toBe("open");
    expect(readMatch(qc, CVE_A)?.notes).toBeNull();
  });
});

describe("useClearKevSuppression — optimistic cache update", () => {
  it("optimistically resets the row to status='open' before the DELETE resolves", async () => {
    const { qc, wrapper } = harness();
    // Pre-set a suppressed state so we can observe the reset.
    const cache = makeCache();
    cache.items[0]!.kevMatches = cache.items[0]!.kevMatches!.map((m) =>
      m.cveID === CVE_A
        ? { ...m, status: "remediated", notes: "patched", updatedAt: "2026-04-28T11:00:00Z", updatedBy: "x" }
        : m,
    );
    qc.setQueryData(STACK_ITEMS_KEY, cache);

    const d = deferredFetch();
    globalThis.fetch = d.fetch as unknown as typeof globalThis.fetch;

    const { result } = renderHook(() => useClearKevSuppression(), { wrapper });

    act(() => {
      result.current.mutate({ stackItemId: ITEM_ID, cveID: CVE_A });
    });

    await waitFor(() => {
      expect(readMatch(qc, CVE_A)?.status).toBe("open");
    });
    expect(readMatch(qc, CVE_A)?.notes).toBeNull();
    expect(readMatch(qc, CVE_A)?.updatedAt).toBeNull();
    expect(readMatch(qc, CVE_A)?.updatedBy).toBeNull();

    d.resolve(jsonResponse({ ok: true }));
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
  });

  it("rolls back to the prior suppression when DELETE errors", async () => {
    const { qc, wrapper } = harness();
    const cache = makeCache();
    cache.items[0]!.kevMatches = cache.items[0]!.kevMatches!.map((m) =>
      m.cveID === CVE_A ? { ...m, status: "acknowledged", notes: "ack" } : m,
    );
    qc.setQueryData(STACK_ITEMS_KEY, cache);

    const d = deferredFetch();
    globalThis.fetch = d.fetch as unknown as typeof globalThis.fetch;

    const { result } = renderHook(() => useClearKevSuppression(), { wrapper });

    act(() => {
      result.current.mutate({ stackItemId: ITEM_ID, cveID: CVE_A });
    });

    await waitFor(() => expect(readMatch(qc, CVE_A)?.status).toBe("open"));

    d.resolve(jsonResponse({ error: "boom" }, 500));
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(readMatch(qc, CVE_A)?.status).toBe("acknowledged");
    expect(readMatch(qc, CVE_A)?.notes).toBe("ack");
  });
});
