// Agent-budget section (ADR-0025 §9 + ADR-0027 §Decision.4) — Aegis UI
// Phase 4 redesign. One `setrow` per agent: label/hint on the left, the
// HTML5 `range` slider pair + meter + spend-line on the right.
// Flat-additive schema (ADR-0027).

import { useEffect, useMemo, useState } from "react";
import { MessageBar, MessageBarBody } from "@fluentui/react-components";
import { ApiError } from "@/api/client";
import { useUpdateAgentBudget } from "../queries";
import {
  AGENT_BUDGET_BOUNDS,
  type AgentBudgetRecord,
  type AgentSpendBucket,
  type TenantSettings,
} from "../types";

interface Draft {
  briefManualRunCeiling: number;
  briefDailyTokenBudget: number;
  postureManualRunCeiling: number;
  postureWeeklyTokenBudget: number;
  incidentsAnalysisManualRunCeiling: number;
  incidentsAnalysisDailyTokenBudget: number;
}

const FIELDS = [
  "briefManualRunCeiling",
  "briefDailyTokenBudget",
  "postureManualRunCeiling",
  "postureWeeklyTokenBudget",
  "incidentsAnalysisManualRunCeiling",
  "incidentsAnalysisDailyTokenBudget",
] as const;

/** Clamp `v` to `[min, max]`. Used by the incidents-pair coupling logic
 *  to keep the auto-synced sibling slider inside its declared bounds. */
function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}

export function AgentBudgetSection({ settings }: { settings: TenantSettings }) {
  const update = useUpdateAgentBudget();
  const spend = settings.agentSpendCurrent;
  const server: AgentBudgetRecord = useMemo(
    () =>
      settings.agentBudget ?? {
        briefManualRunCeiling: AGENT_BUDGET_BOUNDS.briefManualRunCeiling.min,
        briefDailyTokenBudget: AGENT_BUDGET_BOUNDS.briefDailyTokenBudget.min,
        postureManualRunCeiling: AGENT_BUDGET_BOUNDS.postureManualRunCeiling.min,
        postureWeeklyTokenBudget: AGENT_BUDGET_BOUNDS.postureWeeklyTokenBudget.min,
        incidentsAnalysisManualRunCeiling:
          AGENT_BUDGET_BOUNDS.incidentsAnalysisManualRunCeiling.min,
        incidentsAnalysisDailyTokenBudget:
          AGENT_BUDGET_BOUNDS.incidentsAnalysisDailyTokenBudget.min,
        updatedAt: null,
        updatedBy: null,
        source: "default",
      },
    [settings.agentBudget],
  );

  const initialDraft = (): Draft => ({
    briefManualRunCeiling: server.briefManualRunCeiling,
    briefDailyTokenBudget: server.briefDailyTokenBudget,
    postureManualRunCeiling: server.postureManualRunCeiling,
    postureWeeklyTokenBudget: server.postureWeeklyTokenBudget,
    incidentsAnalysisManualRunCeiling: server.incidentsAnalysisManualRunCeiling,
    incidentsAnalysisDailyTokenBudget: server.incidentsAnalysisDailyTokenBudget,
  });
  const [draft, setDraft] = useState<Draft>(initialDraft);

  useEffect(() => {
    setDraft(initialDraft());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    server.briefManualRunCeiling,
    server.briefDailyTokenBudget,
    server.postureManualRunCeiling,
    server.postureWeeklyTokenBudget,
    server.incidentsAnalysisManualRunCeiling,
    server.incidentsAnalysisDailyTokenBudget,
  ]);

  const dirty = FIELDS.some((key) => draft[key] !== server[key]);

  const diff = useMemo(() => {
    const out: Partial<Draft> = {};
    for (const key of FIELDS) {
      if (draft[key] !== server[key]) out[key] = draft[key];
    }
    return out;
  }, [draft, server]);

  return (
    <section className="admin-section">
      <div className="admin-section__head">
        <div>
          <p className="t-eyebrow">Section 2 of 4</p>
          <h2 className="t-h2" style={{ marginTop: 4 }}>
            Agent budget
          </h2>
          <p className="t-body t-body--mute" style={{ marginTop: 6, maxWidth: 580 }}>
            Per-agent spend ceilings. Each agent has a manual-run ceiling and a token budget over
            its cadence window. Changes apply to the next run.
          </p>
        </div>
        <div className="row" style={{ gap: 8 }}>
          <button
            type="button"
            className="btn btn--subtle btn--small"
            disabled={!dirty || update.isPending}
            onClick={() => setDraft(initialDraft())}
          >
            Discard
          </button>
          <button
            type="button"
            className="btn btn--primary btn--small"
            disabled={!dirty || update.isPending}
            onClick={() => update.mutate(diff)}
          >
            {update.isPending ? "Saving…" : "Save"}
          </button>
        </div>
      </div>

      <div>
        <BudgetPair
          name="Daily Brief"
          hint="Manual ceiling + daily token budget. Hard cap before circuit breaker opens."
          manualValue={draft.briefManualRunCeiling}
          manualBounds={AGENT_BUDGET_BOUNDS.briefManualRunCeiling}
          onManualChange={(v) => setDraft((p) => ({ ...p, briefManualRunCeiling: v }))}
          tokenValue={draft.briefDailyTokenBudget}
          tokenBounds={AGENT_BUDGET_BOUNDS.briefDailyTokenBudget}
          onTokenChange={(v) => setDraft((p) => ({ ...p, briefDailyTokenBudget: v }))}
          {...(spend?.brief ? { spend: spend.brief } : {})}
          ceilings={{
            manualRun: draft.briefManualRunCeiling,
            tokens: draft.briefDailyTokenBudget,
          }}
          disabled={update.isPending}
        />
        <BudgetPair
          name="Weekly Posture"
          hint="Manual ceiling + weekly token budget. Posture runs once per ISO week."
          manualValue={draft.postureManualRunCeiling}
          manualBounds={AGENT_BUDGET_BOUNDS.postureManualRunCeiling}
          onManualChange={(v) => setDraft((p) => ({ ...p, postureManualRunCeiling: v }))}
          tokenValue={draft.postureWeeklyTokenBudget}
          tokenBounds={AGENT_BUDGET_BOUNDS.postureWeeklyTokenBudget}
          onTokenChange={(v) => setDraft((p) => ({ ...p, postureWeeklyTokenBudget: v }))}
          {...(spend?.posture ? { spend: spend.posture } : {})}
          ceilings={{
            manualRun: draft.postureManualRunCeiling,
            tokens: draft.postureWeeklyTokenBudget,
          }}
          disabled={update.isPending}
        />
        <BudgetPair
          name="Incidents analysis"
          hint="On-demand only. Each run reserves ~3,000 tokens (~¼¢ at current gpt-4.1-mini rates); settled runs free the hold so realised actual usage is what counts. The sliders are coupled in run-units — moving either re-syncs the other. Save isn't gated on agreement; operators who want a manual ceiling smaller than the token budget can save with the warning visible."
          manualValue={draft.incidentsAnalysisManualRunCeiling}
          manualBounds={AGENT_BUDGET_BOUNDS.incidentsAnalysisManualRunCeiling}
          // Bidirectional coupling — moving the manual slider re-syncs
          // the token budget to manualRun × reservation (clamped to the
          // token bounds). When the operator wants explicit disagreement
          // (e.g. token cap at the bound max with a smaller manual
          // ceiling), they can move the token slider afterwards; the
          // warning fires but save still works.
          onManualChange={(v) =>
            setDraft((p) => ({
              ...p,
              incidentsAnalysisManualRunCeiling: v,
              incidentsAnalysisDailyTokenBudget: clamp(
                v * 3_000,
                AGENT_BUDGET_BOUNDS.incidentsAnalysisDailyTokenBudget.min,
                AGENT_BUDGET_BOUNDS.incidentsAnalysisDailyTokenBudget.max,
              ),
            }))
          }
          tokenValue={draft.incidentsAnalysisDailyTokenBudget}
          tokenBounds={AGENT_BUDGET_BOUNDS.incidentsAnalysisDailyTokenBudget}
          onTokenChange={(v) =>
            setDraft((p) => ({
              ...p,
              incidentsAnalysisDailyTokenBudget: v,
              incidentsAnalysisManualRunCeiling: clamp(
                Math.floor(v / 3_000),
                AGENT_BUDGET_BOUNDS.incidentsAnalysisManualRunCeiling.min,
                AGENT_BUDGET_BOUNDS.incidentsAnalysisManualRunCeiling.max,
              ),
            }))
          }
          perRunReservation={3_000}
          {...(spend?.incidents ? { spend: spend.incidents } : {})}
          ceilings={{
            manualRun: draft.incidentsAnalysisManualRunCeiling,
            tokens: draft.incidentsAnalysisDailyTokenBudget,
          }}
          disabled={update.isPending}
        />
      </div>

      {server.updatedAt && (
        <p className="t-caption">
          Last updated {new Date(server.updatedAt).toLocaleString()}
          {server.updatedBy ? ` by ${server.updatedBy}` : ""}
          {server.source === "default" && " (using defaults)"}
        </p>
      )}

      {update.isSuccess && (
        <MessageBar intent="success">
          <MessageBarBody>Agent budget saved.</MessageBarBody>
        </MessageBar>
      )}
      {update.isError && (
        <MessageBar intent="error" role="alert">
          <MessageBarBody>
            Save failed.{" "}
            {update.error instanceof ApiError
              ? `(${update.error.status}) ${update.error.message}`
              : (update.error as Error).message}
          </MessageBarBody>
        </MessageBar>
      )}
    </section>
  );
}

interface BudgetPairProps {
  readonly name: string;
  readonly hint: string;
  readonly manualValue: number;
  readonly manualBounds: { readonly min: number; readonly max: number; readonly step: number };
  readonly onManualChange: (v: number) => void;
  readonly tokenValue: number;
  readonly tokenBounds: { readonly min: number; readonly max: number; readonly step: number };
  readonly onTokenChange: (v: number) => void;
  /** Tokens reserved per run (`estimateReservedTokens` in the matching
   *  api/src/lib/run*Agent.ts). When set, the token slider readout shows
   *  the supported run count alongside the raw token figure, and a small
   *  warning surfaces when the token budget would cap below the manual
   *  ceiling. Opt-in per agent — passing this only makes sense when the
   *  slider step is aligned to the reservation amount. */
  readonly perRunReservation?: number;
  readonly spend?: AgentSpendBucket;
  readonly ceilings?: { readonly manualRun: number; readonly tokens: number };
  readonly disabled: boolean;
}

function BudgetPair(props: BudgetPairProps) {
  const cadenceLabel = props.spend?.bucketCadence === "weekly" ? "This week" : "Today";
  const tokensSpent = props.spend?.tokensActualTotal ?? 0;
  const ceilingTokens = props.ceilings?.tokens ?? 0;
  const tokenPct =
    ceilingTokens > 0 ? Math.min(100, Math.round((tokensSpent / ceilingTokens) * 100)) : 0;
  const meterCls =
    tokenPct > 80
      ? "meter__fill meter__fill--danger"
      : tokenPct > 50
        ? "meter__fill meter__fill--warn"
        : "meter__fill";

  return (
    <div className="setrow">
      <div className="setrow__label">
        <span className="setrow__label-name">{props.name}</span>
        <span className="setrow__label-hint">{props.hint}</span>
      </div>
      <div className="setrow__control">
        <div className="range-row">
          <input
            type="range"
            className="range"
            min={props.manualBounds.min}
            max={props.manualBounds.max}
            step={props.manualBounds.step}
            value={props.manualValue}
            disabled={props.disabled}
            onChange={(e) => props.onManualChange(Number(e.target.value))}
            aria-label={`${props.name} manual-run ceiling`}
          />
          <span className="range-readout">{props.manualValue} runs/d</span>
        </div>
        <div className="range-row">
          <input
            type="range"
            className="range"
            min={props.tokenBounds.min}
            max={props.tokenBounds.max}
            step={props.tokenBounds.step}
            value={props.tokenValue}
            disabled={props.disabled}
            onChange={(e) => props.onTokenChange(Number(e.target.value))}
            aria-label={`${props.name} token budget`}
          />
          <span className="range-readout">
            {props.perRunReservation
              ? `${Math.floor(props.tokenValue / props.perRunReservation)} runs · ${props.tokenValue.toLocaleString()} tk`
              : `${props.tokenValue.toLocaleString()} tk`}
          </span>
        </div>
        {props.perRunReservation &&
          props.ceilings &&
          Math.floor(props.tokenValue / props.perRunReservation) < props.ceilings.manualRun && (
            <p
              className="t-caption"
              style={{ color: "var(--orange-fg, #b45309)", marginTop: "var(--sp-xs)" }}
              role="status"
            >
              ⚠ Token budget caps at {Math.floor(props.tokenValue / props.perRunReservation)}{" "}
              runs/day — below your {props.ceilings.manualRun}-run manual ceiling. Drag the token
              slider right until the run-count matches.
            </p>
          )}
        {props.spend && !props.spend.empty && (
          <>
            <div className="meter">
              <div className={meterCls} style={{ width: `${tokenPct}%` }} />
            </div>
            <SpendLine
              spend={props.spend}
              cadenceLabel={cadenceLabel}
              tokenPct={tokenPct}
              {...(props.ceilings ? { ceilings: props.ceilings } : {})}
            />
          </>
        )}
        {props.spend && props.spend.empty && (
          <p className="t-caption" style={{ fontStyle: "italic" }}>
            {cadenceLabel}: no runs yet for this bucket ({props.spend.bucketKey}).
          </p>
        )}
      </div>
    </div>
  );
}

function SpendLine({
  spend,
  cadenceLabel,
  tokenPct,
  ceilings,
}: {
  spend: AgentSpendBucket;
  cadenceLabel: string;
  tokenPct: number;
  ceilings?: { readonly manualRun: number; readonly tokens: number };
}) {
  const totalRuns = spend.runsSucceeded + spend.runsFailed;
  const manualPct =
    ceilings && ceilings.manualRun > 0
      ? Math.min(100, Math.round((spend.manualRunsToday / ceilings.manualRun) * 100))
      : null;
  return (
    <div className="spend-line">
      <span className="spend-line__metric">
        <strong>{cadenceLabel}:</strong> {spend.tokensActualTotal.toLocaleString()} tk ({tokenPct}%
        of ceiling)
      </span>
      <span className="spend-line__metric">
        <strong>{totalRuns}</strong> run{totalRuns === 1 ? "" : "s"} ({spend.runsSucceeded} ok
        {spend.runsFailed > 0 ? `, ${spend.runsFailed} failed` : ""})
      </span>
      <span className="spend-line__metric">
        <strong>{spend.manualRunsToday}</strong> manual today
        {manualPct !== null ? ` (${manualPct}% of ceiling)` : ""}
      </span>
    </div>
  );
}
