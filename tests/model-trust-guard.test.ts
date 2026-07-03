import { expect, test } from "bun:test";
import { UNTRUSTED_MODEL_INPUT_RULE, withUntrustedModelInputRule } from "../src/model/trust-guard";

test("appends the shared model-input trust rule without rewriting the stage prompt", () => {
  expect(withUntrustedModelInputRule("Stage policy.\n")).toBe(
    `Stage policy.\n\n${UNTRUSTED_MODEL_INPUT_RULE}`,
  );
});
