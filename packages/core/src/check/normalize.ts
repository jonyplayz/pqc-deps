import type { Registry } from '../constants';

/** Canonical form of a package name for matching within one registry. */
export function normalizeName(registry: Registry, name: string): string {
  const n = name.trim();
  switch (registry) {
    case 'pypi':
      return n.toLowerCase().replace(/[-_.]+/g, '-'); // PEP 503
    case 'cargo':
      return n.toLowerCase().replace(/_/g, '-');
    case 'go':
      return n.replace(/\/v\d+$/, ''); // module major-version suffix
    default:
      return n.toLowerCase();
  }
}

/**
 * Heuristic: does a package name suggest it does cryptography or TLS?
 * Used only to flag untracked dependencies as "worth a look"; never to claim a status.
 */
const CRYPTO_SUBSTRINGS = [
  'crypt',
  'cipher',
  'jwt',
  'jose',
  'webtoken',
  'x509',
  'pkcs',
  'sodium',
  'nacl',
  'kyber',
  'dilithium',
  'mlkem',
  'ml-kem',
  'mldsa',
  'ml-dsa',
  'oqs',
  'quantum',
  'openssl',
  'boringssl',
  'wolfssl',
  'mbedtls',
  'gnutls',
  'rustls',
  'bouncycastle',
  'bcprov',
  'bcpkix',
  'bcfips',
  'ecdsa',
  'ed25519',
  'x25519',
  'secp256',
  'hmac',
  'argon2',
  'bcrypt',
  'scrypt',
  'webpki',
  'pyopenssl',
];
const CRYPTO_TOKENS = new Set([
  'tls',
  'ssl',
  'ssh',
  'rsa',
  'jws',
  'jwe',
  'jwk',
  'pem',
  'asn1',
  'der',
  'sign',
  'signer',
  'signing',
  'signature',
  'signatures',
  'saml',
  'oauth',
  'oauth2',
  'oidc',
  'openid',
  'cert',
  'certs',
  'certificate',
  'certificates',
  'tink',
  'ring',
  'paramiko',
  'requests',
  'urllib3',
  'httpx',
  'aiohttp',
  'axios',
  'undici',
  'got',
  'okhttp',
  'grpc',
  'netty',
  'conscrypt',
  'kms',
  'vault',
  'keystore',
  'elliptic',
  'noble',
  'forge',
  'crypto',
  'hpke',
  'cose',
  'webauthn',
  'fido2',
  'pgp',
  'gpg',
  'openpgp',
  'age',
  'acme',
  'letsencrypt',
]);

export function looksCryptoRelated(name: string): boolean {
  const lower = name.toLowerCase();
  if (CRYPTO_SUBSTRINGS.some((s) => lower.includes(s))) return true;
  return lower.split(/[^a-z0-9]+/).some((t) => CRYPTO_TOKENS.has(t));
}
