import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './style.css';

type Account = { Id: string; Name: string };
type Session = { username: string; accounts: Account[]; accountError?: string };

function App() {
  const [session, setSession] = useState<Session>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(new URLSearchParams(location.search).get('error') === 'oauth'
    ? 'Salesforce sign-in did not complete. Check the app settings and try again.'
    : '');

  useEffect(() => {
    fetch('/api/session').then(async response => {
      if (response.status === 401) return;
      if (!response.ok) throw new Error();
      setSession(await response.json());
    }).catch(() => setError('Could not check your Salesforce session. Reload to try again.'))
      .finally(() => setLoading(false));
  }, []);

  async function signOut() {
    try {
      const response = await fetch('/auth/logout', { method: 'POST' });
      if (!response.ok) throw new Error();
      location.assign('/');
    } catch {
      setError('Could not sign out. Try again.');
    }
  }

  return <main>
    <header><h1>Rep Workspace</h1>{session && <button onClick={signOut}>Sign out</button>}</header>
    {error && <p role="alert">{error}</p>}
    {loading ? <p role="status">Checking Salesforce session...</p> : session ? <section>
      <p>Signed in as <strong>{session.username}</strong></p>
      <h2>Salesforce accounts</h2>
      {session.accountError ? <p role="alert">{session.accountError}</p> : session.accounts.length
        ? <ul>{session.accounts.map(account => <li key={account.Id}>{account.Name}</li>)}</ul>
        : <p>No accounts are visible to this Salesforce user.</p>}
    </section> : <section>
      <h2>Connect to Salesforce</h2>
      <p>Sign in to view accounts available to your Salesforce user.</p>
      <a className="button" href="/auth/login">Sign in with Salesforce</a>
    </section>}
  </main>;
}

createRoot(document.getElementById('root')!).render(<App />);
