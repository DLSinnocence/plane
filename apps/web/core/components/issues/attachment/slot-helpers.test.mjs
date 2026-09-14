import assert from "node:assert/strict";
import { test } from "node:test";
import { countAttachments, nextEmptyAttachmentName, missingSlotNames, validateSlotNames } from "./slot-helpers.ts";

test("empty attachment names are legal and unique after normalization", () => {
  assert.equal(nextEmptyAttachmentName([], "空附件"), "空附件 1");
  assert.equal(
    nextEmptyAttachmentName([" Empty attachment 1 ", "EMPTY ATTACHMENT 2", "Empty attachment 4"], "Empty attachment"),
    "Empty attachment 3"
  );
  const existing = Array.from({ length: 49 }, (_, index) => `空附件 ${index + 1}`);
  const next = nextEmptyAttachmentName(existing, "空附件");
  assert.equal(next, "空附件 50");
  assert.equal(validateSlotNames([...existing, next]), null);
  assert.equal(validateSlotNames([nextEmptyAttachmentName([], "😀".repeat(101))]), null);
  assert.equal(validateSlotNames([nextEmptyAttachmentName([], " ")]), null);
});

test("attachment count includes empty rows without counting attached files twice", () => {
  assert.equal(countAttachments(0, []), 0);
  assert.equal(countAttachments(0, [{ attachment: null }]), 1);
  assert.equal(countAttachments(3, [{ attachment: { id: "file" } }, { attachment: null }]), 4);
  assert.equal(countAttachments(3, [{ attachment: { id: "file" } }]), 3);
  assert.equal(countAttachments(3, []), 3);
});

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
