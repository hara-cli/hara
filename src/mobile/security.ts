import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
  sign,
  verify,
} from "node:crypto";

const ENCRYPTION_SALT = Buffer.from("hara-relay-e2e-v1", "utf8");
const MAX_PLAINTEXT_BYTES = 256_000;

export type DeviceKeyMaterial = Readonly<{
  privateKeyPem: string;
  publicKeySpki: string;
}>;

export type RelayEnvelopeFields = Readonly<{
  accountId: string;
  ciphertext: string;
  expiresAt: number;
  messageId: string;
  nonce: string;
  senderDeviceId: string;
  targetDeviceId: string;
}>;

const identifier = (value: string, name: string): string => {
  if (!value || value.length > 160 || value.trim() !== value || /\s/u.test(value)) {
    throw new TypeError(`${name} must be a bounded identifier`);
  }
  return value;
};

const canonicalBase64url = (value: string, name: string, maximum: number): Buffer => {
  if (!value || value.length > maximum || !/^[A-Za-z0-9_-]+$/u.test(value)) {
    throw new TypeError(`${name} must be canonical base64url`);
  }
  const decoded = Buffer.from(value, "base64url");
  if (decoded.toString("base64url") !== value) {
    throw new TypeError(`${name} must be canonical base64url`);
  }
  return decoded;
};

export function generateDeviceKey(): DeviceKeyMaterial {
  const keys = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  return Object.freeze({
    privateKeyPem: keys.privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
    publicKeySpki: keys.publicKey.export({ format: "der", type: "spki" }).toString("base64url"),
  });
}

export function assertDeviceKey(material: DeviceKeyMaterial): DeviceKeyMaterial {
  const privateKey = createPrivateKey(material.privateKeyPem);
  const publicKey = createPublicKey({
    format: "der",
    key: canonicalBase64url(material.publicKeySpki, "publicKeySpki", 2_048),
    type: "spki",
  });
  if (
    privateKey.asymmetricKeyType !== "ec"
    || publicKey.asymmetricKeyType !== "ec"
    || privateKey.asymmetricKeyDetails?.namedCurve !== "prime256v1"
    || publicKey.asymmetricKeyDetails?.namedCurve !== "prime256v1"
  ) throw new TypeError("device key must use P-256");
  const derived = createPublicKey(privateKey).export({ format: "der", type: "spki" });
  if (!Buffer.from(derived).equals(Buffer.from(publicKey.export({ format: "der", type: "spki" })))) {
    throw new TypeError("device public and private keys do not match");
  }
  return material;
}

export function publicKeyThumbprint(publicKeySpki: string): string {
  const key = createPublicKey({
    format: "der",
    key: canonicalBase64url(publicKeySpki, "publicKeySpki", 2_048),
    type: "spki",
  });
  if (key.asymmetricKeyType !== "ec" || key.asymmetricKeyDetails?.namedCurve !== "prime256v1") {
    throw new TypeError("public key must use P-256");
  }
  return createHash("sha256").update(publicKeySpki, "utf8").digest("hex");
}

export function signPayload(privateKeyPem: string, payload: string): string {
  if (!payload || Buffer.byteLength(payload, "utf8") > 65_536) {
    throw new TypeError("payload must be bounded");
  }
  return sign("sha256", Buffer.from(payload, "utf8"), createPrivateKey(privateKeyPem)).toString("base64url");
}

export function verifyPayload(publicKeySpki: string, payload: string, signature: string): boolean {
  const key = createPublicKey({
    format: "der",
    key: canonicalBase64url(publicKeySpki, "publicKeySpki", 2_048),
    type: "spki",
  });
  const signatureBytes = canonicalBase64url(signature, "signature", 256);
  return verify("sha256", Buffer.from(payload, "utf8"), key, signatureBytes);
}

export function registrationProofPayload(input: Readonly<{
  accountId: string;
  accountRegion: "cn" | "global";
  publicKeySpki: string;
}>): string {
  return [
    "hara-device-registration-v1",
    input.accountRegion,
    identifier(input.accountId, "accountId"),
    publicKeyThumbprint(input.publicKeySpki),
  ].join("\n");
}

export function relayConnectionProofPayload(input: Readonly<{
  connectionId: string;
  credential: string;
  nonce: string;
}>): string {
  return [
    "hara-relay-connect-v1",
    identifier(input.connectionId, "connectionId"),
    input.nonce,
    createHash("sha256").update(input.credential, "utf8").digest("hex"),
  ].join("\n");
}

export function relayEnvelopePayload(fields: RelayEnvelopeFields): string {
  if (!Number.isSafeInteger(fields.expiresAt) || fields.expiresAt <= 0) {
    throw new TypeError("expiresAt must be a positive safe integer");
  }
  return [
    "hara-relay-envelope-v1",
    identifier(fields.accountId, "accountId"),
    identifier(fields.senderDeviceId, "senderDeviceId"),
    identifier(fields.targetDeviceId, "targetDeviceId"),
    identifier(fields.messageId, "messageId"),
    String(fields.expiresAt),
    fields.nonce,
    createHash("sha256").update(fields.ciphertext, "utf8").digest("hex"),
  ].join("\n");
}

function peerPublicKey(publicKeySpki: string) {
  const key = createPublicKey({
    format: "der",
    key: canonicalBase64url(publicKeySpki, "peerPublicKeySpki", 2_048),
    type: "spki",
  });
  if (key.asymmetricKeyType !== "ec" || key.asymmetricKeyDetails?.namedCurve !== "prime256v1") {
    throw new TypeError("peer key must use P-256");
  }
  return key;
}

function sharedKey(privateKeyPem: string, publicKeySpki: string, context: string): Buffer {
  if (!context || Buffer.byteLength(context, "utf8") > 1_024) {
    throw new TypeError("encryption context must be bounded");
  }
  const secret = diffieHellman({
    privateKey: createPrivateKey(privateKeyPem),
    publicKey: peerPublicKey(publicKeySpki),
  });
  return Buffer.from(hkdfSync("sha256", secret, ENCRYPTION_SALT, Buffer.from(context, "utf8"), 32));
}

export function encryptionContext(accountId: string, firstDeviceId: string, secondDeviceId: string): string {
  const devices = [identifier(firstDeviceId, "firstDeviceId"), identifier(secondDeviceId, "secondDeviceId")].sort();
  return ["hara-relay-e2e-v1", identifier(accountId, "accountId"), ...devices].join("\n");
}

export function encryptForPeer(
  privateKeyPem: string,
  peerPublicKeySpki: string,
  context: string,
  plaintext: string,
): Readonly<{ ciphertext: string; nonce: string }> {
  const bytes = Buffer.from(plaintext, "utf8");
  if (!bytes.length || bytes.length > MAX_PLAINTEXT_BYTES) throw new TypeError("plaintext must be bounded");
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", sharedKey(privateKeyPem, peerPublicKeySpki, context), nonce);
  const encrypted = Buffer.concat([cipher.update(bytes), cipher.final()]);
  const combined = Buffer.concat([nonce, encrypted, cipher.getAuthTag()]);
  return Object.freeze({
    ciphertext: combined.toString("base64url"),
    nonce: nonce.toString("base64url"),
  });
}

export function decryptFromPeer(
  privateKeyPem: string,
  peerPublicKeySpki: string,
  context: string,
  ciphertext: string,
  expectedNonce?: string,
): string {
  const combined = canonicalBase64url(ciphertext, "ciphertext", 350_000);
  if (combined.length <= 28 || combined.length > MAX_PLAINTEXT_BYTES + 28) {
    throw new TypeError("ciphertext must be bounded");
  }
  const nonce = combined.subarray(0, 12);
  if (expectedNonce && nonce.toString("base64url") !== expectedNonce) {
    throw new TypeError("ciphertext nonce does not match its signed metadata");
  }
  const tag = combined.subarray(combined.length - 16);
  const encrypted = combined.subarray(12, combined.length - 16);
  const decipher = createDecipheriv("aes-256-gcm", sharedKey(privateKeyPem, peerPublicKeySpki, context), nonce);
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([decipher.update(encrypted), decipher.final()]);
  return plaintext.toString("utf8");
}
