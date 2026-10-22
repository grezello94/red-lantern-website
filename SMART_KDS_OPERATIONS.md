# Smart KDS kitchen caller

Open `/smart-kds` for the caller, live preparation board, ingredient alerts and station queue forecast. `/kds` remains the ticket display. In Admin → Smart KDS, choose **Smart KDS** as the display and **Manual staff-controlled actions** as the scheduling mode to use start/ready controls. Shadow mode shows recommendations for review.

## Tablet board during a rush

The main screen groups dishes into compact order/table tickets. A landscape tablet shows six tickets per page, and page controls show the total matching orders and current page. Every active item remains accessible; additional orders are paged instead of shrinking their text or pushing controls below a long briefing. Scroll within a ticket when a table has many dishes.

Use **All**, **Start now**, **Cooking**, **Waiting** and **Ready** to focus on one kind of work. The tab counts are item counts; the page total is an order count. Search by dish, table, order number or chef note. Search and status changes return to the first matching page; routine live updates keep the selected page. Assigned work that can actually start appears before capacity-blocked warnings.

Each dish row has its own clear kitchen action and **Mark ready** control. Compatible batches remain available from the bulk cooking control, and their member items stay in the order tickets so individual completion is always reachable. The compact caller strip shows the next instruction; expand calls, alerts or station details when needed. Fish preparation alerts remain visible even when their cooking course is held. Fullscreen keeps the tablet focused on kitchen work.

## What the board tells the kitchen

| Signal | Meaning | Staff response |
| --- | --- | --- |
| Green | Start now; the task has an available station allocation | Begin preparation and tap **Start preparation** |
| Yellow | Get ingredients ready, prepare next, wait for capacity or keep cooking on hold | Follow the displayed start time and reason; check ingredient alerts |
| Red | Safe start was missed, a fired item has no start acknowledgement, cooking is over its estimate, or expo must resolve a blocked station | Check the item immediately; confirm actual progress or resolve capacity |
| Neutral | Preparation is acknowledged, or the dish is ready/at expo | Continue cooking or hand off and record the next status |

An ordered item is not automatically red merely because it has not started. Its preparation window, course and station determine when it should start. Red means the recorded state needs attention. A held course is not called to start cooking; it can still have an ingredient readiness alert.

The kitchen caller lists quantities, destinations, portions, cooking styles, add-ons, chef notes and estimated start/ready times in priority order. The optional **Enable voice + chime** button reads new calls and sounds urgent alerts on supported browsers. It must be enabled on the kitchen device. Repeated refreshes do not repeat the same call. The caller pauses when the board loses its live snapshot, the session expires, the display is hidden, or it is in shadow mode.

## Fish and seafood

Every pending fish/seafood item produces an immediate ingredient readiness alert, including an item whose cooking is held for a later course. Helpers should check portions and chilled/thawed stock and use the kitchen-approved thawing process when necessary. The caller does not infer a thaw duration, confirm stock availability, or count an ingredient check as the start of cooking. Tell expo when stock cannot meet the order's timing.

## Menu understanding and chef calibration

The server reads the active food and bar Air Menu and assigns a production family to each dish. Families cover soups, wok dishes, tandoor, fish/seafood preparations, curry, biryani, bread, cold sides, desserts and drinks. Unrecognized dishes use an explicit fallback. Admin shows family coverage and preparation suggestions so the chef can review the entire current menu.

Menu-name estimates are initial estimates, not measured recipes. They distinguish cooking duration from a course's service target. The chef should save each dish's realistic minimum/typical/maximum preparation time, station, plating and handoff time, portion capacity, course dependencies, and any permitted holding time. Use the existing Kitchen performance reports to compare those settings with recorded starts and ready times. The caller does not automatically train or rewrite chef settings from historical durations.

Saved chef profiles override inferred times. Demonstrably untouched old generic profiles gain menu-specific estimates at read time. Production profile snapshots and saved service deadlines for orders already sold remain authoritative; refreshing the screen does not move their deadlines forward. Menu suggestions never create a station or change printer routing.

## Bulk orders and busy periods

Batching requires the chef to enable **Can be batched**, assign a compatibility group and set the maximum/optimal portions and waiting window. Keep incompatible dishes, portions, cooking styles, notes and add-ons in separate groups. The scheduler preserves modifier compatibility, station allocation, course holds and the earliest safe start. It does not hold an urgent dish to wait for more portions.

Approved large order lines split into complete production tasks within the saved batch limit. The caller lists the full bulk quantity and the order allocations, and **Start batch** acknowledges the listed tasks together. A batch occupies its configured station capacity once. Unapproved bulk quantities receive a conservative multi-wave forecast and a chef review instruction; the system does not assume that a single pan cooks an unlimited quantity.

The load panel shows active orders, queued/cooking portions, items needing attention, station occupancy and estimated queue clearance. Quiet, steady, busy and surge levels come from actual pending work and configured capacity. Queue forecasts include acknowledged cooking, fired work and approved batches. A disabled or undersized station requires expo to restore capacity, split work or reassign it. The forecast exposes possible missed service targets rather than extending the guest's saved promise.

## Operating discipline

Record **Start preparation → Mark ready → Send to expo → Mark served** as work progresses. **Mark ready** is also available on unfinished assigned items if the food has already been prepared and the cook did not record its start. It can be used before the forecast time or while the item is waiting for a station slot. This records the actual completion time without inventing a start time; it does not mark the food served. A task explicitly held by staff must be released first. Each allocation of a proposed batch can be marked ready individually.

Shadow mode shows the ready controls disabled and explains how to enable **Manual staff-controlled actions** in Admin → Smart KDS → Setup. Kitchen staff also need permission to update kitchen statuses. Items without an assigned station need that assignment before staff can record their kitchen actions.

The system sees those records, not the physical kitchen. It cannot know that a chef has started without an acknowledgement, or guarantee on-time food when staffing, equipment or stock cannot meet demand. Configure actual station capacity for the shift and review red alerts promptly. New work does not automatically mark food prepared or print a KOT.

## Verification

`npm run check` checks runtime syntax. `npm run test:kds` runs menu, timing, capacity, workflow, caller, simulation and isolated API tests. The API tests use an in-memory PostgreSQL-compatible database and loopback HTTP; they do not read local restaurant credentials or touch production orders. Browser coverage is in `tests/kds-reliability.spec.js` and `tests/kds-expediter.spec.js` and uses mocked API responses.
