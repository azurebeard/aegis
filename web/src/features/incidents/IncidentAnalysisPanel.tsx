// Incidents-agent analysis panel (ADR-0028) — Aegis UI Phase 3 redesign.
//
// Visual surface: design-system `ai-panel` (tinted bg + brand left rule)
// with `narrative__section` blocks for the three sections (Attack
// narrative / Impact assessment / Suggested next steps — last one in
// `narrative__section--danger` variant). Uses the shared SafeMarkdown
// renderer — no dangerouslySetInnerHTML path.

import { useMemo } from "react";
import {
  Body1,
  Button,
  MessageBar,
  MessageBarBody,
  Skeleton,
  SkeletonItem,
} from "@fluentui/react-components";
import { ApiError } from "@/api/client";
import { useCurrentUser } from "@/auth/useCurrentUser";
import { Icon } from "@/components/Icon";
import { SafeMarkdown } from "@/features/brief/SafeMarkdown";
import { useAnalyseIncident, useClearRedactionLock, useIncidentAnalysis } from "./analysisQueries";
import type { IncidentAnalysisResponse } from "./analysisTypes";

interface Props {
  readonly incidentId: string | null;
  readonly incidentLastUpdateDateTime?: string;
}

export function IncidentAnalysisPanel({ incidentId, incidentLastUpdateDateTime }: Props) {
  const user = useCurrentUser();
  const isAdmin = user.hasRole("admin");
  const query = useIncidentAnalysis(incidentId);
  const analyse = useAnalyseIncident();
  const clearLock = useClearRedactionLock();

  const data = query.data;
  const lockActive = data?.redactionLock?.active === true;
  const lockUntil = data?.redactionLock?.until ?? null;
  // React Query v5 flips `analyse.isPending` to false the moment the POST
  // resolves — *before* the `onSuccess` callback runs `invalidateQueries()`.
  // In that ~100–500ms window the GET query is mid-refetch but still serving
  // the stale `awaiting_first_run` body, so the panel briefly falls back to
  // the "No analysis yet" + button state and the just-committed analysis
  // is never shown unless the operator manually reloads. Treat "mutation
  // succeeded and the query is now refetching" as still-in-flight so the
  // "Analysing…" UI bridges the gap until the new envelope lands.
  const isAnalysing = analyse.isPending || (analyse.isSuccess && query.isFetching);
  const analysisOutOfDate = useMemo(() => {
    if (!data || !data.analysedIncidentLastUpdateDateTime) return false;
    if (!incidentLastUpdateDateTime) return false;
    return data.analysedIncidentLastUpdateDateTime !== incidentLastUpdateDateTime;
  }, [data, incidentLastUpdateDateTime]);

  if (incidentId === null) return null;

  return (
    <div className="ai-panel">
      <div className="ai-panel__head">
        <span className="ai-mark">AI</span>
        <h3 className="t-h3" style={{ flex: 1 }}>
          AI analysis
        </h3>
        {data?.severity === "urgent" && <span className="badge badge--danger">Urgent</span>}
        {data?.severity === "notable" && <span className="badge badge--warning">Notable</span>}
        {lockActive && <span className="badge badge--danger">Redaction lock</span>}
        {analysisOutOfDate && !lockActive && <span className="badge badge--warning">Stale</span>}
      </div>

      <div className="ai-panel__body">
        {query.isPending && (
          <Skeleton>
            <SkeletonItem size={20} />
            <SkeletonItem size={16} style={{ marginTop: "var(--sp-s)" }} />
            <SkeletonItem size={40} style={{ marginTop: "var(--sp-s)" }} />
          </Skeleton>
        )}

        {query.isError && (
          <Body1 style={{ color: "var(--red-fg)" }}>
            Could not load analysis.{" "}
            {query.error instanceof ApiError
              ? `(${query.error.status}) ${query.error.message}`
              : (query.error as Error).message}
          </Body1>
        )}

        {query.isSuccess && data?.health?.status === "awaiting_first_run" && isAnalysing && (
          <>
            <p className="t-body" role="status" aria-live="polite">
              Analysing this incident… typically takes 10–30 seconds. The view will refresh
              automatically when the AI summary is ready — no need to reload.
            </p>
            <Skeleton>
              <SkeletonItem size={20} />
              <SkeletonItem size={16} style={{ marginTop: "var(--sp-s)" }} />
              <SkeletonItem size={40} style={{ marginTop: "var(--sp-s)" }} />
            </Skeleton>
          </>
        )}

        {query.isSuccess && data?.health?.status === "awaiting_first_run" && !isAnalysing && (
          <>
            <p className="t-body">
              No analysis has been produced for this incident yet.
              {isAdmin ? (
                <> Click &ldquo;Analyse now&rdquo; below to generate one.</>
              ) : (
                <> Ask an admin to run an analysis.</>
              )}
            </p>
            {isAdmin && (
              <div>
                <Button
                  appearance="primary"
                  disabled={isAnalysing}
                  onClick={() => analyse.mutate({ incidentId })}
                >
                  Analyse now
                </Button>
              </div>
            )}
            {analyse.isError && (
              <MessageBar intent="error" role="alert">
                <MessageBarBody>
                  Run failed.{" "}
                  {analyse.error instanceof ApiError
                    ? `(${analyse.error.status}) ${analyse.error.message}`
                    : (analyse.error as Error).message}
                </MessageBarBody>
              </MessageBar>
            )}
          </>
        )}

        {query.isSuccess && data && !data.health && (
          <AnalysisBody
            data={data}
            isAdmin={isAdmin}
            lockActive={lockActive}
            lockUntil={lockUntil}
            onReanalyse={() => analyse.mutate({ incidentId })}
            onClearLock={() => clearLock.mutate({ incidentId })}
            analysePending={analyse.isPending}
            clearLockPending={clearLock.isPending}
            analyseError={analyse.error}
            clearLockError={clearLock.error}
          />
        )}
      </div>
    </div>
  );
}

interface BodyProps {
  readonly data: IncidentAnalysisResponse;
  readonly isAdmin: boolean;
  readonly lockActive: boolean;
  readonly lockUntil: string | null;
  readonly onReanalyse: () => void;
  readonly onClearLock: () => void;
  readonly analysePending: boolean;
  readonly clearLockPending: boolean;
  readonly analyseError: Error | null;
  readonly clearLockError: Error | null;
}

function AnalysisBody(props: BodyProps) {
  const { data } = props;

  return (
    <>
      {props.lockActive && (
        <MessageBar intent="warning">
          <MessageBarBody>
            Automatic analysis is paused on this incident because two recent runs triggered the
            content-policy denylist on most adversary-influenceable fields. The lock auto-clears at{" "}
            <strong>
              {props.lockUntil
                ? new Date(props.lockUntil).toLocaleString()
                : "the configured expiry"}
            </strong>
            .{props.isAdmin && <> An admin can clear it sooner with acknowledgment below.</>}
          </MessageBarBody>
        </MessageBar>
      )}

      {data.headline && <p className="narrative__lede">{data.headline}</p>}

      {data.sections && (
        <>
          <Section heading="Attack narrative" body={data.sections.attackNarrative} />
          <Section heading="Impact assessment" body={data.sections.impactAssessment} />
          <Section
            heading="Suggested next steps"
            body={data.sections.suggestedNextSteps}
            tone="danger"
          />
        </>
      )}

      <div
        className="row row--between"
        style={{
          paddingTop: "var(--sp-s)",
          borderTop: "1px solid var(--stroke-2)",
          flexWrap: "wrap",
          gap: "var(--sp-s)",
        }}
      >
        <p className="t-caption">
          {data.generatedAt ? `Generated ${new Date(data.generatedAt).toLocaleString()}` : ""}
          {data.modelDeployment ? ` · ${data.modelDeployment}` : ""}
          {data.analysedIncidentLastUpdateDateTime
            ? ` · based on incident as of ${new Date(data.analysedIncidentLastUpdateDateTime).toLocaleString()}`
            : ""}
        </p>
        {props.isAdmin && (
          <div className="row" style={{ gap: "var(--sp-s)", flexWrap: "wrap" }}>
            {!props.lockActive && (
              <button
                className="btn btn--small"
                disabled={props.analysePending}
                onClick={props.onReanalyse}
                type="button"
              >
                <Icon name="refresh" size={12} />
                {props.analysePending ? "Analysing…" : "Re-analyse"}
              </button>
            )}
            {props.lockActive && (
              <button
                className="btn btn--small btn--primary"
                disabled={props.clearLockPending}
                onClick={props.onClearLock}
                type="button"
              >
                {props.clearLockPending ? "Clearing lock…" : "Clear lock and retry"}
              </button>
            )}
          </div>
        )}
      </div>

      {props.analyseError && (
        <MessageBar intent="error" role="alert">
          <MessageBarBody>
            Run failed.{" "}
            {props.analyseError instanceof ApiError
              ? `(${props.analyseError.status}) ${props.analyseError.message}`
              : props.analyseError.message}
          </MessageBarBody>
        </MessageBar>
      )}
      {props.clearLockError && (
        <MessageBar intent="error" role="alert">
          <MessageBarBody>
            Lock clear failed.{" "}
            {props.clearLockError instanceof ApiError
              ? `(${props.clearLockError.status}) ${props.clearLockError.message}`
              : props.clearLockError.message}
          </MessageBarBody>
        </MessageBar>
      )}
    </>
  );
}

function Section({ heading, body, tone }: { heading: string; body: string; tone?: "danger" }) {
  if (!body || body.length === 0) return null;
  const cls =
    tone === "danger" ? "narrative__section narrative__section--danger" : "narrative__section";
  return (
    <div className={cls}>
      <h4>{heading}</h4>
      <SafeMarkdown>{body}</SafeMarkdown>
    </div>
  );
}
