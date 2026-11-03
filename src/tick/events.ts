// Cambios de estado de las tareas SEO de Órbita que merecen aviso. Lógica pura: el
// LaunchAgent com.miwebdeboda.seo-tick guarda la foto anterior y compara con la actual.
// No fusiona, no aprueba ni ejecuta nada: solo detecta y avisa.

export interface TaskSnap {
  id: string;
  title: string;
  status: string;
  labels: string[];
  /** Último comentario del worker (🤖), con las notas de rama/fusión. */
  lastNote: string | null;
  /** Estado del último encargo en copy_jobs (pending, running, done, failed). */
  jobStatus: string | null;
}

export type TickEventKind = "fusion-inesperada" | "lista-revision" | "bloqueada" | "fallo" | "rama-bloqueada";

export interface TickEvent {
  kind: TickEventKind;
  taskId: string;
  title: string;
  detail: string;
}

export type TickState = Record<string, { status: string; note: string | null; jobStatus: string | null }>;

const isSeo = (labels: string[]) => labels.some((l) => l.startsWith("seo"));

/**
 * Eventos nuevos respecto a la foto anterior. Una tarea vista por primera vez solo
 * avisa si ya está en un estado que lo merece (p. ej. tras reiniciar el tick).
 */
export function computeEvents(prev: TickState, curr: TaskSnap[]): TickEvent[] {
  const events: TickEvent[] = [];
  for (const t of curr) {
    if (!isSeo(t.labels)) continue;
    const before = prev[t.id];
    const noteChanged = (t.lastNote ?? null) !== (before?.note ?? null);
    const note = t.lastNote ?? "";
    if (noteChanged && /fusionada en main/i.test(note) && t.labels.includes("fusion-manual")) {
      events.push({ kind: "fusion-inesperada", taskId: t.id, title: t.title, detail: "Una tarea con «fusion-manual» aparece fusionada en main: revisar de inmediato." });
    }
    if (noteChanged && /no fusionada:.*commit(?:s|\(s\))? de otras tareas/i.test(note)) {
      events.push({ kind: "rama-bloqueada", taskId: t.id, title: t.title, detail: "La rama compartida trae commits de otras tareas: la fusión está bloqueada." });
    }
    if (t.status === "done" && (before?.status !== "done" || noteChanged) && /no fusionada:.*fusion-manual/i.test(note)) {
      events.push({ kind: "lista-revision", taskId: t.id, title: t.title, detail: "Terminada y sin fusionar: lista para revisión y fusión manual." });
    }
    if (t.status === "blocked" && before?.status !== "blocked") {
      events.push({ kind: "bloqueada", taskId: t.id, title: t.title, detail: note.slice(0, 300) || "Bloqueada sin motivo en el comentario." });
    }
    if (t.jobStatus === "failed" && before?.jobStatus !== "failed" && t.status !== "done") {
      events.push({ kind: "fallo", taskId: t.id, title: t.title, detail: "El encargo ha fallado tras agotar los intentos." });
    }
  }
  return events;
}

export function nextState(curr: TaskSnap[]): TickState {
  return Object.fromEntries(curr.map((t) => [t.id, { status: t.status, note: t.lastNote, jobStatus: t.jobStatus }]));
}
