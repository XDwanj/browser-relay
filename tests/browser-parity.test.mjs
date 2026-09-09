import test from "node:test";
import assert from "node:assert/strict";
import { setupBrowser } from "./helpers/real-browser.mjs";
import { createBrowser } from "../server/sdk.js";
import { mkdir } from "node:fs/promises";
import { SNAPSHOT_JS } from "../extension/snapshot.js";

test(
  "reading and session parity through the actual Relay extension",
  { skip: !process.env.BROWSER_RELAY_E2E, timeout: 120000 },
  async (t) => {
    const env = await setupBrowser({
      fixtureFile: "reading.html",
      headed: !!process.env.BROWSER_RELAY_HEADED,
    });
    t.after(env.close);
    const { browser, tab, request, fixtureUrl } = env;
    await t.test(
      "runtime capabilities identify the running executor",
      async () => {
        const c = await browser.capabilities();
        assert.equal(c.protocolVersion, 2);
        assert.ok(c.runtimeId);
        assert.ok(c.features.includes("read"));
      },
    );
    await t.test(
      "complete main-content reading, links, grouping and continuation",
      async () => {
        let o = await tab.read({ maxLength: 1100 });
        let text = o.snapshot;
        const id = o.observationId;
        assert.equal(o.truncated, true);
        assert.ok(o.nextCursor);
        while (o.nextCursor) {
          o = await tab.read({ cursor: o.nextCursor, maxLength: 1100 });
          assert.equal(o.observationId, id);
          text += o.snapshot;
        }
        for (let i = 1; i <= 20; i++)
          assert.ok(text.includes(`END_POST_${i}`), `Post ${i} body missing`);
        assert.ok(text.includes("TABLE_END"));
        assert.ok(text.includes("1053 replies. Reply"));
        assert.ok(
          text.includes("/posts/20?full=long-link-value-" + "x".repeat(210)),
        );
        assert.ok(text.includes("article"));
        assert.equal(text.includes("SECRET_HIDDEN_TEXT"), false);
        assert.equal(text.includes("Navigation noise"), false);
        const unchanged = await tab.read({ diff: true, maxLength: 1100 });
        assert.equal(unchanged.diff, true);
        assert.equal(unchanged.snapshot, "(no changes)");
      },
    );
    await t.test(
      "subtree reading and stale cursors after navigation",
      async () => {
        const o = await tab.snapshot({
          includeNodes: true,
          maxLength: 100000,
          diff: false,
        });
        const article = o.nodes.find((n) => n.role === "article");
        const part = await tab.ref(article.ref).read({ maxLength: 100000 });
        assert.ok(part.snapshot.includes("END_POST_1"));
        assert.equal(part.snapshot.includes("END_POST_2"), false);
        const paged = await tab.read({ maxLength: 100 });
        await tab.goto(fixtureUrl);
        await assert.rejects(() => tab.read({ cursor: paged.nextCursor }), {
          code: "stale_observation",
        });
      },
    );
    await t.test(
      "legacy text handles display:contents, complete table cells and semantic button labels",
      async () => {
        const result = JSON.parse(await tab.eval(SNAPSHOT_JS));
        assert.ok(result.snapshot.includes("END_POST_20"));
        assert.ok(result.snapshot.includes("TABLE_END"));
        assert.ok(result.snapshot.includes("1053 replies. Reply"));
        assert.equal(result.snapshot.includes("SECRET_HIDDEN_TEXT"), false);
      },
    );
    await t.test(
      "ownership, handoff and explicit session stop preserve user tabs",
      async () => {
        const other = createBrowser({ request, sessionId: "second-reader" });
        const ot = other.tab(tab.id);
        await assert.rejects(() => ot.read(), { code: "tab_claimed" });
        await tab.handoff("second-reader");
        assert.ok((await ot.read()).snapshot.includes("Complete reading"));
        await assert.rejects(() => tab.focus(), { code: "tab_claimed" });
        await ot.handoff(browser.sessionId);
        await other.dispose();
        assert.ok((await browser.tabs()).some((x) => x.id === tab.id));
      },
    );
    await t.test(
      "one tab supports semantic, visual and delayed-content recovery",
      async () => {
        await tab.focus();
        const both = await tab.observe({ mode: "both" });
        assert.equal(both.screenshot.format, "png");
        assert.ok(both.screenshot.screenshotId);
        const result = await tab.act(
          [
            {
              type: "click",
              target: { role: "button", name: "Load more posts" },
            },
            {
              type: "wait",
              target: { role: "heading", name: "New author" },
              timeoutMs: 2000,
            },
          ],
          { observe: "read", maxLength: 100000 },
        );
        assert.ok(
          result.observation.snapshot.includes("NEW_CONTENT_CONFIRMED"),
        );
        const scrolled = await tab.scroll(500, {
          waitForChange: true,
          timeoutMs: 100,
        });
        assert.equal(typeof scrolled.results[0].viewportMoved, "boolean");
        assert.equal(typeof scrolled.results[0].contentChanged, "boolean");
      },
    );
    await t.test(
      "popup exposes ownership and stopping a session cancels work without closing the page",
      async () => {
        await tab.claim({ label: "阅读验收" });
        await env.worker.evaluate(() =>
          chrome.storage.local.set({ uiLang: "zh_CN" }),
        );
        const popup = await env.context.newPage();
        try {
          await popup.goto(
            `chrome-extension://${new URL(env.worker.url()).host}/popup.html`,
          );
          await popup.getByText("阅读验收", { exact: false }).waitFor();
          const pending = await tab.act(
            [
              {
                type: "wait",
                target: { role: "heading", name: "Never appears" },
                timeoutMs: 10000,
              },
            ],
            { async: true },
          );
          await popup
            .getByRole("button", { name: "停止", exact: true })
            .waitFor();
          if (process.env.BROWSER_RELAY_SCREENSHOTS) {
            await mkdir(process.env.BROWSER_RELAY_SCREENSHOTS, {
              recursive: true,
            });
            await popup.locator("body").screenshot({
              path:
                process.env.BROWSER_RELAY_SCREENSHOTS +
                "/extension-sessions.png",
            });
          }
          await popup
            .getByRole("button", { name: "停止", exact: true })
            .click();
          await assert.rejects(() => browser.tasks.wait(pending.id), {
            code: "session_stopped",
          });
          await assert.rejects(() => tab.read(), { code: "session_stopped" });
          assert.equal(env.page.isClosed(), false);
        } finally {
          await popup.close();
        }
      },
    );
    await browser.dispose();
  },
);
