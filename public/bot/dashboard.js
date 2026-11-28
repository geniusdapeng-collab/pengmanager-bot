// These are the task states that still have work to run or resolve.
const inProgress = new Set(["queued", "running", "waiting_input", "needs_reconcile"]);

export function isTaskInProgress(task) {
  return inProgress.has(task.state ?? task.status);
}

export function notificationTitle(notification) {
  const title = typeof notification.title === "string" ? notification.title.trim() : "";
  if (title && title !== "weekly_report") return title;
  return title === "weekly_report" || notification.kind === "weekly_report" ? "经营周报" : "经营提醒";
}
