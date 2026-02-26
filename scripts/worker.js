/**
 * Parser Worker - Production architecture.
 * Runs independently: priority listings → immediate, normal → 3–5s delay, nothing → 20–60s.
 * Keeps human-like behavior (storageState, login recovery) in parseManualListings.
 */

import { processPendingListings } from "./parseManualListings.js";

const delay = (ms) => new Promise((res) => setTimeout(res, ms));

function randomMs(minSec, maxSec) {
  const min = minSec * 1000;
  const max = maxSec * 1000;
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

async function startWorker() {
  console.log("[Worker] Parser Worker started. Running independently.");

  while (true) {
    try {
      const result = await processPendingListings();

      if (result === "priority") {
        // Priority listings processed → no delay, continue immediately
        continue;
      }

      if (result === "normal") {
        // Normal pending processed → small human-like delay (3–5s)
        const waitMs = randomMs(3, 5);
        console.log(`[Worker] Normal batch done. Waiting ${waitMs / 1000}s before next check.`);
        await delay(waitMs);
        continue;
      }

      // result === 'none' → nothing to process → random idle (20–60s)
      const idleMs = randomMs(20, 60);
      console.log(`[Worker] No pending listings. Idle ${idleMs / 1000}s.`);
      await delay(idleMs);
    } catch (err) {
      console.error("[Worker] Error:", err.message);
      await delay(5000);
    }
  }
}

startWorker();
