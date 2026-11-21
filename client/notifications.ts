type Selection = { key: string | undefined };

export type Toast = {
  kind: "success" | "error";
  message: string;
  context?: string;
};

export const successDurationMs = 5000;

function scheduleDismiss(callback: () => void, delay: number) {
  const timer = setTimeout(callback, delay);
  return () => clearTimeout(timer);
}

export function createNotifications(
  onChange: (toast: Toast | undefined) => void,
  schedule = scheduleDismiss
) {
  let selection: Selection = { key: undefined };
  let shown: Toast | undefined;
  let cancelTimer: (() => void) | undefined;
  let timerVersion = 0;

  function stopTimer() {
    timerVersion++;
    cancelTimer?.();
    cancelTimer = undefined;
  }

  function dismiss(toast: Toast) {
    if (shown !== toast) return;
    stopTimer();
    shown = undefined;
    onChange(undefined);
  }

  function resume(toast: Toast) {
    if (shown !== toast || toast.kind !== "success") return;
    stopTimer();
    const version = timerVersion;
    cancelTimer = schedule(() => {
      if (version === timerVersion) dismiss(toast);
    }, successDurationMs);
  }

  function isCurrent(scope: Selection) {
    return scope.key !== undefined && scope === selection;
  }

  return {
    navigate(key: string | undefined) {
      if (selection.key === key) return;
      selection = { key };
      if (shown) dismiss(shown);
    },
    capture: () => selection,
    isCurrent,
    publish(scope: Selection, toast: Toast) {
      if (!isCurrent(scope)) return;
      stopTimer();
      shown = toast;
      onChange(toast);
      resume(toast);
    },
    dismiss,
    pause(toast: Toast) {
      if (shown === toast) stopTimer();
    },
    resume,
    dispose() {
      stopTimer();
      shown = undefined;
      selection = { key: undefined };
    }
  };
}
