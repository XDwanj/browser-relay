import { setupBrowser } from "../tests/helpers/real-browser.mjs";
import { writeFile } from "node:fs/promises";

const label = process.env.BROWSER_RELAY_GAP_LABEL || "baseline";
if (!/^[a-z0-9-]+$/.test(label)) throw new Error("Invalid output label");
const runs = Number(process.env.BROWSER_RELAY_GAP_RUNS || 3);
if (!Number.isInteger(runs) || runs < 1 || runs > 10)
  throw new Error("Invalid runs");
const env = await setupBrowser({
  headed: true,
  viewport: { width: 1466, height: 925 },
  fixtureFile: "browser-gaps.html",
});
const role = (role, name) => ({ role, name });
const click = (name, extra = {}) => ({
  type: "click",
  target: role("button", name),
  timeoutMs: 2000,
  ...extra,
});
const cases = [
  [
    "delayed-enabled",
    [click("Start enabling"), click("Delayed action")],
    "Enabled done",
  ],
  [
    "appearance",
    [click("Start appearance"), click("Appeared action")],
    "Appeared done",
  ],
  [
    "temporary-cover",
    [click("Start temporary cover"), click("Covered action")],
    "Covered done",
  ],
  ["moving", [click("Start movement"), click("Moving action")], "Moving done"],
  [
    "scoped",
    [
      click("Save", {
        target: { ...role("button", "Save"), scope: role("group", "South") },
      }),
    ],
    "South saved",
  ],
  [
    "rerender",
    [click("Replace target"), click("Replaceable action")],
    "Replacement done",
  ],
  [
    "trusted-checkbox",
    [
      {
        type: "check",
        target: role("checkbox", "Trusted choice"),
        checked: true,
      },
    ],
    "Checked=true; trusted=true",
  ],
  [
    "custom-checkbox",
    [
      {
        type: "check",
        target: role("checkbox", "Custom choice"),
        checked: true,
      },
    ],
    "Custom checked=true",
  ],
  [
    "disabled-option",
    [
      {
        type: "select",
        target: role("combobox", "Availability"),
        value: "closed",
      },
    ],
    "Ready",
    true,
  ],
  [
    "readonly",
    [
      {
        type: "fill",
        target: role("textbox", "Read only"),
        text: "wrong",
        timeoutMs: 350,
      },
    ],
    "Ready",
    true,
  ],
  [
    "richtext",
    [{ type: "fill", target: role("textbox", "Rich note"), text: "New note" }],
    "Rich=New note",
  ],
  [
    "shadow-cover",
    [click("Shadow covered action", { timeoutMs: 350 })],
    "Ready",
    true,
  ],
  ["frame-cover", [click("Frame action", { timeoutMs: 350 })], "Ready", true],
];
const samples = [];
try {
  for (let iteration = 0; iteration < runs; iteration++) {
    for (const [
      name,
      actions,
      expectedResult,
      expectRefusal = false,
    ] of cases) {
      await env.page.goto(`${env.fixtureUrl}?case=${name}`);
      await env.page.bringToFront();
      const initialState = await env.tab.snapshot({ diff: false });
      const start = performance.now();
      let error = null,
        task;
      try {
        task = await env.tab.act(actions);
      } catch (failure) {
        error = { code: failure.code, message: failure.message };
      }
      const elapsedMs = Math.round((performance.now() - start) * 10) / 10;
      const visibleResult = await env.page.locator("#result").innerText();
      const controlValue =
        name === "disabled-option"
          ? await env.page.locator("#availability").inputValue()
          : name === "readonly"
            ? await env.page.locator("#readonly").inputValue()
            : null;
      const coveredFrameText =
        name === "frame-cover"
          ? await env.page
              .frameLocator('iframe[title="Covered frame"]')
              .locator("button")
              .innerText()
          : null;
      const success =
        visibleResult === expectedResult &&
        (expectRefusal ? error != null : error == null) &&
        (name !== "disabled-option" || controlValue === "open") &&
        (name !== "readonly" || controlValue === "unchanged") &&
        (name !== "frame-cover" || coveredFrameText === "Frame action");
      samples.push({
        case: name,
        iteration,
        expectedResult,
        expectRefusal,
        success,
        elapsedMs,
        error,
        visibleResult,
        controlValue,
        coveredFrameText,
        initialState: initialState.snapshot,
        finalState: task?.observation?.snapshot ?? null,
      });
    }
  }
  const summary = Object.fromEntries(
    cases.map(([name]) => {
      const rows = samples.filter((r) => r.case === name);
      return [
        name,
        { runs: rows.length, successes: rows.filter((r) => r.success).length },
      ];
    }),
  );
  await writeFile(
    `docs/benchmarks/browser-gaps-relay-${label}.json`,
    JSON.stringify(
      {
        measuredAt: new Date().toISOString(),
        label,
        browser: env.context.browser().version(),
        viewport: env.page.viewportSize(),
        headless: false,
        scope:
          "UI outcome probes, not a general model success benchmark. Refusal probes additionally require a surfaced error. Disabled option is an explicit UI-faithfulness criterion, not an assertion about the Playwright API contract.",
        summary,
        samples,
      },
      null,
      2,
    ) + "\n",
  );
  console.log(JSON.stringify(summary, null, 2));
} finally {
  await env.close();
}
