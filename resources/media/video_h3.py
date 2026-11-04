"""MiniMax H3 saved-workflow converter and ComfyUI adapter."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from media_comfy import remove_staged_input, stage_input, start_owned_comfyui
from media_job import MediaJobError, require_file


_CONTROL_TOKENS = {"fixed", "randomize", "increment", "decrement"}


def _acceptor(spec: Any) -> tuple[str, list[str]]:
    first = spec[0] if isinstance(spec, (list, tuple)) and spec else spec
    options = spec[1] if isinstance(spec, (list, tuple)) and len(spec) > 1 and isinstance(spec[1], dict) else {}
    if options.get("forceInput"):
        return "other", []
    if isinstance(first, list):
        return "combo", [str(value) for value in first]
    if first == "COMBO":
        return "combo", [str(value) for value in options.get("options", [])]
    if first == "COMFY_DYNAMICCOMBO_V3":
        keys = [str(item["key"]) for item in options.get("options", []) if isinstance(item, dict) and "key" in item]
        return "dynamic", keys
    if first in ("INT", "FLOAT", "NUMBER"):
        return "number", []
    if first == "BOOLEAN":
        return "bool", []
    if first == "STRING":
        return "text", []
    return "other", []


def _flatten_inputs(tree: Any) -> tuple[dict[str, Any], set[str]]:
    if not isinstance(tree, dict):
        return {}, set()
    if "required" not in tree and "optional" not in tree:
        return dict(tree), set()
    required = tree.get("required", {}) or {}
    optional = tree.get("optional", {}) or {}
    if not isinstance(required, dict) or not isinstance(optional, dict):
        return {}, set()
    merged = dict(required)
    merged.update(optional)
    return merged, set(required)


def _dynamic_options(spec: Any) -> dict[str, dict[str, Any]]:
    options = spec[1] if isinstance(spec, (list, tuple)) and len(spec) > 1 and isinstance(spec[1], dict) else {}
    return {
        str(item["key"]): item
        for item in options.get("options", [])
        if isinstance(item, dict) and item.get("key") is not None
    }


def _fits(kind: str, value: Any) -> bool:
    if kind == "number":
        return isinstance(value, (int, float)) and not isinstance(value, bool)
    if kind == "bool":
        return isinstance(value, bool)
    if kind in ("text", "combo"):
        return isinstance(value, str) or (kind == "combo" and isinstance(value, (int, float)))
    return False


def _has_control(name: str, spec: Any) -> bool:
    options = spec[1] if isinstance(spec, (list, tuple)) and len(spec) > 1 and isinstance(spec[1], dict) else {}
    return _acceptor(spec)[0] == "number" and (
        bool(options.get("control_after_generate")) or name in ("seed", "noise_seed")
    )


def _convert_node(
    node: dict[str, Any],
    spec: dict[str, Any],
    wired: dict[str, list[Any]],
    required: set[str],
    problems: list[str],
) -> dict[str, Any]:
    node_id, class_type = str(node["id"]), node["type"]
    inputs = dict(wired)
    values = node.get("widgets_values", [])
    if isinstance(values, dict):
        for name, value in values.items():
            if name in spec and name not in wired:
                kind, _ = _acceptor(spec[name])
                if kind != "other":
                    inputs[name] = value
        return inputs
    if not isinstance(values, list):
        values = []
    cursor = 0
    defaults: list[str] = []

    def take() -> tuple[Any, bool]:
        nonlocal cursor
        if cursor >= len(values):
            return None, False
        value = values[cursor]
        cursor += 1
        return value, True

    def skip_control(name: str, entry: Any) -> None:
        nonlocal cursor
        if (
            _has_control(name, entry)
            and cursor < len(values)
            and isinstance(values[cursor], str)
            and values[cursor] in _CONTROL_TOKENS
        ):
            cursor += 1

    def visit(name: str, entry: Any, prefix: str, branch_required: set[str]) -> None:
        nonlocal cursor
        full = prefix + name
        kind, options = _acceptor(entry)
        if not prefix and name in wired:
            _, exists = take()
            if not exists:
                problems.append(f"#{node_id} {class_type}: wired widget {full!r} has no saved slot")
                return
            skip_control(name, entry)
            return
        value, exists = take()
        if not exists:
            if name in branch_required:
                problems.append(f"#{node_id} {class_type}: required dynamic input {full!r} has no value")
            else:
                defaults.append(full)
            return
        if kind == "dynamic":
            sub_options = _dynamic_options(entry)
            if not isinstance(value, str) or value not in sub_options:
                problems.append(f"#{node_id} {class_type}: {full!r} is not a valid dynamic option")
                return
            inputs[full] = value
            sub, sub_required = _flatten_inputs(sub_options[value].get("inputs", {}))
            for child, child_spec in sub.items():
                if _acceptor(child_spec)[0] != "other":
                    visit(child, child_spec, full + ".", sub_required)
            return
        if value is None:
            defaults.append(full)
            skip_control(name, entry)
            return
        if not _fits(kind, value):
            problems.append(
                f"#{node_id} {class_type}: widget {full!r} does not match this server's input type; "
                "re-save the workflow in the installed ComfyUI."
            )
            skip_control(name, entry)
            return
        if kind == "combo" and options and isinstance(value, str) and value not in options:
            normalized = value.replace("\\", "/").lower()
            matches = [option for option in options if option.replace("\\", "/").lower() == normalized]
            if len(matches) == 1:
                value = matches[0]
            else:
                problems.append(f"#{node_id} {class_type}: {full!r} is not one of this server's options")
        inputs[full] = value
        skip_control(name, entry)

    for name, entry in spec.items():
        if _acceptor(entry)[0] != "other":
            visit(name, entry, "", required)
    if cursor < len(values):
        defaults.append(f"{len(values) - cursor} trailing UI-only value(s)")
    if defaults:
        # Defaults and UI-only fields are expected in LiteGraph cards; they are not execution errors.
        pass
    return inputs


def convert_workflow(
    workflow: Any, object_info: Any, *, require_save_output: bool = True
) -> dict[str, Any]:
    """Convert an installed ComfyUI LiteGraph workflow using live input specifications."""
    if not isinstance(workflow, dict) or not isinstance(workflow.get("nodes"), list):
        raise MediaJobError("Configured H3 workflow must be a saved ComfyUI LiteGraph JSON file.")
    if not isinstance(object_info, dict):
        raise MediaJobError("Owned ComfyUI returned an invalid /object_info response.")
    links = {}
    for link in workflow.get("links", []):
        if isinstance(link, list) and len(link) >= 6:
            links[link[0]] = link
    graph: dict[str, Any] = {}
    problems: list[str] = []
    for node in workflow["nodes"]:
        if not isinstance(node, dict) or "id" not in node or "type" not in node:
            problems.append("Workflow contains a node without an id or type.")
            continue
        if node.get("mode", 0) in (2, 3):
            continue
        node_id, class_type = str(node["id"]), node["type"]
        info = object_info.get(class_type)
        if not isinstance(info, dict):
            connected = any(item.get("link") is not None for item in node.get("inputs", []) if isinstance(item, dict))
            if connected:
                problems.append(f"#{node_id} {class_type}: node class is not installed in this ComfyUI.")
            continue
        spec, required = _flatten_inputs(info.get("input", {}))
        wired: dict[str, list[Any]] = {}
        for port in node.get("inputs", []) or []:
            if not isinstance(port, dict) or port.get("link") is None:
                continue
            link = links.get(port["link"])
            if link is None:
                problems.append(f"#{node_id} {class_type}: input {port.get('name')!r} cites a missing link.")
                continue
            wired[str(port.get("name"))] = [str(link[1]), link[2]]
        inputs = _convert_node(node, spec, wired, required, problems)
        if class_type.lower().startswith("save") and not any(isinstance(value, list) for value in inputs.values()):
            problems.append(f"#{node_id} {class_type}: output node has no connected input.")
        graph[node_id] = {"class_type": class_type, "inputs": inputs}
    if problems:
        raise MediaJobError("H3 workflow conversion failed before rendering:\n- " + "\n- ".join(problems))
    if require_save_output and not any(
        node["class_type"].lower().startswith("save") for node in graph.values()
    ):
        raise MediaJobError("Configured H3 workflow has no active Save output node.")
    return graph


def _load_workflow(path: Path) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise MediaJobError(f"Could not read configured H3 workflow at {path}: {exc}") from exc
    if not isinstance(value, dict):
        raise MediaJobError(f"Configured H3 workflow at {path} must be a JSON object.")
    return value


def _set_output_prefix(graph: dict[str, Any], job: dict[str, Any]) -> None:
    prefix = f"forge-media/video/{job['run_id']}/clip"
    for node in graph.values():
        inputs = node.get("inputs", {})
        if "filename_prefix" in inputs:
            inputs["filename_prefix"] = prefix


def run(job: dict[str, Any]) -> dict[str, Any]:
    inputs = job.get("inputs")
    if not isinstance(inputs, dict) or "workflow_path" not in inputs:
        raise MediaJobError("Job field inputs.workflow_path is required for H3.")
    workflow_path = require_file(inputs["workflow_path"], "inputs.workflow_path")
    workflow = _load_workflow(workflow_path)
    with start_owned_comfyui(job) as client:
        object_info = client.request_json("GET", "/object_info")
        staged_image = None
        try:
            if isinstance(workflow.get("definitions"), dict):
                from video_h3_blueprint import convert_subgraph_blueprint

                inputs = job.get("inputs", {})
                if not isinstance(inputs, dict) or "image_path" not in inputs:
                    raise MediaJobError("Job field inputs.image_path is required for the H3 blueprint.")
                staged_image = stage_input(job, inputs["image_path"], "inputs.image_path")
                graph = convert_subgraph_blueprint(workflow, job, object_info, staged_image)
            else:
                graph = None
            if graph is None:
                graph = convert_workflow(workflow, object_info)
            _set_output_prefix(graph, job)
            output = client.execute(job, graph, ".mp4", "clip.mp4")
        finally:
            if staged_image is not None:
                remove_staged_input(job, staged_image)
    return {"output_files": [str(output)], "details": {"workflow_path": str(workflow_path)}}
