CREATE SCHEMA bos;
REVOKE ALL ON SCHEMA bos FROM PUBLIC;
DO $role$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'bos_runtime') THEN
    CREATE ROLE bos_runtime NOLOGIN NOSUPERUSER NOBYPASSRLS;
  END IF;
END
$role$;
GRANT USAGE ON SCHEMA bos TO bos_runtime;
CREATE TABLE bos.workspace(id text PRIMARY KEY);
CREATE TABLE bos.workspace_membership(workspace_id text REFERENCES bos.workspace(id), user_id text NOT NULL, role text NOT NULL CHECK(role IN ('owner','editor','viewer')), PRIMARY KEY(workspace_id,user_id));
CREATE FUNCTION bos.can_access(w text, writing boolean DEFAULT false) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog,bos AS $$
 SELECT w = current_setting('bos.workspace_id',true) AND EXISTS (
 SELECT 1 FROM bos.workspace_membership m WHERE m.workspace_id=w AND m.user_id=current_setting('bos.user_id',true)
 AND (NOT writing OR m.role IN ('owner','editor')))
$$;
REVOKE ALL ON FUNCTION bos.can_access(text,boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION bos.can_access(text,boolean) TO bos_runtime;
CREATE TABLE bos.project(workspace_id text REFERENCES bos.workspace(id), id text, PRIMARY KEY(workspace_id,id));
CREATE TABLE bos.task(workspace_id text, id text, project_id text NOT NULL, PRIMARY KEY(workspace_id,id), FOREIGN KEY(workspace_id,project_id) REFERENCES bos.project(workspace_id,id));
CREATE TABLE bos.workflow_version(id text PRIMARY KEY);
INSERT INTO bos.workflow_version VALUES ('prepare_draft_educational/0.1.0');
CREATE TABLE bos.run(workspace_id text, id text, task_id text NOT NULL, workflow_version text NOT NULL REFERENCES bos.workflow_version(id), payload jsonb NOT NULL, PRIMARY KEY(workspace_id,id), FOREIGN KEY(workspace_id,task_id) REFERENCES bos.task(workspace_id,id), CHECK(payload->>'run_id'=id AND payload->>'workspace_id'=workspace_id), CHECK(payload->>'status' IN ('queued','running','waiting_approval','succeeded','failed','cancelled')));
CREATE FUNCTION bos.guard_run() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,bos AS $$
BEGIN
 IF NEW.task_id<>OLD.task_id OR NEW.workflow_version<>OLD.workflow_version OR NEW.workspace_id<>OLD.workspace_id THEN RAISE EXCEPTION 'immutable run identity'; END IF;
 IF OLD.payload->>'status' IN ('succeeded','failed','cancelled') AND NEW.payload->>'status'<>OLD.payload->>'status' THEN RAISE EXCEPTION 'terminal run'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER guard_run BEFORE UPDATE ON bos.run FOR EACH ROW EXECUTE FUNCTION bos.guard_run();
CREATE TABLE bos.snapshot(workspace_id text, run_id text, payload jsonb NOT NULL, PRIMARY KEY(workspace_id,run_id), FOREIGN KEY(workspace_id,run_id) REFERENCES bos.run(workspace_id,id) DEFERRABLE INITIALLY DEFERRED);
CREATE TABLE bos.artifact(workspace_id text, id text, revision integer CHECK(revision>0), run_id text NOT NULL, payload jsonb NOT NULL, PRIMARY KEY(workspace_id,id,revision), FOREIGN KEY(workspace_id,run_id) REFERENCES bos.run(workspace_id,id));
CREATE TABLE bos.verification(workspace_id text, artifact_id text, revision integer, payload jsonb NOT NULL, PRIMARY KEY(workspace_id,artifact_id,revision), FOREIGN KEY(workspace_id,artifact_id,revision) REFERENCES bos.artifact(workspace_id,id,revision));
CREATE TABLE bos.idempotency(workspace_id text, scope_hash text, run_id text NOT NULL, payload jsonb NOT NULL, PRIMARY KEY(workspace_id,scope_hash), FOREIGN KEY(workspace_id,run_id) REFERENCES bos.run(workspace_id,id));
CREATE TABLE bos.run_step(workspace_id text, run_id text, ordinal integer, payload jsonb NOT NULL, PRIMARY KEY(workspace_id,run_id,ordinal), FOREIGN KEY(workspace_id,run_id) REFERENCES bos.run(workspace_id,id));
CREATE TABLE bos.audit_event(workspace_id text, run_id text, ordinal integer, payload jsonb NOT NULL, PRIMARY KEY(workspace_id,run_id,ordinal), FOREIGN KEY(workspace_id,run_id) REFERENCES bos.run(workspace_id,id));
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['workspace','project','task','run','snapshot','artifact','verification','idempotency','run_step','audit_event'] LOOP
 EXECUTE format('ALTER TABLE bos.%I ENABLE ROW LEVEL SECURITY',t);
 EXECUTE format('ALTER TABLE bos.%I FORCE ROW LEVEL SECURITY',t);
 EXECUTE format('CREATE POLICY read_rows ON bos.%I FOR SELECT TO bos_runtime USING (bos.can_access(%I,false))',t,CASE WHEN t='workspace' THEN 'id' ELSE 'workspace_id' END);
 IF t NOT IN ('workspace') THEN
 EXECUTE format('CREATE POLICY insert_rows ON bos.%I FOR INSERT TO bos_runtime WITH CHECK (bos.can_access(workspace_id,true))',t);
 END IF;
 END LOOP;
END $$;
CREATE POLICY update_runs ON bos.run FOR UPDATE TO bos_runtime USING(bos.can_access(workspace_id,true)) WITH CHECK(bos.can_access(workspace_id,true));
GRANT SELECT ON ALL TABLES IN SCHEMA bos TO bos_runtime;
GRANT INSERT ON bos.project,bos.task,bos.run,bos.snapshot,bos.artifact,bos.verification,bos.idempotency,bos.run_step,bos.audit_event TO bos_runtime;
GRANT UPDATE ON bos.run TO bos_runtime;
-- Membership is provisioned by a separate administrator, never the runtime.
ALTER TABLE bos.workspace_membership ENABLE ROW LEVEL SECURITY;
CREATE POLICY own_memberships ON bos.workspace_membership FOR SELECT TO bos_runtime USING(user_id=current_setting('bos.user_id',true) AND workspace_id=current_setting('bos.workspace_id',true));
