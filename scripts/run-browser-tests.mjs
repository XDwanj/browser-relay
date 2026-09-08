import { spawnSync } from "node:child_process";
const result = spawnSync(
  process.execPath,
  ["--test", "tests/browser-e2e.test.mjs"],
  { stdio: "inherit", env: { ...process.env, BROWSER_RELAY_E2E: "1" } },
);
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
