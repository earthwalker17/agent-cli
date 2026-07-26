import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Browser availability (Session 13). Two answers with two costs, honestly separated:
 *
 * - `likelyBrowserAvailable()` — a CHEAP, synchronous existence probe over the standard system
 *   Edge/Chrome install paths and the Playwright browser cache. Feeds plan-time validation
 *   warnings and /checks display ONLY; it may be wrong in both directions and nothing gates
 *   on it.
 * - `probeBrowser()` — the REAL probe: dynamically import playwright-core and actually launch
 *   (then immediately close) a headless browser, trying the system channels first (msedge,
 *   chrome — no binary downloads, the user decision) and the Playwright-cache Chromium last.
 *   Cached per session by the caller (a launch costs seconds). Its failure reason is what a
 *   browser check reports as its honest `unsupported` precondition.
 */

export interface BrowserAvailability {
  available: boolean;
  /** The channel that launched ('msedge' | 'chrome' | 'chromium-cache'). */
  channel?: string;
  reason?: string;
}

const CHANNELS = ['msedge', 'chrome'] as const;
const LAUNCH_TIMEOUT_MS = 30_000;

export async function probeBrowser(): Promise<BrowserAvailability> {
  let chromium: typeof import('playwright-core')['chromium'];
  try {
    ({ chromium } = await import('playwright-core'));
  } catch (e) {
    return { available: false, reason: `playwright-core is not importable: ${(e as Error).message}` };
  }
  const failures: string[] = [];
  for (const channel of CHANNELS) {
    try {
      const b = await chromium.launch({ channel, headless: true, timeout: LAUNCH_TIMEOUT_MS });
      await b.close();
      return { available: true, channel };
    } catch (e) {
      failures.push(`${channel}: ${String((e as Error).message).split('\n')[0] ?? 'launch failed'}`);
    }
  }
  try {
    const b = await chromium.launch({ headless: true, timeout: LAUNCH_TIMEOUT_MS });
    await b.close();
    return { available: true, channel: 'chromium-cache' };
  } catch (e) {
    failures.push(`chromium-cache: ${String((e as Error).message).split('\n')[0] ?? 'launch failed'}`);
  }
  return {
    available: false,
    reason: `no launchable browser: ${failures.join('; ')} — install Microsoft Edge or Google Chrome, or run 'npx playwright install chromium'`,
  };
}

/** Cheap sync guess for plan-time warnings; never gates anything. */
export function likelyBrowserAvailable(): boolean {
  const candidates =
    process.platform === 'win32'
      ? [
          'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
          'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
          'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
          'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
          path.join(process.env['LOCALAPPDATA'] ?? '', 'ms-playwright'),
        ]
      : [
          '/usr/bin/microsoft-edge',
          '/usr/bin/google-chrome',
          '/opt/google/chrome/chrome',
          '/Applications/Microsoft Edge.app',
          '/Applications/Google Chrome.app',
          path.join(os.homedir(), '.cache', 'ms-playwright'),
        ];
  return candidates.some((p) => {
    try {
      return p !== '' && fs.existsSync(p);
    } catch {
      return false;
    }
  });
}
