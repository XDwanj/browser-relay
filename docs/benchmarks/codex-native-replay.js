// Paste into mcp__cua_repl after creating the fixture tab as `nativeBench`.
// This is a CUA REPL snippet, not a standalone Node/Playwright runner.
// State is kept in one object: do not rebind a log captured by an older cell.
var nativeReplay = { samples: [], current: null };

nativeReplay.measure = async function (operation, fn) {
  const start = Date.now();
  try {
    const result = await fn();
    nativeReplay.current.steps.push({
      operation,
      elapsedMs: Date.now() - start,
      success: true,
      ...(typeof result === "string"
        ? { state: result, stateBytes: new TextEncoder().encode(result).length }
        : {}),
    });
    return result;
  } catch (error) {
    nativeReplay.current.steps.push({
      operation, elapsedMs: Date.now() - start, success: false, error: String(error),
    });
    throw error;
  }
};

nativeReplay.observe = async function (full = false) {
  const state = await nativeReplay.measure("getAXState", () =>
    nativeBench.getAXState({ emit: false, ...(full ? { disableDiffing: true } : {}) }),
  );
  const current = nativeReplay.current;
  if (!state.includes("The following is a diff")) current.nodes = new Map();
  for (const removed of state.matchAll(/Removed element IDs:\s*([^\n]+)/g)) {
    for (const part of removed[1].split(",")) {
      const [from, to = from] = part.trim().split(/[-–]/).map(Number);
      for (const id of current.nodes.keys())
        if (id >= from && id <= to) current.nodes.delete(id);
    }
  }
  for (const line of state.split("\n")) {
    const match = line.replace(/^[~+]\s*/, "").match(/^\s*(\d+)\s+(.+)$/);
    if (match) current.nodes.set(Number(match[1]), match[2]);
  }
  return state;
};

nativeReplay.ref = function (pattern) {
  const matches = [...nativeReplay.current.nodes].filter(([, text]) => pattern.test(text));
  if (matches.length !== 1) throw new Error(`Expected one current AX target: ${pattern}`);
  return matches[0][0];
};

nativeReplay.run = async function (variant, iteration, invocation) {
  if (!["ax-single", "ax-batch", "native-playwright"].includes(variant))
    throw new Error("Unknown variant");
  await nativeBench.reload(); // Intentionally outside measured workflow.
  nativeReplay.current = { steps: [], nodes: new Map() };
  const start = Date.now();
  let success = false, error;
  try {
    let finalState;
    if (variant === "native-playwright") {
      const pw = nativeBench.playwright;
      await nativeReplay.measure("domSnapshot", () => pw.domSnapshot());
      await nativeReplay.measure("fill(Search)", () =>
        pw.getByRole("textbox", { name: "Search", exact: true }).fill("invoice"));
      await nativeReplay.measure("selectOption(Owner)", () =>
        pw.getByRole("combobox", { name: "Owner" }).selectOption({ label: "Alice" }));
      await nativeReplay.measure("check(Active)", () =>
        pw.getByRole("checkbox", { name: "Active only" }).check());
      await nativeReplay.measure("click(Search records)", () =>
        pw.getByRole("button", { name: "Search records" }).click());
      await nativeReplay.measure("waitFor(result)", () =>
        pw.getByText("Found: invoice / alice / active", { exact: true })
          .waitFor({ state: "visible", timeoutMs: 5000 }));
      finalState = await nativeReplay.measure("domSnapshot", () => pw.domSnapshot());
    } else {
      await nativeReplay.observe(true);
      await nativeReplay.measure("setValue(Search)", () =>
        nativeBench.setValue(nativeReplay.ref(/^text field .*Search/), "invoice"));
      if (variant === "ax-single") await nativeReplay.observe();
      await nativeReplay.measure("setValue(Owner)", () =>
        nativeBench.setValue(nativeReplay.ref(/^pop up button .*Owner/), "Alice"));
      if (variant === "ax-single") await nativeReplay.observe();
      await nativeReplay.measure("setValue(Active)", () =>
        nativeBench.setValue(nativeReplay.ref(/^checkbox .*Active only/), "1"));
      if (variant === "ax-single") await nativeReplay.observe();
      await nativeReplay.measure("click(Search records)", () =>
        nativeBench.click(nativeReplay.ref(/^button Search records$/)));
      finalState = await nativeReplay.observe();
    }
    success = finalState.includes("Found: invoice / alice / active");
    if (!success) throw new Error("Expected success text not visible");
  } catch (failure) {
    error = String(failure);
  }
  const steps = nativeReplay.current.steps;
  const sample = {
    variant, iteration, invocation, success, error,
    scriptElapsedMs: Date.now() - start,
    toolApiMs: steps.reduce((sum, step) => sum + step.elapsedMs, 0),
    stateBytes: steps.reduce((sum, step) => sum + (step.stateBytes || 0), 0),
    apiCalls: steps.length,
    observations: steps.filter((step) => step.state != null).length,
    steps,
  };
  nativeReplay.samples.push(sample);
  return { ...sample, steps: undefined };
};

// Run each AX pair in its own CUA call, changing i from 0 through 4:
// const order = i % 2 ? ["ax-batch", "ax-single"] : ["ax-single", "ax-batch"];
// for (const variant of order)
//   nodeRepl.write(await nativeReplay.run(variant, i, `pair-${i}`));
// Then run native-playwright iterations 0–4, retaining invocation IDs.
// Read raw observations from nativeReplay.samples; export with nodeRepl.write.
