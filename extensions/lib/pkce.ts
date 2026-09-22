import { randomBytes, createHash } from "node:crypto";

function base64urlEncode(bytes: Buffer): string {
  return bytes.toString("base64url").replace(/=+$/, "");
}

export interface PkcePair {
  verifier: string;
  challenge: string;
}

export function generatePkce(): PkcePair {
  const verifier = base64urlEncode(randomBytes(32));
  const challenge = base64urlEncode(
    createHash("sha256").update(verifier, "utf8").digest(),
  );
  return { verifier, challenge };
}

export function randomState(): string {
  return base64urlEncode(randomBytes(16));
}
