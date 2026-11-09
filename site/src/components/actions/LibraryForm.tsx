/**
 * Library form used by both the public request page (with Turnstile) and the
 * admin page (posts straight to the add-library workflow).
 */
import { useState } from 'preact/hooks';
import { ECOSYSTEM_OPTIONS, postJson, type ApiResult } from './api';
import { Turnstile } from './Turnstile';

const EMPTY = {
  name: '',
  ecosystem: '',
  repo: '',
  homepage: '',
  description: '',
  packages: '',
  applicable: '',
  delegates: '',
  watch_urls: '',
  notes: '',
};
type Fields = typeof EMPTY;

export default function LibraryForm({ mode }: { mode: 'public' | 'admin' }) {
  const [f, setF] = useState<Fields>(EMPTY);
  const [token, setToken] = useState<string | null>(null);
  const [reset, setReset] = useState(0);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ApiResult>();
  const set = (k: keyof Fields) => (e: Event) =>
    setF({ ...f, [k]: (e.target as HTMLInputElement).value });

  const submit = async (e: Event) => {
    e.preventDefault();
    setBusy(true);
    const url = mode === 'admin' ? '/api/admin/add' : '/api/request/library';
    const r = await postJson(url, mode === 'admin' ? f : { ...f, token });
    setResult(r);
    setBusy(false);
    if (r.ok) setF(EMPTY);
    if (mode === 'public') setReset((n) => n + 1);
  };

  const field = (
    k: keyof Fields,
    label: string,
    opts: { required?: boolean; placeholder?: string; hint?: string; type?: string } = {},
  ) => (
    <label class="act-field">
      <span>
        {label}
        {opts.required && <span aria-hidden="true"> *</span>}
      </span>
      <input
        type={opts.type ?? 'text'}
        required={opts.required}
        value={f[k]}
        placeholder={opts.placeholder}
        onInput={set(k)}
      />
      {opts.hint && <small>{opts.hint}</small>}
    </label>
  );

  return (
    <form class="act-form" onSubmit={submit}>
      <div class="act-grid">
        {field('name', 'Library name', { required: true, placeholder: 'Botan' })}
        <label class="act-field">
          <span>
            Ecosystem<span aria-hidden="true"> *</span>
          </span>
          <select required value={f.ecosystem} onChange={set('ecosystem')}>
            <option value="">Choose…</option>
            {ECOSYSTEM_OPTIONS.map(([v, l]) => (
              <option value={v}>{l}</option>
            ))}
          </select>
        </label>
        {field('repo', 'Source repository URL', {
          required: true,
          type: 'url',
          placeholder: 'https://github.com/randombit/botan',
        })}
        {field('homepage', 'Homepage', { type: 'url', placeholder: 'https://botan.randombit.net' })}
        {field('description', 'Short description', { placeholder: 'C++ cryptography library' })}
        {field('packages', 'Package names', {
          placeholder: 'npm:jose pypi:cryptography',
          hint: 'registry:name, space separated. Registries: npm, pypi, go, maven, cargo, nuget.',
        })}
        {field('applicable', 'Applicable algorithms', {
          placeholder: 'ml-kem ml-dsa',
          hint: 'Leave empty if unsure. Options: ml-kem, ml-dsa, slh-dsa, hybrid-tls.',
        })}
        {field('delegates', 'Delegates crypto to', {
          placeholder: 'openssl',
          hint: 'Catalog ids, if it uses another library for crypto.',
        })}
        {field('watch_urls', 'Pages to watch for evidence', {
          placeholder: 'https://botan.randombit.net/news.html',
          hint: 'Release notes or changelog pages (https), space separated.',
        })}
      </div>
      {mode === 'public' && (
        <>
          <label class="act-field">
            <span>Anything else?</span>
            <textarea
              rows={3}
              maxLength={1500}
              value={f.notes}
              onInput={set('notes')}
              placeholder="Known PQC support or plans, with links"
            />
          </label>
          <Turnstile onToken={setToken} resetKey={reset} />
        </>
      )}
      <div class="act-row">
        <button
          type="submit"
          class="btn btn-primary"
          disabled={busy || (mode === 'public' && !token)}
        >
          {busy ? 'Sending…' : mode === 'admin' ? 'Add library' : 'Send request'}
        </button>
      </div>
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
    </form>
  );
}
