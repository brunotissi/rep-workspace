import { useEffect, useState } from "react";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly uncertain = false
  ) {
    super(message);
  }
}

export function useRead<T>(url: string | undefined) {
  const [attempt, setAttempt] = useState(0);
  const [result, setResult] = useState<{
    url: string;
    attempt: number;
    data?: T;
    error?: ApiError;
  }>();
  useEffect(() => {
    if (!url) return;
    const controller = new AbortController();
    fetch(url, { signal: controller.signal })
      .then(async (response) => {
        const data = await response.json().catch(() => null);
        if (!response.ok)
          throw new ApiError(
            response.status,
            data?.error ?? "The request could not be completed."
          );
        if (!data) throw new ApiError(502, "The response could not be read.");
        if (!controller.signal.aborted) setResult({ url, attempt, data });
      })
      .catch((error) => {
        if (!controller.signal.aborted)
          setResult((previous) => ({
            url,
            attempt,
            data: previous?.url === url ? previous.data : undefined,
            error:
              error instanceof ApiError
                ? error
                : new ApiError(0, "The local server could not be reached.")
          }));
      });
    return () => controller.abort();
  }, [url, attempt]);
  const cached = result?.url === url ? result : undefined;
  const current = cached?.attempt === attempt ? cached : undefined;
  return {
    data: cached?.data,
    error: current?.error,
    loading: Boolean(url && !current),
    retry: () => setAttempt((value) => value + 1),
    updateCached: (update: (data: T) => T) =>
      setResult((previous) =>
        previous && previous.url === url && previous.data !== undefined
          ? { ...previous, data: update(previous.data) }
          : previous
      )
  };
}
