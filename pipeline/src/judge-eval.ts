/**
 * Benchmark for the second opinion: real mistakes from the Nov 13-17 audit,
 * which it must reject, and real good claims, which it must accept.
 *
 *   npm run judge-eval -w pipeline                          (configured model)
 *   JUDGE_MODEL=gemini-3.5-flash-lite npm run judge-eval -w pipeline
 */
import { join } from 'node:path';
import { LibrarySchema } from '@pqc-deps/core';
import { REPO_ROOT } from '@pqc-deps/core/node';
import { secondOpinion, type JudgeItem } from './judge';
import { llmFromEnv } from './llm';

process.loadEnvFile(join(REPO_ROOT, '.env'));
process.env.LLM_MODEL = process.env.JUDGE_MODEL ?? process.env.LLM_MODEL;
const lib = (id: string, name: string) =>
  LibrarySchema.parse({
    id,
    name,
    ecosystem: 'c-cpp',
    overall_status: 'unknown',
    last_verified: '2026-11-18',
  });

const cases: Array<{ lib: ReturnType<typeof lib>; item: JudgeItem; expect: string }> = [
  {
    lib: lib('liboqs', 'liboqs'),
    expect: 'version_ok=false (testing line)',
    item: {
      key: 'a',
      algorithm: 'ml-dsa',
      support: 'yes',
      since_version: '0.13.0',
      quotes: [
        { text: '- ML-DSA: Improved testing for ML-DSA.', release: 'liboqs version 0.13.0' },
      ],
    },
  },
  {
    lib: lib('liboqs', 'liboqs'),
    expect: 'version_ok=false (default implementation switch)',
    item: {
      key: 'b',
      algorithm: 'ml-kem',
      support: 'yes',
      since_version: '0.13.0',
      quotes: [
        {
          text: "- ML-KEM: Changed the default ML-KEM implementation to [PQCP's mlkem-native](https://github.com/pq-code-package/mlkem-native).",
          release: 'liboqs version 0.13.0',
        },
      ],
    },
  },
  {
    lib: lib('liboqs-rust', 'liboqs-rust (oqs crate)'),
    expect: 'version_ok=false (dependency update)',
    item: {
      key: 'c',
      algorithm: 'hqc',
      support: 'yes',
      since_version: '0.3.0',
      quotes: [
        { text: 'Update liboqs (includes e.g. HQC round 3 update)', release: 'liboqs-rust 0.3.0' },
      ],
    },
  },
  {
    lib: lib('dotnet-crypto', '.NET (System.Security.Cryptography)'),
    expect: 'supports=false (also blocked in code first)',
    item: {
      key: 'd',
      algorithm: 'ml-kem',
      support: 'yes',
      quotes: [
        {
          text: '* [release/10.0] Fix IsSupported tests for ML-KEM by @github-actions[bot] in https://github.com/dotnet/runtime/pull/132512',
          release: '.NET 10.0.1',
        },
      ],
    },
  },
  {
    lib: lib('openssl', 'OpenSSL'),
    expect: 'default_ok=false (default provider)',
    item: {
      key: 'e',
      algorithm: 'ml-dsa',
      support: 'yes',
      default_enabled: true,
      quotes: [
        {
          text: 'Integrated into the default and FIPS providers.',
          release: 'Changes between 3.4 and 3.5.0',
        },
      ],
    },
  },
  {
    lib: lib('liboqs', 'liboqs'),
    expect: 'default_ok=false (build-config default)',
    item: {
      key: 'i',
      algorithm: 'hqc',
      support: 'yes',
      default_enabled: true,
      quotes: [
        { text: '`KEM_hqc_<1|3|5>` is now enabled by default.', release: 'liboqs version 0.16.0' },
      ],
    },
  },
  {
    lib: lib('rustls', 'rustls'),
    expect: 'default=true (false = safe miss)',
    item: {
      key: 'j',
      algorithm: 'ml-dsa',
      support: 'yes',
      default_enabled: true,
      quotes: [
        {
          text: 'Support for post-quantum secure ML-DSA certificates is now enabled by default in the aws-lc-rs crypto provider.',
          release: 'rustls 0.23.44',
        },
      ],
    },
  },
  {
    lib: lib('cloudflare-circl', 'CIRCL'),
    expect: 'all true',
    item: {
      key: 'f',
      algorithm: 'ml-kem',
      support: 'yes',
      since_version: 'v1.4.0',
      quotes: [{ text: 'New: ML-KEM compatible with FIPS-203.', release: 'CIRCL v1.4.0' }],
    },
  },
  {
    lib: lib('openssl', 'OpenSSL'),
    expect: 'all true',
    item: {
      key: 'g',
      algorithm: 'ml-kem',
      support: 'yes',
      since_version: '3.5.0',
      quotes: [
        {
          text: '* ML-KEM as specified in FIPS 203.',
          release: 'openssl/openssl CHANGES.md / ### Changes between 3.4 and 3.5.0 [8 Apr 2025]',
        },
      ],
    },
  },
  {
    lib: lib('go-crypto', 'Go standard library crypto'),
    expect: 'all true (default)',
    item: {
      key: 'h',
      algorithm: 'hybrid-tls',
      support: 'yes',
      since_version: '1.24',
      default_enabled: true,
      quotes: [
        {
          text: 'From Go 1.24, the default includes the [X25519MLKEM768] hybrid',
          release: 'crypto/tls docs',
        },
      ],
    },
  },
];

const llm = llmFromEnv();
for (const c of cases) {
  const v = (await secondOpinion(llm, c.lib, [c.item])).get(c.item.key);
  console.log(
    `${c.item.key} expect ${c.expect.padEnd(45)} -> supports=${v?.supports_claim} version=${v?.version_ok} default=${v?.default_ok} | ${v?.reason}`,
  );
}
console.log('model:', llm.label);
