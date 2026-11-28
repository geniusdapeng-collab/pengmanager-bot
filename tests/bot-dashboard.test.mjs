import assert from "node:assert/strict";
import test from "node:test";
import { isTaskInProgress, notificationTitle } from "../public/bot/dashboard.js";

test("active task feed and count can exclude every terminal state before pagination", () => {
  const history = ["expired", "cancelled", "succeeded", "failed", "partial", "paused", "queued", "running",
    "waiting_input", "needs_reconcile", "completed", "canceled", "unrecognized"].map(state => ({ state }));
  const active = history.filter(isTaskInProgress);
  assert.deepEqual(active.map(task => task.state), ["queued", "running", "waiting_input", "needs_reconcile"]);
  assert.equal(history.length, 13);
  assert.equal(isTaskInProgress({ status: "queued" }), true);
  assert.equal(isTaskInProgress({ state: "expired", status: "queued" }), false);
});

test("weekly notification titles are readable on the home and task pages", () => {
  assert.equal(notificationTitle({ kind: "weekly_report" }), "经营周报");
  assert.equal(notificationTitle({ title: "weekly_report" }), "经营周报");
  assert.equal(notificationTitle({ kind: "weekly_report", title: "本周交付" }), "本周交付");
  assert.equal(notificationTitle({ kind: "some_internal_event" }), "经营提醒");
});
