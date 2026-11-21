import { useEffect, useState } from "react";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string
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
        setResult({ url, attempt, data });
      })
      .catch((error) => {
        if (!controller.signal.aborted)
          setResult({
            url,
            attempt,
            error:
              error instanceof ApiError
                ? error
                : new ApiError(0, "The local server could not be reached.")
          });
      });
    return () => controller.abort();
  }, [url, attempt]);
  const current =
    result?.url === url && result?.attempt === attempt ? result : undefined;
  return {
    ...current,
    loading: Boolean(url && !current),
    retry: () => setAttempt((value) => value + 1)
  };
}
