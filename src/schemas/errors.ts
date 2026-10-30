import { Schema } from "effect";

/** Reading or writing the repo failed: a missing file, git unavailable, bad JSON. */
export class WorkspaceError extends Schema.TaggedError<WorkspaceError>()("WorkspaceError", {
  operation: Schema.String,
  path: Schema.String,
  reason: Schema.String,
}) {
  override get message(): string {
    return `${this.operation} ${this.path}: ${this.reason}`;
  }
}

/** `shape.config.ts` is missing or does not match the schema. */
export class ConfigError extends Schema.TaggedError<ConfigError>()("ConfigError", {
  path: Schema.String,
  reason: Schema.String,
}) {
  override get message(): string {
    return `${this.path}: ${this.reason}`;
  }
}

/** A track command refused, or stopped partway; the message says which, and what to do. */
export class TrackError extends Schema.TaggedError<TrackError>()("TrackError", {
  reason: Schema.String,
}) {
  override get message(): string {
    return this.reason;
  }
}
