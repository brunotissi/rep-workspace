import { useRef, useState } from "react";
import { WorkspaceIcon } from "./WorkspaceIcon";

export function WorkspaceSidebar({
  username,
  signingOut,
  signOut
}: {
  username?: string;
  signingOut: boolean;
  signOut: () => void;
}) {
  const [hovered, setHovered] = useState(false);
  const [opened, setOpened] = useState(false);
  const [heldByFocus, setHeldByFocus] = useState(false);
  const toggle = useRef<HTMLButtonElement>(null);
  const expanded = hovered || opened || heldByFocus;
  function collapse() {
    setHovered(false);
    setOpened(false);
    setHeldByFocus(false);
  }
  const initials =
    username
      ?.split("@")[0]
      .match(/[a-z0-9]+/gi)
      ?.slice(0, 2)
      .map((part) => part[0].toUpperCase())
      .join("") || "RW";
  return (
    <div className="sidebar-rail">
      <header
        className={"sidebar" + (expanded ? " expanded" : "")}
        onPointerEnter={(event) => {
          if (
            username &&
            event.pointerType === "mouse" &&
            matchMedia(
              "(min-width: 961px) and (hover: hover) and (pointer: fine)"
            ).matches
          ) {
            setHovered(true);
            const focused = document.activeElement;
            if (
              focused?.matches(":focus-visible") &&
              event.currentTarget.contains(focused)
            )
              setHeldByFocus(true);
          }
        }}
        onPointerLeave={() => setHovered(false)}
        onFocus={(event) => {
          if (expanded && event.target.matches(":focus-visible"))
            setHeldByFocus(true);
        }}
        onBlur={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget)) {
            setOpened(false);
            setHeldByFocus(false);
          }
        }}
        onKeyDown={(event) => {
          if (event.key === "Escape" && expanded) {
            event.preventDefault();
            toggle.current?.focus();
            collapse();
          }
        }}
      >
        <div className="sidebar-header">
          <span className="sidebar-brand" aria-hidden="true">
            <span className="brand-mark">
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.7"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M5 16V8h5M10 15l4-4 3 2 3-5" />
              </svg>
            </span>
          </span>
          <h1 className={expanded ? undefined : "visually-hidden"}>
            Rep Workspace
          </h1>
          {username && (
            <button
              type="button"
              ref={toggle}
              className="sidebar-toggle"
              aria-expanded={expanded}
              aria-controls="workspace-nav workspace-user"
              aria-label={expanded ? "Collapse sidebar" : "Expand sidebar"}
              title={expanded ? "Collapse sidebar" : "Expand sidebar"}
              onClick={() => (expanded ? collapse() : setOpened(true))}
            >
              <WorkspaceIcon name={expanded ? "panelClose" : "panelOpen"} />
            </button>
          )}
        </div>
        {username && (
          <>
            <nav id="workspace-nav" aria-label="Workspace">
              <a
                className="pipeline-destination"
                href="#pipeline-title"
                onClick={(event) => event.preventDefault()}
                aria-current="page"
                aria-label="Pipeline"
                title="Pipeline"
              >
                <svg
                  aria-hidden="true"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                >
                  <path d="M5 19v-4m5 4v-8m5 8V8m5 11V4" />
                </svg>
                {expanded && <span>Pipeline</span>}
              </a>
            </nav>
            <div className="sidebar-user">
              <span className="avatar" aria-hidden="true">
                {initials}
              </span>
              <div id="workspace-user" hidden={!expanded}>
                <p title={username}>{username}</p>
                <button
                  type="button"
                  className="sidebar-signout"
                  onClick={signOut}
                  disabled={signingOut}
                >
                  <WorkspaceIcon name="signOut" /> Sign out
                </button>
              </div>
            </div>
          </>
        )}
      </header>
    </div>
  );
}
