import type { PairCapabilityAuthority, PairExecution, PairExecutionDependencies } from "./contracts";
import { constructPairExecution } from "./pair-execution";

export class PairExecutionConfigurationError extends Error {
  override readonly name = "PairExecutionConfigurationError";
}

function requireMethod(value: unknown, path: string): void {
  if (typeof value !== "function") throw new PairExecutionConfigurationError(`missing dependency method: ${path}`);
}

function validateDependencies(deps: PairExecutionDependencies): void {
  if (deps === null || typeof deps !== "object") throw new PairExecutionConfigurationError("dependencies are required");
  requireMethod(deps.economics?.evaluate, "economics.evaluate");
  requireMethod(deps.observations?.record, "observations.record");
  requireMethod(deps.account?.approveSchedule, "account.approveSchedule");
  requireMethod(deps.activation?.prepareSchedule, "activation.prepareSchedule");
  requireMethod(deps.activation?.prepareDueWork, "activation.prepareDueWork");
  requireMethod(deps.store?.commitSchedule, "store.commitSchedule");
  requireMethod(deps.store?.listDueWork, "store.listDueWork");
  requireMethod(deps.store?.commitDuePlan, "store.commitDuePlan");
  requireMethod(deps.store?.commitHalt, "store.commitHalt");
  requireMethod(deps.store?.getGroup, "store.getGroup");
  requireMethod(deps.store?.listActiveGroups, "store.listActiveGroups");
  requireMethod(deps.effects?.dispatchCommitted, "effects.dispatchCommitted");
  requireMethod(deps.effects?.ingestAvailableEvidence, "effects.ingestAvailableEvidence");
  requireMethod(deps.reconciliation?.reconcile, "reconciliation.reconcile");
}

function validateAuthority(authority: PairCapabilityAuthority): void {
  if (authority === null || typeof authority !== "object") throw new PairExecutionConfigurationError("capability authority is required");
  if (typeof authority.observerEnabled !== "boolean" || typeof authority.paperSchedulingEnabled !== "boolean") {
    throw new PairExecutionConfigurationError("authority capability flags must be boolean");
  }
  if (!Number.isSafeInteger(authority.configVersion) || authority.configVersion < 1) {
    throw new PairExecutionConfigurationError("authority configVersion must be a positive safe integer");
  }
  if (authority.policy === null || typeof authority.policy !== "object") {
    throw new PairExecutionConfigurationError("authority policy is required");
  }
  if (authority.liveExecutionAvailable !== false || authority.policy.liveExecutionAvailable !== false) {
    throw new PairExecutionConfigurationError("unsupported execution capability requested");
  }
  if (authority.policy.configVersion !== authority.configVersion) {
    throw new PairExecutionConfigurationError("authority and policy configVersion differ");
  }
  if (authority.policy.observerEnabled !== authority.observerEnabled) {
    throw new PairExecutionConfigurationError("authority and policy observer capability differ");
  }
  if (authority.policy.paperSchedulingEnabled !== authority.paperSchedulingEnabled) {
    throw new PairExecutionConfigurationError("authority and policy paper capability differ");
  }
  if (typeof authority.policy.policyHash !== "string" || authority.policy.policyHash.trim().length === 0) {
    throw new PairExecutionConfigurationError("policy hash must not be empty");
  }
  if (!Array.isArray(authority.policy.depthStressFractionsPpm) || authority.policy.depthStressFractionsPpm.length !== 3) {
    throw new PairExecutionConfigurationError("policy depth stress fractions must contain three entries");
  }
  if (authority.policy.hardRiskConstant === null || typeof authority.policy.hardRiskConstant !== "object") {
    throw new PairExecutionConfigurationError("policy hard risk constant is required");
  }
}

function immutableAuthoritySnapshot(authority: PairCapabilityAuthority): PairCapabilityAuthority {
  const policy = Object.freeze({
    ...authority.policy,
    depthStressFractionsPpm: Object.freeze([...authority.policy.depthStressFractionsPpm]),
    hardRiskConstant: Object.freeze({ ...authority.policy.hardRiskConstant }),
  }) as PairCapabilityAuthority["policy"];
  return Object.freeze({ ...authority, policy });
}

export function createPairExecution(
  deps: PairExecutionDependencies,
  authority: PairCapabilityAuthority,
): PairExecution {
  validateDependencies(deps);
  validateAuthority(authority);
  return constructPairExecution(deps, immutableAuthoritySnapshot(authority));
}
