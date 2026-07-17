// Tests for agentHealth.ts (ADR-0019 §Decision.6/7 circuit breaker + classifier).

import { describe, it, expect } from "vitest";
import { RestError } from "@azure/data-tables";
import {
  allowCall,
  backoffMs,
  classifyError,
  recordFailure,
  recordSuccess,
  startHalfOpenTrial,
  type AgentFetchErrorKind,
  type AgentHealthRow,
  healthRowKey,
} from "../src/lib/agentHealth.js";
import { LeaseContendedError } from "../src/lib/ingestHealth.js";

class MockTable {
  rows = new Map<string, Record<string, unknown> & { etag?: string }>();
  private c = 0;
  async getEntity<T>(pk: string, rk: string): Promise<T> {
    const v = this.rows.get(`${pk}|${rk}`);
    if (!v) throw new RestError("404", { statusCode: 404 });
    return { ...v } as T;
  }
  async createEntity(e: Record<string, unknown>): Promise<{ etag: string }> {
    const k = `${e.partitionKey}|${e.rowKey}`;
    if (this.rows.has(k)) throw new RestError("409", { statusCode: 409 });
    const etag = `e${++this.c}`;
    this.rows.set(k, { ...e, etag });
    return { etag };
  }
  async updateEntity(
    e: Record<string, unknown>,
    _m: "Replace" | "Merge",
    o?: { etag?: string },
  ): Promise<{ etag: string }> {
    const k = `${e.partitionKey}|${e.rowKey}`;
    const existing = this.rows.get(k);
    if (!existing) throw new RestError("404", { statusCode: 404 });
    if (o?.etag && existing.etag !== o.etag) {
      throw new RestError("412", { statusCode: 412 });
    }
    const etag = `e${++this.c}`;
    this.rows.set(k, { ...e, etag });
    return { etag };
  }
}

const TENANT = "t1";
const AGENT = "brief";

function freshRow(): AgentHealthRow {
  return {
    tenantId: TENANT,
    rowKey: healthRowKey(AGENT),
    state: "closed",
    consecutiveFailures: 0,
    nextProbeAt: null,
    lastFailureKind: null,
    lastFailureAt: null,
    updatedAt: new Date().toISOString(),
    etag: "e1",
  };
}

describe("backoffMs schedule (ADR-0019 §Decision.7)", () => {
  it("0 below trip threshold (n<3)", () => {
    expect(backoffMs(0)).toBe(0);
    expect(backoffMs(2)).toBe(0);
  });
  it("60s on first trip (n=3)", () => {
    expect(backoffMs(3)).toBe(60_000);
  });
  it("doubles on n=4, 5, ...", () => {
    expect(backoffMs(4)).toBe(120_000);
    expect(backoffMs(5)).toBe(240_000);
    expect(backoffMs(6)).toBe(480_000);
  });
  it("clamps at 30 minutes", () => {
    expect(backoffMs(20)).toBe(30 * 60_000);
  });
});

describe("allowCall state machine", () => {
  it("closed → allow, not trial", () => {
    const r = freshRow();
    expect(allowCall(r)).toEqual({ allow: true, trial: false });
  });
  it("open + now < probe → deny", () => {
    const r: AgentHealthRow = {
      ...freshRow(),
      state: "open",
      consecutiveFailures: 3,
      nextProbeAt: new Date(Date.now() + 60_000).toISOString(),
    };
    const d = allowCall(r);
    expect(d.allow).toBe(false);
  });
  it("open + now ≥ probe → allow as trial", () => {
    const r: AgentHealthRow = {
      ...freshRow(),
      state: "open",
      consecutiveFailures: 3,
      nextProbeAt: new Date(Date.now() - 1_000).toISOString(),
    };
    const d = allowCall(r);
    expect(d).toEqual({ allow: true, trial: true });
  });
  it("half_open → deny (trial in flight)", () => {
    const r: AgentHealthRow = {
      ...freshRow(),
      state: "half_open",
    };
    expect(allowCall(r).allow).toBe(false);
  });
});

describe("recordFailure", () => {
  it("opens the circuit at >= 3 consecutive failures", async () => {
    const t = new MockTable();
    let row = freshRow();
    await t.createEntity({
      partitionKey: TENANT,
      rowKey: healthRowKey(AGENT),
      State: "closed",
      ConsecutiveFailures: 0,
      NextProbeAt: null,
      LastFailureKind: null,
      LastFailureAt: null,
      UpdatedAt: row.updatedAt,
    });
    // Re-read to get correct etag.
    const fresh = await t.getEntity<{ etag: string }>(TENANT, healthRowKey(AGENT));
    row = { ...row, etag: fresh.etag };
    const after1 = await recordFailure(t as unknown as never, row, "throttle_429");
    expect(after1.state).toBe("closed");
    expect(after1.consecutiveFailures).toBe(1);
    const after2 = await recordFailure(t as unknown as never, after1, "throttle_429");
    expect(after2.state).toBe("closed");
    const after3 = await recordFailure(t as unknown as never, after2, "throttle_429");
    expect(after3.state).toBe("open");
    expect(after3.consecutiveFailures).toBe(3);
    expect(after3.nextProbeAt).not.toBeNull();
  });
});

describe("recordSuccess closes the circuit and resets state", () => {
  it("flips half_open → closed", async () => {
    const t = new MockTable();
    await t.createEntity({
      partitionKey: TENANT,
      rowKey: healthRowKey(AGENT),
      State: "half_open",
      ConsecutiveFailures: 4,
      NextProbeAt: new Date().toISOString(),
      LastFailureKind: "throttle_429",
      LastFailureAt: new Date().toISOString(),
      UpdatedAt: new Date().toISOString(),
    });
    const got = await t.getEntity<{ etag: string }>(TENANT, healthRowKey(AGENT));
    const row: AgentHealthRow = {
      ...freshRow(),
      state: "half_open",
      consecutiveFailures: 4,
      nextProbeAt: new Date().toISOString(),
      lastFailureKind: "throttle_429",
      lastFailureAt: new Date().toISOString(),
      etag: got.etag,
    };
    const closed = await recordSuccess(t as unknown as never, row);
    expect(closed.state).toBe("closed");
    expect(closed.consecutiveFailures).toBe(0);
    expect(closed.nextProbeAt).toBeNull();
  });
});

describe("recordFailure from half_open re-opens with doubled backoff", () => {
  it("uses the now-incremented ConsecutiveFailures for backoff", async () => {
    const t = new MockTable();
    await t.createEntity({
      partitionKey: TENANT,
      rowKey: healthRowKey(AGENT),
      State: "half_open",
      ConsecutiveFailures: 3,
      NextProbeAt: new Date().toISOString(),
      LastFailureKind: "throttle_429",
      LastFailureAt: new Date().toISOString(),
      UpdatedAt: new Date().toISOString(),
    });
    const got = await t.getEntity<{ etag: string }>(TENANT, healthRowKey(AGENT));
    const row: AgentHealthRow = {
      ...freshRow(),
      state: "half_open",
      consecutiveFailures: 3,
      nextProbeAt: new Date().toISOString(),
      lastFailureKind: "throttle_429",
      lastFailureAt: new Date().toISOString(),
      etag: got.etag,
    };
    const reopened = await recordFailure(t as unknown as never, row, "throttle_429");
    expect(reopened.state).toBe("open");
    expect(reopened.consecutiveFailures).toBe(4);
    // Backoff at n=4 = 120s.
    const nextProbeMs = Date.parse(reopened.nextProbeAt ?? "");
    expect(nextProbeMs - Date.now()).toBeGreaterThan(110_000);
    expect(nextProbeMs - Date.now()).toBeLessThan(125_000);
  });
});

describe("startHalfOpenTrial (SEC-M-STEP5-CODE-01)", () => {
  it("persists the half_open state atomically", async () => {
    const t = new MockTable();
    await t.createEntity({
      partitionKey: TENANT,
      rowKey: healthRowKey(AGENT),
      State: "open",
      ConsecutiveFailures: 3,
      NextProbeAt: new Date(Date.now() - 1_000).toISOString(),
      LastFailureKind: "throttle_429",
      LastFailureAt: new Date().toISOString(),
      UpdatedAt: new Date().toISOString(),
    });
    const got = await t.getEntity<{ etag: string }>(TENANT, healthRowKey(AGENT));
    const row: AgentHealthRow = {
      ...freshRow(),
      state: "open",
      consecutiveFailures: 3,
      nextProbeAt: new Date(Date.now() - 1_000).toISOString(),
      etag: got.etag,
    };
    const trialed = await startHalfOpenTrial(t as unknown as never, row);
    expect(trialed.state).toBe("half_open");
    // Next caller reading the row should see `half_open` via allowCall → deny.
    const persisted = t.rows.get(`${TENANT}|${healthRowKey(AGENT)}`);
    expect(persisted?.State).toBe("half_open");
  });

  it("throws LeaseContendedError when a concurrent caller won the trial-marker race", async () => {
    const t = new MockTable();
    await t.createEntity({
      partitionKey: TENANT,
      rowKey: healthRowKey(AGENT),
      State: "open",
      ConsecutiveFailures: 3,
      NextProbeAt: new Date(Date.now() - 1_000).toISOString(),
      LastFailureKind: "throttle_429",
      LastFailureAt: new Date().toISOString(),
      UpdatedAt: new Date().toISOString(),
    });
    const got = await t.getEntity<{ etag: string }>(TENANT, healthRowKey(AGENT));
    const row: AgentHealthRow = {
      ...freshRow(),
      state: "open",
      consecutiveFailures: 3,
      nextProbeAt: new Date(Date.now() - 1_000).toISOString(),
      etag: got.etag,
    };
    // Simulate another caller landing the trial first — the row etag advances.
    const current = t.rows.get(`${TENANT}|${healthRowKey(AGENT)}`);
    if (current) current.etag = "someone-elses-etag";
    await expect(
      startHalfOpenTrial(t as unknown as never, row),
    ).rejects.toBeInstanceOf(LeaseContendedError);
  });

  it("is a no-op when already half_open", async () => {
    const t = new MockTable();
    const row: AgentHealthRow = {
      ...freshRow(),
      state: "half_open",
    };
    const same = await startHalfOpenTrial(t as unknown as never, row);
    expect(same).toBe(row);
    // Nothing written.
    expect(t.rows.size).toBe(0);
  });
});

describe("classifyError — 14 kinds", () => {
  const cases: ReadonlyArray<[string, unknown, AgentFetchErrorKind]> = [
    ["408 timeout", { status: 408 }, "timeout"],
    ["AbortError name", { name: "AbortError" }, "timeout"],
    ["timeout message", { message: "request timed out" }, "timeout"],
    ["429 throttle", { status: 429 }, "throttle_429"],
    ["500 bad_gateway", { status: 500 }, "bad_gateway"],
    ["503 bad_gateway", { status: 503 }, "bad_gateway"],
    ["401 unauthorised", { status: 401 }, "unauthorised_401"],
    ["403 forbidden", { status: 403 }, "forbidden_403"],
    ["404 not found", { status: 404 }, "not_found_404"],
    ["ConfigError name", { name: "ConfigError" }, "config"],
    ["content_filter message", { message: "blocked by content filter" }, "content_filter"],
    ["output_schema message", { message: "invalid output schema" }, "output_schema"],
    ["prompt_injection message", { message: "prompt injection detected" }, "prompt_injection_detected"],
    ["denylist message", { message: "denylist hit" }, "denylist_blocked"],
    ["network message", { message: "fetch failed: ECONNRESET" }, "network"],
    ["explicit kind field", { kind: "internal" }, "internal"],
    ["unknown shape → other", "string-error", "other"],
  ];
  for (const [name, input, expected] of cases) {
    it(`classifies ${name}`, () => {
      expect(classifyError(input)).toBe(expected);
    });
  }
});
