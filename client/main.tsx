import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { useRead } from "./api";
import { Pipeline, ReadError } from "./PipelineView";
import { Snapshot } from "./Snapshot";
import {
  accountDisplayName,
  type PipelineData,
  type SnapshotData
} from "./pipeline";
import { NextActions, type ActionRecommendations } from "./NextActions";
import { runAction, withCloseDate } from "./actions";
import type { ActionInput } from "../server/actions";
import { createNotifications, type Toast } from "./notifications";
import { ToastRegion } from "./ToastRegion";
import "./style.css";

type CloseDateAction = Extract<ActionInput, { kind: "closeDate" }>;
function snapshotWithDate<T extends SnapshotData>(
  data: T,
  change?: CloseDateAction
): T {
  return change && "data" in data.opportunities
    ? {
        ...data,
        opportunities: { data: withCloseDate(data.opportunities.data, change) }
      }
    : data;
}

function Workspace() {
  const pipeline = useRead<PipelineData>("/api/pipeline");
  const [selected, setSelected] = useState<string>();
  const [follow, setFollow] = useState<{ id: string }>();
  const [pending, setPending] = useState<ActionInput["kind"]>();
  const busy = useRef(false);
  const [preview, setPreview] = useState<CloseDateAction>();
  const [toast, setToast] = useState<Toast>();
  const [notifications] = useState(() => createNotifications(setToast));
  const [validation, setValidation] = useState<{
    kind: ActionInput["kind"];
    message: string;
  }>();
  const [expired, setExpired] = useState(false);
  const active = selected
    ? pipeline.data?.rows.find((row) => row.Id === selected)
    : pipeline.data?.rows.find((row) => row.AccountId && row.accountName);
  const selectionKey = active?.AccountId
    ? active.AccountId + ":" + active.Id
    : undefined;
  useLayoutEffect(() => {
    notifications.navigate(selectionKey);
    setValidation(undefined);
  }, [notifications, selectionKey]);
  useEffect(() => () => notifications.dispose(), [notifications]);
  const account = useRead<SnapshotData & { actions?: ActionRecommendations }>(
    active?.AccountId
      ? "/api/accounts/" + active.AccountId + "?opportunity=" + active.Id
      : undefined
  );
  if (
    expired ||
    pipeline.error?.status === 401 ||
    account.error?.status === 401
  ) {
    return (
      <>
        <section className="panel welcome">
          <h2>Salesforce session expired</h2>
          <SignIn />
        </section>
        <ToastRegion toast={toast} notifications={notifications} />
      </>
    );
  }

  const blocked = Boolean(
    account.loading || account.error || pipeline.loading || pipeline.error
  );
  async function save(action: ActionInput) {
    const scope = notifications.capture();
    if (
      busy.current ||
      blocked ||
      !active ||
      scope.key !== action.accountId + ":" + action.opportunityId
    )
      return;
    const context =
      action.kind === "task" && active.accountName
        ? accountDisplayName(active.accountName)
        : active.Name;
    busy.current = true;
    setPending(action.kind);
    setValidation(undefined);
    try {
      await runAction(action, {
        preview: setPreview,
        confirm: (message) => {
          if (action.kind === "closeDate") {
            pipeline.updateCached((data) => ({
              ...data,
              rows: withCloseDate(data.rows, action)
            }));
            account.updateCached((data) => snapshotWithDate(data, action));
            if (notifications.isCurrent(scope))
              setFollow({ id: action.opportunityId });
          }
          notifications.publish(scope, { kind: "success", message, context });
        },
        reject: (error) => {
          if (error.status === 401) setExpired(true);
          notifications.publish(scope, {
            kind: "error",
            message: error.message,
            context
          });
          if (
            notifications.isCurrent(scope) &&
            (error.status === 400 || error.status === 422)
          ) {
            setValidation({ kind: action.kind, message: error.message });
          }
        },
        refresh: () => {
          pipeline.retry();
          account.retry();
        }
      });
    } finally {
      busy.current = false;
      setPending(undefined);
    }
  }

  return (
    <>
      <div className="workspace">
        <section className="panel pipeline" aria-labelledby="pipeline-title">
          <div className="panel-header">
            <h2 id="pipeline-title">My pipeline</h2>
            <p>Open opportunities across your accounts</p>
          </div>
          {pipeline.loading && (
            <p className="notice" role="status">
              {pipeline.data
                ? "Refreshing your opportunities..."
                : "Loading your opportunities..."}
            </p>
          )}
          {pipeline.error && (
            <ReadError retry={pipeline.retry}>
              {pipeline.error.message}
              {pipeline.data && " Showing the last loaded pipeline."}
            </ReadError>
          )}
          {pipeline.data?.accountWarning && (
            <p className="notice" role="status">
              {pipeline.data.accountWarning}
            </p>
          )}
          {pipeline.data && (
            <Pipeline
              data={pipeline.data}
              selected={active?.Id}
              onSelect={(row) => {
                notifications.navigate(
                  row.AccountId ? row.AccountId + ":" + row.Id : undefined
                );
                setSelected(row.Id);
              }}
              follow={follow}
              onFollow={(id) => setFollow({ id })}
              onLeaveFollow={() => setFollow(undefined)}
              preview={preview}
            />
          )}
        </section>
        <aside className="panel snapshot" aria-labelledby="snapshot-title">
          <div className="panel-header">
            <h2 id="snapshot-title">Account snapshot</h2>
            {active && <p>Selected opportunity: {active.Name}</p>}
          </div>
          {!active && (
            <p className="notice">
              {selected && pipeline.data
                ? "The selected opportunity is no longer available in your open pipeline."
                : "Select an opportunity to view its account."}
            </p>
          )}
          {account.loading && (
            <p className="notice" role="status">
              {account.data
                ? "Refreshing account snapshot..."
                : "Loading account snapshot..."}
            </p>
          )}
          {account.error && (
            <ReadError retry={account.retry}>
              {account.error.message}
              {account.data && " Showing the last loaded snapshot."}
            </ReadError>
          )}
          {pending && (
            <p role="status" className="notice">
              {preview
                ? "Saving the previewed close date..."
                : "Saving to Salesforce..."}
            </p>
          )}
          {account.data && active && (
            <>
              <NextActions
                key={active.Id}
                snapshot={account.data}
                selected={active}
                pending={pending}
                blocked={blocked}
                validation={validation}
                onInputChange={(kind) =>
                  setValidation((previous) =>
                    previous?.kind === kind ? undefined : previous
                  )
                }
                onAction={save}
              />
              <Snapshot data={snapshotWithDate(account.data, preview)} />
            </>
          )}
        </aside>
      </div>
      <ToastRegion toast={toast} notifications={notifications} />
    </>
  );
}

function SignIn() {
  return (
    <a className="primary" href="/auth/login">
      Sign in with Salesforce
    </a>
  );
}

function App() {
  const session = useRead<{ username: string }>("/api/session");
  const [logoutError, setLogoutError] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const oauthError =
    new URLSearchParams(location.search).get("error") === "oauth";
  async function signOut() {
    setSigningOut(true);
    setLogoutError(false);
    try {
      const response = await fetch("/auth/logout", { method: "POST" });
      if (!response.ok) throw new Error();
      location.assign("/");
    } catch {
      setLogoutError(true);
      setSigningOut(false);
    }
  }
  return (
    <>
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">
            RW
          </span>
          <h1>Rep Workspace</h1>
        </div>
        {session.data && (
          <div className="user">
            <span>{session.data.username}</span>
            <button className="quiet" onClick={signOut} disabled={signingOut}>
              Sign out
            </button>
          </div>
        )}
      </header>
      <main>
        {logoutError && <ReadError>Could not sign out. Try again.</ReadError>}
        {session.loading && (
          <p className="notice" role="status">
            Checking Salesforce session…
          </p>
        )}
        {session.error && session.error.status !== 401 && (
          <ReadError retry={session.retry}>{session.error.message}</ReadError>
        )}
        {session.error?.status === 401 && (
          <section className="panel welcome">
            <h2>Connect to Salesforce</h2>
            <p>Sign in to see your pipeline and account context.</p>
            {oauthError && (
              <ReadError>
                Salesforce sign-in did not complete. Check the app settings and
                try again.
              </ReadError>
            )}
            <SignIn />
          </section>
        )}
        {session.data && <Workspace />}
      </main>
    </>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
