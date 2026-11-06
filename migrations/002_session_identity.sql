-- Identity is the database login (session_user), not a setting the client can choose.
-- Migration 001 stays as applied. Both the original and the idempotent role form
-- remain valid checksums; this file is the upgrade.
CREATE OR REPLACE FUNCTION bos.can_access(w text, writing boolean DEFAULT false) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, bos AS $$
  SELECT w = current_setting('bos.workspace_id', true)
    AND EXISTS (
      SELECT 1 FROM bos.workspace_membership m
      WHERE m.workspace_id = w
        AND m.user_id = session_user
        AND (NOT writing OR m.role IN ('owner', 'editor'))
    )
$$;
REVOKE ALL ON FUNCTION bos.can_access(text, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION bos.can_access(text, boolean) TO bos_runtime;

DROP POLICY IF EXISTS own_memberships ON bos.workspace_membership;
CREATE POLICY own_memberships ON bos.workspace_membership
  FOR SELECT TO bos_runtime
  USING (user_id = session_user AND workspace_id = current_setting('bos.workspace_id', true));
ALTER TABLE bos.workspace_membership FORCE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION bos.guard_run() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, bos AS $$
BEGIN
  IF NEW.task_id <> OLD.task_id OR NEW.workflow_version <> OLD.workflow_version OR NEW.workspace_id <> OLD.workspace_id THEN
    RAISE EXCEPTION 'immutable run identity';
  END IF;
  IF OLD.payload->>'status' IN ('succeeded', 'failed', 'cancelled') AND NEW.payload->>'status' <> OLD.payload->>'status' THEN
    RAISE EXCEPTION 'terminal run';
  END IF;
  IF COALESCE((OLD.payload->>'cancel_requested')::boolean, false)
     AND NOT COALESCE((NEW.payload->>'cancel_requested')::boolean, false) THEN
    RAISE EXCEPTION 'cancel_requested is permanent';
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION bos.reject_mutation() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  RAISE EXCEPTION '%', TG_ARGV[0] USING ERRCODE = 'P0001';
END $$;
REVOKE ALL ON FUNCTION bos.reject_mutation() FROM PUBLIC;

DROP TRIGGER IF EXISTS artifact_revision_immutable ON bos.artifact;
CREATE TRIGGER artifact_revision_immutable
  BEFORE UPDATE OR DELETE ON bos.artifact
  FOR EACH ROW EXECUTE FUNCTION bos.reject_mutation('artifact_revision_immutable');

DROP TRIGGER IF EXISTS verification_immutable ON bos.verification;
CREATE TRIGGER verification_immutable
  BEFORE UPDATE OR DELETE ON bos.verification
  FOR EACH ROW EXECUTE FUNCTION bos.reject_mutation('verification_immutable');

-- PostgreSQL CHECK treats UNKNOWN (NULL) as success. Require keys so a missing
-- status/run_id/workspace_id cannot slip past the original nullable comparisons.
ALTER TABLE bos.run DROP CONSTRAINT IF EXISTS run_payload_keys_present;
ALTER TABLE bos.run ADD CONSTRAINT run_payload_keys_present CHECK (
  (payload ? 'run_id')
  AND (payload ? 'workspace_id')
  AND (payload ? 'status')
  AND (payload->>'run_id' = id)
  AND (payload->>'workspace_id' = workspace_id)
  AND (payload->>'status' IN ('queued','running','waiting_approval','succeeded','failed','cancelled'))
);
