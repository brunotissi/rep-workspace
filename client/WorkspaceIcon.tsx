const paths = {
  chevron: "m6 9 6 6 6-6",
  panelOpen: "M3 5h18v14H3z M9 5v14 M13 9l3 3-3 3",
  panelClose: "M3 5h18v14H3z M9 5v14 M16 9l-3 3 3 3",
  signOut: "M9 5H4v14h5 M8 12h12m-4-4 4 4-4 4",
  healthy: "M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z M8 12l3 3 5-6",
  caution: "m12 3 10 17H2L12 3Z M12 9v4m0 3h.01",
  attention: "M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z M12 8v5m0 3h.01",
  unknown:
    "M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z M9 9a3 3 0 1 1 4 3c-1 .5-1 1-1 2m0 2h.01",
  account:
    "M4 21V8h5v13 M9 21V3h7v18 M16 21V11h4v10 M2 21h20 M12 7h1m-1 4h1m-1 4h1",
  contact:
    "M16 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0Z M4 21v-2a5 5 0 0 1 5-5h6a5 5 0 0 1 5 5v2",
  activity: "M3 12h4l3-7 4 14 3-7h4",
  layers: "m12 3 9 5-9 5-9-5 9-5Z M3 12l9 5 9-5 M3 16l9 5 9-5",
  calendar: "M4 6h16v15H4z M8 3v6m8-6v6M4 11h16",
  stage: "M5 20v-5m5 5V11m5 9V7m5 13V3",
  action: "m13 2-9 12h7l-1 8 10-12h-7l1-8Z"
};

export function WorkspaceIcon({
  name,
  className
}: {
  name: keyof typeof paths;
  className?: string;
}) {
  return (
    <svg
      aria-hidden="true"
      className={className ? "workspace-icon " + className : "workspace-icon"}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d={paths[name]} />
    </svg>
  );
}
