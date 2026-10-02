---
name: duckle-etl
description: Build, validate, run and debug Duckle ETL pipelines with the duckle MCP tools. Use when the user asks to create, check, run or fix a pipeline.
---

# Duckle ETL workflow

1. Understand the data: list_connections, and the tables in the [Duckle Context].
2. Pick components: list_components, then get_component_schema for each one you use.
3. Build: create_pipeline with `workspace`, a `name`, the pipeline object
   (nodes + edges) and, when the user names a project folder, `folder`.
   Database nodes reference a saved connection via `connectionRef`.
4. Check: validate_pipeline, then check_node_sql for SQL nodes. Fix with
   update_pipeline and check again.
5. Run: run_pipeline with `workspace` and `path` = `<workspace>/pipelines/<id>.json`.
   The user confirms first.
6. On failure: read_run_logs (`pipelineName` + `workspace`), find the failing node, update_pipeline, run again.
   For a long investigation delegate to duckle_subagent with agent `run-debugger`.
