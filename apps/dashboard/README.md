# Dashboard (planned)

Not part of Phase 6. The dashboard will be a read-mostly UI over the Jovi Core API:

- task / job / decision timelines (`GET /api/tasks/:id`, `GET /api/decisions/:id`)
- live event stream (`GET /api/events?afterSequence=…`)
- memory browser (`GET /api/memory`)
- model routing and cost view (`GET /api/models`)
- human approval queue for next actions marked `REQUIRES_APPROVAL`

It must not contain business logic; everything goes through the API.
