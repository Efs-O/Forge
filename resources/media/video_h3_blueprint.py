"""Conversion for ComfyUI's MiniMax H3 subgraph blueprint."""

from __future__ import annotations

from pathlib import Path
from typing import Any

from media_job import MediaJobError
from video_h3 import _acceptor, _dynamic_options, _flatten_inputs, convert_workflow


def _blueprint_input_values(node: dict[str, Any], job: dict[str, Any]) -> dict[str, Any]:
    values = node.get("widgets_values", [])
    if not isinstance(values, list):
        raise MediaJobError("H3 subgraph blueprint has invalid widget values.")
    result: dict[str, Any] = {}
    cursor = 0
    for port in node.get("inputs", []):
        if not isinstance(port, dict) or not isinstance(port.get("widget"), dict):
            continue
        if cursor >= len(values):
            raise MediaJobError("H3 subgraph blueprint is missing a saved widget value.")
        result[str(port.get("name"))] = values[cursor]
        cursor += 1

    video = job.get("video", {})
    if not isinstance(video, dict):
        raise MediaJobError("Job field video must be an object for the H3 blueprint.")
    result["prompt"] = job.get("prompt", "")
    result["value_1"] = job.get("seconds", result.get("value_1"))
    result["noise_seed"] = job.get("seed", result.get("noise_seed"))
    for name in ("width", "height"):
        if name in video:
            result[name] = video[name]
    return result


def _save_video_input_values(
    object_info: dict[str, Any], video_link: list[Any], run_id: str
) -> dict[str, Any]:
    info = object_info.get("SaveVideo")
    if not isinstance(info, dict):
        raise MediaJobError("Owned ComfyUI does not provide the SaveVideo output node.")
    spec, required = _flatten_inputs(info.get("input", {}))
    inputs: dict[str, Any] = {}

    def add_dynamic(name: str, entry: Any) -> None:
        options = _dynamic_options(entry)
        preferred = "mp4" if name == "format" else "h264" if name.endswith("codec") else "auto"
        if preferred not in options:
            raise MediaJobError(
                f"SaveVideo input {name!r} does not offer the required {preferred!r} option."
            )
        inputs[name] = preferred
        nested, _ = _flatten_inputs(options[preferred].get("inputs", {}))
        for child, child_spec in nested.items():
            if _acceptor(child_spec)[0] == "dynamic":
                add_dynamic(f"{name}.{child}", child_spec)

    for name in required:
        entry = spec[name]
        first = entry[0] if isinstance(entry, (list, tuple)) and entry else entry
        options = (
            entry[1]
            if isinstance(entry, (list, tuple))
            and len(entry) > 1
            and isinstance(entry[1], dict)
            else {}
        )
        if first == "VIDEO":
            inputs[name] = video_link
            continue
        if name == "filename_prefix":
            inputs[name] = f"forge-media/video/{run_id}/clip"
            continue
        kind, choices = _acceptor(entry)
        if kind == "dynamic":
            add_dynamic(name, entry)
            continue
        if kind == "combo":
            choice = options.get("default")
            if name == "format":
                choice = next((item for item in choices if "mp4" in item.lower()), choice)
            elif name == "codec":
                choice = next((item for item in choices if "h264" in item.lower()), choice)
            if choice not in choices:
                raise MediaJobError(f"SaveVideo input {name!r} has no valid configured default.")
            inputs[name] = choice
            continue
        if kind in ("number", "bool", "text"):
            if "default" not in options:
                raise MediaJobError(f"SaveVideo input {name!r} has no API-provided default.")
            inputs[name] = options["default"]
            continue
        raise MediaJobError(f"Unsupported required SaveVideo input {name!r}.")

    input_schema = info.get("input", {})
    optional = input_schema.get("optional", {}) if isinstance(input_schema, dict) else {}
    codec_spec = optional.get("codec") if isinstance(optional, dict) else None
    if codec_spec is not None and _acceptor(codec_spec)[0] == "dynamic":
        add_dynamic("codec", codec_spec)
    if not any(
        isinstance(value, list) and len(value) == 2 and value == video_link
        for value in inputs.values()
    ):
        raise MediaJobError("SaveVideo does not expose a required VIDEO input.")
    return inputs


def convert_subgraph_blueprint(
    workflow: dict[str, Any],
    job: dict[str, Any],
    object_info: dict[str, Any],
    staged_image: str,
) -> dict[str, Any] | None:
    root_nodes = workflow.get("nodes")
    definitions = workflow.get("definitions", {})
    subgraphs = definitions.get("subgraphs", []) if isinstance(definitions, dict) else []
    if not isinstance(root_nodes, list) or len(root_nodes) != 1 or not isinstance(subgraphs, list):
        return None
    wrapper = root_nodes[0]
    if not isinstance(wrapper, dict):
        return None
    subgraph = next(
        (item for item in subgraphs if isinstance(item, dict) and item.get("id") == wrapper.get("type")),
        None,
    )
    if subgraph is None:
        return None

    inner_nodes = subgraph.get("nodes")
    inner_links = subgraph.get("links")
    exposed_inputs = subgraph.get("inputs")
    exposed_outputs = subgraph.get("outputs")
    if not all(isinstance(value, list) for value in (inner_nodes, inner_links, exposed_inputs, exposed_outputs)):
        raise MediaJobError("H3 subgraph blueprint has an invalid graph definition.")

    # These names are specific to ComfyUI's upstream MiniMax H3 blueprint.
    exposed_names = {
        str(item.get("name")) for item in exposed_inputs if isinstance(item, dict)
    }
    for name in ("value_1", "noise_seed", "first_frame", "last_frame", "prompt"):
        if name not in exposed_names:
            raise MediaJobError(f"unsupported H3 blueprint: missing input {name}")

    values = _blueprint_input_values(wrapper, job)
    values["first_frame"] = ["forge_h3_load_image", 0]
    values["last_frame"] = None
    boundary_values: dict[tuple[str, str], Any] = {}
    normalized_links: list[list[Any]] = []
    for link in inner_links:
        if not isinstance(link, dict):
            continue
        try:
            normalized = [
                link["id"],
                link["origin_id"],
                link["origin_slot"],
                link["target_id"],
                link["target_slot"],
                link["type"],
            ]
        except KeyError as exc:
            raise MediaJobError("H3 subgraph blueprint contains an incomplete link.") from exc
        normalized_links.append(normalized)
        if link["origin_id"] != -10:
            continue
        origin_slot = link["origin_slot"]
        if not isinstance(origin_slot, int) or not 0 <= origin_slot < len(exposed_inputs):
            raise MediaJobError("H3 subgraph link refers to an unknown exposed input.")
        target = next(
            (item for item in inner_nodes if isinstance(item, dict) and str(item.get("id")) == str(link["target_id"])),
            None,
        )
        target_ports = target.get("inputs", []) if isinstance(target, dict) else []
        target_slot = link["target_slot"]
        if not isinstance(target_ports, list) or not isinstance(target_slot, int) or not 0 <= target_slot < len(target_ports):
            raise MediaJobError("H3 subgraph link refers to an unknown node input.")
        input_name = str(exposed_inputs[origin_slot].get("name"))
        port_name = str(target_ports[target_slot].get("name"))
        boundary_values[(str(link["target_id"]), port_name)] = values.get(input_name)

    output = exposed_outputs[0] if exposed_outputs else None
    output_link_ids = output.get("linkIds", []) if isinstance(output, dict) else []
    output_link = next(
        (link for link in inner_links if isinstance(link, dict) and link.get("id") in output_link_ids),
        None,
    )
    if not isinstance(output_link, dict):
        raise MediaJobError("H3 subgraph blueprint has no connected video output.")

    graph = convert_workflow(
        {"nodes": inner_nodes, "links": normalized_links}, object_info, require_save_output=False
    )
    graph["forge_h3_load_image"] = {
        "class_type": "LoadImage",
        "inputs": {"image": staged_image},
    }
    configured_diffusion = job.get("models", {}).get("diffusion")
    if not isinstance(configured_diffusion, str) or not configured_diffusion.strip():
        raise MediaJobError("H3 job field models.diffusion must name the configured UNET file.")
    configured_unet = Path(configured_diffusion).name

    for (node_id, port_name), value in boundary_values.items():
        node = graph.get(node_id)
        if not isinstance(node, dict) or not isinstance(node.get("inputs"), dict):
            raise MediaJobError(f"H3 subgraph boundary points to missing node #{node_id}.")
        if value is None:
            node["inputs"].pop(port_name, None)
        else:
            node["inputs"][port_name] = value

    unet_nodes = [node for node in graph.values() if "unet_name" in node.get("inputs", {})]
    if not unet_nodes:
        raise MediaJobError("unsupported H3 blueprint: no unet_name input")
    for node in unet_nodes:
        node_info = object_info.get(node["class_type"])
        node_inputs, _ = _flatten_inputs(node_info.get("input", {})) if isinstance(node_info, dict) else ({}, set())
        model_spec = node_inputs.get("unet_name")
        _, choices = _acceptor(model_spec) if model_spec is not None else ("other", [])
        if configured_unet not in choices:
            installed = ", ".join(choices) if choices else "none"
            raise MediaJobError(
                f"Configured H3 UNET {configured_unet!r} is not installed. "
                f"Installed choices: {installed}."
            )
        node["inputs"]["unet_name"] = configured_unet

    video_link = [str(output_link["origin_id"]), output_link["origin_slot"]]
    graph["forge_h3_save_video"] = {
        "class_type": "SaveVideo",
        "inputs": _save_video_input_values(object_info, video_link, job["run_id"]),
    }
    return graph
