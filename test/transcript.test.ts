import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { TranscriptEntry } from "../src/protocol.ts";
import { TranscriptController } from "../src/transcript.ts";

function entry(id: string, text: string): TranscriptEntry {
  return { type: "message", id, message: { role: "assistant", content: [{ type: "text", text }] } };
}

test("takeover transcript remains bounded, follows durable cursors, wraps narrow terminals, and scrolls", () => {
  const controller = new TranscriptController(3);
  controller.applyPage({ entries: [entry("1", "one"), entry("2", "two"), entry("3", "three")], startCursor: "1", cursor: "3", hasMore: true });
  controller.applyPage({ entries: [entry("3", "duplicate"), entry("4", "a very long terminal line that must wrap")], cursor: "4", hasMore: false });

  assert.deepEqual(controller.entries().map((value) => value.id), ["2", "3", "4"], "client memory is capped and duplicate cursor entries are ignored");
  assert.equal(controller.cursor(), "4");
  assert.equal(controller.hasOlder(), true);
  assert.equal(controller.oldestCursor(), "2");
  const latest = controller.render(12, 3);
  assert.equal(latest.length, 3);
  assert.ok(latest.every((line) => visibleWidth(line) <= 12), "every rendered line respects terminal width");

  controller.scroll(2);
  const older = controller.render(12, 3);
  assert.notDeepEqual(older, latest);
  controller.followLatest();
  assert.deepEqual(controller.render(12, 3), latest, "detach-style view state can return to the live tail deterministically");
});
