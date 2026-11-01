-- Reject JSON null and missing required payload keys.
-- Migration 002 used payload ? key, which is true for {"status": null}.
-- CHECK treats SQL UNKNOWN as success; wrap the predicate in IS TRUE.
ALTER TABLE bos.run DROP CONSTRAINT IF EXISTS run_payload_keys_present;
ALTER TABLE bos.run ADD CONSTRAINT run_payload_keys_present CHECK ((
  jsonb_typeof(payload->'run_id') = 'string'
  AND jsonb_typeof(payload->'workspace_id') = 'string'
  AND jsonb_typeof(payload->'status') = 'string'
  AND payload->>'run_id' = id
  AND payload->>'workspace_id' = workspace_id
  AND payload->>'status' IN ('queued','running','waiting_approval','succeeded','failed','cancelled')
) IS TRUE);
