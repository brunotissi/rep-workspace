import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ApiError } from "../client/api";
import { runAction } from "../client/actions";
import {
  createNotifications,
  successDurationMs,
  type Toast
} from "../client/notifications";
import { ToastRegion } from "../client/ToastRegion";

const success: Toast = {
  kind: "success",
  message: "Close date updated in Salesforce.",
  context: "Renewal"
};
const failure: Toast = {
  kind: "error",
  message: "Salesforce denied permission to save this change.",
  context: "Renewal"
};

function fixture() {
  let shown: Toast | undefined;
  const timers: { callback: () => void; delay: number; canceled: boolean }[] =
    [];
  const notifications = createNotifications(
    (value) => {
      shown = value;
    },
    (callback, delay) => {
      const timer = { callback, delay, canceled: false };
      timers.push(timer);
      return () => {
        timer.canceled = true;
      };
    }
  );
  notifications.navigate("account-a:opportunity-a");
  return { notifications, timers, current: () => shown };
}

test("confirmed success publishes immediately and automatically dismisses after five seconds", () => {
  const { notifications, timers, current } = fixture();
  notifications.publish(notifications.capture(), success);
  assert.equal(current(), success);
  assert.equal(timers.length, 1);
  assert.equal(timers[0].delay, successDurationMs);
  assert.equal(timers[0].delay, 5000);
  timers[0].callback();
  assert.equal(current(), undefined);
});

test("errors persist without a timer and can be manually dismissed or superseded", () => {
  const { notifications, timers, current } = fixture();
  const scope = notifications.capture();
  notifications.publish(scope, failure);
  assert.equal(current(), failure);
  assert.equal(timers.length, 0);
  notifications.dismiss(failure);
  assert.equal(current(), undefined);
  notifications.publish(scope, failure);
  notifications.publish(scope, success);
  notifications.dismiss(failure);
  assert.equal(current(), success);
  notifications.dismiss(success);
  assert.equal(timers[0].canceled, true);
});

test("keyboard focus holds a success toast and stale timers cannot dismiss a replacement", () => {
  const { notifications, timers, current } = fixture();
  const scope = notifications.capture();
  notifications.publish(scope, success);
  notifications.pause(success);
  assert.equal(timers[0].canceled, true);
  notifications.resume(success);
  timers[0].callback();
  assert.equal(current(), success);
  notifications.publish(scope, failure);
  timers[1].callback();
  assert.equal(current(), failure);
});

test("navigating clears the toast and invalidates an old selection even after returning", () => {
  const { notifications, timers, current } = fixture();
  const old = notifications.capture();
  notifications.publish(old, success);
  notifications.navigate("account-a:opportunity-a");
  assert.equal(current(), success);
  notifications.navigate("account-a:opportunity-b");
  assert.equal(current(), undefined);
  assert.equal(timers[0].canceled, true);
  notifications.navigate("account-b:opportunity-c");
  notifications.navigate("account-a:opportunity-a");
  notifications.publish(old, failure);
  assert.equal(current(), undefined);
  notifications.publish(notifications.capture(), success);
  assert.equal(current(), success);
});

test("late success and error from a previous selection leave refresh and rollback intact", async () => {
  for (const succeeds of [true, false]) {
    const { notifications, current } = fixture();
    const scope = notifications.capture();
    let resolve!: (value: { message: string }) => void;
    let reject!: (error: ApiError) => void;
    const response = new Promise<{ message: string }>((ok, error) => {
      resolve = ok;
      reject = error;
    });
    let preview = false;
    let refreshed = false;
    const save = runAction(
      {
        kind: "closeDate",
        accountId: "account-a",
        opportunityId: "opportunity-a",
        date: "2026-12-05",
        previousDate: "2026-11-17"
      },
      {
        preview: (value) => {
          preview = Boolean(value);
        },
        confirm: (message) =>
          notifications.publish(scope, { ...success, message }),
        reject: (error) =>
          notifications.publish(scope, { ...failure, message: error.message }),
        refresh: () => {
          refreshed = true;
        }
      },
      () => response
    );
    assert.equal(preview, true);
    notifications.navigate("account-b:opportunity-b");
    const replacement: Toast = {
      kind: "error",
      message: "Current selection notification."
    };
    notifications.publish(notifications.capture(), replacement);
    if (succeeds) resolve({ message: success.message });
    else reject(new ApiError(502, "Old request timed out.", true));
    await save;
    assert.equal(preview, false);
    assert.equal(refreshed, true);
    assert.equal(current(), replacement);
  }
});

test("toast markup provides separate live regions and a labelled dismiss button without autofocus", () => {
  const { notifications } = fixture();
  const html = renderToStaticMarkup(
    createElement(ToastRegion, { toast: success, notifications })
  );
  assert.match(
    html,
    /role="status" aria-atomic="true">Close date updated in Salesforce\. Renewal/
  );
  assert.match(html, /role="alert" aria-atomic="true"><\/div>/);
  assert.match(html, /<button[^>]*aria-label="Dismiss notification"/);
  assert.doesNotMatch(html, /autofocus/i);
  const error = renderToStaticMarkup(
    createElement(ToastRegion, { toast: failure, notifications })
  );
  assert.match(
    error,
    /role="alert" aria-atomic="true">Salesforce denied permission/
  );
});
