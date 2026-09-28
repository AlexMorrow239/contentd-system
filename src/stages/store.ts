/** Legacy object metadata retained until the backfill/library consumers are removed. */
export interface StoreArtifact {
  objectKey: string
  bytes: number
  etag: string
}

/** Legacy key builder retained only for the soon-to-be-removed backfill command. */
export function objectKeyFor(channel: string, jobId: string): string {
  return `videos/${channel}/${jobId}.mp4`
}
