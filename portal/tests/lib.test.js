import test from "node:test";
import assert from "node:assert/strict";
import { ago, bytes, fleetSummary, lampsFor, machineState, parseRoute, worstLamp } from "../src/lib.js";

const NOW = Date.parse("2026-11-03T12:00:00Z");

test("machine state follows the last check-in", () => {
  assert.equal(machineState(null, NOW), "never");
  assert.equal(machineState("2026-11-03T11:59:30Z", NOW), "online");
  assert.equal(machineState("2026-11-03T11:55:00Z", NOW), "late");
  assert.equal(machineState("2026-11-03T10:00:00Z", NOW), "offline");
});

test("ago and bytes read plainly", () => {
  assert.equal(ago("2026-11-03T11:59:50Z", NOW), "10 s ago");
  assert.equal(ago("2026-11-03T11:00:00Z", NOW), "1 h ago");
  assert.equal(bytes(512), "512 B");
  assert.equal(bytes(2_500_000), "2.5 MB");
});

test("the app's own lamps are shown as sent, unknown classes dropped", () => {
  const l = lampsFor({ lamps: [{ k: "arms", cls: "bad", word: "Arms", detail: "left: fault" },
                               { k: "x", cls: "<script>", word: "X", detail: 3 }] });
  assert.deepEqual(l[0], { k: "arms", cls: "bad", word: "Arms", detail: "left: fault" });
  assert.equal(l[1].cls, "");
  assert.equal(l[1].detail, "3");
  assert.equal(worstLamp(l).k, "arms");
});

test("without lamps, the fields make them", () => {
  const l = lampsFor({ job: "teleop", arms: "both on" });
  assert.deepEqual(l.map((x) => x.k), ["job", "arms"]);
  assert.equal(l[0].cls, "run");
  assert.deepEqual(lampsFor(null).map((x) => x.k), ["job"]);
});

test("the fleet's word: faults first, then machines not online", () => {
  const on = "2026-11-03T11:59:50Z";
  assert.equal(fleetSummary([], NOW).word, "No machines");
  assert.equal(fleetSummary([{ last_seen_at: on, status: {} }], NOW).word, "All online");
  assert.equal(fleetSummary([{ last_seen_at: on, status: {} }, { last_seen_at: null }], NOW).word, "1 not online");
  const s = fleetSummary([{ last_seen_at: on, status: { job: "teleop", lamps: [{ cls: "bad" }] } }], NOW);
  assert.equal(s.word, "A fault");
  assert.equal(s.cls, "bad");
  assert.match(s.sentence, /1 running a job/);
});

test("routes", () => {
  assert.deepEqual(parseRoute(""), { page: "home" });
  assert.deepEqual(parseRoute("#/org/abc"), { page: "org", org: "abc", tab: "fleet" });
  assert.deepEqual(parseRoute("#/org/abc/members"), { page: "org", org: "abc", tab: "members" });
  assert.deepEqual(parseRoute("#/org/abc/machine/m1"), { page: "machine", org: "abc", machine: "m1" });
});
