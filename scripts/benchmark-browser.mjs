import { setupBrowser } from "../tests/helpers/real-browser.mjs";
import { chromium } from "playwright";
import { mkdir, writeFile } from "node:fs/promises";

// A deterministic tool-harness benchmark, NOT a model-success benchmark.
// All variants perform the same UI task and verify its visible result.
const count = Number(process.env.BROWSER_RELAY_BENCH_RUNS || 7);
if (!Number.isInteger(count) || count < 1 || count > 30)
  throw new Error("runs must be 1–30");
const latencyMs = Number(process.env.BROWSER_RELAY_BENCH_RTT_MS || 0);
const headed = process.env.BROWSER_RELAY_BENCH_HEADED === "1";
const viewport = {
  width: Number(process.env.BROWSER_RELAY_BENCH_WIDTH || 1280),
  height: Number(process.env.BROWSER_RELAY_BENCH_HEIGHT || 1000),
};
if (Object.values(viewport).some((n) => !Number.isInteger(n) || n < 1 || n > 16384))
  throw new Error("viewport dimensions must be integers from 1 to 16384");
const suite = process.env.BROWSER_RELAY_BENCH_SUITE || "original";
if (!["original", "balanced"].includes(suite))
  throw new Error("suite must be original or balanced");
const variants = suite === "balanced"
  ? ["legacy", "legacy-minimal", "actions", "playwright-cdp"]
  : ["legacy", "actions", "playwright-cdp"];
const env = await setupBrowser({ relayLatencyMs: latencyMs, headed, viewport });
const samples = [];
try {
  for (let iteration = 0; iteration < count; iteration++) {
    // Rotate the supplemental suite to reduce systematic execution-order bias.
    const offset = suite === "balanced" ? iteration % variants.length : 0;
    const order = [...variants.slice(offset), ...variants.slice(0, offset)];
    for (const [position, variant] of order.entries()) {
      await env.page.reload();
      await env.page.bringToFront();
      const native =
        variant === "playwright-cdp"
          ? await chromium.connectOverCDP(`http://127.0.0.1:${env.port}`)
          : null;
      const pw = native
        ?.contexts()[0]
        .pages()
        .find((p) => p.url() === env.fixtureUrl);
      let calls = 0,
        bytes = 0,
        snapshotBytes = 0;
      const request = async (method, path, body) => {
        calls++;
        const r = await env.request(method, path, body);
        bytes += Buffer.byteLength(JSON.stringify(r));
        snapshotBytes += Buffer.byteLength(
          r.snapshot || r.task?.observation?.snapshot || "",
        );
        return r;
      };
      const before = await env.request("GET", "/api/debug");
      const start = performance.now();
      if (variant === "legacy" || variant === "legacy-minimal") {
        const snapshot = () =>
          request("GET", `/api/snapshot?tabId=${env.tab.id}&maxLength=20000`);
        await snapshot();
        await request("POST", "/api/type", {
          tabId: env.tab.id,
          selector: "input[name=query]",
          text: "invoice",
          clear: true,
        });
        if (variant === "legacy") await snapshot();
        await request("POST", "/api/eval", {
          tabId: env.tab.id,
          expression: `(()=>{const e=document.querySelector('select[name=owner]');e.value='alice';e.dispatchEvent(new Event('change',{bubbles:true}));})()`,
        });
        if (variant === "legacy") await snapshot();
        await request("POST", "/api/click", {
          tabId: env.tab.id,
          selector: "input[name=active]",
        });
        if (variant === "legacy") await snapshot();
        await request("POST", "/api/click", {
          tabId: env.tab.id,
          selector: "#form button",
        });
        await request("POST", "/api/wait", {
          tabId: env.tab.id,
          selector: "#status[data-ready]",
          timeoutMs: 5000,
        });
        await snapshot();
      } else if (variant === "actions") {
        const state = await request("POST", "/api/observe", {
          tabId: env.tab.id,
          sessionId: "benchmark",
        });
        const ref = (role, name) => ({
          ref: state.snapshot
            .split("\n")
            .find((line) => line.includes(`] ${role} ${JSON.stringify(name)}`))
            .match(/^\[([^\]]+)\]/)[1],
        });
        await request("POST", "/api/actions", {
          tabId: env.tab.id,
          sessionId: "benchmark",
          actions: [
            { type: "fill", target: ref("textbox", "Search"), text: "invoice" },
            {
              type: "select",
              target: ref("combobox", "Owner"),
              value: "alice",
            },
            {
              type: "check",
              target: ref("checkbox", "Active only"),
              checked: true,
            },
            { type: "click", target: ref("button", "Search records") },
            { type: "wait", target: { selector: "#status[data-ready]" } },
          ],
        });
      } else {
        // Public Playwright operations over the new bridge. This measures CDP
        // interoperability, and is not labelled as Codex's proprietary backend.
        snapshotBytes += Buffer.byteLength(
          await pw.locator("body").ariaSnapshot(),
        );
        await pw
          .getByRole("textbox", { name: "Search", exact: true })
          .fill("invoice");
        await pw.getByRole("combobox", { name: "Owner" }).selectOption("alice");
        await pw.getByRole("checkbox", { name: "Active only" }).check();
        await pw.getByRole("button", { name: "Search records" }).click();
        await pw.locator("#status[data-ready]").waitFor();
        snapshotBytes += Buffer.byteLength(
          await pw.locator("body").ariaSnapshot(),
        );
      }
      const elapsedMs = performance.now() - start;
      const visible = await env.page.locator("#status").textContent();
      if (visible !== "Found: invoice / alice / active")
        throw new Error(`${variant} failed: ${visible}`);
      const after = await env.request("GET", "/api/debug");
      samples.push({
        variant,
        iteration,
        position,
        success: true,
        elapsedMs: Math.round(elapsedMs * 10) / 10,
        httpCalls: calls,
        extensionRoundTrips: after.commandsSent - before.commandsSent,
        responseBytes: variant === "playwright-cdp" ? null : bytes,
        snapshotBytes,
      });
      await native?.close();
    }
  }
  const initial = await env.request("POST", "/api/observe", {
    tabId: env.tab.id,
    sessionId: "delta",
    diff: false,
  });
  const changed = await env.request("POST", "/api/actions", {
    tabId: env.tab.id,
    sessionId: "delta",
    actions: [{ type: "click", target: { selector: "#add" } }],
  });
  const delta = {
    fullSnapshotBytes: Buffer.byteLength(initial.snapshot),
    changedSnapshotBytes: Buffer.byteLength(changed.task.observation.snapshot),
  };
  const median = (v) => {
    const sorted = [...v].sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    if (sorted[middle] == null) return null;
    return sorted.length % 2
      ? sorted[middle]
      : (sorted[middle - 1] + sorted[middle]) / 2;
  };
  const summary = Object.fromEntries(
    variants.map((variant) => {
      const rows = samples.filter((r) => r.variant === variant);
      return [
        variant,
        {
          runs: rows.length,
          successes: rows.filter((r) => r.success).length,
          ...Object.fromEntries(
            [
              "elapsedMs",
              "httpCalls",
              "extensionRoundTrips",
              "responseBytes",
              "snapshotBytes",
            ].map((k) => [k, median(rows.map((r) => r[k]))]),
          ),
        },
      ];
    }),
  );
  const result = {
    measuredAt: new Date().toISOString(),
    suite,
    executionOrder: suite === "balanced" ? "rotating" : "fixed",
    injectedExtensionRttMs: latencyMs,
    platform: process.platform,
    node: process.version,
    chromium: env.context.browser()?.version(),
    headless: !headed,
    viewport: env.page.viewportSize(),
    task: "Search invoice / owner Alice / active only; await visible result",
    scope:
      "Deterministic browser/tool execution; no model inference or token accounting. Playwright over Relay is not Codex Browser Use.",
    summary,
    delta,
    samples,
  };
  await mkdir("docs/benchmarks", { recursive: true });
  await writeFile(
    `docs/benchmarks/browser-runtime${suite === "balanced" ? "-balanced" : ""}${headed ? "-headed" : ""}${latencyMs ? `-rtt${latencyMs}` : ""}.json`,
    JSON.stringify(result, null, 2) + "\n",
  );
  console.log(JSON.stringify({ summary, delta }, null, 2));
} finally {
  await env.close();
}
