// Tests for agentBudget.ts (ADR-0019 §Decision.4 pessimistic reservations).

import { describe, it, expect } from "vitest";
import { RestError } from "@azure/data-tables";
import {
  budgetRowKey,
  releaseReservation,
  reserveTokens,
  settleReservation,
  sweepExpiredReservations,
  type AgentBudgetRow,
  type ActiveReservation,
} from "../src/lib/agentBudget.js";

// --- In-memory TableClient mock --------------------------------------------

interface MockEntity {
  partitionKey: string;
  rowKey: string;
  [k: string]: unknown;
  etag?: string;
}

class MockTableClient {
  private rows = new Map<string, MockEntity>();
  private etagCounter = 0;
  // Optional collision injector — pop one entry per call to simulate 412.
  collisions: ("412" | "ok")[] = [];

  private key(pk: string, rk: string): string {
    return `${pk}|${rk}`;
  }

  async getEntity<T>(pk: string, rk: string): Promise<T> {
    const e = this.rows.get(this.key(pk, rk));
    if (!e) throw new RestError("not found", { statusCode: 404 });
    return { ...e } as unknown as T;
  }

  async createEntity(e: MockEntity): Promise<{ etag: string }> {
    const k = this.key(e.partitionKey, e.rowKey);
    if (this.rows.has(k)) throw new RestError("exists", { statusCode: 409 });
    const etag = `e${++this.etagCounter}`;
    this.rows.set(k, { ...e, etag });
    return { etag };
  }

  async updateEntity(
    e: MockEntity,
    _mode: "Replace" | "Merge",
    options?: { etag?: string },
  ): Promise<{ etag: string }> {
    if (this.collisions.length > 0) {
      const next = this.collisions.shift();
      if (next === "412") {
        throw new RestError("412", { statusCode: 412 });
      }
    }
    const k = this.key(e.partitionKey, e.rowKey);
    const existing = this.rows.get(k);
    if (!existing) throw new RestError("not found", { statusCode: 404 });
    if (options?.etag && existing.etag !== options.etag) {
      throw new RestError("412", { statusCode: 412 });
    }
    const etag = `e${++this.etagCounter}`;
    this.rows.set(k, { ...e, etag });
    return { etag };
  }

  async deleteEntity(_pk: string, _rk: string): Promise<void> {
    /* unused */
  }

  async *listEntities<T>(): AsyncIterable<T> {
    for (const v of this.rows.values()) yield { ...v } as unknown as T;
  }
}

const TENANT = "t1";
const AGENT = "brief";
const DATE = "2026-04-19";
const CEILINGS = {
  dailyTokenBudget: 10_000,
  dailyRunCeiling: 5,
  dailyManualRunCeiling: 3,
};

function tableMock(): MockTableClient {
  return new MockTableClient();
}

describe("reserveTokens — clean path", () => {
  it("reserves on a fresh row and returns ok", async () => {
    const t = tableMock();
    const r = await reserveTokens(
      t as unknown as never,
      TENANT,
      AGENT,
      DATE,
      "run-1",
      1000,
      "timer",
      CEILINGS,
    );
    expect(r.ok).toBe(true);
    const row = (await t.getEntity<{ TokensReservedTotal: number; ActiveReservations: string }>(
      TENANT,
      budgetRowKey(AGENT, DATE),
    ));
    expect(row.TokensReservedTotal).toBe(1000);
    const reservations = JSON.parse(row.ActiveReservations) as ActiveReservation[];
    expect(reservations).toHaveLength(1);
    expect(reservations[0]?.runId).toBe("run-1");
  });
});

describe("reserveTokens — ceiling rejections", () => {
  it("rejects with budget_exhausted when token total would exceed cap", async () => {
    const t = tableMock();
    const big = await reserveTokens(
      t as unknown as never,
      TENANT,
      AGENT,
      DATE,
      "run-1",
      9_000,
      "timer",
      CEILINGS,
    );
    expect(big.ok).toBe(true);
    const second = await reserveTokens(
      t as unknown as never,
      TENANT,
      AGENT,
      DATE,
      "run-2",
      2_000,
      "timer",
      CEILINGS,
    );
    expect(second).toEqual({ ok: false, reason: "budget_exhausted" });
  });

  it("rejects with run_ceiling at 5 in-flight + completed runs", async () => {
    const t = tableMock();
    for (let i = 0; i < 5; i++) {
      const r = await reserveTokens(
        t as unknown as never,
        TENANT,
        AGENT,
        DATE,
        `run-${i}`,
        100,
        "timer",
        CEILINGS,
      );
      expect(r.ok).toBe(true);
    }
    const sixth = await reserveTokens(
      t as unknown as never,
      TENANT,
      AGENT,
      DATE,
      "run-6",
      100,
      "timer",
      CEILINGS,
    );
    expect(sixth).toEqual({ ok: false, reason: "run_ceiling" });
  });

  it("rejects with manual_ceiling only for trigger=admin", async () => {
    const t = tableMock();
    for (let i = 0; i < 3; i++) {
      const r = await reserveTokens(
        t as unknown as never,
        TENANT,
        AGENT,
        DATE,
        `run-${i}`,
        100,
        "admin",
        CEILINGS,
      );
      expect(r.ok).toBe(true);
    }
    const fourthAdmin = await reserveTokens(
      t as unknown as never,
      TENANT,
      AGENT,
      DATE,
      "run-3",
      100,
      "admin",
      CEILINGS,
    );
    expect(fourthAdmin).toEqual({ ok: false, reason: "manual_ceiling" });
    // Timer trigger still allowed (counter is admin-only).
    const fourthTimer = await reserveTokens(
      t as unknown as never,
      TENANT,
      AGENT,
      DATE,
      "run-4",
      100,
      "timer",
      CEILINGS,
    );
    expect(fourthTimer.ok).toBe(true);
  });
});

describe("reserveTokens — ETag retry", () => {
  it("retries up to 3 times on 412 then succeeds", async () => {
    const t = tableMock();
    // Seed first row so ETag exists.
    await reserveTokens(
      t as unknown as never,
      TENANT,
      AGENT,
      DATE,
      "seed",
      100,
      "timer",
      CEILINGS,
    );
    t.collisions = ["412", "ok"]; // one 412, then succeed
    const r = await reserveTokens(
      t as unknown as never,
      TENANT,
      AGENT,
      DATE,
      "run-x",
      100,
      "timer",
      CEILINGS,
    );
    expect(r.ok).toBe(true);
  });
});

describe("sweepExpiredReservations", () => {
  it("removes reservations older than ttlMs and rolls back their tokens", () => {
    const now = new Date("2026-04-19T12:00:00.000Z");
    const stale: ActiveReservation = {
      runId: "old",
      reservedAt: new Date(now.getTime() - 600_000).toISOString(), // 10m ago
      reservedTokens: 500,
    };
    const fresh: ActiveReservation = {
      runId: "new",
      reservedAt: new Date(now.getTime() - 30_000).toISOString(), // 30s ago
      reservedTokens: 200,
    };
    const row: AgentBudgetRow = {
      tenantId: TENANT,
      rowKey: budgetRowKey(AGENT, DATE),
      tokensReservedTotal: 700,
      tokensActualTotal: 0,
      runsSucceeded: 0,
      runsFailed: 0,
      manualRunsToday: 0,
      activeReservations: [stale, fresh],
      etag: "e1",
    };
    const swept = sweepExpiredReservations(row, now, 300_000);
    expect(swept.activeReservations).toHaveLength(1);
    expect(swept.activeReservations[0]?.runId).toBe("new");
    expect(swept.tokensReservedTotal).toBe(200);
  });

  it("returns the row unchanged when nothing is stale", () => {
    const now = new Date("2026-04-19T12:00:00.000Z");
    const fresh: ActiveReservation = {
      runId: "new",
      reservedAt: new Date(now.getTime() - 30_000).toISOString(),
      reservedTokens: 200,
    };
    const row: AgentBudgetRow = {
      tenantId: TENANT,
      rowKey: budgetRowKey(AGENT, DATE),
      tokensReservedTotal: 200,
      tokensActualTotal: 0,
      runsSucceeded: 0,
      runsFailed: 0,
      manualRunsToday: 0,
      activeReservations: [fresh],
      etag: "e1",
    };
    const swept = sweepExpiredReservations(row, now, 300_000);
    expect(swept).toBe(row); // identity, no allocation
  });
});

describe("settleReservation", () => {
  it("removes the reservation and increments runsSucceeded", async () => {
    const t = tableMock();
    await reserveTokens(
      t as unknown as never,
      TENANT,
      AGENT,
      DATE,
      "run-1",
      1000,
      "timer",
      CEILINGS,
    );
    await settleReservation(
      t as unknown as never,
      TENANT,
      AGENT,
      DATE,
      "run-1",
      850,
      "success",
    );
    const row = await t.getEntity<{
      RunsSucceeded: number;
      TokensActualTotal: number;
      ActiveReservations: string;
    }>(TENANT, budgetRowKey(AGENT, DATE));
    expect(row.RunsSucceeded).toBe(1);
    expect(row.TokensActualTotal).toBe(850);
    expect(JSON.parse(row.ActiveReservations)).toHaveLength(0);
  });

  // SEC-BUG-BUDGET-SETTLE-RELEASE — regression test pinning the fix.
  it("releases the held reservation against tokensReservedTotal on success", async () => {
    const t = tableMock();
    await reserveTokens(
      t as unknown as never,
      TENANT,
      AGENT,
      DATE,
      "run-1",
      9_000,
      "timer",
      CEILINGS,
    );
    await settleReservation(
      t as unknown as never,
      TENANT,
      AGENT,
      DATE,
      "run-1",
      1_000,
      "success",
    );
    const row = await t.getEntity<{
      TokensReservedTotal: number;
      TokensActualTotal: number;
    }>(TENANT, budgetRowKey(AGENT, DATE));
    // Reserved 9_000 -> settled -> reservation released entirely.
    expect(row.TokensReservedTotal).toBe(0);
    // Actual usage recorded separately.
    expect(row.TokensActualTotal).toBe(1_000);
  });

  it("releases the held reservation on failure too (failure-path symmetry)", async () => {
    const t = tableMock();
    await reserveTokens(
      t as unknown as never,
      TENANT,
      AGENT,
      DATE,
      "run-1",
      5_000,
      "timer",
      CEILINGS,
    );
    await settleReservation(
      t as unknown as never,
      TENANT,
      AGENT,
      DATE,
      "run-1",
      600,
      "failure",
    );
    const row = await t.getEntity<{
      TokensReservedTotal: number;
      TokensActualTotal: number;
      RunsFailed: number;
    }>(TENANT, budgetRowKey(AGENT, DATE));
    expect(row.TokensReservedTotal).toBe(0);
    expect(row.TokensActualTotal).toBe(600);
    expect(row.RunsFailed).toBe(1);
  });

  it("is a no-op against tokensReservedTotal when the reservation has already been swept", async () => {
    // Simulates the rare race where the periodic sweep removed an
    // active reservation entry between reserve and settle. Settle should
    // still record actuals + outcome counters but not double-subtract
    // from tokensReservedTotal.
    const t = tableMock();
    await reserveTokens(
      t as unknown as never,
      TENANT,
      AGENT,
      DATE,
      "run-1",
      2_000,
      "timer",
      CEILINGS,
    );
    // Manually drain activeReservations to simulate a sweep race.
    const swept = await t.getEntity<{
      ActiveReservations: string;
      TokensReservedTotal: number;
    }>(TENANT, budgetRowKey(AGENT, DATE));
    swept.ActiveReservations = "[]";
    swept.TokensReservedTotal = 0;
    await t.updateEntity(swept, "Replace");
    // Settle now sees an empty list — must not throw and must not
    // produce a negative TokensReservedTotal.
    await settleReservation(
      t as unknown as never,
      TENANT,
      AGENT,
      DATE,
      "run-1",
      500,
      "success",
    );
    const row = await t.getEntity<{
      TokensReservedTotal: number;
      TokensActualTotal: number;
    }>(TENANT, budgetRowKey(AGENT, DATE));
    expect(row.TokensReservedTotal).toBe(0); // clamped to 0
    expect(row.TokensActualTotal).toBe(500);
  });
});

// SEC-BUG-BUDGET-SETTLE-RELEASE — cap-check formula tests.
// Pre-fix: cap was `reservedTotal + new > cap`, which meant settled
// reservations stayed booked forever and the cap tightened with every
// run. Post-fix: cap is `actualTotal + reservedTotal + new > cap`, so
// released reservations free capacity while actual usage still counts
// toward the daily limit.
describe("reserveTokens — cap formula (post-settle release)", () => {
  it("allows a new reservation after a settled one frees capacity", async () => {
    const t = tableMock();
    // Cap is 10_000; first run reserves 9_000.
    const first = await reserveTokens(
      t as unknown as never,
      TENANT,
      AGENT,
      DATE,
      "run-1",
      9_000,
      "timer",
      CEILINGS,
    );
    expect(first.ok).toBe(true);

    // Settle with low actual — releases the 9K hold.
    await settleReservation(
      t as unknown as never,
      TENANT,
      AGENT,
      DATE,
      "run-1",
      1_000,
      "success",
    );

    // Second run should succeed: actualTotal(1K) + reservedTotal(0) +
    // new(8K) = 9K <= 10K cap. Pre-fix this failed because
    // reservedTotal still showed 9K from run-1.
    const second = await reserveTokens(
      t as unknown as never,
      TENANT,
      AGENT,
      DATE,
      "run-2",
      8_000,
      "timer",
      CEILINGS,
    );
    expect(second.ok).toBe(true);
  });

  it("still rejects when cumulative actual + new would exceed cap", async () => {
    const t = tableMock();
    // Pre-load the row with a heavy actualTotal close to the cap.
    await reserveTokens(
      t as unknown as never,
      TENANT,
      AGENT,
      DATE,
      "run-pre",
      9_000,
      "timer",
      CEILINGS,
    );
    await settleReservation(
      t as unknown as never,
      TENANT,
      AGENT,
      DATE,
      "run-pre",
      9_000,
      "success",
    );
    // actualTotal now 9_000, reservedTotal 0. Cap 10_000.
    // A new 2_000 reservation would push 9K + 0 + 2K = 11K > 10K.
    const tooBig = await reserveTokens(
      t as unknown as never,
      TENANT,
      AGENT,
      DATE,
      "run-too-big",
      2_000,
      "timer",
      CEILINGS,
    );
    expect(tooBig).toEqual({ ok: false, reason: "budget_exhausted" });

    // ... but a 1_000 reservation fits exactly at the cap boundary
    // (`<= cap` passes).
    const fits = await reserveTokens(
      t as unknown as never,
      TENANT,
      AGENT,
      DATE,
      "run-fits",
      1_000,
      "timer",
      CEILINGS,
    );
    expect(fits.ok).toBe(true);
  });
});

describe("releaseReservation", () => {
  it("removes the reservation WITHOUT incrementing counters", async () => {
    const t = tableMock();
    await reserveTokens(
      t as unknown as never,
      TENANT,
      AGENT,
      DATE,
      "run-1",
      1000,
      "timer",
      CEILINGS,
    );
    await releaseReservation(
      t as unknown as never,
      TENANT,
      AGENT,
      DATE,
      "run-1",
    );
    const row = await t.getEntity<{
      RunsSucceeded: number;
      RunsFailed: number;
      TokensActualTotal: number;
      TokensReservedTotal: number;
      ActiveReservations: string;
    }>(TENANT, budgetRowKey(AGENT, DATE));
    expect(row.RunsSucceeded).toBe(0);
    expect(row.RunsFailed).toBe(0);
    expect(row.TokensActualTotal).toBe(0);
    expect(row.TokensReservedTotal).toBe(0); // rolled back
    expect(JSON.parse(row.ActiveReservations)).toHaveLength(0);
  });
});
