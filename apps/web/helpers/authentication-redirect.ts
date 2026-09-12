import { isValidNextPath } from "@plane/utils";

/** Keep the existing query URL intact, but only allow a local redirect destination. */
export function getSafeNextPath(value: string | null | undefined): string | undefined {
  if (!value || !isValidNextPath(value)) return undefined;
  const path = value.trim();
  if ([...path].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) return undefined;
  const base = "https://plane.invalid";
  if (new URL(path, base).origin !== base) return undefined;
  return path;
}

export function isInvitationPath(value: string | null | undefined): boolean {
  const destination = getSafeNextPath(value);
  if (!destination) return false;
  return new URL(destination, "https://plane.invalid").pathname.replace(/\/$/, "") === "/workspace-invitations";
}

export function getOAuthNextPathQuery(nextPath: string | null | undefined): string {
  const destination = getSafeNextPath(nextPath);
  return destination ? `?next_path=${encodeURIComponent(destination)}` : "";
}

export function getOnboardingPath(nextPath: string | null | undefined): string {
  const destination = getSafeNextPath(nextPath);
  return destination ? `/onboarding?next_path=${encodeURIComponent(destination)}` : "/onboarding";
}

export function getSignInPath(pathname: string | null, query: string): string {
  const destination = getSafeNextPath(pathname ? `${pathname}${query ? `?${query}` : ""}` : undefined);
  return destination ? `/?next_path=${encodeURIComponent(destination)}` : "/";
}
