/** The /admin page: requests queue, refresh, add library, recent activity. */
import { useEffect, useState } from 'preact/hooks';
import { getJson, postJson, type ApiResult } from './api';
import LibraryForm from './LibraryForm';

interface Req {
  number: number;
  kind?: 'recheck' | 'library';
  title: string;
  url: string;
  created: string;
  body: string;
}
interface Activity {
  runs: Array<{
    title: string;
    workflow: string;
    status: string;
    conclusion: string | null;
    url: string;
    created: string;
  }>;
  proposals: Array<{ number: number; title: string; url: string; created: string }>;
}

const when = (iso: string) => new Date(iso).toLocaleString();

export default function AdminApp() {
  const [login, setLogin] = useState<string>();
  const [auth, setAuth] = useState<{ status: number; error: string }>();
  const [requests, setRequests] = useState<Req[]>();
  const [activity, setActivity] = useState<Activity>();
  const [libs, setLibs] = useState<Array<{ id: string; name: string }>>([]);
  const [selected, setSelected] = useState('');
  const [msg, setMsg] = useState<ApiResult>();
  const [busy, setBusy] = useState<string>();

  const loadRequests = () =>
    getJson<{ requests: Req[] }>('/api/admin/requests').then((r) =>
      setRequests(r.data?.requests ?? []),
    );
  const loadActivity = () =>
    getJson<Activity>('/api/admin/activity').then((r) => r.data && setActivity(r.data));

  useEffect(() => {
    getJson<{ login: string }>('/api/admin/whoami').then((r) => {
      if (!r.data) return setAuth({ status: r.status, error: r.error ?? 'Not signed in.' });
      setLogin(r.data.login);
      loadRequests();
      loadActivity();
      fetch('/api/catalog.json')
        .then((x) => x.json())
        .then((c: { libraries: Array<{ id: string; name: string }> }) =>
          setLibs(
            c.libraries
              .map((l) => ({ id: l.id, name: l.name }))
              .sort((a, b) => a.name.localeCompare(b.name)),
          ),
        );
    });
  }, []);

  const signOut = async () => {
    await postJson('/api/auth/logout', {});
    window.location.reload();
  };

  if (auth) {
    // 401: not signed in. 403: signed in but not a maintainer. 503: login not set up.
    return (
      <div class="card">
        {auth.status === 401 ? (
          <>
            <p>This page is for the project's maintainers.</p>
            <a class="btn btn-primary" href="/api/auth/login?return=/admin">
              Sign in with GitHub
            </a>
          </>
        ) : (
          <>
            <p class="act-err" role="alert">
              {auth.error}
            </p>
            {auth.status === 403 && (
              <button class="btn" onClick={signOut}>
                Sign out
              </button>
            )}
          </>
        )}
      </div>
    );
  }
  if (!login) return <p class="act-muted">Checking your sign-in…</p>;

  const decide = async (r: Req, action: 'approve' | 'reject') => {
    let reason = '';
    if (action === 'reject') {
      const answer = window.prompt('Reason shown to the requester (optional):', '');
      if (answer === null) return;
      reason = answer;
    }
    setBusy(`req-${r.number}`);
    const result = await postJson(`/api/admin/requests/${r.number}`, { action, reason });
    setMsg(result);
    setBusy(undefined);
    // GitHub's issue list lags a few seconds after a change, so drop the
    // decided request locally instead of trusting an immediate reload.
    if (!result.error) setRequests((list) => list?.filter((x) => x.number !== r.number));
    window.scrollTo({ top: 0, behavior: 'smooth' });
    setTimeout(loadActivity, 4000);
  };

  const refresh = async () => {
    if (!selected) return;
    setBusy('refresh');
    setMsg(await postJson('/api/admin/refresh', { id: selected }));
    setBusy(undefined);
    setTimeout(loadActivity, 4000);
  };

  return (
    <div class="admin">
      <p class="act-muted">
        Signed in as @{login} ·{' '}
        <button class="btn act-small" onClick={signOut}>
          Sign out
        </button>
      </p>
      {msg && (
        <p class={msg.error ? 'act-err' : 'act-ok'} role="status">
          {msg.error ?? msg.message} {msg.runsUrl && <a href={msg.runsUrl}>Follow progress</a>}
        </p>
      )}

      <section class="card">
        <h2>Requests from visitors</h2>
        {!requests ? (
          <p class="act-muted">Loading…</p>
        ) : requests.length === 0 ? (
          <p class="act-muted">No open requests.</p>
        ) : (
          <ul class="admin-list">
            {requests.map((r) => (
              <li>
                <div>
                  <strong>{r.kind === 'recheck' ? 'Re-check' : 'New library'}</strong>:{' '}
                  <a href={r.url}>{r.title}</a>
                  <span class="act-muted"> · {when(r.created)}</span>
                </div>
                <details>
                  <summary>Details</summary>
                  <pre>{r.body}</pre>
                </details>
                <div class="act-row">
                  <button
                    class="btn btn-primary"
                    disabled={!!busy}
                    onClick={() => decide(r, 'approve')}
                  >
                    {r.kind === 'recheck' ? 'Approve and re-check' : 'Approve and add'}
                  </button>
                  <button class="btn" disabled={!!busy} onClick={() => decide(r, 'reject')}>
                    Reject
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section class="card">
        <h2>Refresh a library</h2>
        <div class="act-row">
          <label class="sr-only" for="lib-select">
            Library
          </label>
          <select
            id="lib-select"
            value={selected}
            onChange={(e) => setSelected((e.target as HTMLSelectElement).value)}
          >
            <option value="">Choose a library…</option>
            {libs.map((l) => (
              <option value={l.id}>{l.name}</option>
            ))}
          </select>
          <button class="btn btn-primary" disabled={!selected || !!busy} onClick={refresh}>
            {busy === 'refresh' ? 'Starting…' : 'Refresh now'}
          </button>
        </div>
        <p class="act-muted">
          Changes arrive as a pull request for review; nothing is published until it's merged.
        </p>
      </section>

      <section class="card">
        <h2>Add a library</h2>
        <LibraryForm mode="admin" />
      </section>

      <section class="card">
        <h2>
          Recent activity{' '}
          <button class="btn act-small" onClick={loadActivity}>
            Reload
          </button>
        </h2>
        {!activity ? (
          <p class="act-muted">Loading…</p>
        ) : (
          <>
            <h3>Proposals waiting for review</h3>
            {activity.proposals.length === 0 ? (
              <p class="act-muted">None.</p>
            ) : (
              <ul>
                {activity.proposals.map((p) => (
                  <li>
                    <a href={p.url}>
                      #{p.number} {p.title}
                    </a>
                  </li>
                ))}
              </ul>
            )}
            <h3>Workflow runs</h3>
            <ul>
              {activity.runs.map((r) => (
                <li>
                  <a href={r.url}>{r.title}</a>{' '}
                  <span class={r.conclusion === 'failure' ? 'act-err-inline' : 'act-muted'}>
                    · {r.status === 'completed' ? r.conclusion : r.status} · {when(r.created)}
                  </span>
                </li>
              ))}
            </ul>
          </>
        )}
      </section>
    </div>
  );
}
