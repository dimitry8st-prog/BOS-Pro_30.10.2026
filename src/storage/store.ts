import type {
  ArtifactRevision,
  IdempotencyRecord,
  InputSnapshot,
  RunRecord,
} from "../contract/types.js";

export interface RunStore {
  readonly kind: "development-file";
  readonly durableProduction: false;
  saveRun(run: RunRecord): Promise<void>;
  readRun(runId: string): Promise<RunRecord | null>;
  listRuns(): Promise<RunRecord[]>;
  saveSnapshot(snapshot: InputSnapshot): Promise<void>;
  readSnapshot(runId: string): Promise<InputSnapshot | null>;
  saveArtifactRevision(revision: ArtifactRevision): Promise<void>;
  readArtifactRevision(artifactId: string, revision: number): Promise<ArtifactRevision | null>;
  listArtifactRevisions(artifactId: string): Promise<ArtifactRevision[]>;
  getIdempotency(scopeHash: string): Promise<IdempotencyRecord | null>;
  putIdempotency(record: IdempotencyRecord): Promise<void>;
  withIdempotencyLock<T>(scopeHash: string, fn: () => Promise<T>): Promise<T>;
  requestCancel(runId: string): Promise<void>;
}
