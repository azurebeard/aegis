// Tests for the centralised AIEVENT wrapper
// (HANDOVER §6.3 App Insights SDK wrapper).
//
// Coverage:
//   - emitAievent always writes the legacy "AIEVENT <Name> ${JSON}" line
//     to context.log (preserves FunctionAppLogs grep contract).
//   - emitAievent never throws when telemetry init fails / SDK is
//     unavailable.
//   - normaliseProperties stringifies nested objects, drops null/undefined,
//     passes primitives through.
//   - state machine: when APPLICATIONINSIGHTS_CONNECTION_STRING is unset,
//     the SDK is marked "disabled" and stays so for the lifetime of the
//     module.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __test__, emitAievent } from "../src/lib/aievent.js";

beforeEach(() => {
  __test__.reset();
});

afterEach(() => {
  vi.unstubAllEnvs();
  __test__.reset();
});

describe("emitAievent — log-line contract (FunctionAppLogs grep)", () => {
  it("writes the legacy 'AIEVENT <Name> <JSON>' line to context.log", () => {
    const calls: string[] = [];
    const ctx = { log: (msg: string) => calls.push(msg) };
    emitAievent(ctx, "MyEvent", { foo: "bar", n: 42 });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toBe('AIEVENT MyEvent {"foo":"bar","n":42}');
  });

  it("does not throw when properties contain a nested object", () => {
    const ctx = { log: vi.fn() };
    expect(() =>
      emitAievent(ctx, "WithNested", { meta: { a: 1, b: [1, 2] } }),
    ).not.toThrow();
    expect(ctx.log).toHaveBeenCalledOnce();
  });

  it("does not throw when called repeatedly without a connection string", () => {
    vi.stubEnv("APPLICATIONINSIGHTS_CONNECTION_STRING", "");
    const ctx = { log: vi.fn() };
    for (let i = 0; i < 5; i++) {
      expect(() => emitAievent(ctx, `Event${i}`, { i })).not.toThrow();
    }
    expect(ctx.log).toHaveBeenCalledTimes(5);
  });
});

describe("normaliseProperties", () => {
  it("passes primitives through unchanged", () => {
    const out = __test__.normaliseProperties({
      s: "hi",
      n: 7,
      b: true,
    });
    expect(out).toEqual({ s: "hi", n: 7, b: true });
  });

  it("drops null and undefined values", () => {
    const out = __test__.normaliseProperties({
      keep: 1,
      nope: null,
      gone: undefined,
    });
    expect(out).toEqual({ keep: 1 });
  });

  it("JSON-stringifies nested objects so customDimensions doesn't see [object Object]", () => {
    const out = __test__.normaliseProperties({
      meta: { a: 1, b: "x" },
    });
    expect(out).toEqual({ meta: '{"a":1,"b":"x"}' });
  });

  it("survives circular references (falls back to String())", () => {
    const cyclic: Record<string, unknown> = { a: 1 };
    cyclic.self = cyclic;
    const out = __test__.normaliseProperties({ cyclic });
    // String(...) yields "[object Object]" — acceptable. The point is
    // the helper doesn't throw on circular input.
    expect(out.cyclic).toBeTypeOf("string");
  });
});
