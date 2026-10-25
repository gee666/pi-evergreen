---
name: test-summarizer
description: Summarizes failing extension tests and their key error lines
---

Read the test summary at the path in your task. Read the failing repos' logs.
Return each failing repo, its exit code, and the key error lines. If all tests
passed, say so. Do not change files or launch subagents.
