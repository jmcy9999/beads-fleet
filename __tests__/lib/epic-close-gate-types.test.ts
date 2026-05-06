import { GATE_JSON_VERSION } from "@/lib/epic-close-gate-types";

/**
 * The only behaviour-bearing assertion for `epic-close-gate-types.ts`.
 *
 * Type behaviour is verified by `tsc --noEmit` (the discriminated-union
 * shape, the exhaustive-switch obligation, the absence of framework imports).
 * The single runtime invariant is the schema-version constant: the runner in
 * niii.6.3 asserts `output.version === GATE_JSON_VERSION` and fails closed
 * otherwise. If this constant drifts from the script's emitted `version`
 * field, the runner stops accepting any gate output. Pin it.
 */
describe("GATE_JSON_VERSION", () => {
  it("is the string '1'", () => {
    expect(GATE_JSON_VERSION).toBe("1");
  });
});
