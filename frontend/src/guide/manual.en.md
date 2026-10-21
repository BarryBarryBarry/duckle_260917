# Otter ETL agent User Guide

> This guide ships with the app. If something goes wrong, start with [Troubleshooting](#4-troubleshooting).

## 1. What is Otter ETL agent

**Otter ETL agent** is a desktop data integration (ETL) tool that runs on your own machine. It **reads** data from one place, **transforms** it, and **writes** it somewhere else. For example:

- Migrate an orders table from a legacy database to a new system, mapping, cleansing and validating fields on the way;
- Merge and aggregate several CSV / Excel / Parquet files and load the result into a database;
- Extract data from a database on a schedule and produce report files.

One such data job is called a **pipeline**. A pipeline is made of **nodes** joined by **edges**:

```
Source (read) → Transform (process) → Sink (write)
```

There are two ways to build one:

| Approach | Best for | What it means |
|---|---|---|
| **Agent** | Getting results fast without learning every component | Describe what you need in plain language; the Agent creates, validates and runs the pipeline |
| **Manual** | Fine control over every step | Drag components onto the canvas, wire them and fill in their properties |

Both produce the same pipeline file, so you can switch at any time. Letting the Agent draft a pipeline and then fine-tuning it by hand is the most common workflow.

Key concepts:

- **Workspace**: an ordinary folder on your machine holding pipelines, connections, context variables and documents. Everything is plain JSON, easy to back up or put under version control.
- **Engine**: pipelines compile to SQL and run locally on the built-in DuckDB engine. Your data is never uploaded to a cloud service.
- **Connection**: saved database connection details (host, account and so on) that several pipelines can reuse. Passwords are stored encrypted inside the workspace.

## 2. Main features

### 2.1 The window at a glance

| Area | Where | What it does |
|---|---|---|
| Top bar | Very top | Settings (gear icon), UI language, account, light / dark theme |
| Pipeline tab bar | Below the top bar | Open pipeline tabs, **+** new pipeline, **Run**, Save, Validate, More (**…**) |
| Editor views | Below the tab bar | **Canvas** (build), **Plan** (generated SQL), **Run** (the current run), **History** (past runs) |
| Left sidebar | Left | **Project**: pipelines, connections, contexts and more in the workspace; **Components**: everything you can drag onto the canvas |
| Canvas | Center | Place nodes and draw edges; zoom, Auto-layout and layout-direction buttons sit in the bottom-left corner, a minimap in the bottom-right |
| Right tool strip | Far right | **Properties** (edit the selected node), **Agent** (AI assistant), **Guide** (this guide) |
| Bottom panel | Bottom | **Problems** (validation results), **Output** (rows and timing per node), **Console** (execution log) |

![Window overview (numbers map to the table below)](./images/overview.webp)

> The numbered callouts map to the table above: 1 Top bar, 2 Pipeline tab bar, 3 Editor views, 4 Left sidebar, 5 Canvas, 6 Right tool strip, 7 Bottom panel.

### 2.2 Core features

- **Sources (read)**: files such as CSV, Excel, JSON and Parquet; relational databases such as MySQL, PostgreSQL, SQL Server, Oracle and SQLite; plus cloud warehouses, object storage, REST APIs and hundreds more.
- **Transforms (process)**: filter, derived columns, type casts, deduplication, sorting, group-by aggregation, joins, unions, pivots, window functions, string and date handling, and more. The **visual mapper** handles multi-table joins and field mapping without writing SQL.
- **Data quality**: not-null, range, regex and uniqueness checks. Rows that fail come out of the **reject** port so you can review them separately.
- **Sinks (write)**: write to files or databases with overwrite, append, Truncate + insert, or Upsert (update by key) write modes.
- **Control flow**: conditional split, parallel branches, loops, calling other pipelines, retry and try / catch.
- **Custom code**: write SQL or scripts directly in a node for logic no component covers.
- **Agent**: describe what you need in plain language and the Agent builds, validates, runs and troubleshoots the pipeline. See [3.1](#31-build-a-pipeline-with-the-agent).
- **Preview and transparent SQL**: every node can preview sample rows; the **Plan** view shows the SQL the whole pipeline compiles to, which you can copy or export from the **…** menu.
- **Validation and run history**: required fields, dangling edges and cycles are checked as you edit; every run is recorded in **History**.
- **Scheduling and deployment**: from Home you can schedule a pipeline (Schedules), run several pipelines in order (Plans), or package one for a server (Build and Deploy).

## 3. Quick start

### Before you begin

1. **Choose a workspace**: on first launch, pick a folder as your workspace. If you already have one, pick the same folder and its contents load automatically.
2. **Install the engine**: first use asks to download the DuckDB engine; click **Install** when prompted.
3. **Prepare your data**: make sure you can reach the source and target databases (network, account permissions), or have the files you want to process ready.

### 3.1 Build a pipeline with the Agent

**Step 1: Configure a model (once)**

1. Click the **gear icon** in the top bar to open Settings, then expand **AI assistant**.
2. Choose **External OpenAI-compatible endpoint** and fill in:
   - **Base URL**: the model service address, for example `https://api.openai.com`;
   - **Model**: the model name. Click **Fetch models** to list what the service offers and pick one;
   - **API key**: your model service key.
3. Click **Save**.

> Settings are saved per workspace. Configure them again after switching to a new workspace.

**Step 2: Open the Agent**

1. Click **Agent** in the right tool strip (a workspace must be open).
2. First use asks you to **Install Agent** (about a 75 MB download). Click **Install** and wait for it to finish.

**Step 3: Pick data sources**

1. Click the **Data sources** button below the input box and choose a database type.
2. Pick a saved connection, or click **+ New connection** and enter the host, port, database and credentials. Click **Test connection** to confirm it works, then **Save and use**.
3. Choose what the connection is for: **Source database** (the Agent reads from it), **Target database** (the Agent writes to it) or **Both**.

![Pick data sources: 1 click the Data sources button below the input, 2 choose a database type from the list](./images/agent-datasource.webp)

> Connection details are sent to the Agent with your message, but **passwords are never sent to the model**.

**Step 4: Describe what you need and send**

State the requirement clearly in the input box, for example:

```
Migrate the source table sales.orders to the target table dw.ods_orders:
1. Only orders from 2024 onwards;
2. Rename cust_no to customer_id and round amounts to two decimals;
3. Where order_id is duplicated, keep only the latest row;
4. After loading, check that both sides have the same row count.
```

Tips for a good request:

- Give the full names of the **source** and **target** tables;
- Spell out **filters, field mappings and calculation rules**;
- Say how to **write** the data (overwrite / append / upsert by key);
- If you have a migration spec, attach it with the **+** button next to the input (executable files are not accepted);
- Type `/` to run a skill written for this workspace.

**Step 5: Follow progress and open the result**

1. The Agent shows its **Reasoning** and **Progress**, for example create pipeline → validate pipeline → run pipeline.
2. When it finishes, click **Open** on the result card to open the generated pipeline on the canvas.
3. Check the nodes and edges on the canvas; click a node to review its configuration in **Properties** and its sample rows in **Preview**.
4. If the result is not quite right, keep going in the chat, for example "write to the target table in append mode". The Agent edits the same pipeline.

> Click **Stop** at any time while the Agent is working. If it reports that its output was cut off, send "continue" and it carries on.

### 3.2 Build a pipeline by hand

**Step 1: Create a pipeline**

Click **+** in the tab bar (or right-click Pipelines in the **Project** sidebar → **New pipeline…**), enter a name and pick a template:

| Template | What it gives you |
|---|---|
| Empty | A blank canvas |
| Sample · CSV → Filter → Parquet | A pre-wired three-node example for learning the editor |
| Sample · Join + Group By | Two CSVs joined and aggregated |
| From SQL | Paste a SELECT statement and get the matching nodes |

![Create a new pipeline: enter a name and choose a template](./images/new-pipeline.webp)

> Pipeline names are converted to lowercase letters, digits, underscores and hyphens.

**Step 2: Add a source**

1. In the left sidebar, switch to **Components** and expand **Sources**, or type a keyword (such as `mysql` or `csv`) in the search box.
2. Drag the component onto the canvas, click the node and fill in **Properties → Basic** on the right:
   - Files: the file path;
   - Databases: pick a saved **connection**, then enter a table name or a query.
3. On the **Schema** tab, click **Autodetect from source** to read columns and types; check sample rows on the **Preview** tab.

![Components panel: search and add a source component](./images/palette.webp)
![Schema tab: autodetect columns and types from the source](./images/autodetect.webp)
![Preview tab: inspect sample rows](./images/preview.webp)

> No saved connection yet? Create one from the **Data sources** menu in the Agent input; it then appears here.

**Step 3: Add transforms and checks**

1. Drag the components you need from **Transforms**, such as filter, aggregate or join.
2. **Wire them**: drag from the output port on the right of the upstream node to the input port on the left of the downstream node.
3. Select a node and configure it in **Properties**. For multi-table joins or complex mappings, click **Open visual mapper**.
4. To validate data, drag in a check from **Data Quality**. Failing rows leave through the **reject** port; connect a sink to it to keep them for review.

![Canvas wiring: connect an upstream output port to a downstream input port](./images/connect.webp)

**Step 4: Add a sink**

Drag the target component from **Sinks**, connect it to the last transform, fill in the target path or table in its properties, and choose a write mode (overwrite / append / Truncate + insert / Upsert).

**Step 5: Validate, run, save**

1. Click **Validate** (check-mark icon) in the tab bar and fix everything listed under **Problems** in the bottom panel.
2. Click **Run** (`F5`). Nodes light up in execution order and show their row counts; click **Stop** (`F6`) to cancel a run.
3. See rows written and time taken per node under **Output**, and the detailed log under **Console**.
4. Click **Save** (`Ctrl+S`).

![After a successful run: review per-node rows and timing in Output](./images/run-result.webp)

> Tip: **Auto-layout** in the canvas's bottom-left corner tidies the canvas in one click.

## 4. Troubleshooting

### 4.1 How to narrow a problem down

When something goes wrong, work through these in order:

1. **Node status**: a node that errored is marked "Failed"; an incompletely configured node says "Required fields missing".
2. **Bottom panel**:
   - **Problems**: configuration errors such as empty required fields, dangling edges or cycles;
   - **Console**: the detailed runtime error; the last few lines usually name the cause;
   - **Output**: row counts per node, showing where rows were lost or multiplied.
3. **The data**: select a node and look at **Properties → Preview**, walking upstream one node at a time.
4. **The SQL**: switch to the **Plan** view to see the generated SQL, and run it in your database client to check it on its own.
5. **Ask the Agent**: send it the error, for example "running xxx failed, please investigate". The Agent can read run logs, check a node's SQL and suggest fixes.

![Configuration issue example: the Problems panel reports missing required fields and validation errors](./images/problems.webp)
![Run failure example: failed node state plus Console logs help locate the root cause](./images/run-failed.webp)

### 4.2 Common problems

**Running pipelines**

| Symptom | Likely cause | Fix |
|---|---|---|
| A node says "Required fields missing" | A required property is empty | Click the node and complete the required fields in **Properties → Basic** |
| Run reports DuckDB not found | The first-run engine install was skipped or interrupted | Restart the app and install the DuckDB engine when prompted |
| Database connection fails or times out | Wrong host, port or credentials, or no network route | Edit the connection under **Data sources** and click **Test connection**; check firewall and VPN |
| Login rejected | Wrong or expired password | Re-enter the credentials in the prompt; they are stored only in this workspace |
| Row counts are not what you expect | Filter, join or deduplication rules are off | Find the node where the count changes under **Output**, then check its conditions with **Preview** and **Plan** |
| Garbled characters | The source file is not UTF-8 | Set the correct encoding in the file source's properties |
| Column type errors | The detected type does not match the actual data | Change the column type on the **Schema** tab, or add a type cast upstream |
| External services unreachable on a corporate network | Internet access goes through a proxy | Configure it under **Settings → HTTP / HTTPS proxy** |

**The Agent**

| Symptom | Fix |
|---|---|
| The Agent button is greyed out | Open a workspace first |
| "No model configured" | Configure an External OpenAI-compatible endpoint in Settings as in [3.1 Step 1](#31-build-a-pipeline-with-the-agent) |
| The API key is rejected | Check that the key in **Settings → AI assistant** is correct and has not expired |
| Quota used up | Top up or switch to another model, then send "continue" |
| Rate limited | Wait a moment and send again |
| Output was cut off | Send "continue"; for large jobs, ask the Agent for a runnable skeleton first and add nodes step by step |
| Runtime incomplete, or the process exited unexpectedly | Close and reopen the Agent panel; reinstall the Agent if needed |
| The generated pipeline is not what you wanted | Give more specific instructions in the chat, or open it and adjust by hand |

### 4.3 Still stuck

Contact support with:

1. A screenshot of the problem;
2. The full error from the **Console** in the bottom panel;
3. The pipeline involved (export it from **…** → **Export as .duckle.json**);
4. The steps: what you did, what you expected, and what actually happened.
