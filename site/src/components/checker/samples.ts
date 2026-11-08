/** Small sample manifests for the "Try an example" buttons. */
export const SAMPLES: Record<string, { filename: string; text: string }> = {
  'package.json': {
    filename: 'package.json',
    text: JSON.stringify(
      {
        name: 'my-api',
        engines: { node: '>=20' },
        dependencies: {
          express: '^4.21.0',
          jose: '^5.2.0',
          jsonwebtoken: '^9.0.2',
          'node-forge': '^1.3.1',
          axios: '^1.7.0',
        },
        devDependencies: { vitest: '^2.1.0' },
      },
      null,
      2,
    ),
  },
  'requirements.txt': {
    filename: 'requirements.txt',
    text: `cryptography==42.0.5
PyJWT[crypto]>=2.8
paramiko>=3.4
requests==2.32.3
django>=5.0
`,
  },
  'go.mod': {
    filename: 'go.mod',
    text: `module example.com/service

go 1.23

require (
\tgithub.com/golang-jwt/jwt/v5 v5.2.1
\tgolang.org/x/crypto v0.28.0
\tgithub.com/gin-gonic/gin v1.10.0
)
`,
  },
  'pom.xml': {
    filename: 'pom.xml',
    text: `<project>
  <properties>
    <maven.compiler.release>21</maven.compiler.release>
    <bc.version>1.78.1</bc.version>
  </properties>
  <dependencies>
    <dependency>
      <groupId>org.bouncycastle</groupId>
      <artifactId>bcprov-jdk18on</artifactId>
      <version>\${bc.version}</version>
    </dependency>
    <dependency>
      <groupId>com.nimbusds</groupId>
      <artifactId>nimbus-jose-jwt</artifactId>
      <version>9.40</version>
    </dependency>
  </dependencies>
</project>
`,
  },
  'Cargo.toml': {
    filename: 'Cargo.toml',
    text: `[package]
name = "my-service"
version = "0.1.0"

[dependencies]
rustls = "0.23"
reqwest = { version = "0.12", features = ["rustls-tls"] }
jsonwebtoken = "9"
serde = "1"
`,
  },
};
