import { Result } from './Result';

/** Small invariant helpers returning Result instead of throwing. */
export const Guard = {
  againstNullOrUndefined(value: unknown, name: string): Result<void> {
    return value === null || value === undefined
      ? Result.fail(`${name} is null or undefined`)
      : Result.ok();
  },
  againstEmpty(value: string, name: string): Result<void> {
    return value.trim().length === 0 ? Result.fail(`${name} must not be empty`) : Result.ok();
  },
  inRange(value: number, min: number, max: number, name: string): Result<void> {
    return value < min || value > max
      ? Result.fail(`${name} must be between ${min} and ${max}`)
      : Result.ok();
  },
};
