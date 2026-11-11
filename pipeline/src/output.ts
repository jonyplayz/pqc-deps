import { stringify } from 'yaml';
import { ALGORITHM_INFO, ALGORITHMS, STATUS_INFO, type Library } from '@pqc-deps/core';
import type { RunResult } from './run';

const KEY_ORDER: Array<keyof Library> = [
  'id',
  'name',
  'ecosystem',
  'description',
  'homepage',
  'repo',
  'package_names',
  'separate_versioning',
  'implicit_for',
  'delegates_to',
  'applicable_algorithms',
  'overall_status',
  'algorithms',
  'roadmap',
  'fips',
  'upgrade_notes',
  'notes',
  'last_verified',
  'pipeline',
];

/** Serialize a library in a stable, review-friendly key order. */
export function libraryToYaml(lib: Library): string {
  const ordered: Record<string, unknown> = {};
  for (const k of KEY_ORDER) {
    const v = lib[k];
    if (v === undefined) continue;
    if (Array.isArray(v) && !v.length && k === 'delegates_to') continue;
    if (
      v &&
      typeof v === 'object' &&
      !Array.isArray(v) &&
      !Object.keys(v).length &&
      k !== 'algorithms'
    )
      continue;
    if (k === 'algorithms') {
      const algs: Record<string, unknown> = {};
      for (const a of ALGORITHMS) if (lib.algorithms[a]) algs[a] = lib.algorithms[a];
      ordered[k] = algs;
    } else ordered[k] = v;
  }
  return `# yaml-language-server: $schema=../schema/library.schema.json\n${stringify(ordered, { lineWidth: 0 })}`;
}

const esc = (s: string) => s.replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');

/** Markdown report for human review (PR body / proposals/<id>.md). */
export function reportMarkdown(r: RunResult, existing: Library): string {
  const lines: string[] = [];
  lines.push(`## ${existing.name} (\`${r.id}\`)`, '');
  if (r.model)
    lines.push(
      `Model: \`${r.model}\` · Documents: ${r.docs.length} used of ${r.totalFetched} fetched`,
      '',
    );
  else
    lines.push(
      `Dry run (no LLM). Documents: ${r.docs.length} mention PQC, of ${r.totalFetched} fetched.`,
      '',
    );

  if (r.error) lines.push(`> **Error:** ${r.error}`, '');

  if (r.library) {
    const st = r.library.overall_status;
    lines.push(`**Proposed status:** ${STATUS_INFO[st].label} (\`${st}\`)`, '');
    if (r.changes.length) {
      lines.push('### Changes', '', '| Field | Before | After |', '| --- | --- | --- |');
      for (const c of r.changes)
        lines.push(`| \`${c.field}\` | ${esc(c.before)} | ${esc(c.after)} |`);
      lines.push('');
    } else lines.push('No changes besides `last_verified`.', '');

    lines.push('### Evidence for each claim', '');
    for (const a of ALGORITHMS) {
      const s = r.library.algorithms[a];
      if (!s || s.support === 'unknown') continue;
      lines.push(
        `- **${ALGORITHM_INFO[a].label}**: ${s.support}${s.since_version ? ` since ${s.since_version}` : ''}${s.default_enabled !== undefined ? `, default ${s.default_enabled ? 'on' : 'off'}` : ''}${s.experimental ? ', experimental' : ''}`,
      );
      for (const src of s.sources)
        lines.push(`  - [${esc(src.title)}](${src.url}): "${esc(src.quote)}"`);
    }
    if (r.library.roadmap) {
      const rm = r.library.roadmap;
      lines.push(
        `- **Roadmap** (${rm.confidence}): ${rm.summary ?? ''} ${rm.target_version ? `target ${rm.target_version}` : ''} ${rm.target_date ?? ''}`.trim(),
      );
      for (const src of rm.sources)
        lines.push(`  - [${esc(src.title)}](${src.url}): "${esc(src.quote)}"`);
    }
    if (r.library.fips && r.library.fips.status !== 'unknown') {
      lines.push(`- **FIPS**: ${r.library.fips.status}`);
      for (const src of r.library.fips.sources)
        lines.push(`  - [${esc(src.title)}](${src.url}): "${esc(src.quote)}"`);
    }
    if (r.library.upgrade_notes)
      lines.push(
        '',
        `**Upgrade notes (generated from the verified claims):** ${r.library.upgrade_notes}`,
      );
    lines.push('');
  }

  if (r.dropped.length) {
    lines.push('### Dropped (failed verification, left unknown)', '');
    for (const d of r.dropped) lines.push(`- \`${d.field}\`: ${esc(d.claim)} (${d.reason})`);
    lines.push('');
  }
  if (r.kept.length)
    lines.push('### Kept from the existing entry', '', ...r.kept.map((k) => `- ${k}`), '');
  if (r.reviewerNotes) lines.push('### Model notes for the reviewer', '', r.reviewerNotes, '');
  if (r.warnings.length)
    lines.push('### Warnings', '', ...r.warnings.map((w) => `- ${esc(w)}`), '');

  lines.push(
    '<details><summary>Documents given to the model</summary>',
    '',
    ...r.docs.map(
      (d) =>
        `- ${d.id} [${esc(d.title)}](${d.url}) · ${d.kind}${d.date ? ` · ${d.date}` : ''} · ${d.hits} PQC mention(s)`,
    ),
    '',
    '</details>',
    '',
    '**Reviewer checklist:** open each source, confirm the quote supports the claim, check versions and the default/opt-in flags, then approve.',
  );
  return lines.join('\n');
}
