import { detectFormat } from './detect';
import { parseCargoLock, parseCargoToml } from './parsers/cargo';
import { parseGoMod } from './parsers/go';
import { parseBuildGradle, parsePomXml, parseVersionCatalog } from './parsers/jvm';
import { parsePackageJson, parsePackageLock } from './parsers/npm';
import { parsePyprojectToml, parseRequirementsTxt } from './parsers/python';
import { ManifestError, type ManifestFormat, type ParsedManifest } from './types';

const PARSERS: Record<ManifestFormat, (text: string) => ParsedManifest> = {
  'package.json': parsePackageJson,
  'package-lock.json': parsePackageLock,
  'requirements.txt': parseRequirementsTxt,
  'pyproject.toml': parsePyprojectToml,
  'go.mod': parseGoMod,
  'pom.xml': parsePomXml,
  'build.gradle': parseBuildGradle,
  'libs.versions.toml': parseVersionCatalog,
  'Cargo.toml': parseCargoToml,
  'Cargo.lock': parseCargoLock,
};

/** Parse a manifest. `format` wins over `filename`, which wins over content sniffing. */
export function parseManifest(
  text: string,
  opts: { filename?: string; format?: ManifestFormat } = {},
): ParsedManifest {
  const format = opts.format ?? detectFormat(text, opts.filename);
  if (!format) {
    throw new ManifestError(
      "Couldn't recognise this file. Pick the format manually, or paste a package.json, package-lock.json, requirements.txt, pyproject.toml, go.mod, pom.xml, build.gradle, libs.versions.toml, Cargo.toml or Cargo.lock.",
    );
  }
  return PARSERS[format](text);
}
