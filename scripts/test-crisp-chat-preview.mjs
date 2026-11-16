import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { chromium } from "playwright";

const asset = (name) => readFileSync(new URL(
  `../integrations/wordpress/jellybean-presence/assets/${name}`, import.meta.url,
), "utf8");
const browser = await chromium.launch({
  headless: true,
  ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
    ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {}),
});
try {
  for (const mobile of [false, true]) {
    const page = await browser.newPage({
      viewport: mobile ? { width: 390, height: 844 } : { width: 1366, height: 900 },
      isMobile: mobile, hasTouch: mobile,
    });
    await page.route("https://preview.test/**", (route) => route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><div class="crisp-client">
        <div data-id="new_messages"><div class="cc-1ts3v">
          <div class="cc-1k3vn" id="old">Hi</div>
          <div class="cc-1k3vn" id="latest">Welcome back! How can we help?</div>
        </div><button>Compose your reply</button></div>
        <button id="launcher">Chat <span id="badge">2</span></button>
        <div id="history">Full conversation</div></div>`,
    }));
    await page.goto("https://preview.test/");
    await page.clock.install();
    await page.evaluate(() => {
      window.events = {};
      window.commands = [];
      window.CRISP_WEBSITE_ID = "test-site";
      window.$crisp = {
        push(command) {
          window.commands.push(command.slice(0, 2));
          if (command[0] === "on") window.events[command[1]] = command[2];
        },
      };
    });
    await page.addStyleTag({ content: asset("chat-preview.css") });
    await page.addScriptTag({ content: asset("chat-preview.js") });
    assert.equal(await page.locator("#old").isVisible(), false);
    assert.equal(await page.locator("#latest").isVisible(), true);
    await page.clock.fastForward(8100);
    assert.equal(await page.locator("#latest").isVisible(), false);
    assert.equal(await page.locator("#badge").innerText(), "2");
    assert.equal(await page.locator("#launcher").isVisible(), true);
    assert.equal(await page.locator("#history").isVisible(), true);
    await page.evaluate(() => window.events["message:received"]({ content: "New reply" }));
    assert.equal(await page.locator("#latest").isVisible(), true);
    await page.evaluate(() => window.events["chat:opened"]());
    assert.equal(await page.locator("#latest").isVisible(), false);
    assert.equal(await page.evaluate(() => window.commands.some(([action]) => action === "do")), false);
    // Dismissal survives same-tab navigation; no repeat popup on every page.
    await page.reload();
    await page.evaluate(() => { window.$crisp = { push() {} }; window.CRISP_WEBSITE_ID = "test-site"; });
    await page.addStyleTag({ content: asset("chat-preview.css") });
    await page.addScriptTag({ content: asset("chat-preview.js") });
    assert.equal(await page.locator("#latest").isVisible(), false);
    console.log(`PASS: ${mobile ? "mobile" : "desktop"} single preview, timeout, badge, open, navigation`);
    await page.close();
  }
} finally {
  await browser.close();
}
