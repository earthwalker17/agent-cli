import type { ApprovalOutcome, ApprovalRequest, Approver } from '../types.js';

/**
 * Child→parent approval forwarding (V0.7). Wraps the parent SESSION approver — never the io
 * layer directly — so every mode fail-closes structurally: non-interactive parents forward
 * into autoDenyApprover, REPL EOF maps to deny-&-stop, --dangerously-allow-all keeps meaning
 * what it says. The queue is strictly serialized because the REPL owns ONE readline with ONE
 * pending question slot; two concurrent asks would orphan a promise forever.
 *
 * Every entry carries its task's AbortSignal:
 * - aborted while QUEUED → resolves deny (source 'task-aborted') without ever being displayed;
 * - aborted while DISPLAYED → the child unblocks immediately with the same deny, the pending
 *   terminal question stays owned by the queue, and the eventual answer is discarded with an
 *   honest chrome line (a stale security prompt must never silently swallow the user's next
 *   instruction as its answer — when it does consume a line, the discard is SAID).
 */

export interface ApprovalForwarder {
  /** Serialized, signal-linked forward of one child ask to the parent approver. */
  ask(req: ApprovalRequest, signal: AbortSignal | undefined): Promise<ApprovalOutcome>;
}

const TASK_ABORTED: ApprovalOutcome = { decision: 'deny', scope: 'once', source: 'task-aborted' };

export function createApprovalForwarder(base: Approver, info?: (line: string) => void): ApprovalForwarder {
  let chain: Promise<void> = Promise.resolve();
  return {
    ask(req, signal) {
      return new Promise<ApprovalOutcome>((resolve) => {
        let settled = false;
        const settle = (o: ApprovalOutcome): void => {
          if (!settled) {
            settled = true;
            resolve(o);
          }
        };
        const onAbort = (): void => settle(TASK_ABORTED);
        if (signal?.aborted) {
          onAbort();
          return;
        }
        signal?.addEventListener('abort', onAbort, { once: true });

        chain = chain.then(async () => {
          try {
            if (settled) return; // died while queued — never display a moot prompt
            const outcome = await base(req);
            if (settled) info?.('  (task already ended — approval answer discarded)');
            else settle(outcome);
          } catch (err) {
            // A throwing approver fails closed for this child; the queue keeps serving others.
            settle({ decision: 'deny', scope: 'once', source: 'task-aborted' });
            info?.(`  (approval forwarding failed: ${(err as Error).message})`);
          } finally {
            signal?.removeEventListener('abort', onAbort);
          }
        });
      });
    },
  };
}
