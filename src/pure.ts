export type State = {
  lastPiVersion?: string;
  lastDepsUpdateMonth?: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isRepoCandidate(
  value: unknown,
): value is { name: string; isArchived: boolean; url: string } {
  return (
    isRecord(value) &&
    typeof value.name === "string" &&
    typeof value.isArchived === "boolean" &&
    typeof value.url === "string" &&
    value.name.startsWith("pi-") &&
    value.name !== "pi-evergreen" &&
    !value.isArchived
  );
}

export function isManagedPackage(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (Object.hasOwn(value, "pi")) return true;
  if (Array.isArray(value.keywords) && value.keywords.includes("pi-package")) {
    return true;
  }
  return [
    "dependencies",
    "devDependencies",
    "peerDependencies",
    "optionalDependencies",
  ].some((field) => {
    const dependencies = value[field];
    return (
      isRecord(dependencies) &&
      Object.keys(dependencies).some((name) =>
        /^@(earendil-works|mariozechner)\/pi-/.test(name),
      )
    );
  });
}

export function extractSummary(markdown: string): string {
  const lines = markdown.split(/\r?\n/);
  const start = lines.findIndex((line) => /^##[ \t]+Summary[ \t]*$/.test(line));
  if (start === -1) return "";
  const body = lines.slice(start + 1);
  const end = body.findIndex((line) => /^#{1,2}(?:[ \t]+|$)/.test(line));
  return (end === -1 ? body : body.slice(0, end)).join("\n").trim();
}

export function decideRun(
  state: State,
  version: string,
  month: string,
): { baseline: boolean; run: boolean; depsUpdate: boolean } {
  const baseline = !state.lastPiVersion;
  const depsUpdate = state.lastDepsUpdateMonth !== month;
  return {
    baseline,
    run: !baseline && (state.lastPiVersion !== version || depsUpdate),
    depsUpdate,
  };
}
