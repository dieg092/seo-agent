// src/opportunity/lifecycle.test.ts
// Una prueba por transición de la spec §6, más las reglas del Anexo B.1.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  InvalidTransitionError,
  OPPORTUNITY_STATES,
  canTransition,
  initialLifecycle,
  transition,
  type Lifecycle,
  type LifecycleEvent,
  type OpportunityState,
} from "./lifecycle";

const DAY = 24 * 60 * 60 * 1000;
const t0 = new Date("2026-11-01T06:00:00Z");
const day = (n: number) => new Date(t0.getTime() + n * DAY);

function at(state: OpportunityState, overrides: Partial<Lifecycle> = {}): Lifecycle {
  return {
    state,
    stateChangedAt: t0,
    confirmations: 2,
    absences: 0,
    oscillations: 0,
    oscillationsSince: null,
    dismissedValue: null,
    staleAt: null,
    ...overrides,
  };
}

const seen: LifecycleEvent = { type: "observed", critical: false, value: 2.5 };
const seenCritical: LifecycleEvent = { type: "observed", critical: true, value: 10 };
const absent: LifecycleEvent = { type: "absent" };

test("[*] → detected: un hallazgo no crítico nuevo empieza en detected con 1 confirmación", () => {
  const lc = initialLifecycle(false, t0);
  assert.equal(lc.state, "detected");
  assert.equal(lc.confirmations, 1);
});

test("[*] → open: un hallazgo crítico se abre con 1 evaluación", () => {
  assert.equal(initialLifecycle(true, t0).state, "open");
});

test("detected → open: la segunda evaluación consecutiva lo abre", () => {
  const lc = transition(initialLifecycle(false, t0), seen, day(1));
  assert.equal(lc.state, "open");
  assert.equal(lc.confirmations, 2);
  assert.equal(lc.stateChangedAt.getTime(), day(1).getTime());
});

test("detected → open: un crítico en detected se abre en la siguiente evaluación", () => {
  const lc = transition(at("detected", { confirmations: 0 }), seenCritical, day(1));
  assert.equal(lc.state, "open");
});

test("detected: si desaparece, la cuenta de confirmaciones vuelve a 0 (sin parpadeos)", () => {
  let lc = initialLifecycle(false, t0);
  lc = transition(lc, absent, day(1));
  assert.equal(lc.state, "detected");
  assert.equal(lc.confirmations, 0);
  lc = transition(lc, seen, day(2));
  assert.equal(lc.state, "detected");
  lc = transition(lc, seen, day(3));
  assert.equal(lc.state, "open");
});

test("open → queued: el puente crea la tarea", () => {
  assert.equal(transition(at("open"), { type: "task-created" }, day(1)).state, "queued");
});

test("queued → in_progress", () => {
  assert.equal(transition(at("queued"), { type: "task-started" }, day(1)).state, "in_progress");
});

test("in_progress → applied: cambio desplegado", () => {
  assert.equal(transition(at("in_progress"), { type: "deployed" }, day(1)).state, "applied");
});

test("in_progress → blocked: la tarea queda bloqueada", () => {
  assert.equal(transition(at("in_progress"), { type: "task-blocked" }, day(1)).state, "blocked");
});

test("blocked → in_progress: la tarea se desbloquea", () => {
  assert.equal(transition(at("blocked"), { type: "task-started" }, day(1)).state, "in_progress");
});

test("applied → verifying: sonda después del despliegue, con las ausencias a 0", () => {
  const lc = transition(at("applied", { absences: 2 }), { type: "verification-started" }, day(1));
  assert.equal(lc.state, "verifying");
  assert.equal(lc.absences, 0);
});

test("verifying → resolved: la condición desaparece 3 evaluaciones seguidas", () => {
  let lc = at("verifying");
  lc = transition(lc, absent, day(1));
  lc = transition(lc, absent, day(2));
  assert.equal(lc.state, "verifying");
  lc = transition(lc, absent, day(3));
  assert.equal(lc.state, "resolved");
});

test("verifying: si vuelve a verse, la racha de ausencias se reinicia", () => {
  let lc = at("verifying");
  lc = transition(lc, absent, day(1));
  lc = transition(lc, absent, day(2));
  lc = transition(lc, seen, day(3));
  lc = transition(lc, absent, day(4));
  assert.equal(lc.state, "verifying");
  assert.equal(lc.absences, 1);
});

test("verifying → regression: error técnico atribuible", () => {
  assert.equal(transition(at("verifying"), { type: "regression-detected" }, day(1)).state, "regression");
});

test("regression → queued: tarea de reversión automática", () => {
  assert.equal(transition(at("regression"), { type: "task-created" }, day(1)).state, "queued");
});

test("open → dismissed: tarea cancelada por el fundador, guarda value × severityW", () => {
  const lc = transition(at("open"), { type: "task-cancelled", value: 5 }, day(1));
  assert.equal(lc.state, "dismissed");
  assert.equal(lc.dismissedValue, 5);
});

test("queued, in_progress y blocked → dismissed al cancelar la tarea (§7)", () => {
  for (const state of ["queued", "in_progress", "blocked"] as const) {
    assert.equal(transition(at(state), { type: "task-cancelled", value: 1 }, day(1)).state, "dismissed");
  }
});

test("dismissed → open: reabre si value × severityW llega al doble", () => {
  const dismissed = at("dismissed", { dismissedValue: 5 });
  assert.equal(transition(dismissed, { type: "observed", critical: false, value: 9.9 }, day(1)).state, "dismissed");
  const reopened = transition(dismissed, { type: "observed", critical: false, value: 10 }, day(1));
  assert.equal(reopened.state, "open");
  assert.equal(reopened.dismissedValue, null);
});

test("dismissed → open: reabre si pasan 90 días y sigue presente", () => {
  const dismissed = at("dismissed", { dismissedValue: 5 });
  assert.equal(transition(dismissed, seen, day(89)).state, "dismissed");
  assert.equal(transition(dismissed, seen, day(90)).state, "open");
  // Si ya no está, no se reabre por mucho tiempo que pase.
  assert.equal(transition(dismissed, absent, day(120)).state, "dismissed");
});

test("open → resolved: sin cambio, la condición desaparece 3 evaluaciones seguidas", () => {
  let lc = at("open");
  lc = transition(lc, absent, day(1));
  lc = transition(lc, absent, day(2));
  assert.equal(lc.state, "open");
  lc = transition(lc, absent, day(3));
  assert.equal(lc.state, "resolved");
});

test("resolved → open: reaparece y cuenta la oscilación", () => {
  const lc = transition(at("resolved"), seen, day(1));
  assert.equal(lc.state, "open");
  assert.equal(lc.oscillations, 1);
  assert.equal(lc.oscillationsSince?.getTime(), day(1).getTime());
});

test("resolved → stale: 3 reaperturas en 60 días", () => {
  const second = transition(at("resolved", { oscillations: 1, oscillationsSince: day(0) }), seen, day(20));
  assert.equal(second.state, "open");
  assert.equal(second.oscillations, 2);
  const third = transition({ ...second, state: "resolved" }, seen, day(50));
  assert.equal(third.state, "stale");
  assert.equal(third.staleAt?.getTime(), day(50).getTime());
});

test("resolved → open: las reaperturas de hace más de 60 días no cuentan", () => {
  const lc = transition(at("resolved", { oscillations: 2, oscillationsSince: day(0) }), seen, day(61));
  assert.equal(lc.state, "open");
  assert.equal(lc.oscillations, 1);
});

test("open → stale: 60 días sin poder resolverse con su tarea cerrada", () => {
  assert.equal(transition(at("open"), { type: "tick", taskClosed: true }, day(59)).state, "open");
  assert.equal(transition(at("open"), { type: "tick", taskClosed: false }, day(90)).state, "open");
  const lc = transition(at("open"), { type: "tick", taskClosed: true }, day(60));
  assert.equal(lc.state, "stale");
  assert.equal(lc.staleAt?.getTime(), day(60).getTime());
});

test("verifying → stale: 60 días verificando sin resolverse", () => {
  assert.equal(transition(at("verifying"), { type: "tick", taskClosed: false }, day(60)).state, "stale");
});

test("stale es terminal: ni evaluaciones ni eventos de tarea lo mueven", () => {
  const stale = at("stale");
  assert.equal(transition(stale, seen, day(1)).state, "stale");
  assert.equal(transition(stale, absent, day(1)).state, "stale");
  assert.equal(transition(stale, { type: "tick", taskClosed: true }, day(200)).state, "stale");
  assert.throws(() => transition(stale, { type: "task-created" }, day(1)), InvalidTransitionError);
});

test("los eventos de tarea fuera del diagrama lanzan InvalidTransitionError", () => {
  assert.throws(() => transition(at("detected"), { type: "task-created" }, day(1)), InvalidTransitionError);
  assert.throws(() => transition(at("open"), { type: "deployed" }, day(1)), InvalidTransitionError);
  assert.throws(() => transition(at("queued"), { type: "deployed" }, day(1)), InvalidTransitionError);
  assert.throws(() => transition(at("applied"), { type: "regression-detected" }, day(1)), InvalidTransitionError);
  assert.throws(() => transition(at("resolved"), { type: "task-cancelled", value: 1 }, day(1)), InvalidTransitionError);
});

test("canTransition coincide con transition para todos los estados y eventos de tarea", () => {
  const taskEvents: LifecycleEvent[] = [
    { type: "task-created" },
    { type: "task-started" },
    { type: "task-blocked" },
    { type: "deployed" },
    { type: "verification-started" },
    { type: "regression-detected" },
    { type: "task-cancelled", value: 1 },
  ];
  let valid = 0;
  for (const state of OPPORTUNITY_STATES) {
    for (const event of taskEvents) {
      const allowed = canTransition(state, event.type);
      if (allowed) {
        valid += 1;
        assert.doesNotThrow(() => transition(at(state), event, day(1)));
      } else {
        assert.throws(() => transition(at(state), event, day(1)), InvalidTransitionError);
      }
    }
  }
  // open→queued, regression→queued, queued→in_progress, blocked→in_progress,
  // in_progress→blocked, in_progress→applied, applied→verifying,
  // verifying→regression y 4 cancelaciones.
  assert.equal(valid, 12);
});

test("los eventos de evaluación nunca fallan en ningún estado", () => {
  for (const state of OPPORTUNITY_STATES) {
    assert.doesNotThrow(() => transition(at(state), seen, day(1)));
    assert.doesNotThrow(() => transition(at(state), absent, day(1)));
    assert.doesNotThrow(() => transition(at(state), { type: "tick", taskClosed: true }, day(1)));
  }
});
