// Real Chromium regression for #19, without installing a runtime dependency.
// PLAYWRIGHT_MODULE=/absolute/path/to/playwright/index.mjs node --test scripts/spa-readiness.test.mjs
// SOURCE_REF=deb4c7a runs the same assertions against the original implementation.
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { test } from "node:test";

const source = process.env.SOURCE_REF
  ? execFileSync("git", ["show", `${process.env.SOURCE_REF}:chrome-extension/background.js`], { encoding: "utf8" })
  : fs.readFileSync(new URL("../chrome-extension/background.js", import.meta.url), "utf8");
const between = (start, end) => {
  const normalized = source.replace(/\r\n/g, "\n");
  const first = normalized.indexOf(start);
  const last = normalized.indexOf(end, first);
  assert.ok(first >= 0 && last > first, `missing source boundary: ${start} / ${end}`);
  return normalized.slice(first, last);
};

async function fixture(run) {
  assert.ok(process.env.PLAYWRIGHT_MODULE, "Set PLAYWRIGHT_MODULE to an existing Playwright index.mjs");
  const { chromium } = await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE).href);
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(`<button id="open">Open dialog</button><script>
      window.clicks = 0;
      document.getElementById('open').onclick = () => {
        window.clicks++;
        setTimeout(() => {
          const modal = document.createElement('div');
          modal.setAttribute('role', 'dialog');
          modal.innerHTML = '<h1>Connect your Domain</h1><input aria-label="Domain"><button>Next</button>';
          document.body.append(modal);
        }, 1100);
      };
    </script>`);
    const context = vm.createContext({
      setTimeout, Date,
      chrome: { tabs: { get: async () => ({ status: "complete" }) } },
      requireClientId: () => "test",
      checkTab: async () => {},
      send: async (_tabId, _method, params) => {
        try { return { result: { value: await page.evaluate(params.expression) } }; }
        catch (error) { return { exceptionDetails: { text: error.message } }; }
      },
    });
    vm.runInContext(
      between("const SNAPSHOT_JS", "async function clickAt") +
      between("const CLICK_JS", "/// Click a snapshotted") +
      between("const sleep =", "/**\n * The page's readable text"), context,
    );
    const evaluate = (expression) => vm.runInContext(expression, context);
    const initial = await evaluate("snapshot(1)");
    const index = initial.elements.find((el) => el.label === "Open dialog").i;
    assert.equal((await page.evaluate(evaluate(`CLICK_JS(${index})`))).ok, true);
    await run({ page, evaluate });
  } finally {
    await browser.close();
  }
}

test("a single click waits for the delayed SPA dialog without navigation", async () => {
  await fixture(async ({ page, evaluate }) => {
    const start = Date.now();
    const result = await evaluate('withState({tabId:1,returnState:true,waitForSelector:"[role=dialog] button",waitTimeoutMs:3000},{ok:true})');
    const elapsed = Date.now() - start;
    console.log(`post-click wait ${elapsed}ms; Next=${result.snapshot.elements.some((el) => el.label === "Next")}`);
    assert.ok(result.snapshot.elements.some((el) => el.label === "Next"), "snapshot returned before the delayed dialog rendered");
    assert.equal(result.readiness.status, "met");
    assert.equal(result.readiness.condition, "visible_selector");
    assert.ok(elapsed >= 900 && elapsed < 3500);
    assert.equal(await page.evaluate("window.clicks"), 1);
    assert.equal(await page.locator("[role=dialog]").count(), 1);
    assert.equal(page.url(), "about:blank");
  });
});

test("timeout preserves the successful action; read-only re-observation never clicks again", async () => {
  await fixture(async ({ page, evaluate }) => {
    const result = await evaluate('withState({tabId:1,returnState:true,waitForSelector:"[role=dialog] button",waitTimeoutMs:100},{ok:true})');
    assert.equal(result.ok, true);
    assert.equal(result.readiness.status, "timeout");
    assert.ok(!result.snapshot.elements.some((el) => el.label === "Next"));
    const readiness = await evaluate('waitForReadiness({tabId:1,waitForSelector:"[role=dialog] button",waitTimeoutMs:3000})');
    assert.equal(readiness.status, "met");
    assert.ok((await evaluate("snapshot(1)")).elements.some((el) => el.label === "Next"));
    assert.equal(await page.evaluate("window.clicks"), 1);
    assert.equal(await page.locator("[role=dialog]").count(), 1);
  });
});

test("invalid selector syntax is a readiness error, not a failed or duplicated action", async () => {
  await fixture(async ({ page, evaluate }) => {
    const result = await evaluate('withState({tabId:1,returnState:true,waitForSelector:"[",waitTimeoutMs:100},{ok:true})');
    assert.equal(result.ok, true);
    assert.equal(result.readiness.status, "error");
    assert.equal(result.readiness.error, "invalid CSS selector");
    assert.equal(await page.evaluate("window.clicks"), 1);
    const malicious = '[id="x"]); window.injected = true; //';
    const readiness = await evaluate(`waitForReadiness({tabId:1,waitForSelector:${JSON.stringify(malicious)},waitTimeoutMs:0})`);
    assert.equal(readiness.status, "error");
    assert.equal(await page.evaluate("window.injected"), undefined);
  });
});

test("an unconfigured action snapshot does not claim application readiness", async () => {
  await fixture(async ({ evaluate }) => {
    const result = await evaluate("withState({tabId:1,returnState:true},{ok:true})");
    assert.equal(result.ok, true);
    assert.equal(result.readiness.status, "not_requested");
    assert.equal(result.readiness.condition, "document_load");
  });
});

test("a hidden match does not satisfy visible-selector readiness", async () => {
  await fixture(async ({ page, evaluate }) => {
    await page.evaluate(() => {
      const hidden = document.createElement("button");
      hidden.id = "ready";
      hidden.style.display = "none";
      document.body.append(hidden);
      setTimeout(() => { hidden.style.display = "block"; }, 600);
    });
    const start = Date.now();
    const readiness = await evaluate('waitForReadiness({tabId:1,waitForSelector:"#ready",waitTimeoutMs:2000})');
    assert.equal(readiness.status, "met");
    assert.ok(Date.now() - start >= 450);
  });
});
