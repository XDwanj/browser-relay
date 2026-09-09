import { setupBrowser } from "../tests/helpers/real-browser.mjs";
import { writeFile } from "node:fs/promises";

const env = await setupBrowser({
  headed: true,
  viewport: { width: 1466, height: 925 },
});
const samples = [];
try {
  for (let iteration = 0; iteration < 7; iteration++) {
    const order = iteration % 2 ? [2000, 0] : [0, 2000];
    for (const readinessTimeoutMs of order) {
      await env.page.reload();
      await env.page.bringToFront();
      const initial = await env.tab.snapshot({
        diff: false,
        includeNodes: true,
      });
      const target = initial.nodes.find(
        (n) => n.role === "button" && n.name === "Add row",
      );
      const start = performance.now();
      await env.tab.act([
        {
          type: "click",
          target: { ref: target.ref },
          ...(readinessTimeoutMs ? { timeoutMs: readinessTimeoutMs } : {}),
        },
      ]);
      const elapsedMs = Math.round((performance.now() - start) * 10) / 10;
      const success = (await env.page.locator("#rows li").count()) === 2;
      if (!success) throw new Error("Expected exactly one added row");
      samples.push({ iteration, readinessTimeoutMs, elapsedMs, success });
    }
  }
  const summary = Object.fromEntries(
    [0, 2000].map((timeout) => {
      const rows = samples.filter((s) => s.readinessTimeoutMs === timeout);
      return [
        timeout,
        {
          runs: rows.length,
          elapsedMs: rows.map((s) => s.elapsedMs).sort((a, b) => a - b)[3],
        },
      ];
    }),
  );
  await writeFile(
    "docs/benchmarks/browser-readiness-cost.json",
    JSON.stringify(
      {
        measuredAt: new Date().toISOString(),
        scope:
          "Relay only. Already-ready Add row control; action and final observation timed, setup and independent outcome assertion excluded. Measures opt-in stability waiting overhead, not a model comparison.",
        browser: env.context.browser().version(),
        viewport: env.page.viewportSize(),
        headless: false,
        summary,
        samples,
      },
      null,
      2,
    ) + "\n",
  );
  console.log(JSON.stringify(summary));
} finally {
  await env.close();
}
