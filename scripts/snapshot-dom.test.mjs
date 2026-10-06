#!/usr/bin/env node
// Real Chromium regression, dependency-free CDP; never uses the user's profile.
// node scripts/snapshot-dom.test.mjs --chrome <Chrome for Testing binary>
// Add --source <background.js> to run the same regression against a baseline.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const option = (name) => {
  const at = process.argv.indexOf(name);
  return at >= 0 ? process.argv[at + 1] : undefined;
};
const chromePath = option("--chrome");
if (!chromePath) throw new Error("provide --chrome <Chrome for Testing binary>");
const scratch = process.env.TMPDIR || path.join(root, ".snapshot-test");
fs.mkdirSync(scratch, { recursive: true });
const profile = fs.mkdtempSync(path.join(scratch, "snapshot-dom-"));
const chrome = spawn(chromePath, [
  `--user-data-dir=${profile}`,
  "--headless=new",
  "--remote-debugging-port=0",
  "--no-first-run",
  ...(process.platform === "linux" ? ["--no-sandbox"] : []),
  "about:blank",
], { stdio: ["ignore", "ignore", "pipe"] });
let chromeLog = "";
chrome.stderr.on("data", (chunk) => (chromeLog += chunk));
chrome.on("error", (error) => (chromeLog += error.message));
let socket;
try {
  let port;
  for (let n = 0; n < 100; n++) {
    try {
      port = Number(fs.readFileSync(path.join(profile, "DevToolsActivePort"), "utf8").split("\n")[0]);
      break;
    } catch {}
    if (!chrome.pid || chrome.exitCode !== null || chrome.signalCode !== null) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.ok(port, `Chromium did not start:\n${chromeLog}`);
  // DevTools publishes its port before the initial page target is ready.
  let target;
  for (let n = 0; n < 100 && !target; n++) {
    const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
    target = targets.find((entry) => entry.type === "page" && entry.webSocketDebuggerUrl);
    if (!target) await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.ok(target, `Chromium did not publish a page target:\n${chromeLog}`);
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });
  let id = 0;
  const pending = new Map();
  socket.addEventListener("message", (event) => {
    const reply = JSON.parse(event.data);
    pending.get(reply.id)?.(reply);
    pending.delete(reply.id);
  });
  async function command(method, params) {
    const current = ++id;
    const result = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(current);
        reject(new Error(`CDP timeout: ${method}`));
      }, 10000);
      pending.set(current, (reply) => {
        clearTimeout(timer);
        resolve(reply);
      });
    });
    socket.send(JSON.stringify({ id: current, method, params }));
    const reply = await result;
    assert.ok(!reply.error, JSON.stringify(reply));
    return reply.result;
  }
  async function evaluate(expression) {
    const result = await command("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    assert.ok(!result.exceptionDetails, JSON.stringify(result));
    return result.result.value;
  }
  const source = fs.readFileSync(option("--source") || path.join(root, "chrome-extension/background.js"), "utf8");
  const declaration = source.slice(source.indexOf("const SNAPSHOT_JS ="), source.indexOf("\nasync function snapshot("));
  const expression = vm.runInNewContext(declaration + "\nSNAPSHOT_JS");
  const clickDeclaration = source.slice(source.indexOf("const CLICK_JS ="), source.indexOf("\n/// Click a snapshotted element"));
  const click = vm.runInNewContext(clickDeclaration + "\nCLICK_JS");
  const snapshot = (options = {}) => evaluate(expression.slice(0, -2) + `(${JSON.stringify(options)})`);
  const set = (html) => evaluate(`document.body.innerHTML = ${JSON.stringify(html)}; true`);
  const buttons = (count, prefix = "Background") => Array.from({ length: count }, (_, i) => `<button>${prefix} ${i}</button>`).join("");
  await set(`<main aria-hidden="true">${buttons(260)}</main><div role="dialog" aria-modal="true" style="position:fixed;inset:0;background:white"><input aria-label="Domain"><button>Next</button><button>Verify</button></div>`);
  const modal = await snapshot();
  console.log(`original reproduction: ${modal.elements.length} controls; labels=${modal.elements.slice(0, 3).map((el) => el.label).join(", ")}`);
  assert.deepEqual(modal.elements.map((el) => el.label), ["Domain", "Next", "Verify"]);
  assert.equal(modal.scope, "modal");
  console.log("PASS appended modal excludes 260 hidden background controls");
  // Keep evaluating the original target after activating a different tab.
  const foreground = await command("Target.createTarget", { url: "about:blank" });
  await command("Target.activateTarget", { targetId: foreground.targetId });
  assert.deepEqual((await snapshot()).elements.map((el) => el.label), ["Domain", "Next", "Verify"]);
  console.log("PASS modal snapshot works in a background tab");

  await set(`${buttons(260)}<div role="dialog" style="position:fixed;inset:0;background:white"><button>Foreground</button></div>`);
  assert.deepEqual((await snapshot()).elements.map((el) => el.label), ["Foreground"]);
  console.log("PASS modal budget excludes ordinary covered background");

  await set('<div role="dialog" style="position:fixed;inset:0;z-index:20;background:white"><button>Top</button></div><div role="dialog" style="position:fixed;inset:0;z-index:10;background:white"><button>Under</button></div>');
  assert.equal((await snapshot()).elements[0].label, "Top");
  await evaluate('document.body.innerHTML += \'<dialog><button>Native top layer</button></dialog>\'; document.querySelector("dialog").showModal(); true');
  assert.equal((await snapshot()).elements[0].label, "Native top layer");
  await evaluate('document.querySelector("dialog").innerHTML += \'<div role="alertdialog" style="position:fixed;inset:100px;background:white"><button>Nested native</button></div>\'; true');
  assert.deepEqual((await snapshot()).elements.map((el) => el.label), ["Nested native"]);
  console.log("PASS painted stacking and native modal top layer");

  await set('<div inert><dialog><button>Escaped inert</button><span inert><button>Still inert</button></span></dialog></div><button>Background</button>');
  await evaluate('document.querySelector("dialog").showModal(); true');
  assert.deepEqual((await snapshot()).elements.map((el) => el.label), ["Escaped inert"]);
  console.log("PASS native modal escapes ancestor inertness, not explicit descendant inertness");

  await set('<button>Page action</button><dialog open><button>Modeless</button></dialog>');
  assert.deepEqual((await snapshot()).elements.map((el) => el.label), ["Page action", "Modeless"]);
  await set('<button>Page action</button><div role="dialog" aria-modal="false"><button>Explicitly nonmodal</button></div>');
  assert.equal((await snapshot()).scope, "page");
  assert.equal((await snapshot()).total, 2);
  console.log("PASS modeless and explicitly nonmodal dialogs retain page controls");

  await set('<div style="position:fixed;inset:0;z-index:30"><div role="dialog" style="position:absolute;inset:0;background:white"><button>High context</button></div></div><div style="position:fixed;inset:0;z-index:10"><div role="dialog" style="position:absolute;inset:0;z-index:9999;background:white"><button>Low context</button></div></div>');
  assert.equal((await snapshot()).elements[0].label, "High context");
  await set('<div role="dialog" style="position:fixed;inset:0;background:white"><button>Parent</button><div role="alertdialog" style="position:fixed;inset:100px;background:white"><button>Nested</button></div></div>');
  assert.deepEqual((await snapshot()).elements.map((el) => el.label), ["Nested"]);
  console.log("PASS stacking contexts and nested topmost dialog");

  await set(`${buttons(260)}<div aria-modal="true" style="position:fixed;inset:0;background:white;overflow:auto">${buttons(300, "Modal")}</div>`);
  const modalFirst = await snapshot({ limit: 100 });
  assert.equal(modalFirst.total, 300);
  assert.equal(modalFirst.nextOffset, 100);
  const modalLast = await snapshot({ offset: 200, limit: 100 });
  assert.equal(modalLast.elements[0].label, "Modal 200");
  assert.equal(modalLast.elements[0].i, 200);
  assert.equal(modalLast.nextOffset, null);
  await evaluate('globalThis.savedHitTest = document.elementsFromPoint; document.elementsFromPoint = () => []; true');
  assert.equal((await snapshot()).scope, "modal");
  await evaluate('document.elementsFromPoint = globalThis.savedHitTest; delete globalThis.savedHitTest; true');
  console.log("PASS large modal pagination and background-tab hit-test fallback");

  await set('<div aria-hidden="true"><button>Hidden</button></div><div inert><button>Inert</button></div><div style="opacity:0"><button>Transparent</button></div><div hidden><button>Gone</button></div><button style="position:absolute;top:2000px">Offscreen</button><input type="password" value="DO-NOT-LEAK">');
  const accessible = await snapshot();
  assert.deepEqual(accessible.elements.map((el) => el.label), ["Offscreen", ""]);
  assert.equal(accessible.elements[0].inView, false);
  assert.ok(!JSON.stringify(accessible).includes("DO-NOT-LEAK"));
  console.log("PASS hidden/inert ancestors excluded, offscreen retained, password protected");

  await set(buttons(520, "Control"));
  const first = await snapshot();
  assert.equal(first.elements.length, 250);
  assert.equal(first.total, 520);
  assert.equal(first.truncated, true);
  assert.equal(first.nextOffset, 250);
  const second = await snapshot({ offset: first.nextOffset, limit: 250 });
  assert.equal(second.elements[0].i, 250);
  assert.equal(second.elements[0].label, "Control 250");
  assert.equal(await evaluate('document.querySelector(\'[data-cu-idx="0"]\').innerText'), "Control 0");
  assert.equal(await evaluate('document.querySelectorAll(\'[data-cu-idx="250"]\').length'), 1);
  await evaluate('document.querySelector(\'[data-cu-idx="250"]\').onclick = () => document.title = "clicked page two"; true');
  assert.equal((await evaluate(click(second.elements[0].i))).ok, true);
  assert.equal(await evaluate("document.title"), "clicked page two");
  const last = await snapshot({ offset: second.nextOffset });
  assert.equal(last.elements.length, 20);
  assert.equal(last.truncated, false);
  assert.equal(last.nextOffset, null);
  assert.equal((await snapshot({ offset: 1000 })).elements.length, 0);
  await evaluate('document.querySelector(\'[data-cu-idx="0"]\').hidden = true; true');
  await snapshot();
  assert.equal(await evaluate('document.querySelectorAll(\'button[hidden][data-cu-idx]\').length'), 0);
  console.log("PASS bounded pagination, unique actionable global indices, stale-index cleanup");
} finally {
  socket?.close();
  if (chrome.pid && chrome.exitCode === null && chrome.signalCode === null) {
    const exited = new Promise((resolve) => chrome.once("exit", resolve));
    chrome.kill();
    await exited;
  }
  // Windows child processes can release profile files a moment after exit.
  fs.rmSync(profile, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
}
