import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const bridgePath = fileURLToPath(new URL("../scripts/jev-wechat-bridge.py", import.meta.url));
const pythonAvailable = spawnSync("python3", ["--version"], { encoding: "utf8" }).status === 0;

test("managed WeChat preflight does not require a Send button before text exists", {
  skip: !pythonAvailable,
}, () => {
  const harness = String.raw`
import importlib.util
import sys

spec = importlib.util.spec_from_file_location("hara_jev_bridge", sys.argv[1])
bridge = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bridge)

window = {"wid": 7, "pid": 8, "title": "WeChat", "x": 0, "y": 0, "w": 900, "h": 700}
bridge.scan = lambda _perception: {
    "ok": True, "title": "测试群", "digest": "a" * 64, "messages": [], "window": window,
}
bridge._send_button = lambda _fill, _window: None

class Fill:
    def locate_input(self, current_window):
        return {"box": "editor", "rect": (10, 500, 700, 150), "window": current_window}
    def _ax_value(self, _box):
        return ""

result = bridge.managed_send_preflight(None, Fill(), {
    "managed": True,
    "expectedTitle": "测试群",
    "expectedDigest": "a" * 64,
})
assert result == {"ok": True, "ready": True, "inputMode": "accessibility", "sendMode": "after-fill"}
`;
  const result = spawnSync("python3", ["-c", harness, bridgePath], {
    encoding: "utf8",
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test("managed WeChat delivery uses the guarded visual fallback and presses Send once", {
  skip: !pythonAvailable,
}, () => {
  const harness = String.raw`
import importlib.util
import json
import sys
import types

spec = importlib.util.spec_from_file_location("hara_jev_bridge", sys.argv[1])
bridge = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bridge)

window = {"wid": 7, "pid": 8, "title": "WeChat", "x": 0, "y": 0, "w": 900, "h": 700}
expected = {"ok": True, "title": "测试群", "digest": "a" * 64, "messages": [], "window": window}
after = {"ok": True, "title": "测试群", "digest": "b" * 64, "messages": [{"side": "me", "text": "收到"}], "window": window}
scans = [expected, expected, after]
bridge.scan = lambda _perception: scans.pop(0)
bridge._send_button = lambda _fill, _window: object()
bridge.time.sleep = lambda _seconds: None

visual_reads = iter(["", "收到", ""])
visual = types.ModuleType("visual_fill")
visual.chat_signature = lambda _window, _rect: b"stable"
visual.input_text = lambda _window, _rect: next(visual_reads)
region = types.ModuleType("input_region")
region.locate_visual_input = lambda _window: (20, 500, 700, 150)
sys.modules["visual_fill"] = visual
sys.modules["input_region"] = region

presses = []
application_services = types.ModuleType("ApplicationServices")
application_services.kAXPressAction = "press"
application_services.AXUIElementPerformAction = lambda _button, _action: presses.append("press") or 0
sys.modules["ApplicationServices"] = application_services

class Fill:
    def locate_input(self, current_window):
        return {"box": None, "rect": None, "window": current_window}
    def _ax_value(self, _box):
        return None
    def fill_text(self, text, target=None):
        assert text == "收到"
        assert target["visual_rect"] == (20, 500, 700, 150)
        return True, "verified"

result = bridge.send_managed_draft(None, Fill(), {
    "managed": True,
    "draft": "收到",
    "expectedTitle": "测试群",
    "expectedDigest": "a" * 64,
})
assert result["ok"] is True and result["sent"] is True
assert result["inputMode"] == "visual"
assert presses == ["press"]
print(json.dumps(result))
`;
  const result = spawnSync("python3", ["-c", harness, bridgePath], {
    encoding: "utf8",
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(JSON.parse(result.stdout).inputMode, "visual");
});

test("managed WeChat delivery accepts a delayed exact readback after the visual writer reports uncertainty", {
  skip: !pythonAvailable,
}, () => {
  const harness = String.raw`
import importlib.util
import json
import sys
import types

spec = importlib.util.spec_from_file_location("hara_jev_bridge", sys.argv[1])
bridge = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bridge)

window = {"wid": 7, "pid": 8, "title": "WeChat", "x": 0, "y": 0, "w": 900, "h": 700}
expected = {"ok": True, "title": "测试群", "digest": "a" * 64, "messages": [], "window": window}
after = {"ok": True, "title": "测试群", "digest": "b" * 64, "messages": [{"side": "me", "text": "收到"}], "window": window}
scans = [expected, expected, after]
bridge.scan = lambda _perception: scans.pop(0)
bridge._send_button = lambda _fill, _window: object()
bridge.time.sleep = lambda _seconds: None

# Empty before the write, one stale frame after the writer returns, then the exact
# draft appears.  The final empty read confirms the single Send press cleared it.
visual_reads = iter(["", "", "收到", ""])
visual = types.ModuleType("visual_fill")
visual.chat_signature = lambda _window, _rect: b"stable"
visual.input_text = lambda _window, _rect: next(visual_reads)
region = types.ModuleType("input_region")
region.locate_visual_input = lambda _window: (20, 500, 700, 150)
sys.modules["visual_fill"] = visual
sys.modules["input_region"] = region

presses = []
application_services = types.ModuleType("ApplicationServices")
application_services.kAXPressAction = "press"
application_services.AXUIElementPerformAction = lambda _button, _action: presses.append("press") or 0
sys.modules["ApplicationServices"] = application_services

class Fill:
    def locate_input(self, current_window):
        return {"box": None, "rect": None, "window": current_window}
    def _ax_value(self, _box):
        return None
    def fill_text(self, text, target=None):
        assert text == "收到"
        return False, "已尝试输入，画面未能确认；请检查草稿，勿重复点击"

result = bridge.send_managed_draft(None, Fill(), {
    "managed": True,
    "draft": "收到",
    "expectedTitle": "测试群",
    "expectedDigest": "a" * 64,
})
assert result["ok"] is True and result["sent"] is True
assert result["inputMode"] == "visual"
assert presses == ["press"]
print(json.dumps(result))
`;
  const result = spawnSync("python3", ["-c", harness, bridgePath], {
    encoding: "utf8",
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(JSON.parse(result.stdout).inputMode, "visual");
});

test("managed WeChat delivery rechecks the observation and never presses after a change", {
  skip: !pythonAvailable,
}, () => {
  const harness = String.raw`
import importlib.util
import sys
import types

spec = importlib.util.spec_from_file_location("hara_jev_bridge", sys.argv[1])
bridge = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bridge)

window = {"wid": 7, "pid": 8, "title": "WeChat", "x": 0, "y": 0, "w": 900, "h": 700}
first = {"ok": True, "title": "测试群", "digest": "a" * 64, "messages": [], "window": window}
changed = {"ok": True, "title": "测试群", "digest": "b" * 64, "messages": [], "window": window}
scans = [first, changed]
bridge.scan = lambda _perception: scans.pop(0)
bridge._send_button = lambda _fill, _window: object()

visual_reads = iter(["", "收到"])
visual = types.ModuleType("visual_fill")
visual.chat_signature = lambda _window, _rect: b"stable"
visual.input_text = lambda _window, _rect: next(visual_reads)
region = types.ModuleType("input_region")
region.locate_visual_input = lambda _window: (20, 500, 700, 150)
sys.modules["visual_fill"] = visual
sys.modules["input_region"] = region

presses = []
application_services = types.ModuleType("ApplicationServices")
application_services.kAXPressAction = "press"
application_services.AXUIElementPerformAction = lambda _button, _action: presses.append("press") or 0
sys.modules["ApplicationServices"] = application_services

class Fill:
    def locate_input(self, current_window):
        return {"box": None, "rect": None, "window": current_window}
    def _ax_value(self, _box):
        return None
    def fill_text(self, _text, target=None):
        return True, "verified"

result = bridge.send_managed_draft(None, Fill(), {
    "managed": True,
    "draft": "收到",
    "expectedTitle": "测试群",
    "expectedDigest": "a" * 64,
})
assert result["ok"] is False
assert result["category"] == "conversation_changed"
assert presses == []
`;
  const result = spawnSync("python3", ["-c", harness, bridgePath], {
    encoding: "utf8",
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test("managed WeChat delivery can click one stable OCR-verified Send label", {
  skip: !pythonAvailable,
}, () => {
  const harness = String.raw`
import importlib.util
import sys
import types

spec = importlib.util.spec_from_file_location("hara_jev_bridge", sys.argv[1])
bridge = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bridge)

window = {"wid": 7, "pid": 8, "title": "WeChat", "x": 0, "y": 0, "w": 900, "h": 700}
expected = {"ok": True, "title": "测试群", "digest": "a" * 64, "messages": [], "window": window}
after = {"ok": True, "title": "测试群", "digest": "b" * 64, "messages": [{"side": "me", "text": "收到"}], "window": window}
scans = [expected, expected, expected, after]
bridge.scan = lambda _perception: scans.pop(0)
bridge._send_button = lambda _fill, _window: None
bridge._visual_send_point = lambda _perception, _current: {"mode": "visual", "point": (820.0, 650.0), "confidence": 0.99}
bridge.time.sleep = lambda _seconds: None

visual_reads = iter(["", "收到", ""])
visual = types.ModuleType("visual_fill")
visual.chat_signature = lambda _window, _rect: b"stable"
visual.input_text = lambda _window, _rect: next(visual_reads)
visual.window_is_current = lambda _window, _app, require_front=False: require_front
region = types.ModuleType("input_region")
region.locate_visual_input = lambda _window: (20, 500, 700, 150)
sys.modules["visual_fill"] = visual
sys.modules["input_region"] = region

class App:
    def activateWithOptions_(self, _options):
        pass

appkit = types.ModuleType("AppKit")
appkit.NSApplicationActivateIgnoringOtherApps = 1
sys.modules["AppKit"] = appkit

posts = []
quartz = types.ModuleType("Quartz")
quartz.kCGEventLeftMouseDown = 1
quartz.kCGEventLeftMouseUp = 2
quartz.kCGMouseButtonLeft = 0
quartz.kCGHIDEventTap = 0
quartz.kCGMouseEventClickState = 1
quartz.CGEventCreateMouseEvent = lambda _source, event_type, point, _button: (event_type, point)
quartz.CGEventSetFlags = lambda _event, _flags: None
quartz.CGEventSetIntegerValueField = lambda _event, _field, _value: None
quartz.CGEventPost = lambda _tap, event: posts.append(event)
sys.modules["Quartz"] = quartz

class Fill:
    def locate_input(self, current_window):
        return {"box": None, "rect": None, "window": current_window}
    def _ax_value(self, _box):
        return None
    def _wechat_app(self):
        return App()
    def fill_text(self, _text, target=None):
        return True, "verified"

result = bridge.send_managed_draft(None, Fill(), {
    "managed": True,
    "draft": "收到",
    "expectedTitle": "测试群",
    "expectedDigest": "a" * 64,
})
assert result["ok"] is True and result["sent"] is True
assert result["sendMode"] == "visual"
assert len(posts) == 2
assert posts[0][1] == (820.0, 650.0)
`;
  const result = spawnSync("python3", ["-c", harness, bridgePath], {
    encoding: "utf8",
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});
