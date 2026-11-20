/** Response of `GET /api/health`. */
export interface HealthResponse {
  status: 'ok';
  /** Application version, `0.0.0` for untagged and local builds. */
  version: string;
  /** Git commit the image was built from, `null` outside of image builds. */
  commit: string | null;
  /** Commit time (ISO 8601) of `commit`, `null` outside of image builds. */
  commitTime: string | null;
}
