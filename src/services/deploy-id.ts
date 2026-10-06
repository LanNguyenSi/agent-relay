/** Caller-supplied deploy correlation id validation (X-Deploy-Id / deployId). */
const DEPLOY_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

/** True when `value` is a string of 1-128 chars from [A-Za-z0-9._:-]. */
export function isValidDeployId(value: unknown): value is string {
  return typeof value === "string" && DEPLOY_ID_PATTERN.test(value);
}
