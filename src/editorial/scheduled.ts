// src/editorial/scheduled.ts
// Revisión previa a la publicación: los artículos ya escritos y programados (publishedAt futuro en
// src/lib/blog/posts.ts de main) se evalúan con mucha antelación, el primero el que antes sale.
// Si la IA editorial no los aprueba y queda margen, se abre una corrección (content-prepublish-fix)
// que tiene que fusionarse antes de PREPUBLISH_FREEZE_DAYS días de su publicación. Sin margen, el
// artículo sale como estaba y, ya publicado, entra en el circuito normal de mejoras.
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { contentFromSource } from "./article";

const DAY = 86_400_000;
/** Solo se abre corrección si faltan al menos estos días (tres rondas de corrección y CI holgadas). */
export const PREPUBLISH_MIN_LEAD_DAYS = 21;
/** La corrección no se fusiona si el artículo sale en menos de estos días. */
export const PREPUBLISH_FREEZE_DAYS = 3;

export interface ScheduledArticle {
  slug: string; // categoría/nombre, como el resto de la IA editorial
  url: string;
  publishedAt: string; // YYYY-MM-DD
  contentPath: string; // src/lib/blog/content/<cat>/<nombre>.ts
}

/** Entradas de posts.ts: slug, categoría, fecha y fichero del contenido (por el import). */
export function parsePosts(postsSource: string): { name: string; category: string; publishedAt: string; contentPath: string }[] {
  const imports = new Map<string, string>();
  for (const m of postsSource.matchAll(/import\s+([\p{L}\w$]+)\s+from\s+"\.\/content\/([^"]+)";/gu)) imports.set(m[1], `src/lib/blog/content/${m[2]}.ts`);
  const out: { name: string; category: string; publishedAt: string; contentPath: string }[] = [];
  for (const block of postsSource.split(/\n\s*\{\s*\n/).slice(1)) {
    const slug = /\bslug:\s*"([^"]+)"/.exec(block)?.[1];
    const content = /(?:^|\s)content:\s*([\p{L}\w$]+)/u.exec(block)?.[1];
    const category = /\bcategorySlug:\s*"([^"]+)"/.exec(block)?.[1];
    const publishedAt = /\bpublishedAt:\s*"(\d{4}-\d{2}-\d{2})/.exec(block)?.[1];
    const contentPath = content ? imports.get(content) : undefined;
    if (slug && category && publishedAt && contentPath) out.push({ name: slug, category, publishedAt, contentPath });
  }
  return out;
}

/** Día de hoy en Madrid (YYYY-MM-DD). */
const madridToday = (now: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Madrid", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);

/** Programados (fecha posterior a hoy), del más próximo al más lejano. */
export function scheduledFrom(postsSource: string, siteBase: string, now: Date): ScheduledArticle[] {
  const today = madridToday(now);
  return parsePosts(postsSource)
    .filter((p) => p.publishedAt > today)
    .sort((a, b) => a.publishedAt.localeCompare(b.publishedAt) || a.name.localeCompare(b.name))
    .map((p) => {
      const slug = p.contentPath.replace(/^src\/lib\/blog\/content\//, "").replace(/\.ts$/, "");
      return { slug, url: `${siteBase}/blog/${slug}`, publishedAt: p.publishedAt, contentPath: p.contentPath };
    });
}

/** Días que faltan para que salga (en días enteros de calendario). */
export function daysUntil(publishedAt: string, now: Date): number {
  return Math.floor((Date.parse(`${publishedAt}T00:00:00Z`) - Date.parse(`${madridToday(now)}T00:00:00Z`)) / DAY);
}

export interface AppRepo {
  read: (path: string) => string | null;
}

const APP_DIR = () => process.env.WEDDING_INVITE_2_DIR ?? join(__dirname, "..", "..", "..", "wedding-invite-2");

/** Lectura de ficheros de origin/main del repo de la app (con un fetch por pasada). */
export function appMainRepo(): AppRepo {
  execFileSync("git", ["-C", APP_DIR(), "fetch", "-q", "origin", "main"], { stdio: "ignore", timeout: 120_000 });
  return {
    read: (path) => {
      try {
        return execFileSync("git", ["-C", APP_DIR(), "show", `origin/main:${path}`], { encoding: "utf8", maxBuffer: 8_000_000 });
      } catch {
        return null;
      }
    },
  };
}

/** Programados con su texto (markdown) listo para evaluar. */
export function loadScheduled(repo: AppRepo, siteBase: string, now: Date): (ScheduledArticle & { md: string })[] {
  const posts = repo.read("src/lib/blog/posts.ts");
  if (!posts) return [];
  const out: (ScheduledArticle & { md: string })[] = [];
  for (const a of scheduledFrom(posts, siteBase, now)) {
    const src = repo.read(a.contentPath);
    const md = src && contentFromSource(src);
    if (md) out.push({ ...a, md });
  }
  return out;
}
