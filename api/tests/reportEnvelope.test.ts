// Pure unit tests for the report envelope's profile-title join.
// The IO-bound assembleSecureScore path is exercised through integration
// (azd deploy + render); here we test only the in-memory decoration.

import { describe, expect, it } from "vitest";

import { decorateSnapshotWithControlTitles } from "../src/lib/reportEnvelope.js";
import type { SecureScoreSnapshot } from "../src/lib/types.js";

function snap(
  controlScores: SecureScoreSnapshot["controlScores"],
): SecureScoreSnapshot {
  return {
    snapshotDate: "2026-05-21",
    createdDateTime: "2026-05-21T00:00:00Z",
    ingestedAt: "2026-05-21T00:00:00Z",
    currentScore: 50,
    maxScore: 100,
    percentage: 50,
    activeUserCount: 0,
    licensedUserCount: 0,
    enabledServices: [],
    averageComparativeScores: [],
    controlScores,
    graphId: "g",
    ingestRunId: "r",
  };
}

describe("decorateSnapshotWithControlTitles", () => {
  it("joins Microsoft title onto matching controlScores by controlName", () => {
    const out = decorateSnapshotWithControlTitles(
      snap([
        { controlCategory: "Identity", controlName: "AdminMFAV2", description: "", score: 1.0 },
        { controlCategory: "Identity", controlName: "PhishResistantAuth", description: "", score: 0.5 },
      ]),
      [
        { controlName: "AdminMFAV2", title: "Require MFA for administrative roles" },
        { controlName: "PhishResistantAuth", title: "Enforce phish-resistant authentication" },
      ],
    );
    expect(out.controlScores[0]!.title).toBe("Require MFA for administrative roles");
    expect(out.controlScores[1]!.title).toBe("Enforce phish-resistant authentication");
  });

  it("leaves controlName-only entries untouched when no profile matches", () => {
    const out = decorateSnapshotWithControlTitles(
      snap([
        { controlCategory: "Identity", controlName: "Unmapped", description: "", score: 1.0 },
      ]),
      [{ controlName: "DifferentControl", title: "Some other title" }],
    );
    expect(out.controlScores[0]!.title).toBeUndefined();
    expect(out.controlScores[0]!.controlName).toBe("Unmapped");
  });

  it("skips empty / whitespace-only titles so the renderer's controlName fallback fires", () => {
    const out = decorateSnapshotWithControlTitles(
      snap([
        { controlCategory: "Identity", controlName: "EmptyTitleCtrl", description: "", score: 1.0 },
        { controlCategory: "Identity", controlName: "WhitespaceTitleCtrl", description: "", score: 2.0 },
        { controlCategory: "Identity", controlName: "RealTitleCtrl", description: "", score: 3.0 },
      ]),
      [
        { controlName: "EmptyTitleCtrl", title: "" },
        { controlName: "WhitespaceTitleCtrl", title: "   " },
        { controlName: "RealTitleCtrl", title: "Real title" },
      ],
    );
    expect(out.controlScores[0]!.title).toBeUndefined();
    expect(out.controlScores[1]!.title).toBeUndefined();
    expect(out.controlScores[2]!.title).toBe("Real title");
  });

  it("returns the original snapshot reference when no profiles supply usable titles", () => {
    const input = snap([
      { controlCategory: "Identity", controlName: "Ctrl", description: "", score: 1.0 },
    ]);
    const out = decorateSnapshotWithControlTitles(input, []);
    expect(out).toBe(input);
  });

  it("caps title length defensively at 200 chars (WS10 SEC-L-SS-TITLE-01)", () => {
    const long = "A".repeat(500);
    const out = decorateSnapshotWithControlTitles(
      snap([
        { controlCategory: "Identity", controlName: "Ctrl", description: "", score: 1.0 },
      ]),
      [{ controlName: "Ctrl", title: long }],
    );
    expect(out.controlScores[0]!.title).toHaveLength(200);
    expect(out.controlScores[0]!.title).toBe("A".repeat(200));
  });

  it("does not mutate the input snapshot's controlScores entries", () => {
    const input = snap([
      { controlCategory: "Identity", controlName: "AdminMFAV2", description: "", score: 1.0 },
    ]);
    const before = input.controlScores[0];
    decorateSnapshotWithControlTitles(input, [
      { controlName: "AdminMFAV2", title: "Friendly" },
    ]);
    expect(input.controlScores[0]).toBe(before);
    expect((input.controlScores[0] as { title?: string }).title).toBeUndefined();
  });
});
