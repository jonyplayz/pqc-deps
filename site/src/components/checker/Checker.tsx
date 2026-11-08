/**
 * "Check my project": parses dependency manifests in the browser and matches
 * them against /api/catalog.json. Nothing the user pastes leaves the page.
 */
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { Library } from '@pqc-deps/core';
import type { DelegationNode } from '@pqc-deps/core';
import {
  MANIFEST_FORMATS,
  ManifestError,
  checkManifest,
  indexCatalog,
  parseManifest,
  type CatalogIndex,
  type CheckReport,
  type Dependency,
  type Finding,
  type ManifestFormat,
  type Verdict,
} from '@pqc-deps/core/check';
import { ALGORITHM_INFO, STATUS_INFO } from '@pqc-deps/core/status';
import { SAMPLES } from './samples';

interface Props {
  repoUrl: string;
}

interface Input {
  name: string;
  text: string;
}

type Result = { name: string; report: CheckReport } | { name: string; error: string };

const VERDICT: Record<
  Verdict,
  { label: string; tone: 'good' | 'bad' | 'warn' | 'info' | 'muted' }
> = {
  ok: { label: 'PQC available', tone: 'good' },
  upgrade: { label: 'Upgrade needed', tone: 'bad' },
  'check-installed': { label: 'Check installed version', tone: 'warn' },
  'version-unknown': { label: 'Version unknown', tone: 'warn' },
  'not-comparable': { label: 'Check bundled version', tone: 'warn' },
  'not-yet': { label: 'No PQC yet', tone: 'bad' },
  unknown: { label: 'Not researched', tone: 'muted' },
  delegated: { label: 'Delegates crypto', tone: 'info' },
};

function advice(f: Finding): string {
  const lib = f.library.name;
  const algs = f.algorithms.map((a) => ALGORITHM_INFO[a].label).join(', ');
  switch (f.verdict) {
    case 'ok':
      return `Your version includes PQC support${algs ? ` (${algs})` : ''}.`;
    case 'upgrade':
      return `Upgrade ${lib} to ${f.upgradeTo} or later${algs ? ` for ${algs}` : ''}.`;
    case 'check-installed':
      return `Your version range allows releases older than ${f.upgradeTo}. Make sure the installed version is ${f.upgradeTo} or later (check your lockfile).`;
    case 'version-unknown':
      return f.upgradeTo
        ? `PQC support starts at ${f.upgradeTo}. We couldn't tell which version you use.`
        : `${lib} supports PQC, but we couldn't determine the minimum version.`;
    case 'not-comparable':
      return `This package's version numbers don't follow ${lib}'s. Check that the ${lib} it uses is ${f.upgradeTo} or later.`;
    case 'not-yet': {
      const r = f.library.roadmap;
      const eta = [r?.target_version && `version ${r.target_version}`, r?.target_date]
        .filter(Boolean)
        .join(', ');
      return f.library.overall_status === 'planned'
        ? `No PQC support yet. A public plan exists${eta ? ` (target: ${eta})` : ''}.`
        : 'No PQC support and no public plan found. Consider alternatives.';
    }
    case 'unknown':
      return 'Not researched yet, or the evidence is inconclusive.';
    case 'delegated':
      return `${lib} doesn't do the cryptography itself. What matters is the libraries below.`;
  }
}

const isDevScope = (d?: Dependency) =>
  !!d?.scope && /^(dev|test|group:dev|group:test|build)/.test(d.scope);

function Chain({ nodes }: { nodes: DelegationNode[] }) {
  if (!nodes.length) return null;
  return (
    <ul class="chk-chain">
      {nodes.map((n) => (
        <li key={n.library.id}>
          <a href={`/libraries/${n.library.id}`}>{n.library.name}</a>{' '}
          <span
            class={`chk-st chk-st-${n.library.overall_status === 'n/a' ? 'na' : n.library.overall_status}`}
          >
            {STATUS_INFO[n.library.overall_status].label}
          </span>
          {n.condition && <span class="chk-muted"> ({n.condition})</span>}
          <Chain nodes={n.children} />
        </li>
      ))}
    </ul>
  );
}

function FindingRow({ f }: { f: Finding }) {
  const v = VERDICT[f.verdict];
  const d = f.dependency;
  return (
    <li class="chk-finding">
      <div class="chk-finding-head">
        <span class={`chk-verdict chk-${v.tone}`}>{v.label}</span>
        <a class="chk-lib" href={`/libraries/${f.library.id}`}>
          {f.library.name}
        </a>
        <span
          class={`chk-st chk-st-${f.library.overall_status === 'n/a' ? 'na' : f.library.overall_status}`}
        >
          {STATUS_INFO[f.library.overall_status].label}
        </span>
      </div>
      <div class="chk-dep">
        {d ? (
          <>
            <code>{d.name}</code>
            {d.version && <code class="chk-ver">{d.version}</code>}
            <span class="chk-muted">
              {d.direct ? 'direct' : 'transitive'}
              {d.scope ? ` · ${d.scope}` : ''}
            </span>
          </>
        ) : (
          <span class="chk-muted">Runtime / standard library</span>
        )}
      </div>
      <p class="chk-advice">{advice(f)}</p>
      {f.note && <p class="chk-muted chk-small">{f.note}</p>}
      {f.library.upgrade_notes && f.verdict !== 'ok' && (
        <p class="chk-small">
          <strong>Upgrade notes:</strong> {f.library.upgrade_notes}
        </p>
      )}
      {f.chain.length > 0 && (
        <div class="chk-small">
          <span class="chk-muted">Cryptography provided by:</span>
          <Chain nodes={f.chain} />
        </div>
      )}
    </li>
  );
}

function Report({
  result,
  hideDev,
  repoUrl,
}: {
  result: Result;
  hideDev: boolean;
  repoUrl: string;
}) {
  if ('error' in result) {
    return (
      <section class="chk-report">
        <h2>{result.name}</h2>
        <p class="chk-error" role="alert">
          {result.error}
        </p>
      </section>
    );
  }
  const r = result.report;
  const findings = r.findings.filter((f) => !(hideDev && isDevScope(f.dependency)));
  const possiblyCrypto = r.possiblyCrypto.filter((d) => !(hideDev && isDevScope(d)));
  const untracked = r.untracked.filter((d) => !(hideDev && isDevScope(d)));
  const action = findings.filter((f) =>
    ['upgrade', 'not-yet', 'check-installed'].includes(f.verdict),
  ).length;

  return (
    <section class="chk-report">
      <h2>
        {result.name} <span class="chk-muted chk-small">({r.format})</span>
      </h2>
      <ul class="chk-summary">
        <li>
          <strong>{r.totalDependencies}</strong> dependencies read
        </li>
        <li>
          <strong>{findings.length}</strong> tracked crypto{' '}
          {findings.length === 1 ? 'library' : 'libraries'}
        </li>
        <li class={action ? 'chk-bad' : ''}>
          <strong>{action}</strong> need attention
        </li>
        <li>
          <strong>{possiblyCrypto.length}</strong> possibly crypto, not tracked
        </li>
      </ul>

      {r.warnings.length > 0 && (
        <ul class="chk-warnings">
          {r.warnings.map((w) => (
            <li>{w}</li>
          ))}
        </ul>
      )}

      {findings.length > 0 ? (
        <ul class="chk-findings">
          {findings.map((f) => (
            <FindingRow
              key={`${f.library.id}-${f.dependency?.name}-${f.dependency?.version}`}
              f={f}
            />
          ))}
        </ul>
      ) : (
        <p class="chk-muted">None of these dependencies are in the catalog yet.</p>
      )}

      {possiblyCrypto.length > 0 && (
        <>
          <h3>Possibly crypto-related, not tracked yet</h3>
          <p class="chk-muted chk-small">
            Their names suggest cryptography or TLS (a simple name check, so there may be false
            positives). Their PQC status is unknown.{' '}
            <a href={`${repoUrl}/issues/new?template=new-library.yml`}>Request a library</a>.
          </p>
          <ul class="chk-plain">
            {possiblyCrypto.map((d) => (
              <li>
                <code>{d.name}</code> {d.version && <code class="chk-ver">{d.version}</code>}
              </li>
            ))}
          </ul>
        </>
      )}

      {untracked.length > 0 && (
        <details class="chk-details">
          <summary>{untracked.length} other dependencies not in the catalog</summary>
          <p class="chk-muted chk-small">
            Most likely not crypto libraries, but they may still use crypto internally.
          </p>
          <ul class="chk-plain chk-cols">
            {untracked.map((d) => (
              <li>
                <code>{d.name}</code>
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}

export default function Checker({ repoUrl }: Props) {
  const [catalog, setCatalog] = useState<CatalogIndex | null>(null);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [text, setText] = useState('');
  const [format, setFormat] = useState<'' | ManifestFormat>('');
  const [files, setFiles] = useState<Input[]>([]);
  const [results, setResults] = useState<Result[] | null>(null);
  const [hideDev, setHideDev] = useState(true);
  const [dragging, setDragging] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    fetch('/api/catalog.json')
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((data: { libraries: Library[] }) => setCatalog(indexCatalog(data.libraries)))
      .catch((e) =>
        setCatalogError(`Couldn't load the catalog (${e.message}). Try reloading the page.`),
      );
  }, []);

  const readFiles = async (list: FileList | null) => {
    if (!list) return;
    const read = await Promise.all(
      [...list].slice(0, 20).map(async (f) => ({ name: f.name, text: await f.text() })),
    );
    setFiles(read);
    setResults(null);
  };

  const run = () => {
    if (!catalog) return;
    const inputs: Input[] = files.length
      ? files
      : text.trim()
        ? [{ name: 'Pasted manifest', text }]
        : [];
    setResults(
      inputs.map((input) => {
        try {
          const parsed = parseManifest(input.text, {
            ...(input.name !== 'Pasted manifest' ? { filename: input.name } : {}),
            ...(format && !files.length ? { format } : {}),
          });
          return { name: input.name, report: checkManifest(parsed, catalog) };
        } catch (e) {
          return {
            name: input.name,
            error:
              e instanceof ManifestError ? e.message : `Unexpected error: ${(e as Error).message}`,
          };
        }
      }),
    );
    requestAnimationFrame(() => document.getElementById('chk-results')?.focus());
  };

  const canRun = !!catalog && (files.length > 0 || text.trim().length > 0);
  const sampleButtons = useMemo(() => Object.keys(SAMPLES), []);

  return (
    <div class="chk">
      <div
        class={`chk-input${dragging ? ' chk-drag' : ''}`}
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          void readFiles(e.dataTransfer?.files ?? null);
        }}
      >
        <label for="chk-text" class="chk-label">
          Paste a manifest, or drop files here
        </label>
        <textarea
          id="chk-text"
          rows={12}
          spellcheck={false}
          placeholder={'{\n  "dependencies": { "jose": "^5.2.0" }\n}'}
          value={text}
          disabled={files.length > 0}
          onInput={(e) => {
            setText((e.target as HTMLTextAreaElement).value);
            setResults(null);
          }}
        />
        <div class="chk-controls">
          <label class="chk-inline">
            Format{' '}
            <select
              value={format}
              disabled={files.length > 0}
              onChange={(e) =>
                setFormat((e.target as HTMLSelectElement).value as ManifestFormat | '')
              }
            >
              <option value="">Auto-detect</option>
              {MANIFEST_FORMATS.map((f) => (
                <option value={f}>{f}</option>
              ))}
            </select>
          </label>
          <button type="button" class="btn" onClick={() => fileInput.current?.click()}>
            Choose files…
          </button>
          <input
            ref={fileInput}
            type="file"
            multiple
            hidden
            accept=".json,.txt,.in,.toml,.mod,.xml,.gradle,.kts,.lock,.pom"
            onChange={(e) => void readFiles((e.target as HTMLInputElement).files)}
          />
          <button type="button" class="btn btn-primary" disabled={!canRun} onClick={run}>
            Check dependencies
          </button>
        </div>
        {files.length > 0 && (
          <p class="chk-small">
            Selected: {files.map((f) => f.name).join(', ')}{' '}
            <button
              type="button"
              class="chk-link"
              onClick={() => {
                setFiles([]);
                setResults(null);
                if (fileInput.current) fileInput.current.value = '';
              }}
            >
              clear
            </button>
          </p>
        )}
        <p class="chk-small chk-muted">
          Try an example:{' '}
          {sampleButtons.map((k, i) => (
            <>
              {i > 0 && ' · '}
              <button
                type="button"
                class="chk-link"
                onClick={() => {
                  setFiles([]);
                  setText(SAMPLES[k]!.text);
                  setFormat('');
                  setResults(null);
                }}
              >
                {k}
              </button>
            </>
          ))}
        </p>
      </div>

      {catalogError && (
        <p class="chk-error" role="alert">
          {catalogError}
        </p>
      )}
      {!catalog && !catalogError && <p class="chk-muted">Loading catalog…</p>}

      {results && (
        <div id="chk-results" tabIndex={-1} aria-live="polite">
          <label class="chk-inline chk-small">
            <input
              type="checkbox"
              checked={hideDev}
              onChange={(e) => setHideDev((e.target as HTMLInputElement).checked)}
            />{' '}
            Hide dev, test and build dependencies
          </label>
          {results.length === 0 && <p class="chk-muted">Nothing to check.</p>}
          {results.map((r) => (
            <Report result={r} hideDev={hideDev} repoUrl={repoUrl} />
          ))}
        </div>
      )}
    </div>
  );
}
