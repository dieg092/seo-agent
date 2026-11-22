import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prisma } from "../db";
import { EditorialDeferred } from "../editorial/modelErrors";
import { campaignUrl, hmacKey, madrid, minimize, scorePost, selectCards, threadKey, type RawPost } from "./core";
import { validateDrafts, type DraftInput } from "./draft";
import { tick, type TickDeps } from "./runner";
import type { Source } from "./sources";
import { facebookGroupPost, facebookPostsFromMail, telegramPosts, weddingGroups } from "./accounts";

const NOW = new Date("2026-11-23T08:00:00Z"); // 09:00 en Madrid
const post = (text: string, hoursAgo = 2, id = "c1"): RawPost => ({ canonicalId: id, url: `https://www.youtube.com/watch?v=v&lc=${id}`, text, publishedAt: new Date(NOW.getTime() - hoursAgo * 3_600_000) });
const Q = "Nos casamos en Zaragoza en mayo, ¿cómo hacéis la invitación por WhatsApp para que los invitados confirmen asistencia?";

test("puntuación: pregunta de boda en España reciente pasa; promoción, antigua o sin señal de España no", () => {
  assert.equal(scorePost(post(Q), NOW).eligible, true);
  assert.equal(scorePost(post(Q, 24 * 8), NOW).reason, "antiguo");
  assert.equal(scorePost(post("Sorteo de invitaciones de boda en Madrid, ¿participas?"), NOW).reason, "promocional");
  assert.equal(scorePost(post("How do you send wedding invitations by WhatsApp?"), NOW).eligible, false);
});

test("minimiza correos, teléfonos, enlaces y menciones y recorta a 500", () => {
  const m = minimize("Escribidme a ana@correo.es o al 600 123 456, mirad https://x.com y a @ana.boda " + "a".repeat(600));
  assert.doesNotMatch(m, /ana@|600 123|https|@ana/);
  assert.ok(m.length <= 500);
});

test("selección: mejores primero, máximo 3 por fuente y huecos del día", () => {
  const c = (id: string, kind: string, score: number) => ({ id, sourceKind: kind, score, detectedAt: NOW });
  const sel = selectCards([c("a", "youtube", 90), c("b", "youtube", 85), c("c", "youtube", 80), c("d", "youtube", 99), c("e", "telegram", 70)], 10);
  assert.deepEqual(sel.map((x) => x.id), ["d", "a", "b", "e"]);
  assert.equal(selectCards([c("a", "youtube", 90), c("e", "telegram", 70)], 1).length, 1);
});

test("hmac estable por clave y madrid() en hora local", () => {
  const key = hmacKey(join(mkdtempSync(join(tmpdir(), "com-")), "k"));
  assert.equal(threadKey("youtube", "x", key), threadKey("youtube", "x", key));
  assert.notEqual(threadKey("youtube", "x", key), threadKey("telegram", "x", key));
  assert.deepEqual(madrid(NOW), { day: "2026-11-23", hour: 9 });
  assert.match(campaignUrl("/invitacion-digital-boda", "youtube", "abc"), /utm_medium=community&utm_campaign=primeras_parejas&utm_content=abc/);
});

test("validación de borradores: sin precios, enlaces solo de campaña y divulgación obligatoria", () => {
  const url = campaignUrl("/invitacion-digital-boda", "youtube", "k1");
  const cands: DraftInput[] = [{ id: "p1", source: "youtube", excerpt: Q, campaignUrl: url }];
  const long = "Lo más cómodo es mandar un único enlace por WhatsApp con la fecha, el horario y cómo llegar, y pedir que cada invitado confirme ahí con su menú y alergias. Así no persigues a nadie por mensajes sueltos.";
  const ok = (text: string) => validateDrafts({ results: [{ id: "p1", decision: "draft", text }] }, cands);
  assert.equal(ok(long).length, 1);
  assert.equal(ok(`${long} Soy el creador de miwebdeboda: ${url}`)[0].mentionsSite, true);
  assert.equal(ok(`${long} Mirad miwebdeboda: ${url}`).length, 0, "sin divulgación");
  assert.equal(ok(`${long} Soy el creador de miwebdeboda: https://otra.web`).length, 0, "enlace no autorizado");
  assert.equal(ok(`${long} Cuesta 49 €.`).length, 0, "precio");
  assert.equal(validateDrafts({ results: [{ id: "otro", decision: "draft", text: long }] }, cands).length, 0);
});

// --- tick contra la BD de tests ---
const key = hmacKey(join(mkdtempSync(join(tmpdir(), "com-")), "k"));
const fakeSource = (posts: RawPost[]): Source => ({ kind: "youtube", everyMs: 0, configured: () => true, fetch: async () => posts });
const DRAFT = "Lo más cómodo es mandar un único enlace por WhatsApp con la fecha, el horario y cómo llegar, y pedir que cada invitado confirme ahí con su menú y alergias. Así no persigues a nadie por mensajes sueltos.";
let lastDay: string | null = null;
function deps(posts: RawPost[], runner: TickDeps["runner"] = async (r) => ({ results: JSON.parse(r.user.split("<CANDIDATES>\n")[1].split("\n</CANDIDATES>")[0]).map((c: { id: string }) => ({ id: c.id, decision: "draft", text: DRAFT })) }), now = NOW): TickDeps {
  return { db: prisma, now: () => now, env: {}, sources: [fakeSource(posts)], key, runner, lastDraftDay: () => lastDay, setLastDraftDay: (d) => (lastDay = d) };
}

beforeEach(async () => {
  lastDay = null;
  await prisma.communityCard.deleteMany();
  await prisma.communityPost.deleteMany();
  await prisma.communityDedup.deleteMany();
  await prisma.communityDailyResult.deleteMany();
  await prisma.communityControl.upsert({ where: { id: "global" }, create: { id: "global", enabled: true }, update: { enabled: true } });
  await prisma.communitySource.upsert({ where: { kind: "youtube" }, create: { kind: "youtube", enabled: true, status: "ready" }, update: { enabled: true, status: "ready", lastAttemptAt: null } });
});

test("tick: guarda candidatas, crea tarjetas una vez al día y nunca repite un hilo", async () => {
  const r = await tick(deps([post(Q, 2, "a"), post(Q, 3, "b"), post("Hola", 1, "c")]));
  assert.equal(r.stored, 2);
  assert.equal(r.cards, 2);
  const cards = await prisma.communityCard.findMany();
  assert.equal(cards.length, 2);
  assert.ok(cards.every((c) => c.dayMadrid === "2026-11-23" && c.status === "pending"));
  // mismo hilo otra vez: no entra; y no hay segunda redacción ese día
  await prisma.communitySource.update({ where: { kind: "youtube" }, data: { lastAttemptAt: null } });
  const r2 = await tick(deps([post(Q, 1, "a"), post(Q, 1, "d")]));
  assert.equal(r2.stored, 1);
  assert.equal(r2.cards, 0);
  assert.equal(await prisma.communityDedup.count(), 4);
});

test("tick: apagado no lee ni redacta; aplazado por cupo no gasta el día", async () => {
  await prisma.communityControl.update({ where: { id: "global" }, data: { enabled: false } });
  assert.equal((await tick(deps([post(Q, 2, "a")]))).off, true);
  assert.equal(await prisma.communityPost.count(), 0);
  await prisma.communityControl.update({ where: { id: "global" }, data: { enabled: true } });
  const r = await tick(deps([post(Q, 2, "a")], async () => { throw new EditorialDeferred("busy", NOW, "Órbita ocupada"); }));
  assert.ok(r.deferred);
  assert.equal(lastDay, null);
  assert.equal(await prisma.communityCard.count(), 0);
});

test("tick: antes de las 07:00 no redacta y lo caducado se borra dejando la huella", async () => {
  const early = new Date("2026-11-23T04:00:00Z");
  const r = await tick(deps([post(Q, 2, "a")], undefined, early));
  assert.equal(r.cards, 0);
  assert.equal(await prisma.communityPost.count(), 1);
  const later = new Date(early.getTime() + 8 * 86_400_000);
  await tick(deps([], undefined, later));
  assert.equal(await prisma.communityPost.count(), 0);
  const d = await prisma.communityDedup.findFirst();
  assert.equal(d?.disposition, "expired");
});

test("tick: lo que rechaza la redacción no se vuelve a proponer", async () => {
  await tick(deps([post(Q, 2, "a")], async () => ({ results: [{ id: "x", decision: "reject", text: "" }] })));
  const p = await prisma.communityPost.findFirst();
  assert.equal(p?.eligible, false);
  assert.equal(p?.reason, "rechazada_redaccion");
});

test("telegram: solo grupos públicos de bodas y enlace al mensaje", () => {
  const gs = weddingGroups([{ id: "1", username: "novias2027es", title: "Novias 2027 España" }, { id: "2", username: null, title: "Novias privadas 2027" }, { id: "3", username: "futbol", title: "Fútbol" }]);
  assert.deepEqual(gs.map((g) => g.id), ["1"]);
  const p = telegramPosts(gs[0], [{ id: 42, text: Q, date: NOW.getTime() / 1000 }, { id: 43, text: "ok", date: 0 }]);
  assert.equal(p.length, 1);
  assert.equal(p[0].url, "https://t.me/novias2027es/42");
  assert.equal(p[0].canonicalId, "1:42");
});

test("facebook por correo: enlace limpio (también envuelto en /nd/) y un único post por correo", () => {
  assert.deepEqual(facebookGroupPost("https://www.facebook.com/groups/novias2027/posts/123456/?ref=mail"), { canonicalId: "novias2027/123456", url: "https://www.facebook.com/groups/novias2027/posts/123456/" });
  assert.equal(facebookGroupPost("https://www.facebook.com/nd/?groups%2F99%2Fpermalink%2F777%2F&aref=1")?.canonicalId, "99/777");
  assert.equal(facebookGroupPost("https://evil.com/groups/1/posts/2"), null);
  const one = facebookPostsFromMail({ text: `Ana ha publicado en Novias 2027\n${Q}\nVer publicación`, html: '<a href="https://www.facebook.com/groups/1/posts/2/">Ver</a>', date: NOW });
  assert.equal(one.length, 1);
  assert.match(one[0].text, /WhatsApp/);
  assert.doesNotMatch(one[0].text, /Ver publicación/);
  const two = facebookPostsFromMail({ text: Q, html: '<a href="https://www.facebook.com/groups/1/posts/2/">a</a><a href="https://www.facebook.com/groups/1/posts/3/">b</a>', date: NOW });
  assert.equal(two.length, 0);
});
