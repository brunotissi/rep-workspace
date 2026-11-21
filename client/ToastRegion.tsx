import type { Toast, createNotifications } from "./notifications";

export function ToastRegion({
  toast,
  notifications
}: {
  toast?: Toast;
  notifications: ReturnType<typeof createNotifications>;
}) {
  const announcement = toast
    ? [toast.message, toast.context].filter(Boolean).join(" ")
    : "";
  return (
    <>
      <div className="visually-hidden" role="status" aria-atomic="true">
        {toast?.kind === "success" ? announcement : ""}
      </div>
      <div className="visually-hidden" role="alert" aria-atomic="true">
        {toast?.kind === "error" ? announcement : ""}
      </div>
      {toast && (
        <div className={"toast toast-" + toast.kind}>
          <div>
            <p className="toast-message">{toast.message}</p>
            {toast.context && <p className="toast-context">{toast.context}</p>}
          </div>
          <button
            className="toast-dismiss"
            type="button"
            aria-label="Dismiss notification"
            onFocus={() => notifications.pause(toast)}
            onBlur={() => notifications.resume(toast)}
            onClick={() => notifications.dismiss(toast)}
          >
            <span aria-hidden="true">×</span>
          </button>
        </div>
      )}
    </>
  );
}
