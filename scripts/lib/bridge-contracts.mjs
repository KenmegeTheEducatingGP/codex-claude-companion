import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const ajv = new Ajv2020({ allErrors: true, strict: true });
addFormats(ajv);

/** Contract versions every validator accepts. Each schema file is a oneOf union of these branches. */
export const BRIDGE_CONTRACT_VERSIONS = Object.freeze([1, 2]);

const FAMILIES = Object.freeze(["claude", "codex"]);
const SCHEMAS = Object.freeze({
  request: "bridge-delegation-request.schema.json",
  event: "bridge-event.schema.json",
  messageOperation: "bridge-message-operation.schema.json",
  result: "bridge-result.schema.json",
  receipt: "bridge-receipt.schema.json"
});

function readSchema(filename) {
  return JSON.parse(fs.readFileSync(path.join(ROOT, "schemas", filename), "utf8"));
}

// Compiling the union root registers every branch; each version is then validated
// against its own branch, so 1.x documents keep their 1.2.0 error messages.
const validators = Object.fromEntries(Object.entries(SCHEMAS).map(([kind, filename]) => {
  const schema = readSchema(filename);
  ajv.compile(schema);
  const branches = Object.fromEntries(BRIDGE_CONTRACT_VERSIONS.map((version) => {
    const branch = ajv.getSchema(`${schema.$id}#/$defs/v${version}`);
    if (!branch) throw new Error(`Bridge ${kind} schema has no v${version} branch.`);
    return [version, branch];
  }));
  return [kind, branches];
}));
const configValidator = ajv.compile(readSchema("bridge-config.schema.json"));

export class BridgeContractValidationError extends Error {
  constructor(message, { phase, errors = [] } = {}) {
    super(message);
    this.name = "BridgeContractValidationError";
    this.phase = phase;
    this.errors = errors;
  }
}

function formatSchemaErrors(errors = []) {
  return errors.map((error) => {
    const location = error.instancePath || "/";
    return `${location} ${error.message}`;
  }).join("; ");
}

function runValidator(kind, validator, value) {
  if (!validator(value)) {
    const errors = structuredClone(validator.errors ?? []);
    throw new BridgeContractValidationError(
      `Bridge ${kind} failed schema validation: ${formatSchemaErrors(errors)}`,
      { phase: "schema", errors }
    );
  }
  return value;
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// Dispatch on schemaVersion. A document that is not an object, or has no
// schemaVersion, is reported against the 1.x contract exactly as 1.2.0 did.
function versionOf(kind, value) {
  if (!isPlainObject(value) || !Object.hasOwn(value, "schemaVersion")) return 1;
  if (!BRIDGE_CONTRACT_VERSIONS.includes(value.schemaVersion)) {
    throw new BridgeContractValidationError(
      `Bridge ${kind} failed schema validation: unsupported schemaVersion ${JSON.stringify(value.schemaVersion)}; supported versions: ${BRIDGE_CONTRACT_VERSIONS.join(", ")}.`,
      { phase: "schema" }
    );
  }
  return value.schemaVersion;
}

function validateSchema(kind, value) {
  const version = versionOf(kind, value);
  runValidator(kind, validators[kind][version], value);
  return version;
}

function semanticsError(message) {
  return new BridgeContractValidationError(message, { phase: "semantics" });
}

export function validateBridgeRequestContract(request) {
  const version = validateSchema("request", request);
  const { execution } = request;
  if (execution.sandboxAttestation !== null) {
    const attestation = execution.sandboxAttestation;
    for (const key of ["jobId", "executor", "canonicalWorkspacePath"]) {
      if (attestation[key] !== (key === "jobId" ? request.jobId : execution[key])) {
        throw semanticsError(`Bridge request sandbox attestation ${key} is not bound to the request.`);
      }
    }
  }
  if (version === 2 && request.task.continuesJobId === request.jobId) {
    throw semanticsError("Bridge request task.continuesJobId must name an earlier job, not the request's own jobId.");
  }
  return request;
}

// schemaVersion 2 events and message operations may be authored by either family,
// so whether an author is legitimate depends on the job: callers pass its families.
function jobFamilies(kind, context) {
  const originFamily = context?.originFamily;
  const workerFamily = context?.workerFamily;
  if (!FAMILIES.includes(originFamily) || !FAMILIES.includes(workerFamily)) {
    throw semanticsError(
      `Bridge ${kind} schemaVersion 2 validation needs the job's origin and worker families ({ originFamily, workerFamily }, each one of ${FAMILIES.join(", ")}).`
    );
  }
  return { originFamily, workerFamily };
}

// The side of the job that each family-authored v2 event type speaks for: the role the
// 1.x schema fixed, where Codex was always the origin and Claude always the worker. A
// message type names its family instead, so either side may send one.
const EVENT_AUTHOR_ROLES = Object.freeze({
  progress: "worker",
  question: "worker",
  blocked: "worker",
  completed: "worker",
  failed: "worker",
  cancelled: "worker",
  cancel_requested: "origin"
});

/**
 * Validate one bridge event. schemaVersion 2 events also need the job's families:
 * either family may be the origin or the worker, and an event a family authors keeps
 * its 1.x role, so worker-side events come from the worker family and a cancel
 * request from the origin family.
 *
 * @param {object} event
 * @param {{originFamily: "claude"|"codex", workerFamily: "claude"|"codex"}} [context] required for schemaVersion 2
 */
export function validateBridgeEventContract(event, context) {
  const version = versionOf("event", event);
  if (version === 1) return runValidator("event", validators.event[1], event);
  const { originFamily, workerFamily } = jobFamilies("event", context);
  runValidator("event", validators.event[2], event);
  const { sender, type } = event;
  if (!FAMILIES.includes(sender)) return event;
  if (sender !== originFamily && sender !== workerFamily) {
    throw semanticsError(
      `Bridge event ${type} sender ${sender} is neither the job's origin family (${originFamily}) nor its worker family (${workerFamily}).`
    );
  }
  const role = Object.hasOwn(EVENT_AUTHOR_ROLES, type) ? EVENT_AUTHOR_ROLES[type] : undefined;
  if (role === undefined) return event;
  const expected = role === "worker" ? workerFamily : originFamily;
  if (sender !== expected) {
    throw semanticsError(`Bridge event ${type} must come from the ${role} family (${expected}), not ${sender}.`);
  }
  return event;
}

/**
 * Validate one durable messaging operation. In schemaVersion 2 the family named in
 * the kind is bound to the job: a pending message and an applied record name the
 * origin family, and an acknowledgement names the worker family, as in 1.x.
 *
 * @param {object} operation
 * @param {{originFamily: "claude"|"codex", workerFamily: "claude"|"codex"}} [context] required for schemaVersion 2
 */
export function validateBridgeMessageOperationContract(operation, context) {
  const version = versionOf("messageOperation", operation);
  if (version === 1) return runValidator("messageOperation", validators.messageOperation[1], operation);
  const { originFamily, workerFamily } = jobFamilies("messageOperation", context);
  runValidator("messageOperation", validators.messageOperation[2], operation);
  const { kind, state } = operation;
  const family = kind.slice(0, kind.indexOf("_"));
  const side = state === "ack" ? "worker" : "origin";
  const expected = side === "worker" ? workerFamily : originFamily;
  if (family !== expected) {
    throw semanticsError(
      `Bridge messageOperation ${kind} (${state}) must name the job's ${side} family (${expected}), not ${family}.`
    );
  }
  return operation;
}

export function validateBridgeResultContract(result) {
  validateSchema("result", result);
  return result;
}

/**
 * Validate a parsed user configuration file (schemas/bridge-config.schema.json).
 *
 * @returns the validated configuration unchanged
 * @throws {BridgeContractValidationError} with `phase` set to `schema`
 */
export function validateBridgeConfigContract(config) {
  return runValidator("config", configValidator, config);
}

function parseTimestamp(receipt, label, value) {
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) {
    throw new BridgeContractValidationError(
      `Bridge receipt ${label} must be a valid date-time string.`,
      { phase: "semantics" }
    );
  }
  return milliseconds;
}

function validateReceiptSemantics(receipt) {
  // The request validator holds the same invariant for the same field: a job continues an earlier
  // job, and a persisted receipt that names itself would be a cycle in the continuation history.
  if (receipt.schemaVersion === 2 && receipt.continuesJobId === receipt.jobId) {
    throw semanticsError("Bridge receipt continuesJobId must name an earlier job, not the receipt's own jobId.");
  }
  const createdAt = parseTimestamp(receipt, "createdAt", receipt.createdAt);
  const deliveredAt = receipt.delivery.deliveredAt === null
    ? null
    : parseTimestamp(receipt, "deliveredAt", receipt.delivery.deliveredAt);
  const acknowledgedAt = receipt.delivery.acknowledgedAt === null
    ? null
    : parseTimestamp(receipt, "acknowledgedAt", receipt.delivery.acknowledgedAt);
  const verifiedAt = receipt.verification.verifiedAt === null
    ? null
    : parseTimestamp(receipt, "verifiedAt", receipt.verification.verifiedAt);

  if (deliveredAt !== null && deliveredAt < createdAt) {
    throw new BridgeContractValidationError(
      "Bridge receipt chronology is invalid: deliveredAt must not precede createdAt.",
      { phase: "semantics" }
    );
  }
  if (acknowledgedAt !== null && acknowledgedAt < deliveredAt) {
    throw new BridgeContractValidationError(
      "Bridge receipt chronology is invalid: acknowledgedAt must not precede deliveredAt.",
      { phase: "semantics" }
    );
  }
  if (verifiedAt !== null && verifiedAt < createdAt) {
    throw new BridgeContractValidationError(
      "Bridge receipt chronology is invalid: verifiedAt must not precede createdAt.",
      { phase: "semantics" }
    );
  }
}

/**
 * Validate the complete bridge receipt contract: JSON Schema shape and semantic
 * chronology. Callers must use this entry point rather than compiling only the
 * schema, because JSON Schema cannot compare date-time values.
 *
 * @returns the validated receipt unchanged
 * @throws {BridgeContractValidationError} with `phase` set to `schema` or `semantics`
 */
export function validateBridgeReceiptContract(receipt) {
  validateSchema("receipt", receipt);
  validateReceiptSemantics(receipt);
  return receipt;
}
