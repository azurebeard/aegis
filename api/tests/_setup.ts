// Vitest global setup — runs before every test file.
//
// §10.66 Phase E — legacy x-ms-client-principal path retired. Pre-Phase-E
// this file pinned AEGIS_LEGACY_CLIENT_PRINCIPAL=enabled so handler tests
// could authenticate via a synthesised base64 header. That code path is
// gone; tests that need an authenticated principal now mock
// `readClientPrincipal` via vi.mock (see e.g. getRiskyUsersSummary.test.ts).
//
// File intentionally left as a placeholder — vitest still loads it as the
// setupFiles entry, but there's no global state to pin.

export {};
