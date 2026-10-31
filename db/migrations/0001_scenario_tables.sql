-- Учебная схема prepare_draft. Campaign, experiment, реклама и видео намеренно отсутствуют.
-- Миграцию применяет bos_owner. Данные учебного сценария читает роль без superuser и без BYPASSRLS.

CREATE TABLE schema_migration (
  version text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE workspace (
  id text PRIMARY KEY,
  name text NOT NULL,
  created_at timestamptz NOT NULL
);

CREATE TABLE workspace_membership (
  workspace_id text NOT NULL REFERENCES workspace (id),
  user_id text NOT NULL,
  role text NOT NULL CHECK (role IN ('owner', 'member')),
  created_at timestamptz NOT NULL,
  PRIMARY KEY (workspace_id, user_id)
);

CREATE TABLE project (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspace (id),
  name text NOT NULL,
  created_at timestamptz NOT NULL,
  UNIQUE (id, workspace_id)
);

CREATE TABLE workflow_version (
  id text NOT NULL,
  workspace_id text NOT NULL REFERENCES workspace (id),
  scenario_version text NOT NULL,
  rules_version text NOT NULL,
  definition jsonb NOT NULL,
  created_at timestamptz NOT NULL,
  PRIMARY KEY (id, workspace_id)
);

CREATE TABLE task (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspace (id),
  project_id text NOT NULL,
  title text NOT NULL,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL,
  UNIQUE (id, workspace_id),
  FOREIGN KEY (project_id, workspace_id) REFERENCES project (id, workspace_id)
);

CREATE TABLE run (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspace (id),
  project_id text NOT NULL,
  task_id text NOT NULL,
  workflow_version_id text NOT NULL,
  status text NOT NULL CHECK (status IN ('queued', 'running', 'waiting_approval', 'succeeded', 'failed', 'cancelled')),
  operation text NOT NULL CHECK (operation = 'prepare_draft'),
  idempotency_key text NOT NULL,
  input_hash text NOT NULL,
  scope_hash text NOT NULL UNIQUE,
  record jsonb NOT NULL,
  snapshot jsonb NOT NULL,
  cancel_requested boolean NOT NULL DEFAULT false,
  publication_status text NOT NULL DEFAULT 'not_published' CHECK (publication_status = 'not_published'),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  UNIQUE (workspace_id, operation, idempotency_key),
  UNIQUE (id, workspace_id),
  FOREIGN KEY (project_id, workspace_id) REFERENCES project (id, workspace_id),
  FOREIGN KEY (task_id, workspace_id) REFERENCES task (id, workspace_id),
  FOREIGN KEY (workflow_version_id, workspace_id) REFERENCES workflow_version (id, workspace_id)
);

CREATE TABLE run_step (
  id text PRIMARY KEY,
  run_id text NOT NULL,
  workspace_id text NOT NULL,
  step_index integer NOT NULL CHECK (step_index >= 0),
  step text NOT NULL,
  outcome text NOT NULL,
  error_code text,
  at timestamptz NOT NULL,
  artifact_refs jsonb NOT NULL,
  UNIQUE (run_id, step_index),
  FOREIGN KEY (run_id, workspace_id) REFERENCES run (id, workspace_id)
);

CREATE TABLE artifact (
  id text NOT NULL,
  revision integer NOT NULL CHECK (revision >= 1),
  run_id text NOT NULL,
  workspace_id text NOT NULL,
  content_hash text NOT NULL,
  body text NOT NULL,
  record jsonb NOT NULL,
  created_at timestamptz NOT NULL,
  PRIMARY KEY (id, revision),
  UNIQUE (id, revision, workspace_id),
  FOREIGN KEY (run_id, workspace_id) REFERENCES run (id, workspace_id)
);

CREATE TABLE verification (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspace (id),
  artifact_id text NOT NULL,
  artifact_revision integer NOT NULL,
  status text NOT NULL CHECK (status IN ('pass', 'fail', 'needs_review')),
  record jsonb NOT NULL,
  created_at timestamptz NOT NULL,
  UNIQUE (artifact_id, artifact_revision),
  FOREIGN KEY (artifact_id, artifact_revision, workspace_id) REFERENCES artifact (id, revision, workspace_id)
);

CREATE TABLE audit_event (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspace (id),
  actor_user_id text NOT NULL,
  action text NOT NULL,
  entity text NOT NULL,
  entity_id text NOT NULL,
  error_code text,
  at timestamptz NOT NULL,
  record jsonb NOT NULL
);

CREATE FUNCTION bos_is_member(target_workspace text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $fn$
  SELECT EXISTS (
    SELECT 1
    FROM public.workspace_membership
    WHERE workspace_id = target_workspace
      AND user_id = session_user
  );
$fn$;

REVOKE ALL ON FUNCTION bos_is_member(text) FROM PUBLIC;

CREATE FUNCTION reject_terminal_run_status()
RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF OLD.status IN ('succeeded', 'failed', 'cancelled') AND NEW.status IS DISTINCT FROM OLD.status THEN
    RAISE EXCEPTION 'illegal_transition' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$fn$;

CREATE TRIGGER run_status_immutable
  BEFORE UPDATE ON run
  FOR EACH ROW
  EXECUTE FUNCTION reject_terminal_run_status();

CREATE FUNCTION reject_artifact_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  RAISE EXCEPTION 'artifact_revision_immutable' USING ERRCODE = 'P0001';
END;
$fn$;

CREATE TRIGGER artifact_immutable
  BEFORE UPDATE OR DELETE ON artifact
  FOR EACH ROW
  EXECUTE FUNCTION reject_artifact_mutation();

CREATE FUNCTION reject_verification_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  RAISE EXCEPTION 'verification_immutable' USING ERRCODE = 'P0001';
END;
$fn$;

CREATE TRIGGER verification_immutable
  BEFORE UPDATE OR DELETE ON verification
  FOR EACH ROW
  EXECUTE FUNCTION reject_verification_mutation();

ALTER TABLE workspace ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspace FORCE ROW LEVEL SECURITY;
ALTER TABLE project ENABLE ROW LEVEL SECURITY;
ALTER TABLE project FORCE ROW LEVEL SECURITY;
ALTER TABLE task ENABLE ROW LEVEL SECURITY;
ALTER TABLE task FORCE ROW LEVEL SECURITY;
ALTER TABLE workflow_version ENABLE ROW LEVEL SECURITY;
ALTER TABLE workflow_version FORCE ROW LEVEL SECURITY;
ALTER TABLE run ENABLE ROW LEVEL SECURITY;
ALTER TABLE run FORCE ROW LEVEL SECURITY;
ALTER TABLE run_step ENABLE ROW LEVEL SECURITY;
ALTER TABLE run_step FORCE ROW LEVEL SECURITY;
ALTER TABLE artifact ENABLE ROW LEVEL SECURITY;
ALTER TABLE artifact FORCE ROW LEVEL SECURITY;
ALTER TABLE verification ENABLE ROW LEVEL SECURITY;
ALTER TABLE verification FORCE ROW LEVEL SECURITY;
ALTER TABLE audit_event ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_event FORCE ROW LEVEL SECURITY;
ALTER TABLE workspace_membership ENABLE ROW LEVEL SECURITY;

CREATE POLICY workspace_member ON workspace
  FOR ALL TO bos_member
  USING (bos_is_member(id))
  WITH CHECK (bos_is_member(id));

CREATE POLICY project_member ON project
  FOR ALL TO bos_member
  USING (bos_is_member(workspace_id))
  WITH CHECK (bos_is_member(workspace_id));

CREATE POLICY task_member ON task
  FOR ALL TO bos_member
  USING (bos_is_member(workspace_id))
  WITH CHECK (bos_is_member(workspace_id));

CREATE POLICY workflow_member ON workflow_version
  FOR ALL TO bos_member
  USING (bos_is_member(workspace_id))
  WITH CHECK (bos_is_member(workspace_id));

CREATE POLICY run_member ON run
  FOR ALL TO bos_member
  USING (bos_is_member(workspace_id))
  WITH CHECK (bos_is_member(workspace_id));

CREATE POLICY run_step_member ON run_step
  FOR ALL TO bos_member
  USING (bos_is_member(workspace_id))
  WITH CHECK (bos_is_member(workspace_id));

CREATE POLICY artifact_member ON artifact
  FOR ALL TO bos_member
  USING (bos_is_member(workspace_id))
  WITH CHECK (bos_is_member(workspace_id));

CREATE POLICY verification_member ON verification
  FOR ALL TO bos_member
  USING (bos_is_member(workspace_id))
  WITH CHECK (bos_is_member(workspace_id));

CREATE POLICY audit_member ON audit_event
  FOR ALL TO bos_member
  USING (bos_is_member(workspace_id))
  WITH CHECK (bos_is_member(workspace_id));

CREATE POLICY membership_self ON workspace_membership
  FOR SELECT TO bos_member
  USING (user_id = current_user);

GRANT USAGE ON SCHEMA public TO bos_member;
GRANT CONNECT ON DATABASE bos_pro_test TO bos_member;
GRANT SELECT ON workspace, workspace_membership, project TO bos_member;
GRANT SELECT, INSERT ON workflow_version, task, run_step, artifact, verification, audit_event TO bos_member;
GRANT SELECT, INSERT, UPDATE ON run TO bos_member;
GRANT UPDATE ON artifact, verification TO bos_member;
GRANT EXECUTE ON FUNCTION bos_is_member(text) TO bos_member;

REVOKE ALL ON schema_migration FROM PUBLIC;
REVOKE ALL ON schema_migration FROM bos_member;
