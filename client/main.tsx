import { useState } from "react";
import { createRoot } from "react-dom/client";
import { useRead } from "./api";
import { Pipeline, ReadError } from "./PipelineView";
import { Snapshot } from "./Snapshot";
import type { PipelineData, SnapshotData } from "./pipeline";
import "./style.css";

function Workspace() {
  const pipeline = useRead<PipelineData>("/api/pipeline");
  const [selected, setSelected] = useState<string>();
  const active =
    pipeline.data?.rows.find((row) => row.Id === selected) ??
    pipeline.data?.rows.find((row) => row.AccountId && row.accountName);
  const account = useRead<SnapshotData>(
    active?.AccountId ? "/api/accounts/" + active.AccountId : undefined
  );
  if (pipeline.error?.status === 401 || account.error?.status === 401) {
    return (
      <section className="panel welcome">
        <h2>Salesforce session expired</h2>
        <SignIn />
      </section>
    );
  }
  return (
    <div className="workspace">
      <section className="panel pipeline" aria-labelledby="pipeline-title">
        <div className="panel-header">
          <h2 id="pipeline-title">My pipeline</h2>
          <p>Open opportunities across your accounts</p>
        </div>
        {pipeline.loading && (
          <p className="notice" role="status">
            Loading your opportunities…
          </p>
        )}
        {pipeline.error && (
          <ReadError retry={pipeline.retry}>{pipeline.error.message}</ReadError>
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
            onSelect={(row) => setSelected(row.Id)}
          />
        )}
      </section>
      <aside className="panel snapshot" aria-labelledby="snapshot-title">
        <div className="panel-header">
          <h2 id="snapshot-title">Account snapshot</h2>
          {active && <p>Selected opportunity · {active.Name}</p>}
        </div>
        {!active && (
          <p className="notice">Select an opportunity to view its account.</p>
        )}
        {account.loading && (
          <p className="notice" role="status">
            Loading account snapshot…
          </p>
        )}
        {account.error && (
          <ReadError retry={account.retry}>{account.error.message}</ReadError>
        )}
        {account.data && <Snapshot data={account.data} />}
      </aside>
    </div>
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
