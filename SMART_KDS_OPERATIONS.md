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

## Running orders

Put **running** in the dish's chef note or the current round's order note when guests are already eating and need another portion. Detection ignores case and matches the whole word: `RUNNING - extra portion` qualifies; `overrunning` does not. The dish keeps its original notes and shows **RUNNING · Priority top-up** on the board. The caller identifies the additional portion explicitly.

An eligible running item is called to start immediately and receives the next available station slot ahead of ordinary waiting work. Critical overdue work and explicit rush overrides retain precedence. The request does not interrupt food already cooking, bypass a course or staff hold, or invent a preparation/ready acknowledgement. A blocked running item stays visible as a priority top-up with its capacity or hold reason. It is not delayed to wait for a larger batch.

New rounds save their own order note so marking one round running does not automatically prioritize later rounds. Older lines without a round-note snapshot use the existing order note. A running request never changes the saved service deadline or marks food served.

## Fish and seafood

Every pending fish/seafood item produces an immediate ingredient readiness alert, including an item whose cooking is held for a later course. Helpers should check portions and chilled/thawed stock and use the kitchen-approved thawing process when necessary. The caller does not infer a thaw duration, confirm stock availability, or count an ingredient check as the start of cooking. Tell expo when stock cannot meet the order's timing.

## Menu understanding and chef calibration

The server reads the active food and bar Air Menu and assigns a production family to each dish. Families cover soups, wok dishes, tandoor, fish/seafood preparations, curry, biryani, bread, cold sides, desserts and drinks. Unrecognized dishes use an explicit fallback. Admin shows family coverage and preparation suggestions so the chef can review the entire current menu.

Menu-name estimates are initial estimates, not measured recipes. They distinguish cooking duration from a course's service target. The chef should save each dish's realistic minimum/typical/maximum preparation time, station, plating and handoff time, portion capacity, course dependencies, and any permitted holding time. Use the Kitchen performance reports and learned timing information to compare those settings with recorded starts and ready times. Learning adjusts the live forecast; it never rewrites the chef's saved profile.

Saved chef profiles override inferred times. Demonstrably untouched old generic profiles gain menu-specific estimates at read time. Production profile snapshots and saved service deadlines for orders already sold remain authoritative; refreshing the screen does not move their deadlines forward. Menu suggestions never create a station or change printer routing.

## Learning from quiet and peak service

The KDS records the station's load when a cook actually starts an item and measures the elapsed time until **Mark ready**. Quiet, busy and surge samples remain separate, as do different stations, dishes, portions, quantities, styles, add-ons and recipe notes. The operational word **running** does not create a different recipe. The load panel shows how many usable samples and dishes have been recorded and how many current estimates use learning.

At least five compatible samples are required before an estimate changes. The model uses recent observations from the last 30 days, rejects invalid timestamps and isolated outliers, and blends a conservative observed percentile with the configured duration. Adjustments stay between the chef's minimum duration with buffers and twice the configured maximum with buffers. With insufficient data, the configured estimate remains in use.

Only actual start and ready acknowledgements qualify. Marking ready without a recorded start, an interrupted or reclassified cooking attempt, correlated shared-batch records and unknown multiple cooking waves do not teach an invented preparation time. A confirmed batch containing one independent production task can teach its exact quantity variant. Existing historical records without a captured load are not labelled quiet or busy after the fact. Saved service deadlines, chef profiles and actual kitchen states stay unchanged. A slower learned estimate can bring the preparation call forward; a faster estimate does not move an already-saved safe start later.

## Cross-table batching during busy periods

Bulk coordination includes matching orders arriving from different tables, as well as large individual orders. For example, two identical soups arriving within a five-minute collection window can form one cooking batch with a separate allocation for each table. Soup, fried-rice and biryani setup suggestions use a five-minute window. An explicit chef-set window is preserved. Fried rice and biryani, different soup recipes, portions, recipe notes and add-ons are not combined into the same cooking batch.

The oldest order anchors the collection window. A new arrival never resets it. During quiet service, the KDS calls eligible food immediately rather than waiting for another table. During busy service, collection closes at the window or the first dish's safe start, whichever comes first; a full batch, running order or urgent work can close it sooner. The system does not add newly arrived orders to a batch that is already cooking. A single item proceeds when its safe collection period ends even if no matching order arrives.

Course and service preferences still apply. A held main course stays out of a cooking batch until its prerequisite is released. A **Serve together** item can join only when the batch's cooking time fits its synchronized completion window and permitted holding time. Otherwise it forms a separate plan. The batch panel lists table allocations, course preferences and the remaining safe collection time.

## Batch sizes and large individual orders

Batching requires the chef to enable **Can be batched**, assign a compatibility group and set the maximum/optimal portions and waiting window. Keep incompatible dishes, portions, cooking styles, notes and add-ons in separate groups. The scheduler preserves modifier compatibility, station allocation, course holds and the earliest safe start. It does not hold an urgent dish to wait for more portions.

Approved large order lines split into complete production tasks within the saved batch limit. The caller lists the full bulk quantity and the order allocations, and **Start batch** acknowledges the listed tasks together. A batch occupies its configured station capacity once. Unapproved bulk quantities receive a conservative multi-wave forecast and a chef review instruction; the system does not assume that a single pan cooks an unlimited quantity.

The load panel shows active orders, queued/cooking portions, items needing attention, station occupancy and estimated queue clearance. Quiet, steady, busy and surge levels come from actual pending work and configured capacity. Queue forecasts include acknowledged cooking, fired work and approved batches. A disabled or undersized station requires expo to restore capacity, split work or reassign it. The forecast exposes possible missed service targets rather than extending the guest's saved promise.

## Operating discipline

Record **Start preparation → Mark ready → Send to expo → Mark served** as work progresses. **Mark ready** is also available on unfinished assigned items if the food has already been prepared and the cook did not record its start. It can be used before the forecast time or while the item is waiting for a station slot. This records the actual completion time without inventing a start time; it does not mark the food served. A task explicitly held by staff must be released first. Each allocation of a proposed batch can be marked ready individually.

Shadow mode shows the ready controls disabled and explains how to enable **Manual staff-controlled actions** in Admin → Smart KDS → Setup. Kitchen staff also need permission to update kitchen statuses. Items without an assigned station need that assignment before staff can record their kitchen actions.

The system sees those records, not the physical kitchen. It cannot know that a chef has started without an acknowledgement, or guarantee on-time food when staffing, equipment or stock cannot meet demand. Configure actual station capacity for the shift and review red alerts promptly. New work does not automatically mark food prepared or print a KOT.

## Verification

`npm run check` checks runtime syntax. `npm run test:kds` runs menu, timing, capacity, workflow, caller, simulation and isolated API tests. The API tests use an in-memory PostgreSQL-compatible database and loopback HTTP; they do not read local restaurant credentials or touch production orders. Browser coverage is in `tests/kds-reliability.spec.js` and `tests/kds-expediter.spec.js` and uses mocked API responses.
