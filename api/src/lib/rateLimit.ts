// In-process sliding-window rate limiter (ADR-0012 §1.2).
//
// Per-principal 60 req/min on `/api/secure-score/trend`. Flex Consumption
// scales horizontally so the effective limit is `60 * instanceCount`; at
// single-user-tenant scale this is fine. A centralised rate-limit ADR lands
// if the deployment pattern ever multi-tenants.
//
// The limiter is intentionally minimal: one Map keyed by principal, each
// value a bounded ring of request timestamps. O(1) amortised.

export interface RateLimitResult {
  readonly allowed: boolean;
  readonly remaining: number;
  readonly retryAfterMs: number;
  readonly resetAtMs: number;
}

export class SlidingWindowRateLimiter {
  private readonly windows = new Map<string, number[]>();
  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
  ) {}

  check(key: string, nowMs: number = Date.now()): RateLimitResult {
    const bucket = this.windows.get(key) ?? [];
    const cutoff = nowMs - this.windowMs;
    // Prune old timestamps in-place.
    while (bucket.length > 0 && (bucket[0] as number) <= cutoff) {
      bucket.shift();
    }
    if (bucket.length >= this.limit) {
      const oldest = bucket[0] as number;
      const retryAfterMs = Math.max(0, oldest + this.windowMs - nowMs);
      this.windows.set(key, bucket);
      return {
        allowed: false,
        remaining: 0,
        retryAfterMs,
        resetAtMs: oldest + this.windowMs,
      };
    }
    bucket.push(nowMs);
    this.windows.set(key, bucket);
    return {
      allowed: true,
      remaining: Math.max(0, this.limit - bucket.length),
      retryAfterMs: 0,
      resetAtMs: nowMs + this.windowMs,
    };
  }
}

// Shared per-Function-App-instance limiter for the trend endpoint.
export const trendRateLimiter = new SlidingWindowRateLimiter(60, 60_000);

// ADR-0016 §3 — Incidents endpoints. Each endpoint has its own instance so
// busy list-paging does not starve the summary tile's refresh budget.
export const incidentsSummaryRateLimiter = new SlidingWindowRateLimiter(120, 60_000);
export const incidentsListRateLimiter = new SlidingWindowRateLimiter(60, 60_000);
export const incidentsDetailRateLimiter = new SlidingWindowRateLimiter(60, 60_000);

// ADR-0024 §3 — EntraRisk endpoints.
export const riskyUsersSummaryRateLimiter = new SlidingWindowRateLimiter(120, 60_000);
export const riskyUsersListRateLimiter = new SlidingWindowRateLimiter(60, 60_000);

// Admin-run ceilings (30/day per tenant). Keyed by tenantId, not principal,
// so multiple admins share the budget. Parity across all admin-run endpoints
// — the UI Refresh-now button hits the same budget regardless of vertical,
// so a misbehaving client can't burn Graph quota faster on one surface than
// another.
const ADMIN_RUN_DAILY_LIMIT = 30;
const ADMIN_RUN_WINDOW_MS = 24 * 60 * 60_000;
export const entraRiskAdminRunRateLimiter = new SlidingWindowRateLimiter(
  ADMIN_RUN_DAILY_LIMIT,
  ADMIN_RUN_WINDOW_MS,
);
export const secureScoreAdminRunRateLimiter = new SlidingWindowRateLimiter(
  ADMIN_RUN_DAILY_LIMIT,
  ADMIN_RUN_WINDOW_MS,
);
export const incidentsAdminRunRateLimiter = new SlidingWindowRateLimiter(
  ADMIN_RUN_DAILY_LIMIT,
  ADMIN_RUN_WINDOW_MS,
);
// ADR-0032 — KEV admin manual-run sharing the same per-tenant 30/day limit.
export const kevAdminRunRateLimiter = new SlidingWindowRateLimiter(
  ADMIN_RUN_DAILY_LIMIT,
  ADMIN_RUN_WINDOW_MS,
);
// ADR-0037 — ransomware.live PRO threat-intel admin manual-run sharing
// the same per-tenant 30/day limit so cross-vertical admin abuse is
// uniformly bounded.
export const ransomwareIntelAdminRunRateLimiter = new SlidingWindowRateLimiter(
  ADMIN_RUN_DAILY_LIMIT,
  ADMIN_RUN_WINDOW_MS,
);
// ADR-0037 Option B — dedicated 5/day cap on API-key rotation. Separate
// from `ADMIN_RUN_DAILY_LIMIT` because rotation is an order of magnitude
// rarer than admin ingest-runs (most operators rotate on quarterly or
// incident schedules) and a stricter ceiling caps the blast radius of a
// compromised admin session DoS-ing the ingest path via repeated
// invalid-key writes. Per-tenant key parity with the other admin
// limiters.
export const ransomwareIntelKeyRotateRateLimiter = new SlidingWindowRateLimiter(
  5,
  ADMIN_RUN_WINDOW_MS,
);
// ADR-0037 Layer 4 — reader handlers. Summary feeds the dashboard tile
// (refresh-on-focus → 120/min/principal matches incidentsSummary). List
// feeds the drilldown (lower volume → 60/min/principal matches incidentsList).
export const ransomwareIntelSummaryRateLimiter = new SlidingWindowRateLimiter(120, 60_000);
export const ransomwareIntelListRateLimiter = new SlidingWindowRateLimiter(60, 60_000);
// ADR-0030 Phase C §C.5 — dedicated 10/day cap for the email send endpoint.
// Intentionally separate from `ADMIN_RUN_DAILY_LIMIT` so a misbehaving SPA
// hammering Refresh-now on other verticals cannot starve outbound-email
// budget, and a misbehaving email-send loop cannot starve Graph quota for
// ingest verticals. Per-tenant key parity with the other admin-run limiters.
const REPORT_EMAIL_SEND_DAILY_LIMIT = 10;
export const reportEmailSendRateLimiter = new SlidingWindowRateLimiter(
  REPORT_EMAIL_SEND_DAILY_LIMIT,
  ADMIN_RUN_WINDOW_MS,
);

// ADR-0030 Phase C §C.10 — per-admin DELETE rate-limit on
// `/api/reports/email/sends/{graphMessageId}`. Each DELETE writes a
// `report.email.historyRowDeleted` aievent + a Table delete; a scripted
// loop could otherwise flood the audit/telemetry surface even if the
// row itself is idempotently absent. Keyed by **principal** (not tenant)
// so a single misbehaving admin can't burn the per-tenant erasure budget
// for the rest of the admin pool; the SWA role gate still bounds who can
// reach the endpoint. 30/day per admin matches the ADMIN_RUN ceiling.
// WS10 Phase C carry-forward Low — Slice 1(c)/B3.
export const reportEmailDeleteRateLimiter = new SlidingWindowRateLimiter(
  ADMIN_RUN_DAILY_LIMIT,
  ADMIN_RUN_WINDOW_MS,
);

// ADR-0030 Phase C §C.5 — dedicated sub-budget for the auto-capture-on-miss
// path inside the email send endpoint. The parent send limiter (above) caps
// Graph quota burn at 10/day; this sub-budget bounds the audit-chain +
// envelope-blob writes that an auto-capture triggers when the requested
// periodKey doesn't have a snapshot yet. Without this, a scripted "send 10
// fresh periodKeys" loop would generate 10 captures, hammering the audit
// chain and blob store. 5/day per tenant — enough for legitimate "send the
// previous period" workflows that fall through to capture, but caps the
// blast radius of a misbehaving caller. Per-tenant keying mirrors the
// other admin-run limiters (incl. send). WS10 Slice 1(c)/B2 LOW #1.
const REPORT_EMAIL_AUTO_CAPTURE_DAILY_LIMIT = 5;
export const reportEmailAutoCaptureRateLimiter = new SlidingWindowRateLimiter(
  REPORT_EMAIL_AUTO_CAPTURE_DAILY_LIMIT,
  ADMIN_RUN_WINDOW_MS,
);
// ADR-0034 §1 — User dormancy admin manual-run, same per-tenant
// 30/day shared budget as the rest.
export const userDormancyAdminRunRateLimiter = new SlidingWindowRateLimiter(
  ADMIN_RUN_DAILY_LIMIT,
  ADMIN_RUN_WINDOW_MS,
);
// ADR-0034 §1 — read-side limiters mirror the riskyUsers shape.
export const userDormancySummaryRateLimiter = new SlidingWindowRateLimiter(120, 60_000);
export const userDormancyListRateLimiter = new SlidingWindowRateLimiter(60, 60_000);
// ADR-0034 §1 — sign-ins admin-run + read limiters mirror Phase 8B.
export const signInsAdminRunRateLimiter = new SlidingWindowRateLimiter(
  ADMIN_RUN_DAILY_LIMIT,
  ADMIN_RUN_WINDOW_MS,
);
export const signInsSummaryRateLimiter = new SlidingWindowRateLimiter(120, 60_000);
export const signInsListRateLimiter = new SlidingWindowRateLimiter(60, 60_000);
// ADR-0034 §7 — `/api/identities/service-principals` is a
// per-principal read with a 5-minute server cache; tightening the limiter
// guards against accidental tab-spam in the SPA without starving the
// legitimate "Load more" pagination flow.
export const identitiesServicePrincipalsRateLimiter = new SlidingWindowRateLimiter(60, 60_000);
// ADR-0034 §3.3 — CA policy admin manual-run + read limiters
// mirror the userDormancy / signIns shape.
export const conditionalAccessAdminRunRateLimiter = new SlidingWindowRateLimiter(
  ADMIN_RUN_DAILY_LIMIT,
  ADMIN_RUN_WINDOW_MS,
);
export const conditionalAccessSummaryRateLimiter = new SlidingWindowRateLimiter(120, 60_000);
export const conditionalAccessListRateLimiter = new SlidingWindowRateLimiter(60, 60_000);
// ADR-0036 — Defender for Cloud Secure Score admin manual-run + read
// limiters mirror the userDormancy / signIns / conditionalAccess shape.
export const azureSecureScoreAdminRunRateLimiter = new SlidingWindowRateLimiter(
  ADMIN_RUN_DAILY_LIMIT,
  ADMIN_RUN_WINDOW_MS,
);
export const azureSecureScoreSummaryRateLimiter = new SlidingWindowRateLimiter(120, 60_000);
export const ADMIN_RUN_DAILY_CEILING = ADMIN_RUN_DAILY_LIMIT;
