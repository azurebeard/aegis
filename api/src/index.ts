// Entry point — registers all HTTP + Timer handlers with the v4 programming model.
//
// HANDOVER §6.3 `deployAiAgents` resolution: the ten agent-plane handlers
// (brief × 4, posture × 3, incidents-analysis × 3) are gated on the
// `AZURE_DEPLOY_AI_AGENTS` app setting. When the AI plane is disabled,
// these imports are skipped entirely via a dynamic `await import()` block
// — unregistered handlers do not appear in `az functionapp function list`
// and the corresponding routes return 404 at the Function runtime rather
// than reaching a handler that would then need to know about the toggle.
// Short-circuiting at module load keeps the AI-plane code path OFF the
// process; a regulated-tenant deployment with `AZURE_DEPLOY_AI_AGENTS=false`
// never instantiates any @azure/ai-projects / @azure/identity Foundry-MI
// credentials.

import "./functions/ping.js";
import "./functions/getSecureScoreLatest.js";
import "./functions/getSecureScoreTrend.js";
import "./functions/getSecureScoreControlProfiles.js";
import "./functions/runSecureScoreIngest.js";
import "./functions/runSecureScoreControlProfilesIngest.js";
import "./ingest/secureScoreTimer.js";
import "./ingest/secureScoreControlProfilesTimer.js";
import "./functions/getIncidentsSummary.js";
import "./functions/getIncidentsList.js";
import "./functions/getIncidentsTrends.js";
import "./functions/getIncidentDetail.js";
import "./functions/runIncidentsIngest.js";
import "./functions/runIncidentsBackfill.js";
import "./ingest/incidentsTimer.js";
import "./functions/getRiskyUsersSummary.js";
import "./functions/getRiskyUsersList.js";
import "./functions/getNotifications.js";
import "./functions/runEntraRiskIngest.js";
import "./ingest/entraRiskTimer.js";
// ADR-0034 §1 Phase 8B — User dormancy report.
import "./functions/getUserDormancySummary.js";
import "./functions/getUserDormancyList.js";
import "./functions/runUserDormancyIngest.js";
import "./ingest/userDormancyTimer.js";
// ADR-0034 §1 Phase 8C — Geo-fenced sign-ins.
import "./functions/getSignInsSummary.js";
import "./functions/getSignInsList.js";
import "./functions/runSignInsIngest.js";
import "./ingest/signInsTimer.js";
// ADR-0034 §7 Phase 8E — Identities page (on-demand SP enumeration).
import "./functions/getServicePrincipals.js";
// ADR-0034 §3.3 Phase 8D — Conditional Access policy state.
import "./functions/getConditionalAccessPolicies.js";
import "./functions/getConditionalAccessSummary.js";
import "./functions/runConditionalAccessIngest.js";
import "./ingest/conditionalAccessTimer.js";
// ADR-0036 — Defender for Cloud Secure Score.
import "./functions/getAzureSecureScoreSummary.js";
import "./functions/runAzureSecureScoreIngest.js";
import "./ingest/azureSecureScoreTimer.js";
import "./functions/getSettings.js";
import "./functions/patchSettings.js";
import "./functions/uploadBrandingLogo.js";
import "./functions/getBrandingLogo.js";
import "./functions/deleteBrandingLogo.js";

import { resolveDeployAiAgents } from "./lib/config.js";

if (resolveDeployAiAgents()) {
  await import("./functions/getBriefLatest.js");
  await import("./functions/getBriefByDate.js");
  await import("./functions/getBriefHistory.js");
  await import("./functions/runDailyBrief.js");
  await import("./functions/dailyBriefTimer.js");
  await import("./functions/getPostureLatest.js");
  await import("./functions/getPostureByWeek.js");
  await import("./functions/getPostureHistory.js");
  await import("./functions/runPostureAgent.js");
  await import("./functions/postureAgentTimer.js");
  await import("./functions/analyseIncident.js");
  await import("./functions/getIncidentAnalysis.js");
  await import("./functions/clearIncidentRedactionLock.js");
  await import("./functions/getAdminAgents.js");
  await import("./functions/getAgentRunHistory.js");
  await import("./functions/getIngestRunHistory.js");
  await import("./functions/getIngestSources.js");
  // ADR-0030 — reports + snapshots
  await import("./functions/captureReportSnapshot.js");
  await import("./functions/getReportCurrent.js");
  await import("./functions/getReportSnapshot.js");
  await import("./functions/listReportSnapshots.js");
  // ADR-0030 — derived HTML rendering for download / email body / print
  await import("./functions/getReportCurrentHtml.js");
  await import("./functions/getReportSnapshotHtml.js");
  // ADR-0030 Phase B — daily auto-capture Timer (idempotent skip-if-exists).
  await import("./ingest/reportSnapshotAutoCaptureTimer.js");
  // ADR-0030 Phase C Slice 1(c)/A — admin send-by-mail endpoint.
  await import("./functions/emailReportSnapshot.js");
  // ADR-0030 Phase C Slice 1(c)/B3 — send-history list / get / delete.
  await import("./functions/listReportEmailSends.js");
  await import("./functions/getReportEmailSend.js");
  await import("./functions/deleteReportEmailSend.js");
  // ADR-0030 §C.22 (forthcoming) — token-gated public share-link endpoint.
  await import("./functions/getReportShare.js");
  // ADR-0031 — stack inventory
  await import("./functions/getStackCatalog.js");
  await import("./functions/getStackItems.js");
  await import("./functions/postStackItem.js");
  await import("./functions/patchStackItem.js");
  await import("./functions/deleteStackItem.js");
  // ADR-0032 — KEV ingest + summary
  await import("./functions/getKevSummary.js");
  await import("./functions/runKevIngest.js");
  await import("./ingest/kevTimer.js");
  // ADR-0033 — KEV match status workflow
  await import("./functions/patchKevSuppression.js");
  await import("./functions/deleteKevSuppression.js");
  // ADR-0033 §5 Phase 2.5 — daily expiry sweep (hygiene; effective state
  // is already correct via the read-time resolver).
  await import("./ingest/kevSuppressionsSweepTimer.js");
  // ADR-0037 — ransomware.live PRO threat-intel: hourly Timer, admin-
  // trigger POST handler, summary + list reader handlers.
  await import("./ingest/ransomwareIntelTimer.js");
  await import("./functions/runRansomwareIntelIngest.js");
  await import("./functions/getRansomwareIntelSummary.js");
  await import("./functions/getRansomwareIntelList.js");
  // ADR-0037 Option B — self-service key rotation
  // from the SPA admin section. ABAC-gated KV write via api-reader MI.
  await import("./functions/rotateRansomwareIntelKey.js");
}
