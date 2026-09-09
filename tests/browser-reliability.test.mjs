import test from "node:test";
import assert from "node:assert/strict";
import { setupBrowser } from "./helpers/real-browser.mjs";

test(
  "browser action reliability regressions",
  {
    skip: process.env.BROWSER_RELAY_E2E !== "1",
    timeout: 60000,
  },
  async (t) => {
    const env = await setupBrowser({ fixtureFile: "browser-gaps.html" });
    t.after(env.close);
    const { tab, page, browser } = env;
    const open = async (name) => {
      await page.goto(`${env.fixtureUrl}?case=${name}`);
      await page.bringToFront();
    };
    const result = () => page.locator("#result").innerText();

    await t.test(
      "wait for enabled, appearing, and temporarily covered controls",
      async () => {
        await open("delayed-enabled");
        await tab.act([
          { type: "click", target: { selector: "#enable-start" } },
          {
            type: "wait",
            target: { selector: "#enabled-target" },
            state: "enabled",
            timeoutMs: 2000,
          },
          { type: "click", target: { selector: "#enabled-target" } },
        ]);
        assert.equal(await result(), "Enabled done");
        for (const [name, start, target, expected] of [
          [
            "appearance",
            "Start appearance",
            "Appeared action",
            "Appeared done",
          ],
          [
            "temporary-cover",
            "Start temporary cover",
            "Covered action",
            "Covered done",
          ],
          ["moving", "Start movement", "Moving action", "Moving done"],
        ]) {
          await open(name);
          await tab.act([
            { type: "click", target: { role: "button", name: start } },
            {
              type: "click",
              target: { role: "button", name: target },
              timeoutMs: 2000,
            },
          ]);
          assert.equal(await result(), expected);
        }
      },
    );

    await t.test(
      "scoped SDK locators and snapshot context disambiguate duplicate names",
      async () => {
        await open("scoped");
        const state = await tab.snapshot({ includeNodes: true, diff: false });
        const south = state.nodes.find(
          (n) => n.role === "group" && n.name === "South",
        );
        assert.ok(
          state.nodes.some((n) => n.name === "Save" && n.within === south.ref),
        );
        await tab
          .getByRole("group", { name: "South" })
          .getByRole("button", { name: "Save" })
          .click();
        assert.equal(await result(), "South saved");
        await tab
          .locator("fieldset")
          .getByRole("button", { name: "Save" })
          .click()
          .then(
            () =>
              assert.fail("Ambiguous parent must not pick the first fieldset"),
            (e) => assert.match(e.message, /found 2/),
          );
        await tab.locator("#north-save").click();
        assert.equal(await result(), "North saved");
        await tab
          .locator("fieldset:nth-of-type(2)")
          .getByRole("button", { name: "Save" })
          .click();
        assert.equal(await result(), "South saved");
      },
    );

    await t.test(
      "checkbox actions deliver a trusted click once and support ARIA controls",
      async () => {
        for (const [name, label, expected] of [
          ["trusted-checkbox", "Trusted choice", "Checked=true; trusted=true"],
          ["custom-checkbox", "Custom choice", "Custom checked=true"],
        ]) {
          await open(name);
          await page.evaluate(() => {
            window.probeClicks = 0;
            document
              .querySelector("section:not([hidden])")
              .addEventListener("click", () => window.probeClicks++);
          });
          const control = tab.getByRole("checkbox", { name: label });
          await control.check();
          assert.equal(await result(), expected);
          const task = await control.check();
          assert.equal(task.results[0].changed, false);
          assert.equal(await page.evaluate(() => window.probeClicks), 1);
        }
      },
    );

    await t.test(
      "invalid editing/selection preserve prior data; rich text remains editable",
      async () => {
        await open("disabled-option");
        await assert.rejects(
          () =>
            tab
              .getByRole("combobox", { name: "Availability" })
              .select("closed"),
          /option_disabled/,
        );
        assert.equal(await page.locator("#availability").inputValue(), "open");
        await open("readonly");
        await assert.rejects(
          () => tab.locator("#readonly").fill("wrong"),
          /not_editable/,
        );
        assert.equal(await page.locator("#readonly").inputValue(), "unchanged");
        await open("richtext");
        await tab.getByRole("textbox", { name: "Rich note" }).fill("New note");
        assert.equal(await result(), "Rich=New note");
      },
    );

    await t.test(
      "frame hit-testing checks the actual action point, not the iframe center",
      async () => {
        await open("frame-cover");
        const frame = page.frameLocator('iframe[title="Covered frame"]');
        await assert.rejects(
          () =>
            tab
              .getByRole("button", { name: "Frame action" })
              .click({ timeoutMs: 250 }),
          /covered|clipped/,
        );
        assert.equal(await frame.locator("button").innerText(), "Frame action");
        await page
          .locator('section[data-case="frame-cover"] .cover')
          .evaluate((cover) => {
            cover.style.left = "300px";
          });
        await tab.getByRole("button", { name: "Frame action" }).click();
        assert.equal(await frame.locator("button").innerText(), "Frame done");
      },
    );

    await t.test(
      "AX targets in closed shadow roots retain hit testing through outer hosts",
      async () => {
        await open("richtext");
        await page.evaluate(() => {
          const host = document.createElement("div");
          const button = document.createElement("button");
          button.textContent = "Closed shadow action";
          button.onclick = () => {
            document.getElementById("result").textContent =
              "Closed shadow done";
          };
          host.attachShadow({ mode: "closed" }).append(button);
          document.body.prepend(host);
        });
        const target = tab.getByRole("button", {
          name: "Closed shadow action",
        });
        await target.click();
        assert.equal(await result(), "Closed shadow done");
        await page.evaluate(() => {
          const cover = document.createElement("div");
          cover.style.cssText =
            "position:fixed;inset:0;z-index:10000;background:#ddd";
          document.body.append(cover);
        });
        await assert.rejects(() => target.click(), /covered/);
      },
    );

    await t.test(
      "readiness cancellation prevents dispatch and a click is never replayed",
      async () => {
        await open("delayed-enabled");
        const task = await tab.act(
          [
            {
              type: "click",
              target: { selector: "#enabled-target" },
              timeoutMs: 5000,
            },
            { type: "click", target: { selector: "#enable-start" } },
          ],
          { async: true },
        );
        await browser.tasks.cancel(task.id);
        await assert.rejects(() => browser.tasks.wait(task.id), /cancel/i);
        assert.equal(await result(), "Ready");
        await open("rerender");
        const stale = (await tab.snapshot({ includeNodes: true })).nodes.find(
          (n) => n.name === "Replaceable action" && n.role === "button",
        ).ref;
        await tab
          .getByRole("button", { name: "Replace target", exact: true })
          .click();
        await assert.rejects(
          () => tab.ref(stale).click({ timeoutMs: 500 }),
          /reference|exists|expired/i,
        );
        await tab
          .getByRole("button", { name: "Replaceable action" })
          .click({ timeoutMs: 500 });
        assert.equal(await result(), "Replacement done");
        await page.evaluate(() => {
          window.onceClicks = 0;
          const button = document.createElement("button");
          button.id = "once";
          button.textContent = "Once";
          button.onclick = () => {
            window.onceClicks++;
            button.remove();
          };
          document.body.prepend(button);
        });
        await tab.locator("#once").click({ timeoutMs: 500 });
        assert.equal(await page.evaluate(() => window.onceClicks), 1);
      },
    );
  },
);
