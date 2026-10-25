Maintain the initialized extensions listed in the manifest.

Run directory: {{runDir}}
Test summary: {{testSummary}}
Manifest: {{manifest}}
Previous Pi version: {{lastVersion}}
Current Pi version: {{newVersion}}
Changelog: {{changelog}}
Dependency-update month: {{depsUpdate}}
Report destination: {{reportPath}}

Read the changelog entries between the previous and current versions. If they
are equal, there are no new entries. Launch exactly ONE `test-summarizer` agent
with intelligence `junior`, the test summary path, and max_subagents_allowed 0.
Do not read full test logs yourself. Read the manifest.

Select repos whose tests fail or whose intent could plausibly be affected or
helped by a changelog change. For example, auth changes belong with auth-related
extensions. In a dependency-update month, check `npm outdated` in each listed
repo and also select every repo with outdated npm dependencies.

Launch one `maintainer` agent per selected repo, all at once, with intelligence
`worker`. Pass only repo-specific details: absolute repo path, reasons for
selection, relevant changelog lines, that repo's test result and key errors,
dependency-update flag, and any pull failure. Set max_subagents_allowed to 0,
or 1 only when a reviewer is genuinely needed for risky work.

Wait for every maintainer to complete. Completions wake you; do not poll or sleep.
Then write a short repo-to-outcome report to the report destination and finish.

Pull failures to pass to the affected maintainers:
{{pullFailures}}
