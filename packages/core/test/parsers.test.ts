import { describe, expect, it } from 'vitest';
import { detectFormat } from '../src/check/detect';
import { parseManifest } from '../src/check/parse';
import { ManifestError } from '../src/check/types';
import { compareVersions, lowerBound } from '../src/check/version';

const byName = (m: ReturnType<typeof parseManifest>) =>
  Object.fromEntries(m.dependencies.map((d) => [d.name, d]));

describe('package.json', () => {
  const text = JSON.stringify({
    name: 'app',
    engines: { node: '>=22' },
    dependencies: {
      jose: '^5.2.0',
      express: '4.19.2',
      local: 'file:../local',
      alias: 'npm:jsonwebtoken@^9.0.0',
    },
    devDependencies: { vitest: '~3.0.0' },
  });
  const m = parseManifest(text, { filename: 'package.json' });
  const d = byName(m);
  it('reads all sections with scopes', () => {
    expect(d.jose).toMatchObject({
      registry: 'npm',
      version: '^5.2.0',
      exact: false,
      direct: true,
    });
    expect(d.express).toMatchObject({ version: '4.19.2', exact: true });
    expect(d.vitest!.scope).toBe('dev');
  });
  it('resolves npm: aliases and drops non-registry versions', () => {
    expect(d.jsonwebtoken).toMatchObject({ version: '^9.0.0' });
    expect(d.local!.version).toBeUndefined();
  });
  it('reads engines.node as the runtime', () => {
    expect(m.runtime).toEqual({ registry: 'npm', name: 'node', version: '>=22' });
  });
  it('rejects invalid JSON', () => {
    expect(() => parseManifest('{nope', { format: 'package.json' })).toThrow(ManifestError);
  });
});

describe('package-lock.json', () => {
  it('v3: resolves versions and marks direct vs transitive', () => {
    const lock = {
      lockfileVersion: 3,
      packages: {
        '': { dependencies: { jose: '^5' }, devDependencies: { tsx: '^4' } },
        'node_modules/jose': { version: '5.9.6' },
        'node_modules/tsx': { version: '4.19.0', dev: true },
        'node_modules/tsx/node_modules/esbuild': { version: '0.23.0', dev: true },
        'node_modules/jwa': { version: '2.0.0' },
        'node_modules/aliased': { name: 'real-pkg', version: '1.0.0' },
        'packages/workspace-a': { version: '0.0.0' },
      },
    };
    const d = byName(parseManifest(JSON.stringify(lock), { filename: 'package-lock.json' }));
    expect(d.jose).toMatchObject({ version: '5.9.6', exact: true, direct: true });
    expect(d.tsx).toMatchObject({ direct: true, scope: 'dev' });
    expect(d.esbuild).toMatchObject({ direct: false, scope: 'dev' });
    expect(d.jwa).toMatchObject({ direct: false });
    expect(d['real-pkg']).toBeDefined();
    expect(d['workspace-a']).toBeUndefined();
  });
  it('v1: walks the nested tree', () => {
    const lock = {
      lockfileVersion: 1,
      dependencies: { a: { version: '1.0.0', dependencies: { b: { version: '2.0.0' } } } },
    };
    const m = parseManifest(JSON.stringify(lock));
    expect(m.format).toBe('package-lock.json');
    expect(m.dependencies.map((x) => x.name).sort()).toEqual(['a', 'b']);
    expect(m.warnings[0]).toMatch(/v1/);
  });
});

describe('requirements.txt', () => {
  const text = `
# comment
cryptography==43.0.1 \\
    --hash=sha256:abc
PyJWT[crypto]>=2.8,<3  # inline comment
requests
paramiko ; python_version >= "3.8"
-r other.txt
-e git+https://github.com/x/y.git#egg=y
./local/pkg
pkg-from-url @ https://example.com/pkg.whl
`;
  const m = parseManifest(text, { filename: 'requirements.txt' });
  const d = byName(m);
  it('parses pins, ranges, extras, markers and continuations', () => {
    expect(d.cryptography).toMatchObject({ version: '==43.0.1', exact: true });
    expect(d.PyJWT).toMatchObject({ version: '>=2.8,<3', exact: false });
    expect(d.requests!.version).toBeUndefined();
    expect(d.paramiko!.version).toBeUndefined();
    expect(d['pkg-from-url']).toBeDefined();
  });
  it('skips options and paths, warns about includes', () => {
    expect(Object.keys(d)).toHaveLength(5);
    expect(m.warnings.join()).toMatch(/other\.txt/);
  });
});

describe('pyproject.toml', () => {
  it('reads PEP 621, optional deps and dependency groups', () => {
    const m = parseManifest(
      `[project]
name = "x"
requires-python = ">=3.11"
dependencies = ["cryptography>=42", "httpx"]
[project.optional-dependencies]
jwt = ["pyjwt[crypto]==2.9.0"]
[dependency-groups]
dev = ["pytest>=8", { include-group = "lint" }]
`,
      { filename: 'pyproject.toml' },
    );
    const d = byName(m);
    expect(d.cryptography).toMatchObject({ version: '>=42' });
    expect(d.pyjwt).toMatchObject({ exact: true, scope: 'optional:jwt' });
    expect(d.pytest!.scope).toBe('group:dev');
    expect(m.runtime).toMatchObject({ name: 'python', version: '>=3.11' });
  });
  it('reads Poetry tables', () => {
    const m = parseManifest(`[tool.poetry.dependencies]
python = "^3.10"
paramiko = "^3.4"
cryptography = { version = "43.0.0", extras = ["ssh"] }
[tool.poetry.group.dev.dependencies]
pytest = "*"
`);
    const d = byName(m);
    expect(m.format).toBe('pyproject.toml');
    expect(d.paramiko).toMatchObject({ version: '^3.4', exact: false });
    expect(d.cryptography).toMatchObject({ version: '43.0.0', exact: true });
    expect(d.pytest).toMatchObject({ scope: 'group:dev' });
    expect(d.pytest!.version).toBeUndefined();
    expect(d.python).toBeUndefined();
    expect(m.runtime?.version).toBe('^3.10');
  });
});

describe('go.mod', () => {
  const text = `module example.com/app

go 1.23
toolchain go1.24.1

require golang.org/x/crypto v0.31.0

require (
\tgithub.com/golang-jwt/jwt/v5 v5.2.1
\tgolang.org/x/sys v0.28.0 // indirect
\texample.com/old v1.0.0
\texample.com/local v1.0.0
)

replace example.com/old => example.com/new v1.1.0
replace example.com/local => ../local
`;
  const m = parseManifest(text, { filename: 'go.mod' });
  const d = byName(m);
  it('reads single and block requires with indirect markers', () => {
    expect(d['golang.org/x/crypto']).toMatchObject({
      version: 'v0.31.0',
      exact: true,
      direct: true,
    });
    expect(d['github.com/golang-jwt/jwt/v5']).toMatchObject({ direct: true });
    expect(d['golang.org/x/sys']).toMatchObject({ direct: false });
  });
  it('applies replace directives', () => {
    expect(d['example.com/old']).toBeUndefined();
    expect(d['example.com/new']).toMatchObject({ version: 'v1.1.0' });
    expect(d['example.com/local']!.version).toBeUndefined();
  });
  it('uses the newer of go and toolchain as the runtime', () => {
    expect(m.runtime).toEqual({ registry: 'go', name: 'go', version: '1.24.1' });
  });
});

describe('pom.xml', () => {
  const text = `<?xml version="1.0"?>
<project xmlns="http://maven.apache.org/POM/4.0.0">
  <version>1.0.0</version>
  <properties>
    <bc.version>1.79</bc.version>
    <maven.compiler.release>21</maven.compiler.release>
  </properties>
  <dependencyManagement><dependencies>
    <dependency><groupId>com.nimbusds</groupId><artifactId>nimbus-jose-jwt</artifactId><version>9.40</version></dependency>
    <dependency><groupId>io.netty</groupId><artifactId>netty-bom</artifactId><version>4.1.115.Final</version><type>pom</type><scope>import</scope></dependency>
  </dependencies></dependencyManagement>
  <dependencies>
    <dependency><groupId>org.bouncycastle</groupId><artifactId>bcprov-jdk18on</artifactId><version>\${bc.version}</version></dependency>
    <dependency><groupId>com.nimbusds</groupId><artifactId>nimbus-jose-jwt</artifactId></dependency>
    <dependency><groupId>junit</groupId><artifactId>junit</artifactId><version>[4.0,5.0)</version><scope>test</scope></dependency>
  </dependencies>
</project>`;
  const m = parseManifest(text, { filename: 'pom.xml' });
  const d = byName(m);
  it('resolves properties and managed versions', () => {
    expect(d['org.bouncycastle:bcprov-jdk18on']).toMatchObject({
      version: '1.79',
      exact: true,
      direct: true,
    });
    expect(d['com.nimbusds:nimbus-jose-jwt']).toMatchObject({ version: '9.40', direct: true });
  });
  it('keeps scopes, ranges and managed-only entries', () => {
    expect(d['junit:junit']).toMatchObject({ scope: 'test', exact: false });
    expect(d['io.netty:netty-bom']).toMatchObject({ scope: 'managed', direct: false });
  });
  it('reads the Java release', () => {
    expect(m.runtime).toMatchObject({ name: 'java', version: '21' });
  });
});

describe('build.gradle', () => {
  it('reads Groovy string and map notation with variables', () => {
    const m = parseManifest(
      `def bcVersion = '1.79'
dependencies {
    implementation "org.bouncycastle:bcprov-jdk18on:$bcVersion"
    implementation group: 'com.nimbusds', name: 'nimbus-jose-jwt', version: '9.40'
    testImplementation 'org.junit.jupiter:junit-jupiter:5.11.0' // tests
    // implementation 'commented:out:1.0'
    implementation platform('io.netty:netty-bom:4.1.115.Final')
    implementation 'com.squareup.okhttp3:okhttp'
}
java { toolchain { languageVersion = JavaLanguageVersion.of(17) } }`,
      { filename: 'build.gradle' },
    );
    const d = byName(m);
    expect(d['org.bouncycastle:bcprov-jdk18on']).toMatchObject({ version: '1.79', exact: true });
    expect(d['com.nimbusds:nimbus-jose-jwt']).toMatchObject({ version: '9.40' });
    expect(d['org.junit.jupiter:junit-jupiter']!.scope).toBe('test');
    expect(d['commented:out']).toBeUndefined();
    expect(d['io.netty:netty-bom']).toBeDefined();
    expect(d['com.squareup.okhttp3:okhttp']!.version).toBeUndefined();
    expect(m.runtime?.version).toBe('17');
  });
  it('reads Kotlin DSL and warns about version catalogs', () => {
    const m = parseManifest(
      `val joseVersion = "9.41"
dependencies {
    implementation("com.nimbusds:nimbus-jose-jwt:\${joseVersion}")
    implementation(libs.bouncycastle)
}`,
      { filename: 'build.gradle.kts' },
    );
    expect(byName(m)['com.nimbusds:nimbus-jose-jwt']).toMatchObject({ version: '9.41' });
    expect(m.warnings.join()).toMatch(/libs\.versions\.toml/);
  });
});

describe('libs.versions.toml', () => {
  it('resolves version refs and all library notations', () => {
    const m = parseManifest(
      `[versions]
bc = "1.79"
[libraries]
bcprov = { module = "org.bouncycastle:bcprov-jdk18on", version.ref = "bc" }
jose = { group = "com.nimbusds", name = "nimbus-jose-jwt", version = "9.40" }
okhttp = "com.squareup.okhttp3:okhttp:4.12.0"
`,
      { filename: 'gradle/libs.versions.toml' },
    );
    const d = byName(m);
    expect(d['org.bouncycastle:bcprov-jdk18on']!.version).toBe('1.79');
    expect(d['com.nimbusds:nimbus-jose-jwt']!.version).toBe('9.40');
    expect(d['com.squareup.okhttp3:okhttp']!.version).toBe('4.12.0');
  });
});

describe('Cargo', () => {
  it('Cargo.toml: tables, renames, targets; caret requirements are not exact', () => {
    const m = parseManifest(
      `[package]
name = "app"
[dependencies]
rustls = "0.23"
ring = { version = "=0.17.8" }
my-ssl = { package = "openssl", version = "0.10.66", optional = true }
local = { path = "../local" }
[dev-dependencies]
proptest = "1"
[target.'cfg(unix)'.dependencies]
nix = "0.29"
`,
      { filename: 'Cargo.toml' },
    );
    const d = byName(m);
    expect(d.rustls).toMatchObject({ version: '0.23', exact: false });
    expect(d.ring).toMatchObject({ exact: true });
    expect(d.openssl).toMatchObject({ version: '0.10.66' });
    expect(d.local!.version).toBeUndefined();
    expect(d.proptest!.scope).toBe('dev');
    expect(d.nix).toBeDefined();
  });
  it('Cargo.lock: registry packages only', () => {
    const m = parseManifest(`version = 4
[[package]]
name = "app"
version = "0.1.0"

[[package]]
name = "rustls"
version = "0.23.20"
source = "registry+https://github.com/rust-lang/crates.io-index"
`);
    expect(m.format).toBe('Cargo.lock');
    expect(m.dependencies).toEqual([
      { registry: 'cargo', name: 'rustls', version: '0.23.20', exact: true, direct: false },
    ]);
  });
});

describe('detectFormat', () => {
  it.each([
    ['{"lockfileVersion":3,"packages":{}}', 'package-lock.json'],
    ['{"dependencies":{}}', 'package.json'],
    ['module x\n\ngo 1.22\n', 'go.mod'],
    ['<project><dependencies/></project>', 'pom.xml'],
    ['[project]\nname="x"', 'pyproject.toml'],
    ['[package]\nname="x"', 'Cargo.toml'],
    ['[versions]\n[libraries]\n', 'libs.versions.toml'],
    ['dependencies {\n implementation "a:b:1"\n}', 'build.gradle'],
    ['cryptography==43.0.1\nrequests\n', 'requirements.txt'],
  ])('%s → %s', (text, fmt) => {
    expect(detectFormat(text)).toBe(fmt);
  });
  it('returns undefined for unrecognised text', () => {
    expect(detectFormat('hello world, this is not a manifest!')).toBeUndefined();
    expect(() => parseManifest('hello world, this is not a manifest!')).toThrow(
      /Couldn't recognise/,
    );
  });
});

describe('hardening from CodeQL review', () => {
  it('gradle: only test/androidTest configurations are test scope', () => {
    const m = parseManifest(
      `dependencies {
    implementation 'com.example:lib-androidTest-helper:1.0'
    androidTestImplementation 'junit:junit:4.13.2'
    testImplementation 'org.junit.jupiter:junit-jupiter:5.11.0'
}`,
      { filename: 'build.gradle' },
    );
    const d = Object.fromEntries(m.dependencies.map((x) => [x.name, x]));
    expect(d['com.example:lib-androidTest-helper']!.scope).toBeUndefined();
    expect(d['junit:junit']!.scope).toBe('test');
    expect(d['org.junit.jupiter:junit-jupiter']!.scope).toBe('test');
  });

  it('gradle: comment stripping keeps URLs and strings, handles unterminated comments', () => {
    const m = parseManifest(
      `repositories { maven { url "https://repo.example.com/maven" } } // trailing comment
/* block comment implementation 'commented:out:1.0' */
dependencies {
    implementation "com.example:with-slashes:1.0" // note
    // implementation 'also:commented:1.0'
}
/* unterminated`,
      { filename: 'build.gradle' },
    );
    expect(m.dependencies.map((x) => x.name)).toEqual(['com.example:with-slashes']);
  });

  it('stays fast on huge or hostile input', () => {
    const start = Date.now();
    const long = '1' + '.1'.repeat(50_000) + '!';
    expect(lowerBound(`>=${long}`)).toBeUndefined();
    expect(compareVersions(long, '1.0')).toBeUndefined();
    detectFormat('implementation' + ' '.repeat(200_000) + '(x'); // must just return quickly
    parseManifest('dependencies {\n' + '/'.repeat(200_000) + '\n}', { filename: 'build.gradle' });
    expect(Date.now() - start).toBeLessThan(2000);
  });
});
