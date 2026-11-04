import pytest

from media_job import MediaJobError
from video_h3 import convert_workflow


def _object_info(require_codec=True):
    required = {
        "video": ["VIDEO", {"forceInput": True}],
        "filename_prefix": ["STRING", {}],
        "format": [
            "COMFY_DYNAMICCOMBO_V3",
            {
                "options": [
                    {
                        "key": "mp4",
                        "inputs": {
                            "required": (
                                {"codec": [["h264", "hevc"]], "crf": ["INT", {}]}
                                if require_codec
                                else {"crf": ["INT", {}]}
                            )
                        },
                    }
                ]
            },
        ],
    }
    return {"SaveVideo": {"input": {"required": required}}}


def _workflow(values):
    return {
        "nodes": [
            {
                "id": 2,
                "type": "SaveVideo",
                "mode": 0,
                "inputs": [{"name": "video", "link": 10}],
                "widgets_values": values,
            }
        ],
        "links": [[10, 1, 0, 2, 0, "VIDEO"]],
    }


def test_h3_converter_preserves_dynamic_combo_widget_order():
    graph = convert_workflow(_workflow(["clip", "mp4", "h264", 21]), _object_info())
    inputs = graph["2"]["inputs"]
    assert inputs["video"] == ["1", 0]
    assert inputs["filename_prefix"] == "clip"
    assert inputs["format"] == "mp4"
    assert inputs["format.codec"] == "h264"
    assert inputs["format.crf"] == 21


def test_h3_converter_fails_before_render_when_selected_dynamic_branch_is_incomplete():
    with pytest.raises(MediaJobError, match="required dynamic input"):
        convert_workflow(_workflow(["clip", "mp4"]), _object_info())


def test_h3_converter_rejects_missing_active_output_node():
    with pytest.raises(MediaJobError, match="no active Save output"):
        convert_workflow({"nodes": [], "links": []}, {})
