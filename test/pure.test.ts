import assert from "node:assert/strict";
import test from "node:test";
import {
  decideRun,
  extractSummary,
  isManagedPackage,
  isRepoCandidate,
} from "../src/pure.ts";

test("repo candidates require the expected shape and an eligible name", () => {
  const repo = { name: "pi-example", isArchived: false, url: "https://example.com" };
  assert.equal(isRepoCandidate(repo), true);
  for (const value of [
    null,
    [],
    "pi-example",
    {},
    { ...repo, name: 42 },
    { ...repo, name: "other" },
    { ...repo, name: "pi-evergreen" },
    { ...repo, isArchived: true },
    { ...repo, isArchived: "false" },
    { name: repo.name, isArchived: false },
    { ...repo, url: null },
  ]) {
    assert.equal(isRepoCandidate(value), false);
  }
});

test("managed packages match any Pi marker or supported dependency field", () => {
  for (const pi of [null, false, "", {}, undefined]) {
    assert.equal(isManagedPackage({ pi }), true);
  }
  assert.equal(isManagedPackage({ keywords: ["other", "pi-package"] }), true);
  for (const field of [
    "dependencies",
    "devDependencies",
    "peerDependencies",
    "optionalDependencies",
  ]) {
    for (const scope of ["earendil-works", "mariozechner"]) {
      assert.equal(isManagedPackage({ [field]: { [`@${scope}/pi-core`]: "*" } }), true);
    }
  }
  for (const value of [
    null,
    [],
    {},
    { keywords: "pi-package" },
    { keywords: ["pi-package-other"] },
    { dependencies: null },
    { dependencies: ["@earendil-works/pi-core"] },
    { dependencies: { "@other/pi-core": "*", "@earendil-works/other": "*" } },
  ]) {
    assert.equal(isManagedPackage(value), false);
  }
});

test("summary extraction omits its heading and stops at level one or two", () => {
  for (const heading of ["# Next", "## Next"]) {
    assert.equal(
      extractSummary(`# Intro\n\n## Summary\n\n- Intent\n### Detail\nMore\n\n${heading}\nExcluded`),
      "- Intent\n### Detail\nMore",
    );
  }
  assert.equal(extractSummary("## Summary\r\n\r\n- Intent\r\n"), "- Intent");
  assert.equal(extractSummary("## Summary\n## Next\nText"), "");
  assert.equal(extractSummary("# Summary\nText"), "");
  assert.equal(extractSummary("No summary"), "");
});

test("run decisions distinguish baseline, version changes, and monthly updates", () => {
  assert.deepEqual(decideRun({}, "1.0", "2026-10"), {
    baseline: true, run: false, depsUpdate: true,
  });
  assert.deepEqual(decideRun({ lastDepsUpdateMonth: "2026-10" }, "1.0", "2026-10"), {
    baseline: true, run: false, depsUpdate: false,
  });
  const state = { lastPiVersion: "1.0", lastDepsUpdateMonth: "2026-10" };
  assert.deepEqual(decideRun(state, "1.0", "2026-10"), {
    baseline: false, run: false, depsUpdate: false,
  });
  assert.deepEqual(decideRun(state, "1.1", "2026-10"), {
    baseline: false, run: true, depsUpdate: false,
  });
  assert.deepEqual(decideRun(state, "1.0", "2026-11"), {
    baseline: false, run: true, depsUpdate: true,
  });
  assert.deepEqual(decideRun(state, "1.1", "2026-11"), {
    baseline: false, run: true, depsUpdate: true,
  });
  assert.deepEqual(decideRun({ lastPiVersion: "1.0" }, "1.0", "2026-10"), {
    baseline: false, run: true, depsUpdate: true,
  });
  assert.deepEqual(state, { lastPiVersion: "1.0", lastDepsUpdateMonth: "2026-10" });
});
