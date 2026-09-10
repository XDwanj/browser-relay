// Verify the real GitHub-to-npm trust without publishing a version.
// https://api-docs.npmjs.com/ documents the package-scoped token exchange.
import { readFileSync } from "node:fs";

class VerificationError extends Error {}

async function verify() {
  const requestUrl = process.env.ACTIONS_ID_TOKEN_REQUEST_URL;
  const requestToken = process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
  if (!requestUrl || !requestToken) {
    throw new VerificationError("GitHub OIDC is unavailable; grant this job id-token: write.");
  }

  const { name } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  const oidcUrl = new URL(requestUrl);
  oidcUrl.searchParams.set("audience", "npm:registry.npmjs.org");
  const identity = await fetch(oidcUrl, {
    headers: { Authorization: `Bearer ${requestToken}` },
    redirect: "error",
    signal: AbortSignal.timeout(15000),
  });
  if (!identity.ok) throw new VerificationError(`GitHub OIDC request failed (HTTP ${identity.status}).`);
  const { value: idToken } = await identity.json();
  if (typeof idToken !== "string" || !idToken) throw new VerificationError("GitHub returned no OIDC token.");

  const exchange = await fetch(
    `https://registry.npmjs.org/-/npm/v1/oidc/token/exchange/package/${encodeURIComponent(name)}`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${idToken}`, "Content-Type": "application/json" },
      body: "{}",
      redirect: "error",
      signal: AbortSignal.timeout(15000),
    },
  );
  if (exchange.status !== 201) {
    throw new VerificationError(`npm OIDC exchange failed (HTTP ${exchange.status}); check the trusted publisher configuration.`);
  }
  const grant = await exchange.json();
  // Match npm CLI's lib/utils/oidc.js: only `token` is required.
  // Registry responses need not include token_type or expiry metadata.
  if (!grant || typeof grant.token !== "string" || !grant.token) {
    throw new VerificationError("npm did not return an OIDC grant token.");
  }

  // Do not log or persist either credential, including response bodies on errors.
  console.log(`OIDC authentication verified for ${name}. No package was published by this check.`);
}

try {
  await verify();
} catch (error) {
  console.error(error instanceof VerificationError
    ? error.message
    : "OIDC verification failed while requesting or reading provider credentials.");
  process.exitCode = 1;
}
