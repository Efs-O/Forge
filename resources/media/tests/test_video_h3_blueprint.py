import pytest

from media_job import MediaJobError
from video_h3_blueprint import convert_subgraph_blueprint


INPUT_NAMES = ["prompt", "value_1", "noise_seed", "first_frame", "last_frame"]


def _build_object_info(format_keys=("mp4",), codec_keys=("h264", "hevc")):
    codec = [
        "COMFY_DYNAMICCOMBO_V3",
        {"options": [{"key": key, "inputs": {"required": {}}} for key in codec_keys]},
    ]
    return {
        "UNETLoader": {"input": {"required": {"unet_name": [["h3-model.safetensors", "other.safetensors"], {}]}}},
        "H3Video": {
            "input": {
                "required": {
                    "prompt": ["STRING", {}],
                    "value_1": ["FLOAT", {}],
                    "noise_seed": ["INT", {}],
                    "first_frame": ["IMAGE", {"forceInput": True}],
                    "last_frame": ["IMAGE", {"forceInput": True}],
                    "model": ["MODEL", {"forceInput": True}],
                }
            }
        },
        "LoadImage": {"input": {"required": {"image": ["STRING", {}]}}},
        "SaveVideo": {
            "input": {
                "required": {
                    "video": ["VIDEO", {"forceInput": True}],
                    "filename_prefix": ["STRING", {}],
                    "format": [
                        "COMFY_DYNAMICCOMBO_V3",
                        {
                            "options": [
                                {
                                    "key": key,
                                    "inputs": {"required": {"codec": codec}},
                                }
                                for key in format_keys
                            ]
                        },
                    ],
                }
            }
        },
    }


def _build_blueprint(missing_input=None):
    exposed_names = [name for name in INPUT_NAMES if name != missing_input]
    slot_by_name = {name: index for index, name in enumerate(exposed_names)}
    links = []
    target_slot = {"prompt": 0, "value_1": 1, "noise_seed": 2, "first_frame": 3, "last_frame": 4}
    for name, origin_slot in slot_by_name.items():
        links.append(
            {
                "id": 10 + origin_slot,
                "origin_id": -10,
                "origin_slot": origin_slot,
                "target_id": 2,
                "target_slot": target_slot[name],
                "type": "IMAGE" if "frame" in name else "STRING",
            }
        )
    links.extend(
        [
            {"id": 30, "origin_id": 1, "origin_slot": 0, "target_id": 2, "target_slot": 5, "type": "MODEL"},
            {"id": 40, "origin_id": 2, "origin_slot": 0, "target_id": -20, "target_slot": 0, "type": "VIDEO"},
        ]
    )
    node_inputs = [
        {"name": "prompt", "link": 10 + slot_by_name.get("prompt", 0)},
        {"name": "value_1", "link": 10 + slot_by_name.get("value_1", 0)},
        {"name": "noise_seed", "link": 10 + slot_by_name.get("noise_seed", 0)},
        {"name": "first_frame", "link": 10 + slot_by_name.get("first_frame", 0)},
        {"name": "last_frame", "link": 10 + slot_by_name.get("last_frame", 0)},
        {"name": "model", "link": 30},
    ]
    wrapper_inputs = [{"name": name, "widget": {"name": name}} for name in exposed_names]
    widget_values = ["saved prompt", 2.0, 7, "saved image", None][: len(exposed_names)]
    return {
        "nodes": [
            {"id": 100, "type": "h3-subgraph", "inputs": wrapper_inputs, "widgets_values": widget_values}
        ],
        "definitions": {
            "subgraphs": [
                {
                    "id": "h3-subgraph",
                    "inputs": [{"name": name} for name in exposed_names],
                    "outputs": [{"linkIds": [40]}],
                    "nodes": [
                        {"id": 1, "type": "UNETLoader", "inputs": [{"name": "unet_name"}], "widgets_values": ["other.safetensors"]},
                        {"id": 2, "type": "H3Video", "inputs": node_inputs, "widgets_values": ["", 0, 0, None, None, None]},
                    ],
                    "links": links,
                }
            ]
        },
    }


@pytest.fixture
def synthetic_blueprint():
    return _build_blueprint()


@pytest.fixture
def fake_object_info():
    return _build_object_info()


def _job():
    return {
        "run_id": "h3-test",
        "prompt": "a user-authored motion prompt",
        "seconds": 5.0,
        "seed": 4242,
        "video": {"width": 1344, "height": 768},
        "models": {"diffusion": "models/h3-model.safetensors"},
    }


def test_blueprint_uses_request_inputs_and_builds_save_video(synthetic_blueprint, fake_object_info):
    graph = convert_subgraph_blueprint(
        synthetic_blueprint, _job(), fake_object_info, "forge_h3_still.png"
    )

    assert graph["2"]["inputs"]["prompt"] == "a user-authored motion prompt"
    assert graph["2"]["inputs"]["value_1"] == 5.0
    assert graph["2"]["inputs"]["noise_seed"] == 4242
    assert graph["2"]["inputs"]["first_frame"] == ["forge_h3_load_image", 0]
    assert "last_frame" not in graph["2"]["inputs"]
    assert graph["1"]["inputs"]["unet_name"] == "h3-model.safetensors"
    assert graph["forge_h3_load_image"]["inputs"]["image"] == "forge_h3_still.png"
    assert graph["forge_h3_save_video"]["inputs"]["format"] == "mp4"
    assert graph["forge_h3_save_video"]["inputs"]["format.codec"] == "h264"


def test_blueprint_refuses_missing_exposed_input():
    with pytest.raises(MediaJobError, match="unsupported H3 blueprint: missing input prompt"):
        convert_subgraph_blueprint(
            _build_blueprint("prompt"), _job(), _build_object_info(), "still.png"
        )


def test_blueprint_refuses_uninstalled_configured_unet_and_lists_choices():
    job = _job()
    job["models"]["diffusion"] = "models/not-installed.safetensors"
    with pytest.raises(MediaJobError, match="not-installed.safetensors.*h3-model.safetensors, other.safetensors"):
        convert_subgraph_blueprint(_build_blueprint(), job, _build_object_info(), "still.png")


@pytest.mark.parametrize(
    ("format_keys", "codec_keys", "missing"),
    [(("webm",), ("h264",), "mp4"), (("mp4",), ("hevc",), "h264")],
)
def test_blueprint_refuses_save_video_without_mp4_or_h264(format_keys, codec_keys, missing):
    with pytest.raises(MediaJobError, match=missing):
        convert_subgraph_blueprint(
            _build_blueprint(), _job(), _build_object_info(format_keys, codec_keys), "still.png"
        )
