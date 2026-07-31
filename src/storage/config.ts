/**
 * S3/R2 configuration, deliberately in its own module with NO `@aws-sdk/*`
 * import. Callers that only need to know whether storage is configured — the
 * produce tick's fail-fast check, the `produce` CLI command — can ask without
 * paying the ~60ms and ~10MB the SDK costs at startup. `./s3.js` re-exports
 * both, so importing from there stays correct for anything already holding a
 * client.
 */

import { BrainrotError } from '../errors.js'

export interface S3Config {
  endpoint: string
  bucket: string
  accessKeyId: string
  secretAccessKey: string
  region: string
  publicEndpoint?: string
}

/**
 * Reads at CALL time, not module load — the convention costs.ts's
 * globalDailyCapMicros already sets, so tests and long-lived cron processes
 * observe env changes without a re-import. Reports EVERY missing key rather
 * than the first: an
 * operator configuring this for the first time should need one round trip,
 * not four.
 */
function readConfig(): { config: S3Config; missing: string[] } {
  const missing: string[] = []
  // Every key read through here is required; the optional ones are read
  // directly below.
  const read = (name: string): string => {
    const value = process.env[name]?.trim() ?? ''
    if (value === '') missing.push(name)
    return value
  }
  const publicEndpoint = process.env.BRAINROT_S3_PUBLIC_ENDPOINT?.trim()
  const config: S3Config = {
    endpoint: read('BRAINROT_S3_ENDPOINT'),
    bucket: read('BRAINROT_S3_BUCKET'),
    accessKeyId: read('BRAINROT_S3_ACCESS_KEY_ID'),
    secretAccessKey: read('BRAINROT_S3_SECRET_ACCESS_KEY'),
    // R2 ignores region but the SDK requires one; 'auto' is R2's documented value.
    region: process.env.BRAINROT_S3_REGION?.trim() || 'auto',
    publicEndpoint: publicEndpoint === '' ? undefined : publicEndpoint,
  }
  return { config, missing }
}

function missingMessage(missing: string[]): string {
  return (
    `object storage is not configured: missing ${missing.join(', ')}. ` +
    'Set them in .env (see .env.example) — there is no local fallback.'
  )
}

/**
 * There is deliberately no fallback to fakeStore here (design spec §3.5): a
 * production tick that quietly wrote videos to a local temp directory and
 * reported success is a worse failure than a crash.
 */
export function s3ConfigFromEnv(): S3Config {
  const { config, missing } = readConfig()
  if (missing.length > 0) {
    throw new BrainrotError(missingMessage(missing), { domain: 'config', kind: 'invalid' })
  }
  return config
}

/**
 * The non-throwing form: the message s3ConfigFromEnv() would throw, or
 * undefined when storage is configured.
 *
 * Exists so the produce path can refuse a job BEFORE the Remotion render
 * rather than after it. The `store` stage runs last (design spec decision 5),
 * so an unconfigured deployment otherwise discovers the problem only once the
 * most expensive stage in the pipeline has already completed.
 */
export function s3ConfigError(): string | undefined {
  const { missing } = readConfig()
  return missing.length > 0 ? missingMessage(missing) : undefined
}
