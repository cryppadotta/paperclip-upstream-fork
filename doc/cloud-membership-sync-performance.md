# Cloud membership synchronization

Trusted Cloud requests synchronize the user's profile, company membership and
default grants before they resolve authority. Synchronization writes are shared
only within one database client and process. Requests with different contexts
for the same user execute in order. An A, B, A sequence still applies all three
contexts. Other users can proceed independently.

Successful identical contexts retain the existing five-second write debounce.
Failed or partial synchronization invalidates the prior success, so a retry can
repair it. Membership reads, owner-elevation settings and stale administrator
removal remain fresh on each request. This cache does not store actors.

Guarded upserts preserve `updated_at` when profile fields, role and status do not
change. They still repair missing default grants. Access lists now sort these
rows by their last actual change. Profile resolution pages through memberships
instead of depending on the first 200 rows. Its cursor preserves PostgreSQL
timestamp precision, and its company access check remains in place.

## Reproduce the local comparison

From the repository root, use a disposable PostgreSQL 17 container:

```sh
pnpm --filter @paperclipai/server exec tsx ../scripts/benchmark-cloud-membership-sync.ts \
  --baseline-ref=db70c5acd92f50fa37fb4f0dea3da0e7685089a2 --docker-postgres=17 \
  > /tmp/cloud-membership-sync.json
```

The harness imports the actual resolvers, applies normal migrations, seeds
synthetic data and removes its container. It does not use `DATABASE_URL`.
Two warmup pairs precede five alternating measured pairs. Each pair uses a
fresh synchronization scope and 20 simultaneous requests for one unchanged
user. Row triggers count updates, including updates that preserve values.

PostgreSQL 17.11 measured a median 51.07 ms before and 25.71 ms after. The ranges
were 47.21–63.25 ms and 24.17–29.32 ms. Membership statements fell from 20 to one,
and profile plus membership tuple updates fell from 40 to zero. All 20 complete
actor results matched on every sample. This measures local service work and
authority reads. It does not establish production request latency or remove
locks across replicas.

## Safety checks

Run the Cloud actor, Cloud transient database retry, company provisioning,
Cloud synchronization PostgreSQL and user profile route suites. They cover
coalescing, A/B/A transitions, failed partial writes, expiry, distinct users and
databases, grant repair, real role-change invalidation, imported-membership
revocation, owner-flag changes and cross-company denial. The profile regression
first returned 404 with the former lookup and passes with 201 memberships whose
timestamps cross a page boundary within the same millisecond.

No schema migration, startup work or deployment is required by this change.
