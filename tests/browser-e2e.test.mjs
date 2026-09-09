import test from "node:test";
import assert from "node:assert/strict";
import { setupBrowser } from "./helpers/real-browser.mjs";
import { chromium } from "playwright";
import { createScriptRuntime } from "../server/script-runtime.js";
import { createTransport, createBrowser } from "../server/sdk.js";
import { deriveRouteId } from "../server/remote-protocol.js";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { randomBytes } from "node:crypto";
import { waitFor } from "./helpers/real-browser.mjs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

test(
  "real extension: accessibility, grouped actions, visual input, tasks, runtime, and CDP",
  { skip: process.env.BROWSER_RELAY_E2E !== "1", timeout: 120000 },
  async (t) => {
    const env = await setupBrowser();
    t.after(env.close);
    const { tab, page, browser, request } = env;
    await t.test(
      "AX snapshot includes shadow DOM and both frames; no password value",
      async () => {
        const state = await tab.snapshot({ diff: false, includeNodes: true });
        assert.match(state.snapshot, /Shadow action/);
        assert.match(state.snapshot, /Frame action/);
        assert.match(state.snapshot, /Cross frame/);
        assert.doesNotMatch(
          JSON.stringify(state),
          /fixture-secret-never-print/,
        );
        assert.equal(state.warnings.length, 0);
        assert.ok(state.frames.length >= 3);
      },
    );
    await t.test(
      "short action group fills, selects, checks and waits for visible result",
      async () => {
        await tab.act([
          {
            type: "fill",
            target: { role: "textbox", name: "Search" },
            text: "invoice",
          },
          {
            type: "select",
            target: { role: "combobox", name: "Owner" },
            value: "alice",
          },
          {
            type: "check",
            target: { role: "checkbox", name: "Active only" },
            checked: true,
          },
          { type: "click", target: { role: "button", name: "Search records" } },
          {
            type: "wait",
            target: {
              role: "StaticText",
              name: "Found: invoice / alice / active",
            },
          },
        ]);
        assert.equal(
          await page.locator("#status").textContent(),
          "Found: invoice / alice / active",
        );
      },
    );
    await t.test(
      "diff state, duplicate targets and stale references",
      async () => {
        const state = await tab.snapshot({ diff: false, includeNodes: true });
        const button = state.nodes.find(
          (n) => n.name === "Add row" && n.role === "button",
        );
        await tab.ref(button.ref).click();
        const delta = await tab.snapshot();
        assert.equal(delta.diff, true);
        await assert.rejects(
          () => tab.getByRole("button", { name: "Save" }).click(),
          /matches 2/,
        );
        await page.reload();
        await assert.rejects(
          () => tab.ref(button.ref).click(),
          /reference|expired|no longer/i,
        );
      },
    );
    await t.test(
      "actions through shadow DOM and cross-origin frame",
      async () => {
        // Parent scrolling must settle before routing input into an OOPIF.
        // Repetition catches the down-in-parent/up-in-child race seen in audit.
        for (let iteration = 0; iteration < 20; iteration++) {
          await page.reload();
          await tab.getByRole("button", { name: "Shadow action" }).click();
          await tab.getByRole("button", { name: "Frame action" }).click();
          await tab.getByRole("button", { name: "Cross frame" }).click();
          assert.equal(
            await page.locator("#shadow button").textContent(),
            "Shadow done",
          );
          assert.equal(
            await page.frameLocator("#cross").locator("button").textContent(),
            "Frame done",
          );
        }
      },
    );
    await t.test("screenshot mapping and canvas click", async () => {
      await page.locator("#canvas").scrollIntoViewIfNeeded();
      const box = await page.locator("#canvas").boundingBox();
      const shot = await tab.screenshot();
      assert.equal(shot.width, 1280);
      assert.ok(shot.height > 0);
      await tab.clickAt(
        (box.x + 150) / shot.imageToViewport.scaleX,
        (box.y + 45) / shot.imageToViewport.scaleY,
        { screenshotId: shot.screenshotId },
      );
      assert.equal(
        await page.locator("#canvas-result").textContent(),
        "Canvas done",
      );
      await page.evaluate(() => scrollBy(0, 100));
      await assert.rejects(
        () => tab.clickAt(10, 10, { screenshotId: shot.screenshotId }),
        /Viewport changed/,
      );
    });
    await t.test("drag and element scrolling", async () => {
      await page.locator("#drag").scrollIntoViewIfNeeded();
      const box = await page.locator("#drag").boundingBox();
      await tab.drag(
        { x: box.x + 10, y: box.y + 10 },
        { x: box.x + 130, y: box.y + 10 },
      );
      assert.equal(
        await page.locator("#drag-result").textContent(),
        "Drag done",
      );
      await tab.act([
        { type: "scroll", target: { selector: "#scrollbox" }, deltaY: 250 },
      ]);
      assert.ok(
        (await page.locator("#scrollbox").evaluate((el) => el.scrollTop)) > 0,
      );
    });
    await t.test(
      "cancellation stops subsequent actions and permits following jobs",
      async () => {
        const job = await tab.act(
          [
            {
              type: "wait",
              target: { role: "button", name: "Never appears" },
              timeoutMs: 15000,
            },
            { type: "click", target: { selector: "#add" } },
          ],
          { async: true },
        );
        await browser.tasks.cancel(job.id);
        await assert.rejects(() => browser.tasks.wait(job.id), /cancel/i);
        const before = await page.locator("#rows li").count();
        await tab.locator("#add").click();
        assert.equal(await page.locator("#rows li").count(), before + 1);
      },
    );
    await t.test(
      "persistent JS bindings and original image content",
      async () => {
        const runtime = createScriptRuntime({ request });
        try {
          const a = await runtime.execute({
            code: `var t = browser.tab(${JSON.stringify(tab.id)}); var retained = 41; retained`,
          });
          assert.equal(a.isError, false);
          const b = await runtime.execute({
            code: "retained += 1; print(retained); display(await t.screenshot())",
          });
          assert.equal(b.isError, false);
          assert.equal(b.content[0].text, "42");
          assert.ok(b.content.some((c) => c.type === "image"));
        } finally {
          await runtime.close();
        }
      },
    );
    await t.test(
      "editable guards, empty values, and device-pixel screenshot mapping",
      async () => {
        await page.bringToFront();
        await tab
          .getByRole("textbox", { name: "Search", exact: true })
          .fill("clear me");
        await tab
          .getByRole("textbox", { name: "Search", exact: true })
          .fill("");
        assert.equal(await page.locator("input[name=query]").inputValue(), "");
        await assert.rejects(
          () => tab.locator("#add").fill("wrong control"),
          /not_editable/,
        );
        await page.evaluate(() => {
          const input = document.createElement("input");
          input.type = "number";
          input.id = "numeric-probe";
          input.value = "12";
          document.body.prepend(input);
        });
        await tab.locator("#numeric-probe").fill("34");
        assert.equal(await page.locator("#numeric-probe").inputValue(), "34");
        const cdp = await env.context.newCDPSession(page);
        try {
          await cdp.send("Emulation.setDeviceMetricsOverride", {
            width: 1280,
            height: 1000,
            deviceScaleFactor: 2,
            mobile: false,
          });
          await page.locator("#canvas").scrollIntoViewIfNeeded();
          const box = await page.locator("#canvas").boundingBox(),
            shot = await tab.screenshot();
          assert.equal(shot.viewport.dpr, 2);
          assert.equal(shot.imageToViewport.scaleX, 1280 / shot.width);
          await tab.clickAt(
            (box.x + 150) / shot.imageToViewport.scaleX,
            (box.y + 45) / shot.imageToViewport.scaleY,
            { screenshotId: shot.screenshotId },
          );
          assert.equal(
            await page.locator("#canvas-result").textContent(),
            "Canvas done",
          );
        } finally {
          await cdp.send("Emulation.clearDeviceMetricsOverride");
          await cdp.detach();
        }
      },
    );
    await t.test(
      "Playwright connects over advertised CDP and preserves user tab",
      async () => {
        const connected = await chromium.connectOverCDP(
          `http://127.0.0.1:${env.port}`,
          { timeout: 10000 },
        );
        try {
          const target = connected
            .contexts()[0]
            .pages()
            .find((p) => p.url() === env.fixtureUrl);
          assert.ok(target);
          await target.getByRole("button", { name: "Add row" }).click();
          assert.ok((await target.screenshot()).length > 100);
          const created = await connected.contexts()[0].newPage();
          await created.goto(env.fixtureUrl + "?cdp");
          await created
            .getByRole("textbox", { name: "Search", exact: true })
            .fill("CDP navigation");
          assert.equal(
            await created
              .getByRole("textbox", { name: "Search", exact: true })
              .inputValue(),
            "CDP navigation",
          );
          await created.close();
        } finally {
          await connected.close();
        }
        assert.equal(page.isClosed(), false);
        await page.reload({ timeout: 5000 });
      },
    );
    await t.test(
      "popup cancels work and remote hub uses the same executor",
      async () => {
        const server = createServer();
        await new Promise((r) => server.listen(0, "127.0.0.1", r));
        const hubPort = server.address().port;
        await new Promise((r) => server.close(r));
        const hub = spawn(process.execPath, ["server/hub-server.js"], {
          cwd: new URL("..", import.meta.url),
          env: { ...process.env, BROWSER_RELAY_HUB_PORT: String(hubPort) },
          stdio: "ignore",
        });
        const popup = await env.context.newPage();
        try {
          await waitFor(
            async () =>
              (await fetch(`http://127.0.0.1:${hubPort}/v1/health`)).ok,
          );
          const secret = randomBytes(24).toString("base64url");
          await env.worker.evaluate(
            (config) => chrome.storage.local.set(config),
            {
              remoteControlEnabled: true,
              remoteHost: `http://127.0.0.1:${hubPort}`,
              remoteRouteId: deriveRouteId(secret),
              remoteSecret: secret,
              remoteDeviceId: `br-${secret}`,
              uiLang: "zh_CN",
            },
          );
          await popup.goto(
            env.worker.url().replace("/background.js", "/popup.html"),
          );
          const enabled = await popup.evaluate(() =>
            chrome.runtime.sendMessage({ type: "enableRemoteControl" }),
          );
          assert.equal(enabled.connected, true);
          const remote = createBrowser({
            request: createTransport({
              remoteDeviceId: `br-${secret}`,
              remoteHost: `http://127.0.0.1:${hubPort}`,
            }),
          });
          const remoteTab = remote.tab(tab.id);
          const state = await remoteTab.snapshot({ diff: false });
          assert.match(state.snapshot, /Add row/);
          const before = await page.locator("#rows li").count();
          await remoteTab.locator("#add").click();
          assert.equal(await page.locator("#rows li").count(), before + 1);
          const job = await remoteTab.act(
            [
              {
                type: "wait",
                target: { role: "button", name: "Absent" },
                timeoutMs: 15000,
              },
              { type: "click", target: { selector: "#add" } },
            ],
            { async: true },
          );
          await popup.getByRole("button", { name: "取消当前任务" }).waitFor();
          if (process.env.BROWSER_RELAY_SCREENSHOTS) {
            await mkdir(process.env.BROWSER_RELAY_SCREENSHOTS, {
              recursive: true,
            });
            await popup.locator("body").screenshot({
              path: join(
                process.env.BROWSER_RELAY_SCREENSHOTS,
                "extension-tasks.png",
              ),
            });
          }
          await popup.getByRole("button", { name: "取消当前任务" }).click();
          await assert.rejects(() => remote.tasks.wait(job.id), /cancel/i);
          assert.equal(await page.locator("#rows li").count(), before + 1);
        } finally {
          await popup.close();
          hub.kill("SIGTERM");
        }
      },
    );
  },
);
