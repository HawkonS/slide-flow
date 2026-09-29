import { existsSync } from 'node:fs';
import { chromium } from 'playwright';

// Resolve Playwright from web/package.json, including callers in root/tests.
export async function launchBrowser() {
  const executablePath = process.env.PLAYWRIGHT_EXECUTABLE_PATH;
  if (executablePath && !existsSync(executablePath)) {
    throw new Error('PLAYWRIGHT_EXECUTABLE_PATH does not exist: ' + executablePath);
  }
  try {
    return await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
  } catch (cause) {
    throw new Error('Chromium could not start. Run npm run test:pwa:install from web/ (Linux CI may also need npx playwright install-deps chromium), or set PLAYWRIGHT_EXECUTABLE_PATH to an installed Chromium binary.', { cause });
  }
}
