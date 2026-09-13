import assert from "node:assert/strict";
import { test } from "node:test";
import { missingSlotNames, validateSlotNames } from "./slot-helpers.ts";

test("slot names enforce API bounds, trimming and case-insensitive uniqueness", () => {
  assert.equal(validateSlotNames([]), "count");
  assert.equal(validateSlotNames(Array.from({ length: 51 }, (_, i) => `Slot ${i}`)), "count");
  assert.equal(validateSlotNames([" "]), "name");
  assert.equal(validateSlotNames(["a".repeat(101)]), "name");
  assert.equal(validateSlotNames([" Design ", "design"]), "duplicate");
  assert.equal(validateSlotNames(["方案", "设计", "😀".repeat(100)]), null);
  assert.equal(validateSlotNames(Array.from({ length: 50 }, (_, i) => `Slot ${i}`)), null);
});

test("template preview appends only missing names and is idempotent without mutating input", () => {
  const existing = ["Design", "说明"];
  const incoming = [" design ", "说明", " Approval ", "approval"];
  const missing = missingSlotNames(existing, incoming);
  assert.deepEqual(missing, ["Approval"]);
  assert.deepEqual(missingSlotNames([...existing, ...missing], incoming), []);
  assert.deepEqual(existing, ["Design", "说明"]);
  assert.deepEqual(incoming, [" design ", "说明", " Approval ", "approval"]);
});
