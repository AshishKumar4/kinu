// A launcher that is killed with its browser open. Not a test file, so no runner
// discovers it; `scripts/test-chrome.test.ts` spawns it and kills it on purpose.
import { launchTestChrome } from '../../test-chrome';

const chrome = await launchTestChrome();

const page = await chrome.browser.newPage();

await page.goto('data:text/html,<p>held</p>');

console.log(JSON.stringify({ browser: chrome.browser.process()?.pid }));

await new Promise<never>(() => {});
