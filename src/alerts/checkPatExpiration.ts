// src/alerts/checkPatExpiration.ts
export function checkPatExpiration(headers: Headers): { daysRemaining: number } | null {
  const raw = headers.get("github-authentication-token-expiration");
  if (!raw) return null;

  const expiresAt = new Date(raw);
  if (Number.isNaN(expiresAt.getTime())) return null;

  const daysRemaining = Math.round((expiresAt.getTime() - Date.now()) / (24 * 60 * 60 * 1000));
  return { daysRemaining };
}
