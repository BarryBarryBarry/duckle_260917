# Visual Execution Controls

Duckle lets you manage execution engines, monitor pipeline performance, and audit data lineage directly from the user interface.

---

## 1. Running and Controlling Pipelines

The top toolbar contains your primary execution controls:

* **Engine Selector Dropdown**: Located next to the Run button. Switch between the default **DuckDB** execution engine and the optional **SlothDB** engine.
* **Run Button (Play Icon)**: Compiles the visual canvas on your screen and starts execution.
* **Stop Button (Red Pause/Square Icon)**: Immediately interrupts execution. Click this to cancel long runs; the application stops active processes and releases memory.

---

## 2. Real-Time Canvas Feedback

When you click **Run**, the visual canvas provides live feedback:

* **Node Status Colors**:
  * **Spinning Green Border**: The node is currently compiling or running.
  * **Solid Green Border**: The node completed successfully.
  * **Red Border**: The node encountered an error. Click the node and open the **Console Tab** in the Bottom Panel to read the error logs.
* **Live Counters**: Row count badges display under connection edges, streaming the number of records moving from node to node.
* **Step Numbers**: When a run finishes, each node that ran shows the step it ran at on its icon - the engine's real execution order. The numbers belong to that run: editing, moving, adding or deleting nodes does not change them, and only the pipeline's next run (Live-mode previews excepted) replaces them. A node edited since the run keeps its number, greyed, until then.

---

## 3. The Bottom Panel Tabs

Select any node on the canvas to inspect its state using the **Bottom Panel**:

* **Preview Tab**: Displays a spreadsheet-like data grid showing a sample of the rows output by that node.
* **Plan Tab**: Shows the exact, compile-time SQL script Duckle built from your visual layout. You can copy this script to execute it directly inside other database tools.
* **Output Tab**: Lists each stage of the run with its step in execution order (`[2/5]`), row count and elapsed time, followed by the nodes the run left out - disabled, reusing a retry's output, or never reached after an error.
* **Console Tab**: The run as it happens, one line per event: when each stage started and finished (time since the run began, `[step/total]`), `ctl.log` / `ctl.warn` messages, assertions, skipped nodes and, on failure, the error with its SQL. **Copy log** puts the whole timeline on the clipboard.

---

## 4. Offline Extension Downloads

Duckle pre-fetches database components on startup so that your visual connectors can execute pipelines without an active internet connection.

* **Pre-Loaded Pack**: Support for S3 buckets, PostgreSQL/MySQL connectors, Excel sheets, and JSON formats is downloaded during the initial setup.
* **Geospatial Nodes**: Dragging a Spatial/Geography node onto the canvas automatically downloads geospatial extension modules in the background, keeping the initial installation bundle small.
