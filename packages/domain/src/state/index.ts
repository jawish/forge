// @forge/domain state-machine barrel — pure transition logic (docs/11).
// The DO (apps/control-plane §5.1–5.3) validates legality via these and
// implements the returned side-effect manifests against injected ports.

export {
  STATUS_TRANSITIONS,
  ACTIVITY_TRANSITIONS,
  canTransition,
  canTransitionActivity,
  legalStatusTargets,
  legalActivityTargets,
  legalActivityFor,
  transitionSideEffects,
  activityTransitionSideEffects,
  transitionGuard,
  findStatusRule,
  isTerminalStatus,
  isValidState,
} from "./transitions";
export type {
  StatusTransitionRule,
  ActivityTransitionRule,
  SideEffect,
  TransitionGuard,
  TransitionReason,
} from "./transitions";
