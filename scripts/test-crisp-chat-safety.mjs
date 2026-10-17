// Deterministic browser regression for the exact legacy iframe geometry found
// on the Govee sites. No production visits, conversations or network are needed.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { chromium } from "playwright";
const css = readFileSync(
  new URL("../integrations/wordpress/jellybean-presence/assets/chat-safety.css", import.meta.url),
  "utf8",
);
const browser = await chromium.launch({
  headless: true,
  ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
    ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH }
    : {}),
});
try {
  for (const mobile of [false, true]) {
    const page = await browser.newPage({
      viewport: mobile ? { width: 390, height: 844 } : { width: 1366, height: 900 },
      isMobile: mobile,
      hasTouch: mobile,
    });
    await page.setContent(`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1">
      <div class="crisp-client" style="position:fixed;right:24px;bottom:110px;z-index:1000000">
        <button id="native-close" style="width:44px;height:44px" onclick="window.dismissed=true">Close</button>
      </div><button id="launcher" style="position:fixed;right:24px;bottom:20px;width:54px;height:54px">Chat</button>
      <iframe id="unrelated-frame" title="Unrelated" style="width:10px;height:10px"></iframe>
      <iframe id="isolated-govee-popup-frame" title="Govee Installer Chat"
        style="position:fixed;right:20px;bottom:92px;width:320px;height:115px;border:0;background:transparent;z-index:2147483646;display:block"></iframe>`);
    const button = page.locator("#native-close");
    const box = await button.boundingBox();
    const point = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    assert.equal(
      await page.evaluate((p) => document.elementFromPoint(p.x, p.y).id, point),
      "isolated-govee-popup-frame",
    );
    await page.addStyleTag({ content: css });
    // The old snippet tries to redisplay its frame after four seconds.
    await page.locator("#isolated-govee-popup-frame").evaluate((e) => (e.style.display = "block"));
    assert.equal(
      await page.evaluate((p) => document.elementFromPoint(p.x, p.y).id, point),
      "native-close",
    );
    if (mobile) await page.touchscreen.tap(point.x, point.y);
    else await page.mouse.click(point.x, point.y);
    assert.equal(await page.evaluate(() => window.dismissed), true);
    assert.equal(await page.locator("#launcher").isVisible(), true);
    assert.equal(await page.locator("#unrelated-frame").isVisible(), true);
    console.log(
      `PASS: ${mobile ? "mobile touch" : "desktop mouse"} dismiss remains clickable; launcher and unrelated iframe unchanged`,
    );
    await page.close();
  }
} finally {
  await browser.close();
}
