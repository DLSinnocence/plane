import assert from "node:assert/strict";
import { test } from "node:test";
import {
  countAttachments,
  nextEmptyAttachmentName,
  missingSlotNames,
  validateSlotNames,
  validateAttachmentName,
} from "./slot-helpers.ts";

test("empty attachment names are legal and unique after normalization", () => {
  assert.equal(nextEmptyAttachmentName([], "附件"), "附件");
  assert.equal(nextEmptyAttachmentName([" Attachment ", "ATTACHMENT2", "Attachment4"], "Attachment"), "Attachment3");
  const existing = ["附件", ...Array.from({ length: 48 }, (_, index) => `附件${index + 2}`)];
  const next = nextEmptyAttachmentName(existing, "附件");
  assert.equal(next, "附件50");
  assert.equal(validateSlotNames([...existing, next]), null);
  assert.equal(validateSlotNames([nextEmptyAttachmentName([], "😀".repeat(101))]), null);
  assert.equal(validateSlotNames([nextEmptyAttachmentName([], " ")]), null);
});

test("attachment count includes empty rows without counting attached files twice", () => {
  assert.equal(countAttachments(0, []), 0);
  assert.equal(countAttachments(0, [{ attachment: null }]), 1);
  assert.equal(countAttachments(3, [{ attachment: { id: "file" } }, { attachment: null }]), 2);
  assert.equal(countAttachments(3, [{ attachment: { id: "file" } }]), 1);
  assert.equal(countAttachments(3, []), 0);
  assert.equal(countAttachments(3, undefined), 3);
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

test("existing rows above the create limit can still be renamed", () => {
  const names = Array.from({ length: 57 }, (_, index) => `附件${index}`);
  assert.equal(validateAttachmentName("新名称", names), null);
  assert.equal(validateAttachmentName(" 附件2 ", names), "duplicate");
  assert.equal(validateAttachmentName(" ", names), "name");
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
