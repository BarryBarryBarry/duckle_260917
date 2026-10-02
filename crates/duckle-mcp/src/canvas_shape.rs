//! Bring an agent-written pipeline into the shape the desktop canvas needs.
//!
//! The engine only reads `data.componentId`, so a pipeline can validate and run
//! while still missing what the canvas renders from: a node without `type` is
//! drawn by React Flow as a bare label box with no ports (it cannot be edited or
//! wired), and an edge without `sourceHandle` is dropped because Duckle nodes
//! expose named handles. This fills in exactly those fields, the way the GUI
//! would have written them, and never overrides a value that is already there.

use std::collections::{HashMap, VecDeque};

use serde_json::{json, Map, Value};

use crate::catalog;

const X_STEP: f64 = 280.0;
const Y_STEP: f64 = 150.0;

/// The canvas node type for a component: the canvas registers only these
/// three, and control / quality / custom components render as transforms, as
/// the palette's drop handler does.
pub fn flow_type_for(component_id: &str) -> &'static str {
    let kind = catalog::schema(component_id)
        .and_then(|c| c.get("kind").and_then(Value::as_str).map(str::to_string));
    match kind.as_deref() {
        Some("source") => "source",
        Some("sink") => "sink",
        Some(_) => "transform",
        None if component_id.starts_with("src.") => "source",
        None if component_id.starts_with("snk.") => "sink",
        None => "transform",
    }
}

fn ports(component_id: &str, side: &str) -> Vec<Value> {
    catalog::schema(component_id)
        .and_then(|c| c.pointer(&format!("/ports/{side}")).and_then(Value::as_array).cloned())
        .unwrap_or_default()
}

fn port_type(component_id: &str, side: &str, handle: &str) -> Option<String> {
    ports(component_id, side)
        .into_iter()
        .find(|p| p.get("id").and_then(Value::as_str) == Some(handle))
        .and_then(|p| p.get("type").and_then(Value::as_str).map(str::to_string))
}

fn has_valid_position(node: &Value) -> bool {
    node.get("position").is_some_and(|p| {
        p.get("x").is_some_and(Value::is_number) && p.get("y").is_some_and(Value::is_number)
    })
}

/// Left-to-right layers by longest path from a root, for nodes with no usable
/// position. Nodes caught in a cycle fall into the last layer.
fn layered_positions(node_ids: &[String], edges: &[Value]) -> HashMap<String, (f64, f64)> {
    let mut indegree: HashMap<&str, usize> = node_ids.iter().map(|id| (id.as_str(), 0)).collect();
    let mut next: HashMap<&str, Vec<&str>> = HashMap::new();
    for e in edges {
        let (Some(s), Some(t)) = (
            e.get("source").and_then(Value::as_str),
            e.get("target").and_then(Value::as_str),
        ) else {
            continue;
        };
        if indegree.contains_key(s) && indegree.contains_key(t) {
            *indegree.get_mut(t).unwrap() += 1;
            next.entry(s).or_default().push(t);
        }
    }
    let mut depth: HashMap<&str, usize> = HashMap::new();
    let mut queue: VecDeque<&str> = node_ids
        .iter()
        .map(String::as_str)
        .filter(|id| indegree[id] == 0)
        .collect();
    for id in &queue {
        depth.insert(id, 0);
    }
    while let Some(id) = queue.pop_front() {
        let d = depth[id];
        for &t in next.get(id).map(Vec::as_slice).unwrap_or_default() {
            let entry = depth.entry(t).or_insert(0);
            *entry = (*entry).max(d + 1);
            let deg = indegree.get_mut(t).unwrap();
            *deg -= 1;
            if *deg == 0 {
                queue.push_back(t);
            }
        }
    }
    let last = depth.values().copied().max().map_or(0, |m| m + 1);
    let mut rows: HashMap<usize, usize> = HashMap::new();
    node_ids
        .iter()
        .map(|id| {
            let d = depth.get(id.as_str()).copied().unwrap_or(last);
            let row = rows.entry(d).or_insert(0);
            let pos = (d as f64 * X_STEP, *row as f64 * Y_STEP);
            *row += 1;
            (id.clone(), pos)
        })
        .collect()
}

/// Repair the shapes models most often get wrong, so a pipeline that is clear
/// in intent is not refused over spelling: a node id or component written
/// beside `data` instead of inside it (or the other way round), a missing
/// label, `from`/`to` instead of `source`/`target`, and edges without ids.
/// Anything already well-formed is left as it is.
fn repair_common_shapes(obj: &mut serde_json::Map<String, Value>) {
    let mut used: std::collections::HashSet<String> = std::collections::HashSet::new();
    if let Some(nodes) = obj.get_mut("nodes").and_then(Value::as_array_mut) {
        for (index, node) in nodes.iter_mut().enumerate() {
            let Some(map) = node.as_object_mut() else {
                continue;
            };
            if !map.get("data").is_some_and(Value::is_object) {
                map.insert("data".to_string(), Value::Object(serde_json::Map::new()));
            }
            // Node-level fields that belong in data, and data.id that belongs on the node.
            for key in ["componentId", "label", "properties"] {
                if let Some(value) = map.remove(key) {
                    let data = map.get_mut("data").and_then(Value::as_object_mut).unwrap();
                    data.entry(key.to_string()).or_insert(value);
                }
            }
            let data_id = map
                .get_mut("data")
                .and_then(Value::as_object_mut)
                .and_then(|d| d.remove("id"));
            let has_id = map.get("id").and_then(Value::as_str).is_some_and(|s| !s.is_empty());
            if !has_id {
                let id = data_id
                    .as_ref()
                    .and_then(Value::as_str)
                    .filter(|s| !s.is_empty())
                    .map(str::to_string)
                    .unwrap_or_else(|| format!("n{}", index + 1));
                map.insert("id".to_string(), Value::String(id));
            }
            if let Some(id) = map.get("id").and_then(Value::as_str) {
                used.insert(id.to_string());
            }
            let fallback_label = map
                .get("data")
                .and_then(|d| d.get("componentId"))
                .and_then(Value::as_str)
                .or_else(|| map.get("id").and_then(Value::as_str))
                .unwrap_or("node")
                .to_string();
            let data = map.get_mut("data").and_then(Value::as_object_mut).unwrap();
            if !data.get("label").and_then(Value::as_str).is_some_and(|s| !s.is_empty()) {
                data.insert("label".to_string(), Value::String(fallback_label));
            }
        }
    }
    if let Some(edges) = obj.get_mut("edges").and_then(Value::as_array_mut) {
        for (index, edge) in edges.iter_mut().enumerate() {
            let Some(map) = edge.as_object_mut() else {
                continue;
            };
            for (wrong, right) in [("from", "source"), ("to", "target")] {
                if !map.contains_key(right) {
                    if let Some(value) = map.remove(wrong) {
                        map.insert(right.to_string(), value);
                    }
                }
            }
            if !map.get("id").and_then(Value::as_str).is_some_and(|s| !s.is_empty()) {
                let mut n = index + 1;
                while used.contains(&format!("e{n}")) {
                    n += 1;
                }
                let id = format!("e{n}");
                used.insert(id.clone());
                map.insert("id".to_string(), Value::String(id));
            }
        }
    }
}

/// Fill in the canvas fields a pipeline object is missing, in place.
pub fn normalize(pipeline: &mut Value) {
    let Some(obj) = pipeline.as_object_mut() else {
        return;
    };
    repair_common_shapes(obj);
    let edges: Vec<Value> = obj
        .get("edges")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();

    let mut component_of: HashMap<String, String> = HashMap::new();
    if let Some(nodes) = obj.get_mut("nodes").and_then(Value::as_array_mut) {
        let unplaced: Vec<String> = nodes
            .iter()
            .filter(|n| !has_valid_position(n))
            .filter_map(|n| n.get("id").and_then(Value::as_str).map(str::to_string))
            .collect();
        let all_ids: Vec<String> = nodes
            .iter()
            .filter_map(|n| n.get("id").and_then(Value::as_str).map(str::to_string))
            .collect();
        let layout = if unplaced.is_empty() {
            HashMap::new()
        } else {
            layered_positions(&all_ids, &edges)
        };

        for node in nodes.iter_mut() {
            let Some(map) = node.as_object_mut() else {
                continue;
            };
            let id = map.get("id").and_then(Value::as_str).unwrap_or_default().to_string();
            let component = map
                .get("data")
                .and_then(|d| d.get("componentId"))
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string();
            let valid_type = matches!(
                map.get("type").and_then(Value::as_str),
                Some("source" | "transform" | "sink")
            );
            if !valid_type {
                map.insert("type".into(), json!(flow_type_for(&component)));
            }
            if !has_valid_position(&Value::Object(map.clone())) {
                let (x, y) = layout.get(&id).copied().unwrap_or((0.0, 0.0));
                map.insert("position".into(), json!({ "x": x, "y": y }));
            }
            if let Some(data) = map.get_mut("data").and_then(Value::as_object_mut) {
                let has_label = data.get("label").and_then(Value::as_str).is_some_and(|l| !l.trim().is_empty());
                if !has_label && !component.is_empty() {
                    data.insert("label".into(), json!(component));
                }
                data.entry("properties").or_insert_with(|| json!({}));
            }
            component_of.insert(id, component);
        }
    }

    if let Some(edges) = obj.get_mut("edges").and_then(Value::as_array_mut) {
        for edge in edges.iter_mut() {
            let Some(map) = edge.as_object_mut() else {
                continue;
            };
            let source_component = map
                .get("source")
                .and_then(Value::as_str)
                .and_then(|s| component_of.get(s))
                .cloned()
                .unwrap_or_default();
            let target_component = map
                .get("target")
                .and_then(Value::as_str)
                .and_then(|t| component_of.get(t))
                .cloned()
                .unwrap_or_default();
            let blank = |m: &Map<String, Value>, k: &str| {
                m.get(k).and_then(Value::as_str).map_or(true, |s| s.is_empty())
            };
            if blank(map, "sourceHandle") {
                map.insert("sourceHandle".into(), json!("main"));
            }
            if blank(map, "targetHandle") {
                map.insert("targetHandle".into(), json!("main"));
            }
            let source_handle = map.get("sourceHandle").and_then(Value::as_str).unwrap_or("main").to_string();
            let target_handle = map.get("targetHandle").and_then(Value::as_str).unwrap_or("main").to_string();
            // A second input (lookup) is named by the target port, a reject
            // branch by the source port, as the canvas's connection picker does.
            let connection_type = port_type(&target_component, "inputs", &target_handle)
                .filter(|t| t != "main")
                .or_else(|| port_type(&source_component, "outputs", &source_handle).filter(|t| t != "main"))
                .unwrap_or_else(|| "main".into());
            let data = map.entry("data").or_insert_with(|| json!({}));
            if let Some(data) = data.as_object_mut() {
                data.entry("connectionType").or_insert_with(|| json!(connection_type));
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn agent_pipeline() -> Value {
        // The shape an agent wrote for new_order: ids, componentIds and wiring
        // right, canvas fields missing.
        json!({
            "nodes": [
                { "id": "src", "data": { "label": "src order_entry", "componentId": "src.mysql", "properties": {} } },
                { "id": "promo", "data": { "label": "promotion", "componentId": "src.mysql", "properties": {} } },
                { "id": "join", "data": { "label": "join", "componentId": "xf.join", "properties": {} } },
                { "id": "code", "data": { "componentId": "code.sql", "properties": {} } },
                { "id": "sink", "data": { "label": "out", "componentId": "snk.mysql", "properties": {} } }
            ],
            "edges": [
                { "id": "e1", "source": "src", "target": "join", "targetHandle": "main" },
                { "id": "e2", "source": "promo", "target": "join", "targetHandle": "lookup" },
                { "id": "e3", "source": "join", "target": "code" },
                { "id": "e4", "source": "code", "target": "sink", "targetHandle": "main" }
            ]
        })
    }

    #[test]
    fn nodes_get_a_canvas_type_position_and_label() {
        let mut p = agent_pipeline();
        normalize(&mut p);
        let types: Vec<&str> = p["nodes"].as_array().unwrap().iter().map(|n| n["type"].as_str().unwrap()).collect();
        assert_eq!(types, ["source", "source", "transform", "transform", "sink"]);
        assert_eq!(p["nodes"][3]["data"]["label"], "code.sql");
        // Laid out left to right by depth: sources, join, code, sink.
        let x = |i: usize| p["nodes"][i]["position"]["x"].as_f64().unwrap();
        assert!(x(0) == 0.0 && x(1) == 0.0 && x(2) > x(0) && x(3) > x(2) && x(4) > x(3));
        assert_ne!(p["nodes"][0]["position"]["y"], p["nodes"][1]["position"]["y"]);
    }

    #[test]
    fn edges_get_handles_and_the_connection_type_of_their_ports() {
        let mut p = agent_pipeline();
        normalize(&mut p);
        let e = |i: usize| p["edges"][i].clone();
        assert_eq!(e(0)["sourceHandle"], "main");
        assert_eq!(e(0)["data"]["connectionType"], "main");
        assert_eq!(e(1)["targetHandle"], "lookup");
        assert_eq!(e(1)["data"]["connectionType"], "lookup");
        assert_eq!(e(2)["targetHandle"], "main");
    }

    #[test]
    fn reject_branches_are_typed_from_the_source_port() {
        let mut p = json!({
            "nodes": [
                { "id": "j", "type": "transform", "position": { "x": 0, "y": 0 }, "data": { "componentId": "xf.join" } },
                { "id": "k", "type": "sink", "position": { "x": 1, "y": 0 }, "data": { "componentId": "snk.csv" } }
            ],
            "edges": [ { "id": "e", "source": "j", "sourceHandle": "reject", "target": "k" } ]
        });
        normalize(&mut p);
        assert_eq!(p["edges"][0]["data"]["connectionType"], "reject");
    }

    #[test]
    fn existing_canvas_fields_are_left_alone() {
        let mut p = json!({
            "nodes": [ { "id": "a", "type": "source", "position": { "x": 7, "y": 9 }, "data": { "label": "mine", "componentId": "xf.filter" } } ],
            "edges": [ { "id": "e", "source": "a", "sourceHandle": "main", "target": "b", "targetHandle": "main", "data": { "connectionType": "lookup" } } ]
        });
        let before = p.clone();
        normalize(&mut p);
        assert_eq!(p["nodes"][0]["type"], before["nodes"][0]["type"]);
        assert_eq!(p["nodes"][0]["position"], before["nodes"][0]["position"]);
        assert_eq!(p["nodes"][0]["data"]["label"], "mine");
        assert_eq!(p["edges"][0]["data"]["connectionType"], "lookup");
    }
}
