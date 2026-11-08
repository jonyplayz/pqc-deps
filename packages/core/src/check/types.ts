import type { Registry } from '../constants';

export const MANIFEST_FORMATS = [
  'package.json',
  'package-lock.json',
  'requirements.txt',
  'pyproject.toml',
  'go.mod',
  'pom.xml',
  'build.gradle',
  'libs.versions.toml',
  'Cargo.toml',
  'Cargo.lock',
] as const;
export type ManifestFormat = (typeof MANIFEST_FORMATS)[number];

export interface Dependency {
  registry: Registry;
  /** Name as written in the manifest (for Maven: "groupId:artifactId"). */
  name: string;
  /** Version or version requirement as written / resolved. */
  version?: string;
  /** True when `version` is one concrete version (lockfile, pin), false for a range. */
  exact: boolean;
  /** Direct dependency (false = transitive, from a lockfile). */
  direct: boolean;
  /** e.g. "dev", "test", "optional", "build", "managed". Undefined = normal/runtime. */
  scope?: string;
}

/** The language runtime the manifest targets, when it says so. */
export interface Runtime {
  registry: Registry;
  name: 'node' | 'python' | 'go' | 'java';
  /** Usually a minimum (e.g. go.mod `go 1.24`, engines.node ">=22"). */
  version?: string;
}

export interface ParsedManifest {
  format: ManifestFormat;
  registry: Registry;
  dependencies: Dependency[];
  runtime?: Runtime;
  warnings: string[];
}

export class ManifestError extends Error {}
