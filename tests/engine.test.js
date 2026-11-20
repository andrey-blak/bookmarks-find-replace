import test from "node:test";
import assert from "node:assert/strict";
import { engineReady } from "../src/lib/engine.js";

test("engine module loads under node", () => {
  assert.equal(engineReady, true);
});
