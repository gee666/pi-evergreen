Maintain the initialized extensions listed in the manifest.

Run directory: {{runDir}}
Test summary: {{testSummary}}
Manifest: {{manifest}}
Previous Pi version: {{lastVersion}}
Current Pi version: {{newVersion}}
Changelog: {{changelog}}
Dependency-update month: {{depsUpdate}}
Worker instructions: {{workerPrompt}}
Shared rules: {{rulesPath}}
Report destination: {{reportPath}}

Read the changelog entries between the previous and current versions. If they
are equal, there are no new entries. Launch exactly ONE `junior` subagent to
read the test summary and logs and return failing repos with key error lines.
Do not read full test logs yourself. Read the manifest.

Select repos whose tests fail or whose intent could plausibly be affected or
helped by a changelog change. For example, auth changes belong with auth-related
extensions. In a dependency-update month, check `npm outdated` in each listed
repo and also select every repo with outdated npm dependencies.

Launch one `worker` subagent per selected repo, all at once. Give each its
absolute repo path, reasons for selection, relevant changelog lines, that repo's
test summary and key errors, and whether dependencies need updating. Tell it to
read and follow the worker instructions above. Append the shared rules to every
subagent task, including the junior's. Set max_subagents_allowed to 0 for the
junior; allow a worker one reviewer only when genuinely risky, otherwise 0.

Wait for every worker to complete. Completions wake you; do not poll or sleep.
Then write a short repo-to-outcome report to the report destination and finish.

Pull failures to pass to the affected workers:
{{pullFailures}}
