import { XMLParser } from 'fast-xml-parser';
import { parse as parseToml } from 'smol-toml';
import { ManifestError, type Dependency, type ParsedManifest } from '../types';

/** A Maven/Gradle version is exact unless it's a range or still contains a placeholder. */
const isExact = (v: string) => !/[[\](),]|\$|\+|latest|release/i.test(v);

// ---------------------------------------------------------------- pom.xml

export function parsePomXml(text: string): ParsedManifest {
  let doc: any;
  try {
    doc = new XMLParser({
      ignoreAttributes: true,
      parseTagValue: false,
      isArray: (name) => name === 'dependency' || name === 'profile',
    }).parse(text);
  } catch (e) {
    throw new ManifestError(`Not valid XML: ${(e as Error).message}`);
  }
  const project = doc?.project;
  if (!project)
    throw new ManifestError('This does not look like a pom.xml (no <project> element).');
  const warnings: string[] = [];

  const props: Record<string, string> = {};
  for (const [k, v] of Object.entries(project.properties ?? {})) props[k] = String(v);
  const projectVersion = project.version ?? project.parent?.version;
  if (projectVersion) {
    props['project.version'] = String(projectVersion);
    props['pom.version'] = String(projectVersion);
  }
  const resolve = (v: unknown): string | undefined => {
    if (v === undefined || v === null || v === '') return undefined;
    let s = String(v).trim();
    for (let i = 0; i < 5 && s.includes('${'); i++)
      s = s.replace(/\$\{([^}]+)\}/g, (m, k) => props[k] ?? m);
    return s;
  };

  const managed = new Map<string, string>();
  for (const d of project.dependencyManagement?.dependencies?.dependency ?? []) {
    const v = resolve(d.version);
    if (d.groupId && d.artifactId && v) managed.set(`${d.groupId}:${d.artifactId}`, v);
  }

  const deps = new Map<string, Dependency>();
  const collect = (list: any[] | undefined, fromProfile?: string) => {
    for (const d of list ?? []) {
      if (!d.groupId || !d.artifactId) continue;
      const name = `${resolve(d.groupId)}:${resolve(d.artifactId)}`;
      const version = resolve(d.version) ?? managed.get(name);
      const scope =
        d.scope && d.scope !== 'compile'
          ? String(d.scope)
          : fromProfile
            ? `profile:${fromProfile}`
            : undefined;
      if (version?.includes('${'))
        warnings.push(
          `${name}: version ${version} uses a property defined elsewhere (parent POM?).`,
        );
      if (!deps.has(name)) {
        deps.set(name, {
          registry: 'maven',
          name,
          ...(version ? { version } : {}),
          exact: !!version && isExact(version),
          direct: true,
          ...(scope ? { scope } : {}),
        });
      }
    }
  };
  collect(project.dependencies?.dependency);
  for (const p of project.profiles?.profile ?? [])
    collect(p?.dependencies?.dependency, String(p?.id ?? 'profile'));
  // Managed-only entries (BOM imports, version pins) are still worth checking.
  for (const [name, version] of managed) {
    if (!deps.has(name))
      deps.set(name, {
        registry: 'maven',
        name,
        version,
        exact: isExact(version),
        direct: false,
        scope: 'managed',
      });
  }
  if ([...deps.values()].some((d) => !d.version)) {
    warnings.push(
      "Some versions come from a parent POM or BOM that isn't included, so they can't be checked.",
    );
  }

  const java =
    props['maven.compiler.release'] ??
    props['maven.compiler.target'] ??
    props['java.version'] ??
    props['maven.compiler.source'];
  return {
    format: 'pom.xml',
    registry: 'maven',
    dependencies: [...deps.values()],
    ...(java ? { runtime: { registry: 'maven', name: 'java', version: java } } : {}),
    warnings,
  };
}

// ---------------------------------------------------------------- build.gradle(.kts)

const CONFIGS =
  'implementation|api|compileOnly|runtimeOnly|testImplementation|testRuntimeOnly|testCompileOnly|annotationProcessor|kapt|ksp|compile|testCompile|runtime|classpath|androidTestImplementation|debugImplementation|releaseImplementation|compileOnlyApi';

/**
 * Remove /* block *\/ and // line comments without regexes (no backtracking
 * on huge or hostile input). A "//" right after ':' (as in https://) or inside
 * a quoted string is kept.
 */
export function stripComments(text: string): string {
  let out = '';
  let quote: string | undefined;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quote) {
      out += c;
      if (c === '\\') {
        out += text[i + 1] ?? '';
        i++;
      } else if (c === quote) quote = undefined;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      out += c;
    } else if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      i = end === -1 ? text.length : end + 1;
    } else if (c === '/' && text[i + 1] === '/' && text[i - 1] !== ':') {
      const end = text.indexOf('\n', i);
      i = end === -1 ? text.length : end - 1;
    } else out += c;
  }
  return out;
}

export function parseBuildGradle(text: string): ParsedManifest {
  const warnings: string[] = [];
  const src = stripComments(text);

  // Simple variables: def x = '1.2', val x = "1.2", ext.x = '1.2', set("x", "1.2"), x = '1.2' inside ext {}
  const vars: Record<string, string> = {};
  for (const m of src.matchAll(
    /(?:\b(?:def|val|var)\s+|\bext\.)?\b([A-Za-z_][\w.]*)\s*=\s*["']([^"'$]+)["']/g,
  ))
    vars[m[1]!] = m[2]!;
  for (const m of src.matchAll(/\bset\(\s*["']([\w.]+)["']\s*,\s*["']([^"'$]+)["']\s*\)/g))
    vars[m[1]!] = m[2]!;
  const resolve = (v: string | undefined) =>
    v?.replace(
      /\$\{?([A-Za-z_][\w.]*)\}?/g,
      (m, k: string) => vars[k] ?? vars[k.replace(/^(project\.|rootProject\.|ext\.)/, '')] ?? m,
    );

  const deps = new Map<string, Dependency>();
  const add = (config: string, group: string, artifact: string, rawVersion?: string) => {
    const version = resolve(rawVersion);
    const name = `${group}:${artifact}`;
    const scope = /^(test|androidTest)/.test(config)
      ? 'test'
      : /Only$|kapt|ksp|annotationProcessor/.test(config)
        ? config
        : undefined;
    if (version?.includes('$'))
      warnings.push(`${name}: version ${version} uses a variable this tool can't resolve.`);
    if (!deps.has(name) || !deps.get(name)!.version) {
      deps.set(name, {
        registry: 'maven',
        name,
        ...(version ? { version } : {}),
        exact: !!version && isExact(version),
        direct: true,
        ...(scope ? { scope } : {}),
      });
    }
  };

  // implementation 'g:a:v' / implementation("g:a:v") / implementation(platform("g:a:v"))
  const stringNotation = new RegExp(
    `\\b(${CONFIGS})\\s*\\(?\\s*(?:(?:platform|enforcedPlatform)\\s*\\(\\s*)?["']([^"':\\s]+):([^"':\\s]+)(?::([^"'@\\s]+))?(?:@\\w+)?["']`,
    'g',
  );
  for (const m of src.matchAll(stringNotation)) add(m[1]!, m[2]!, m[3]!, m[4]);

  // implementation group: 'g', name: 'a', version: 'v'  /  (group = "g", name = "a", version = "v")
  const mapNotation = new RegExp(
    `\\b(${CONFIGS})\\s*\\(?\\s*group\\s*[:=]\\s*["']([^"']+)["']\\s*,\\s*name\\s*[:=]\\s*["']([^"']+)["'](?:\\s*,\\s*version\\s*[:=]\\s*["']([^"']+)["'])?`,
    'g',
  );
  for (const m of src.matchAll(mapNotation)) add(m[1]!, m[2]!, m[3]!, m[4]);

  if (new RegExp(`\\b(${CONFIGS})\\s*\\(?\\s*libs\\.`).test(src)) {
    warnings.push(
      'Version catalog references (libs.…) found: also paste gradle/libs.versions.toml to check them.',
    );
  }

  const java =
    /JavaLanguageVersion\.of\(\s*(\d+)\s*\)/.exec(src)?.[1] ??
    /\b(?:sourceCompatibility|targetCompatibility)\s*=\s*(?:JavaVersion\.VERSION_)?["']?(\d+(?:[._]\d+)?)/
      .exec(src)?.[1]
      ?.replace('_', '.') ??
    /\bjvmToolchain\(\s*(\d+)\s*\)/.exec(src)?.[1];

  return {
    format: 'build.gradle',
    registry: 'maven',
    dependencies: [...deps.values()],
    ...(java ? { runtime: { registry: 'maven', name: 'java', version: java } } : {}),
    warnings: [
      'Gradle files are scripts; this reads common dependency patterns only. For full accuracy run `gradle dependencies`.',
      ...warnings,
    ],
  };
}

// ---------------------------------------------------------------- gradle/libs.versions.toml

export function parseVersionCatalog(text: string): ParsedManifest {
  let toml: Record<string, any>;
  try {
    toml = parseToml(text) as Record<string, any>;
  } catch (e) {
    throw new ManifestError(`Not valid TOML: ${(e as Error).message}`);
  }
  const versions: Record<string, string> = {};
  for (const [k, v] of Object.entries<any>(toml.versions ?? {})) {
    if (typeof v === 'string') versions[k] = v;
    else if (v && typeof v === 'object') versions[k] = v.strictly ?? v.require ?? v.prefer ?? '';
  }
  const deps: Dependency[] = [];
  for (const entry of Object.values<any>(toml.libraries ?? {})) {
    let module: string | undefined;
    let version: string | undefined;
    if (typeof entry === 'string') {
      const [g, a, v] = entry.split(':');
      module = g && a ? `${g}:${a}` : undefined;
      version = v;
    } else if (entry && typeof entry === 'object') {
      module =
        entry.module ?? (entry.group && entry.name ? `${entry.group}:${entry.name}` : undefined);
      const v = entry.version;
      version =
        typeof v === 'string'
          ? v
          : v?.ref
            ? versions[v.ref]
            : (v?.strictly ?? v?.require ?? v?.prefer);
    }
    if (!module) continue;
    deps.push({
      registry: 'maven',
      name: module,
      ...(version ? { version } : {}),
      exact: !!version && isExact(version),
      direct: true,
    });
  }
  return { format: 'libs.versions.toml', registry: 'maven', dependencies: deps, warnings: [] };
}
