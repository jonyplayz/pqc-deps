/**
 * On a library page: admins get "Refresh now"; visitors can request a re-check.
 */
import { useEffect, useState } from 'preact/hooks';
import { postJson, whoAmI, type ApiResult } from './api';
import { Turnstile } from './Turnstile';

export default function LibraryActions({ id, name }: { id: string; name: string }) {
  const [admin, setAdmin] = useState<string | undefined>();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');
  const [token, setToken] = useState<string | null>(null);
  const [reset, setReset] = useState(0);
  const [result, setResult] = useState<ApiResult>();

  useEffect(() => {
    whoAmI().then(setAdmin);
  }, []);

  const refresh = async () => {
    setBusy(true);
    setResult(await postJson('/api/admin/refresh', { id }));
    setBusy(false);
  };

  const request = async (e: Event) => {
    e.preventDefault();
    setBusy(true);
    const r = await postJson('/api/request/recheck', { id, token, note });
    setResult(r);
    setBusy(false);
    if (r.error) setReset((n) => n + 1);
  };

  return (
    <div class="act">
      {admin ? (
        <>
          <button type="button" class="btn btn-primary" disabled={busy} onClick={refresh}>
            {busy ? 'Starting…' : 'Refresh now'}
          </button>
          <span class="act-muted">
            {' '}
            Signed in as @{admin}. Re-checks {name} and proposes changes for review.
          </span>
        </>
      ) : result?.ok ? null : !open ? (
        <button type="button" class="btn" onClick={() => setOpen(true)}>
          Request a re-check
        </button>
      ) : (
        <form class="act-form" onSubmit={request}>
          <label for="recheck-note">What changed? (optional)</label>
          <textarea
            id="recheck-note"
            rows={3}
            maxLength={1000}
            value={note}
            placeholder="e.g. version 4.2 added ML-DSA: link to release notes"
            onInput={(e) => setNote((e.target as HTMLTextAreaElement).value)}
          />
          <Turnstile onToken={setToken} resetKey={reset} />
          <div class="act-row">
            <button type="submit" class="btn btn-primary" disabled={!token || busy}>
              {busy ? 'Sending…' : 'Send request'}
            </button>
            <button type="button" class="btn" onClick={() => setOpen(false)}>
              Cancel
            </button>
          </div>
        </form>
      )}
      {result && (
        <p class={result.error ? 'act-err' : 'act-ok'} role="status">
          {result.error ?? result.message}
          {result.runsUrl && (
            <>
              {' '}
              <a href={result.runsUrl}>Follow progress</a>
            </>
          )}
        </p>
      )}
    </div>
  );
}
