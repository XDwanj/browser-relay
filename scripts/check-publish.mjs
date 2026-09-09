import { readFileSync } from "node:fs";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
// npm omits npm_config_tag when an explicit --tag=latest equals its default.
// Require a non-default tag instead of treating an absent value as package.next.
const tag = process.env.npm_config_tag;
if (pkg.version.includes("-") && (!tag || tag === "latest")) {
  throw new Error("Development publication requires an explicit non-latest tag. Use --tag next.");
}
