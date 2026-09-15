# Point-guard resync

Check point-guard's recovery state and, if the human confirms, manually re-drive anything still stuck.

The point-guard service already resumes queued work automatically on every startup — this action is for the case where the service is *up* but something is nonetheless idle (a long dependency outage that didn't require a restart, or the human just wants a status check).

## Steps

1. **Read `${BARRY_SECRET}`** from the environment — every point-guard endpoint requires `Authorization: Bearer <BARRY_SECRET>`.

2. **Check readiness**: `curl -s -H "authorization: Bearer $BARRY_SECRET" http://127.0.0.1:3868/readiness`

   Report, in plain language, what you find:
   - `reconciledOnStartup` / `integratingRequeuedOnStartup` / `staleMergesReclaimedOnStartup`: what the LAST restart's recovery pass found and fixed
   - `resumedDelegations` / `resumedMerges` / `prunedWorktrees`: what the last resume pass actually drove forward, versus deferred
   - `outboxBacklog`: whether anything is stuck trying to reach the Barry API

3. **List what's currently stuck**:
   - `curl -s -H "authorization: Bearer $BARRY_SECRET" "http://127.0.0.1:3868/delegations?state=queued"`
   - `curl -s -H "authorization: Bearer $BARRY_SECRET" "http://127.0.0.1:3868/delegations?state=blocked"`

   For each one, report its `reason` field — that's why it's not moving on its own. A `queued` delegation waiting a normal amount of time is fine (the scheduler's concurrency cap may simply be full); a `blocked` one has hit its attempt cap and genuinely needs a human decision, not a resync.

4. **If there is queued work that looks like it should be running** (and only then — do not do this reflexively every time), ask the human to confirm before proceeding: "point-guard has N delegations queued and idle. Force another resume pass now?"

5. **On confirmation**, run: `curl -s -X POST -H "authorization: Bearer $BARRY_SECRET" http://127.0.0.1:3868/admin/resync`

   Report the JSON response's counts directly — do not narrate a success that the numbers don't show. If `resumedDelegations.started` is 0 despite queued work existing, say so plainly; that usually means every concurrency slot is already full (`activeWorkers` from step 2 will confirm), not that the resync failed.

## What this action does NOT do

It never bypasses a `blocked` delegation's attempt cap, never edits a delegation's brief, and never force-publishes anything — `/admin/resync` only re-drives work that was already `queued`, through the exact same gates every other execution path uses.
