import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import { runFlow } from '../src/browser/flow.js';
import { probeBrowser, likelyBrowserAvailable, type BrowserAvailability } from '../src/browser/probe.js';
import { FlowSpecSchema, type FlowSpec } from '../src/browser/types.js';

/**
 * The flow executor against a REAL browser and a REAL in-test HTTP server. Gated on the cheap
 * existence probe (the hasGit precedent); on this project's dev machines a system browser is
 * expected, and the launch probe failing there should FAIL loudly, not skip.
 */

const hasBrowser = likelyBrowserAvailable();
const d = hasBrowser ? describe : describe.skip;

const PAGE = (offOriginUrl: string): string => `<!doctype html><html><head><title>Fixture</title></head><body>
<div id="app" style="display:none">
  <h1 id="title">Fixture App</h1>
  <input id="item-input">
  <button id="add">Add</button>
  <ul id="list"></ul>
  <a id="ext" href="${offOriginUrl}">external</a>
  <button id="boom">Boom</button>
</div>
<script>
setTimeout(function () { document.getElementById('app').style.display = 'block'; }, 300);
document.getElementById('add').addEventListener('click', function () {
  var v = document.getElementById('item-input').value;
  var li = document.createElement('li'); li.textContent = v; li.className = 'item';
  document.getElementById('list').appendChild(li);
});
document.getElementById('boom').addEventListener('click', function () { throw new Error('boom-error'); });
console.error('fixture console error');
</script></body></html>`;

let server: http.Server;
let other: http.Server;
let origin = '';
let otherOrigin = '';
let avail: BrowserAvailability;

const flowDeps = (over: Partial<Parameters<typeof runFlow>[1]> = {}): Parameters<typeof runFlow>[1] => ({
  ...(avail.channel !== undefined ? { channel: avail.channel } : {}),
  originUrl: origin,
  isPreviewAlive: () => true,
  ...over,
});

const spec = (steps: FlowSpec['steps'], over: Partial<FlowSpec> = {}): FlowSpec =>
  FlowSpecSchema.parse({ name: 'fixture-flow', steps, ...over });

beforeAll(async () => {
  other = http.createServer((_q, res) => res.end('<html><body>other origin</body></html>'));
  await new Promise<void>((r) => other.listen(0, '127.0.0.1', r));
  otherOrigin = `http://127.0.0.1:${(other.address() as { port: number }).port}`;
  server = http.createServer((_q, res) => {
    res.setHeader('content-type', 'text/html');
    res.end(PAGE(`${otherOrigin}/away`));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  if (hasBrowser) {
    avail = await probeBrowser();
    // On a machine with a system browser present, the real probe must succeed — a skip here
    // would silently hollow out the whole browser test surface. Generous bound: under full-suite
    // parallelism a browser launch competes with dozens of spawned test processes.
    expect(avail.available, avail.reason ?? '').toBe(true);
  }
}, 300_000);

afterAll(async () => {
  await new Promise((r) => server?.close(r));
  await new Promise((r) => other?.close(r));
});

d('runFlow — real browser', () => {
  it('drives a multi-step flow: declared readiness, fill, click, typed asserts, screenshot, trace', async () => {
    const r = await runFlow(
      spec([
        // #app is display:none for the first 300ms — 'commit'/load would see nothing; the
        // DECLARED readiness is what makes the later steps honest.
        { do: 'goto', path: '/', ready_when: { selector: '#app' } },
        { do: 'fill', selector: '#item-input', value: 'first item' },
        { do: 'click', selector: '#add' },
        { do: 'expect', kind: 'count', selector: 'li.item', count: 1 },
        { do: 'expect', kind: 'text', selector: '#list', text: 'first item' },
        { do: 'screenshot', label: 'after-add' },
      ]),
      flowDeps(),
    );
    expect(r.status, r.summary).toBe('pass');
    expect(r.steps.every((s) => s.ok)).toBe(true);
    const shot = r.artifacts.find((a) => a.kind === 'screenshot');
    expect(shot?.label).toBe('after-add');
    expect(shot!.bytes.length).toBeGreaterThan(1000);
    expect(shot!.bytes.subarray(1, 4).toString('latin1')).toBe('PNG');
    expect(r.artifacts.some((a) => a.kind === 'trace' && a.bytes.length > 1000)).toBe(true);
    // The fixture's console.error is RECORDED but does not change the verdict by default.
    expect(r.consoleErrors.some((c) => c.includes('fixture console error'))).toBe(true);
    expect(r.signals).toContain('console-error');
    expect(r.finalUrl).toContain(origin);
  }, 180_000);

  it('a never-satisfied declared readiness is a TIMEOUT with the honest wording', async () => {
    const r = await runFlow(spec([{ do: 'goto', path: '/', ready_when: { selector: '#does-not-exist', timeout_ms: 1200 } }]), flowDeps());
    expect(r.status).toBe('fail');
    expect(r.steps[0]!.failure?.class).toBe('timeout');
    expect(r.steps[0]!.failure?.detail).toContain('declared readiness');
    expect(r.steps[0]!.failure?.detail).toContain('the page loaded but the application never showed the declared state');
    expect(r.signals).toContain('browser-timeout');
  }, 180_000);

  it('a failed expect is an ASSERTION failure with the last observed state, plus a failure screenshot', async () => {
    const r = await runFlow(
      spec([
        { do: 'goto', path: '/', ready_when: { selector: '#app' } },
        { do: 'expect', kind: 'text', selector: '#list', text: 'never-added-item', timeout_ms: 1200 },
        { do: 'screenshot', label: 'unreached' },
      ]),
      flowDeps(),
    );
    expect(r.status).toBe('fail');
    const failed = r.steps.find((s) => !s.ok)!;
    expect(failed.failure?.class).toBe('assertion');
    expect(failed.failure?.detail).toContain('did not hold within');
    expect(failed.failure?.detail).toContain('last observed');
    expect(r.signals).toContain('browser-assertion-failed');
    // Steps stop at the failure: the declared screenshot never ran; the failure shot did.
    expect(r.steps.some((s) => s.kind === 'screenshot')).toBe(false);
    expect(r.artifacts.some((a) => a.kind === 'screenshot' && a.label.startsWith('failure-step'))).toBe(true);
  }, 180_000);

  it('an uncaught page error fails the flow with signal page-error', async () => {
    const r = await runFlow(
      spec([
        { do: 'goto', path: '/', ready_when: { selector: '#app' } },
        { do: 'click', selector: '#boom' },
        { do: 'expect', kind: 'visible', selector: '#title', timeout_ms: 1000 },
      ]),
      flowDeps(),
    );
    expect(r.status).toBe('fail');
    expect(r.pageErrors.some((p) => p.includes('boom-error'))).toBe(true);
    expect(r.signals).toContain('page-error');
  }, 180_000);

  it('an off-origin top-level navigation aborts the flow as a typed NAVIGATION failure', async () => {
    const r = await runFlow(
      spec([
        { do: 'goto', path: '/', ready_when: { selector: '#app' } },
        { do: 'click', selector: '#ext' },
        { do: 'wait_for', text: 'other origin', timeout_ms: 3000 },
      ]),
      flowDeps(),
    );
    expect(r.status).toBe('fail');
    expect(r.steps.some((s) => s.failure?.class === 'navigation' && s.failure.detail.includes('left the preview origin'))).toBe(true);
    expect(r.signals).toContain('browser-navigation');
  }, 180_000);

  it('fail_on_console_error flips the recorded-only default into a failure', async () => {
    const r = await runFlow(spec([{ do: 'goto', path: '/', ready_when: { selector: '#app' } }], { fail_on_console_error: true }), flowDeps());
    expect(r.status).toBe('fail');
    expect(r.summary).toContain('console.error');
  }, 180_000);

  it('a preview that dies mid-flow is an ERROR (preview-died), never a timeout blamed on the app', async () => {
    let alive = true;
    const r = await runFlow(
      spec([
        { do: 'goto', path: '/', ready_when: { selector: '#app' } },
        { do: 'click', selector: '#add' },
      ]),
      flowDeps({
        isPreviewAlive: () => {
          const now = alive;
          alive = false; // dies after the first step's check
          return now;
        },
      }),
    );
    expect(r.status).toBe('error');
    expect(r.signals).toContain('preview-died');
    expect(r.summary).toContain('died mid-flow');
  }, 180_000);
});

describe('flow spec structural rules (no browser needed)', () => {
  it('goto requires ready_when with selector or text', () => {
    expect(() => FlowSpecSchema.parse({ name: 'f', steps: [{ do: 'goto', path: '/', ready_when: {} }] })).toThrow(/never readiness/);
    expect(() => FlowSpecSchema.parse({ name: 'f', steps: [{ do: 'goto', path: 'no-slash', ready_when: { selector: 'x' } }] })).toThrow(/relative path/);
  });

  it('expect/screenshot may not precede the first goto', () => {
    expect(() =>
      FlowSpecSchema.parse({
        name: 'f',
        steps: [
          { do: 'expect', kind: 'visible', selector: '#x' },
          { do: 'goto', path: '/', ready_when: { selector: '#x' } },
        ],
      }),
    ).toThrow(/precedes the first goto/);
  });

  it('a flow needs a goto; screenshots are capped at 4', () => {
    expect(() => FlowSpecSchema.parse({ name: 'f', steps: [{ do: 'click', selector: '#x' }] })).toThrow(/at least one goto/);
    const shots = Array.from({ length: 5 }, (_, i) => ({ do: 'screenshot', label: `s${i}` }));
    expect(() =>
      FlowSpecSchema.parse({ name: 'f', steps: [{ do: 'goto', path: '/', ready_when: { selector: '#x' } }, ...shots] }),
    ).toThrow(/at most 4 screenshots/);
  });
});
