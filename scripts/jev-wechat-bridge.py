#!/usr/bin/env python3
"""Narrow JSON bridge between Hara and Jev's local WeChat perception layer.

The bridge deliberately exposes only bounded operations: permission/status inspection,
one-shot reading of the currently visible WeChat conversation, explicit draft filling,
and a separately confirmed managed send. It never synthesizes Return, touches the
clipboard, or retains screenshots/messages. Managed send presses only a verified Send
button in the bound WeChat window and fails closed if delivery cannot be read back.
Window pixels stay in memory when macOS permits it; an off-Space capture may briefly use a
0700 temporary directory that is deleted before the bridge returns.
"""

from __future__ import annotations

import hashlib
import json
import os
import platform
import re
import sys
import time
import unicodedata
from copy import copy
from pathlib import Path


_RAPID_OCR = None


def emit(value: dict, exit_code: int = 0) -> None:
    print(json.dumps(value, ensure_ascii=False, separators=(",", ":")))
    raise SystemExit(exit_code)


def bounded_text(value: object, limit: int) -> str:
    return str(value or "").replace("\x00", "").strip()[:limit]


def load_request() -> dict:
    try:
        value = json.load(sys.stdin)
    except Exception:
        emit({"ok": False, "error": "invalid bridge request"}, 2)
    if not isinstance(value, dict):
        emit({"ok": False, "error": "invalid bridge request"}, 2)
    return value


def load_jev(root_value: object):
    root = Path(bounded_text(root_value, 4096)).expanduser().resolve()
    required = (
        root / "src" / "perception.py",
        root / "src" / "fill.py",
        root / "src" / "input_region.py",
        root / "src" / "visual_fill.py",
    )
    if not all(path.is_file() for path in required):
        emit({"ok": False, "error": "the selected Jev source is incomplete"}, 2)
    sys.path.insert(0, str(root / "src"))
    try:
        import fill  # type: ignore
        import perception  # type: ignore
        import visual_fill  # type: ignore
    except Exception as error:
        emit({"ok": False, "error": f"Jev runtime unavailable: {type(error).__name__}"}, 2)

    # Jev's message extraction converts Vision's bottom-origin coordinates to a
    # top-origin layout in place. read_conversation() then asks the same blocks for the
    # header title, so the title bar has already moved to the bottom of the coordinate
    # space and cannot be found. Preserve Jev's measured message logic while giving it
    # shallow copies; the untouched observations remain authoritative for the title.
    original_messages = perception.extract_messages

    def nonmutating_messages(blocks, max_messages=12):
        return original_messages([copy(block) for block in blocks], max_messages=max_messages)

    perception.extract_messages = nonmutating_messages

    # On macOS 27, Apple's Vision OCR can no longer verify Chinese input reliably. Jev's
    # visual writer is still safe, but its readback would report an uncertain failure after
    # the text had already landed. Reuse the same offline RapidOCR engine as conversation
    # scanning for both the before-write emptiness check and the after-write confirmation.
    if needs_rapid_ocr():
        visual_fill.input_text = lambda win, rect: rapid_input_text(perception, win, rect)

    return perception, fill


def macos_major() -> int:
    try:
        return int((platform.mac_ver()[0] or "0").split(".", 1)[0])
    except Exception:
        return 0


def needs_rapid_ocr() -> bool:
    """macOS 27 Vision Accurate fails for Chinese and Fast only supports English."""
    return macos_major() >= 27


def rapid_ocr_ready() -> bool:
    if not needs_rapid_ocr():
        return True
    try:
        import numpy  # noqa: F401  # type: ignore
        import rapidocr_onnxruntime  # noqa: F401  # type: ignore
        return True
    except Exception:
        return False


def rapid_ocr_engine():
    global _RAPID_OCR
    if _RAPID_OCR is None:
        from rapidocr_onnxruntime import RapidOCR  # type: ignore

        _RAPID_OCR = RapidOCR(
            intra_op_num_threads=4,
            det_limit_type="max",
            det_limit_side_len=4000,
        )
    return _RAPID_OCR


def cgimage_rgb(image):
    """Convert a CGImage to an in-memory RGB ndarray without writing chat pixels to disk."""
    import ctypes

    import numpy as np  # type: ignore
    import Quartz  # type: ignore

    width = int(Quartz.CGImageGetWidth(image))
    height = int(Quartz.CGImageGetHeight(image))
    if width < 1 or height < 1 or width * height > 50_000_000:
        raise ValueError("invalid WeChat capture dimensions")
    buffer = ctypes.create_string_buffer(width * height * 4)
    context = Quartz.CGBitmapContextCreate(
        buffer,
        width,
        height,
        8,
        width * 4,
        Quartz.CGColorSpaceCreateDeviceRGB(),
        Quartz.kCGImageAlphaPremultipliedLast | Quartz.kCGBitmapByteOrder32Big,
    )
    if context is None:
        raise RuntimeError("could not create the local WeChat pixel buffer")
    Quartz.CGContextDrawImage(context, Quartz.CGRectMake(0, 0, width, height), image)
    return np.frombuffer(buffer.raw, dtype=np.uint8).reshape(height, width, 4)[:, :, :3].copy()


def capture_rgb(perception, win):
    """Capture privately: memory first, protected one-shot PNG only when macOS requires it."""
    wid = win.get("wid") if isinstance(win, dict) else win.wid
    image = perception.capture_image(wid, nominal=False)
    if image is not None:
        return cgimage_rgb(image)

    import tempfile

    import numpy as np  # type: ignore
    from PIL import Image  # type: ignore

    with tempfile.TemporaryDirectory(prefix="hara-wechat-") as directory:
        png = Path(directory) / "window.png"
        if not perception.capture_window(wid, png):
            image = perception.capture_image(wid, nominal=True)
            return cgimage_rgb(image) if image is not None else None
        with Image.open(png) as captured:
            return np.asarray(captured.convert("RGB")).copy()


def rapid_chat_area(full, display_scale: float):
    """Locate the chat pane and message/input split from pixels, not a fixed width ratio."""
    import numpy as np  # type: ignore

    height, width = full.shape[:2]
    if height < 300 or width < 600:
        return None
    right = full[::8, width // 2::8].reshape(-1, 3)
    colors, counts = np.unique(right, axis=0, return_counts=True)
    pane_background = colors[counts.argmax()]
    is_background = np.abs(full.astype(np.int16) - pane_background.astype(np.int16)).sum(-1) <= 6
    column_ratio = is_background[height // 4: height * 3 // 4].mean(0)
    left = int(np.argmax(column_ratio > 0.3))
    right_edge = width - int(np.argmax(column_ratio[::-1] > 0.3))
    if left <= 0 or right_edge <= left:
        return None

    row_ratio = is_background[:, left:right_edge].mean(1)
    pane_top = int(np.argmax(row_ratio > 0.9))
    pane_bottom = height - int(np.argmax(row_ratio[::-1] > 0.9))
    if pane_bottom <= pane_top:
        return None
    pane = full[pane_top:pane_bottom, left:right_edge].astype(np.int16)
    separators = pane_top + np.where(
        (pane.std(axis=(1, 2)) < 4) & (row_ratio[pane_top:pane_bottom] < 0.1)
    )[0]
    separated = [
        int(row) for index, row in enumerate(separators)
        if index == 0 or row - separators[index - 1] > 3
    ]
    below = [row for row in separated if row > pane_top + 0.45 * (pane_bottom - pane_top)]
    input_top = below[0] if below else pane_bottom
    header_height = max(48, round(64 * max(1.0, min(display_scale, 3.0))))
    above = [
        row for row in separated
        if pane_top + header_height < row < input_top - max(50, round(50 * display_scale))
    ]
    message_top = above[-1] if above else pane_top + header_height
    if right_edge - left < 200 or input_top - message_top < 100:
        return None
    return left, message_top, right_edge, input_top, pane_background, pane_top


def normalize_title(value: object) -> str:
    title = unicodedata.normalize("NFKC", bounded_text(value, 240))
    title = re.sub(r"\s*[（(]\d+[)）]\s*$", "", title)
    title = re.sub(r"[‐‑‒–—−﹣]", "-", title)
    return re.sub(r"\s+", " ", title).strip()


def rapid_title(engine, header) -> str:
    result, _ = engine(header, use_cls=False)
    rows = [row for row in (result or []) if len(row) >= 3 and float(row[2]) >= 0.70]
    if not rows:
        return ""
    first = min(rows, key=lambda row: row[0][0][1])
    first_bottom = first[0][0][1] + (first[0][2][1] - first[0][0][1])
    same_line = [row for row in rows if row[0][0][1] < first_bottom]
    title = min(same_line, key=lambda row: row[0][0][0])[1]
    return normalize_title(title)


def rapid_message_kind(chat, box):
    """Classify OCR text by flat bubble color instead of a resize-sensitive x cutoff."""
    import numpy as np  # type: ignore

    xs = [point[0] for point in box]
    ys = [point[1] for point in box]
    region = chat[int(min(ys)):int(max(ys)), int(min(xs)):int(max(xs))].astype(np.int16)
    if region.size == 0:
        return None, None, 0
    colors, counts = np.unique(region.reshape(-1, 3), axis=0, return_counts=True)
    background = colors[counts.argmax()]
    if counts.max() / region.shape[0] / region.shape[1] < 0.45:
        return None, background, 0
    luma = region @ [0.299, 0.587, 0.114]
    background_luma = background @ [0.299, 0.587, 0.114]
    difference = np.abs(luma - background_luma)
    ink_height = run = 0
    for has_ink in (difference > 60).any(axis=1):
        run = run + 1 if has_ink else 0
        ink_height = max(ink_height, run)
    if background[1] > background[0] + 40 and background[1] > background[2] + 40:
        return "me", background, ink_height
    return ("them" if difference.max() >= 150 else "gray"), background, ink_height


def rapid_messages(engine, chat, pane_background, max_messages: int):
    import numpy as np  # type: ignore
    from types import SimpleNamespace

    result, _ = engine(chat, use_cls=False)
    width = chat.shape[1]
    sender = None
    raw = []
    for box, text, score in sorted(result or [], key=lambda row: row[0][0][1]):
        kind, background, ink_height = rapid_message_kind(chat, box)
        if kind == "gray":
            on_pane = background is not None and np.abs(
                background.astype(np.int16) - pane_background.astype(np.int16)
            ).sum() <= 6
            if (
                on_pane
                and box[0][0] < 0.25 * width
                and len(text) <= 32
                and not re.search(r"[:：]", text)
            ):
                sender = bounded_text(text, 120)
            continue
        if kind is None:
            continue
        raw.append({
            "side": kind,
            "sender": sender if kind == "them" else None,
            "text": bounded_text(text, 2000),
            "top": float(box[0][1]),
            "bottom": float(box[2][1]),
            "ink": ink_height,
            "confidence": float(score),
        })

    normal_ink = float(np.median([row["ink"] for row in raw])) if len(raw) >= 3 else 0.0
    if normal_ink:
        raw = [row for row in raw if row["ink"] >= 0.6 * normal_ink]
    lines = []
    for row in raw:
        if (
            lines
            and lines[-1]["side"] == row["side"]
            and lines[-1]["sender"] == row["sender"]
            and row["top"] - lines[-1]["bottom"] < 0.6 * (normal_ink or row["ink"] or 1)
        ):
            lines[-1]["text"] += row["text"]
            lines[-1]["bottom"] = row["bottom"]
            lines[-1]["confidence"] = min(lines[-1]["confidence"], row["confidence"])
        else:
            lines.append(row)
    return [
        SimpleNamespace(
            side=row["side"],
            text=row["text"],
            conf=row["confidence"],
            sender=row["sender"],
        )
        for row in lines[-max_messages:]
        if row["text"]
    ]


def rapid_input_text(perception, win: dict, rect) -> str | None:
    """Read the visually located WeChat input with the macOS-27 offline OCR path."""
    full = capture_rgb(perception, win)
    if full is None:
        return None
    height, width = full.shape[:2]
    try:
        x, y, w, h = (float(value) for value in rect)
        scale_x = width / max(float(win["w"]), 1.0)
        scale_y = height / max(float(win["h"]), 1.0)
        left = max(0, round((x - float(win["x"])) * scale_x))
        top = max(0, round((y - float(win["y"])) * scale_y))
        right = min(width, round((x + w - float(win["x"])) * scale_x))
        bottom = min(height, round((y + h - float(win["y"])) * scale_y))
    except Exception:
        return None
    if right - left < 80 or bottom - top < 30:
        return None
    crop = full[top:bottom, left:right]
    result, _ = rapid_ocr_engine()(crop, use_cls=False)
    rows = []
    crop_height = crop.shape[0]
    for row in result or []:
        if len(row) < 3 or float(row[2]) < 0.45:
            continue
        box, raw_text = row[0], bounded_text(row[1], 2000)
        if not raw_text:
            continue
        center_y = sum(float(point[1]) for point in box) / max(len(box), 1)
        # The bottom strip contains the voice-mode label and Send button, not draft text.
        if center_y > crop_height * 0.86:
            continue
        compact = re.sub(r"\s+", "", unicodedata.normalize("NFKC", raw_text)).lower()
        if compact in ("按住鼠标语音输入文字", "发送", "send"):
            continue
        rows.append((min(float(point[1]) for point in box), min(float(point[0]) for point in box), raw_text))
    rows.sort(key=lambda item: (item[0], item[1]))
    return "".join(item[2] for item in rows)


def rapid_read_conversation(perception, max_messages: int) -> dict:
    win = perception.find_wechat_window()
    if win is None:
        return {"ok": False, "error": "WeChat main window not found", "messages": []}
    full = capture_rgb(perception, win)
    if full is None:
        return {"ok": False, "error": "WeChat window capture failed", "messages": []}
    display_scale = full.shape[1] / max(float(win.w), 1.0)
    area = rapid_chat_area(full, display_scale)
    if area is None:
        return {"ok": False, "error": "the WeChat chat area could not be located", "messages": []}
    left, message_top, right, input_top, pane_background, pane_top = area
    engine = rapid_ocr_engine()
    title = rapid_title(engine, full[pane_top:message_top, left:right])
    messages = rapid_messages(
        engine,
        full[message_top:input_top, left:right],
        pane_background,
        max_messages,
    )
    return {
        "ok": True,
        "chat_title": title,
        "messages": messages,
        "window": {
            "wid": win.wid,
            "pid": win.pid,
            "title": win.title,
            "w": win.w,
            "h": win.h,
            "x": win.x,
            "y": win.y,
        },
    }


def message_view(message) -> dict:
    side = message.side if message.side in ("them", "me", "unknown") else "unknown"
    result = {
        "side": side,
        "text": bounded_text(message.text, 2000),
        "confidence": round(float(message.conf), 3),
    }
    sender = bounded_text(getattr(message, "sender", ""), 120)
    if sender:
        result["sender"] = sender
    return result


def conversation_digest(title: str, messages: list[dict]) -> str:
    # OCR confidence naturally changes between captures of an unchanged screen. It is useful
    # telemetry but must never participate in the safety identity: doing so falsely pauses
    # Managed mode after the model has drafted a reply. Preserve exact normalized content,
    # sender and side so a real new message or changed conversation still fails closed.
    stable_messages = []
    for message in messages:
        stable_messages.append({
            "side": message.get("side") if message.get("side") in ("them", "me", "unknown") else "unknown",
            "sender": re.sub(
                r"\s+",
                " ",
                unicodedata.normalize("NFKC", bounded_text(message.get("sender"), 120)),
            ).strip(),
            "text": re.sub(
                r"\s+",
                " ",
                unicodedata.normalize("NFKC", bounded_text(message.get("text"), 2000)),
            ).strip(),
        })
    payload = json.dumps(
        {"title": normalize_title(title), "messages": stable_messages},
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")
    return hashlib.sha256(payload).hexdigest()


def scan(perception, max_messages: int = 10) -> dict:
    if not perception.screen_capture_ok():
        return {
            "ok": False,
            "error": "screen-recording-required",
            "screenCapture": "required",
        }
    if needs_rapid_ocr() and not rapid_ocr_ready():
        return {"ok": False, "error": "the offline Chinese OCR runtime is not installed"}
    result = (
        rapid_read_conversation(perception, max_messages)
        if needs_rapid_ocr()
        else perception.read_conversation(max_messages=max_messages)
    )
    if not result.get("ok"):
        return {"ok": False, "error": bounded_text(result.get("error"), 240)}
    title = normalize_title(result.get("chat_title"))
    messages = [message_view(message) for message in result.get("messages", [])][-max_messages:]
    if not title:
        return {"ok": False, "error": "the current WeChat conversation title could not be read"}
    return {
        "ok": True,
        "title": title,
        "messages": messages,
        "digest": conversation_digest(title, messages),
        "window": result.get("window"),
    }


def status(perception, fill) -> dict:
    capture = bool(perception.screen_capture_ok())
    window_found = False
    if capture:
        try:
            window_found = perception.find_wechat_window() is not None
        except Exception:
            window_found = False
    result = {
        "ok": rapid_ocr_ready(),
        "screenCapture": "granted" if capture else "required",
        "accessibility": "granted" if fill.has_accessibility() else "required",
    }
    if not rapid_ocr_ready():
        result["error"] = "the offline Chinese OCR runtime is not installed"
    if capture:
        result["wechat"] = "running" if window_found else "not-running"
    return result


def request_permissions(perception, fill) -> dict:
    """Request macOS grants only after the user clicks the dedicated Hara control."""
    if not perception.screen_capture_ok():
        perception.request_screen_capture()
    if not fill.has_accessibility():
        fill.request_accessibility()
    return status(perception, fill)


def fill_draft(perception, fill, request: dict) -> dict:
    draft = bounded_text(request.get("draft"), 4000)
    expected_title = bounded_text(request.get("expectedTitle"), 240)
    expected_digest = bounded_text(request.get("expectedDigest"), 128)
    if not draft or not expected_title or len(expected_digest) != 64:
        return {"ok": False, "error": "invalid fill request"}

    current = scan(perception)
    if not current.get("ok"):
        return current
    if current["title"] != expected_title or current["digest"] != expected_digest:
        return {
            "ok": False,
            "error": "the visible WeChat conversation changed; generate a fresh draft before filling",
        }

    target = fill.locate_input(current["window"])
    if target.get("box") is None:
        try:
            from input_region import locate_visual_input  # type: ignore
            from visual_fill import chat_signature  # type: ignore

            visual_rect = locate_visual_input(current["window"])
            target["visual_rect"] = visual_rect
            if visual_rect:
                target["chat_signature"] = chat_signature(current["window"], visual_rect)
        except Exception:
            pass
    ok, reason = fill.fill_text(draft, target=target)
    safe_reason = bounded_text(reason, 240)
    review_required = not ok and any(marker in safe_reason for marker in (
        "已尝试输入",
        "输入已中止；请检查草稿",
        "输入过程异常，请先检查草稿",
        "刚尝试过填入",
    ))
    if review_required:
        return {
            "ok": True,
            "filled": False,
            "attempted": True,
            "reviewRequired": True,
            "reason": safe_reason,
        }
    return {"ok": bool(ok), "filled": bool(ok), "reason": safe_reason}


def _send_button(fill, window):
    """Return the Send button inside this exact WeChat window, never a global match."""
    import ApplicationServices as A  # type: ignore

    app = fill._wechat_app()
    if app is None:
        return None
    bounds = tuple(window[key] for key in ("x", "y", "w", "h"))
    root = A.AXUIElementCreateApplication(app.processIdentifier())
    windows = fill._ax_attr(root, A.kAXWindowsAttribute) or []
    target_window = next((item for item in windows if fill._same_rect(fill._ax_rect(item), bounds)), None)
    if target_window is None:
        return None

    queue = [target_window]
    matches = []
    seen = 0
    while queue and seen < 2500:
        element = queue.pop(0)
        seen += 1
        role = fill._ax_attr(element, A.kAXRoleAttribute)
        if role == "AXButton":
            labels = []
            for attribute in (
                A.kAXTitleAttribute,
                A.kAXDescriptionAttribute,
                getattr(A, "kAXHelpAttribute", "AXHelp"),
                A.kAXValueAttribute,
            ):
                value = fill._ax_attr(element, attribute)
                if isinstance(value, str):
                    labels.append(unicodedata.normalize("NFKC", value).strip().lower())
            label = " ".join(labels)
            rect = fill._ax_rect(element)
            if rect and ("发送" in label or re.search(r"\bsend\b", label)):
                x, y, width, height = rect
                wx, wy, ww, wh = bounds
                if (
                    wx <= x <= wx + ww
                    and wy <= y <= wy + wh
                    and x + width <= wx + ww + 3
                    and y + height <= wy + wh + 3
                    and y >= wy + wh * 0.45
                ):
                    matches.append((x + width, y + height, element))
        queue.extend(fill._ax_attr(element, A.kAXChildrenAttribute) or [])
    if not matches:
        return None
    # WeChat's message Send control is the lowest/rightmost matching button.
    return max(matches, key=lambda item: (item[1], item[0]))[2]


def _compact_visible_text(value: object) -> str:
    return "".join(
        character
        for character in unicodedata.normalize("NFKC", bounded_text(value, 4000))
        if not character.isspace()
    )


def _managed_input_target(perception, fill, current: dict):
    """Resolve an empty, readable input route without writing anything.

    Newer WeChat builds do not always expose the editor through Accessibility. Managed
    mode may use Jev's audited visual writer in that case, but only when OCR can prove the
    input is empty. The Send control is intentionally resolved later, after text exists,
    because WeChat 4.x can leave that control disabled while the editor is empty.
    """
    window = current.get("window")
    if not isinstance(window, dict):
        return None, None, "input_unavailable", "the current WeChat window could not be verified"
    target = fill.locate_input(window)
    box = target.get("box")
    if box is not None:
        existing = fill._ax_value(box)
        if existing is not None:
            if existing.strip():
                return None, None, "draft_present", "the WeChat input already contains a user draft; managed send was stopped"
            return target, "accessibility", None, None

    try:
        from input_region import locate_visual_input  # type: ignore
        from visual_fill import chat_signature, input_text  # type: ignore

        visual_rect = locate_visual_input(window)
        signature = chat_signature(window, visual_rect) if visual_rect else None
        existing = input_text(window, visual_rect) if visual_rect else None
    except Exception:
        visual_rect = signature = existing = None
    if visual_rect is None or signature is None or existing is None:
        return None, None, "input_unavailable", "managed send could not verify the WeChat input area"
    if str(existing).strip():
        return None, None, "draft_present", "the WeChat input already contains a user draft; managed send was stopped"
    target.update(box=None, visual_rect=visual_rect, chat_signature=signature)
    return target, "visual", None, None


def _visual_send_point(perception, current: dict):
    """Locate the exact Send label inside the verified input panel, without clicking it."""
    window = current.get("window")
    if not isinstance(window, dict):
        return None
    try:
        from input_region import locate_visual_input  # type: ignore

        input_rect = locate_visual_input(window)
        full = capture_rgb(perception, window)
        if input_rect is None or full is None:
            return None
        result, _ = rapid_ocr_engine()(full, use_cls=False)
    except Exception:
        return None

    image_height, image_width = full.shape[:2]
    if image_width < 1 or image_height < 1:
        return None
    scale_x = image_width / max(float(window["w"]), 1.0)
    scale_y = image_height / max(float(window["h"]), 1.0)
    input_x, input_y, input_width, input_height = (float(value) for value in input_rect)
    candidates = []
    for row in result or []:
        if len(row) < 3 or float(row[2]) < 0.60:
            continue
        box, raw_text = row[0], bounded_text(row[1], 32)
        label = re.sub(r"\s+", "", unicodedata.normalize("NFKC", raw_text)).lower()
        if label not in ("发送", "send"):
            continue
        center_x = sum(float(point[0]) for point in box) / max(len(box), 1)
        center_y = sum(float(point[1]) for point in box) / max(len(box), 1)
        screen_x = float(window["x"]) + center_x / scale_x
        screen_y = float(window["y"]) + center_y / scale_y
        if not (
            input_x + input_width * 0.62 <= screen_x <= input_x + input_width + 4
            and input_y <= screen_y <= input_y + input_height + 4
        ):
            continue
        box_width = (max(float(point[0]) for point in box) - min(float(point[0]) for point in box)) / scale_x
        box_height = (max(float(point[1]) for point in box) - min(float(point[1]) for point in box)) / scale_y
        if not (8 <= box_width <= 180 and 8 <= box_height <= 80):
            continue
        candidates.append((float(row[2]), screen_x, screen_y))
    if len(candidates) != 1:
        return None
    confidence, screen_x, screen_y = candidates[0]
    return {"mode": "visual", "point": (screen_x, screen_y), "confidence": confidence}


def _managed_send_target(perception, fill, current: dict):
    button = _send_button(fill, current.get("window") or {})
    if button is not None:
        return {"mode": "accessibility", "control": button}
    return _visual_send_point(perception, current)


def _same_visual_point(first, second, tolerance: float = 12.0) -> bool:
    first_point = first.get("point", ()) if isinstance(first, dict) else ()
    second_point = second.get("point", ()) if isinstance(second, dict) else ()
    return (
        len(first_point) == 2
        and len(second_point) == 2
        and first.get("mode") == "visual"
        and second.get("mode") == "visual"
        and all(abs(float(a) - float(b)) <= tolerance for a, b in zip(first_point, second_point))
    )


def _managed_input_text(fill, target: dict, input_mode: str):
    if input_mode == "accessibility":
        return fill._ax_value(target.get("box"))
    try:
        from visual_fill import input_text  # type: ignore

        return input_text(target["window"], target["visual_rect"])
    except Exception:
        return None


def _confirmed_managed_input(fill, target: dict, input_mode: str, draft: str):
    """Boundedly wait for the just-written draft to become readable.

    WeChat paints visually injected Unicode before its captured pixels/OCR necessarily
    catch up.  The visual writer can therefore report an uncertain result even though
    the exact draft is already visible.  The input was proven empty before the write, so
    an exact post-write readback is authoritative; nothing consequential happens until
    this succeeds.
    """
    landed = None
    expected = _compact_visible_text(draft)
    for attempt in range(3):
        landed = _managed_input_text(fill, target, input_mode)
        if landed is not None and expected and expected in _compact_visible_text(landed):
            return True, landed
        if attempt < 2:
            time.sleep(0.15)
    return False, landed


def managed_send_preflight(perception, fill, request: dict) -> dict:
    """Prove that the current group has a safe delivery route without typing or sending."""
    if request.get("managed") is not True:
        return {"ok": False, "ready": False, "category": "confirmation_required", "error": "managed confirmation is required"}
    expected_title = bounded_text(request.get("expectedTitle"), 240)
    expected_digest = bounded_text(request.get("expectedDigest"), 128)
    if not expected_title or len(expected_digest) != 64:
        return {"ok": False, "ready": False, "category": "invalid_request", "error": "invalid managed send preflight request"}
    current = scan(perception)
    if not current.get("ok"):
        return {**current, "ready": False, "category": "scan_failed"}
    if current["title"] != expected_title or current["digest"] != expected_digest:
        return {
            "ok": False,
            "ready": False,
            "category": "conversation_changed",
            "error": "the visible WeChat conversation changed; managed mode was not armed",
        }
    _, input_mode, category, reason = _managed_input_target(perception, fill, current)
    if input_mode is None:
        return {"ok": False, "ready": False, "category": category, "error": reason}
    # WeChat 4.x may create or expose its Send button only after text is present. Requiring
    # that control while the verified input is still empty produces a false preflight
    # failure. The consequential control is resolved after the draft lands and is checked
    # again immediately before the single allowed click.
    return {"ok": True, "ready": True, "inputMode": input_mode, "sendMode": "after-fill"}


def send_managed_draft(perception, fill, request: dict) -> dict:
    """Fill and press a verified Send button only for an explicitly armed Hara request."""
    if request.get("managed") is not True:
        return {"ok": False, "category": "confirmation_required", "error": "managed confirmation is required"}
    draft = bounded_text(request.get("draft"), 4000)
    expected_title = bounded_text(request.get("expectedTitle"), 240)
    expected_digest = bounded_text(request.get("expectedDigest"), 128)
    if not draft or not expected_title or len(expected_digest) != 64:
        return {"ok": False, "category": "invalid_request", "error": "invalid managed send request"}

    current = scan(perception)
    if not current.get("ok"):
        return {**current, "category": "scan_failed"}
    if current["title"] != expected_title or current["digest"] != expected_digest:
        return {
            "ok": False,
            "category": "conversation_changed",
            "error": "the visible WeChat conversation changed; managed send was stopped",
        }

    target, input_mode, category, reason = _managed_input_target(perception, fill, current)
    if target is None or input_mode is None:
        return {"ok": False, "category": category, "error": reason}

    ok, reason = fill.fill_text(draft, target=target)
    input_confirmed, landed = _confirmed_managed_input(fill, target, input_mode, draft)
    if not input_confirmed and not ok:
        return {"ok": False, "category": "input_failed", "error": bounded_text(reason, 240)}
    if not input_confirmed:
        return {
            "ok": False,
            "category": "input_unconfirmed",
            "error": "the managed reply could not be verified in the WeChat input",
        }

    # Revalidate the bound conversation after text entry and immediately before the only
    # consequential action. A failed check leaves the draft visible for human review.
    before_press = scan(perception)
    if (
        not before_press.get("ok")
        or before_press.get("title") != expected_title
        or before_press.get("digest") != expected_digest
    ):
        return {
            "ok": False,
            "category": "conversation_changed",
            "error": "the visible WeChat conversation changed before sending",
        }
    send_target = _managed_send_target(perception, fill, before_press)
    if send_target is None:
        return {
            "ok": False,
            "category": "send_control_unavailable",
            "error": "a verified WeChat Send control was not available after filling; the draft remains visible",
        }

    if send_target.get("mode") == "accessibility":
        import ApplicationServices as A  # type: ignore

        try:
            pressed = A.AXUIElementPerformAction(send_target["control"], A.kAXPressAction) == 0
        except Exception:
            pressed = False
        send_mode = "accessibility"
    else:
        send_mode = "visual"
        try:
            import AppKit  # type: ignore
            import Quartz as Q  # type: ignore
            from visual_fill import window_is_current  # type: ignore

            app = fill._wechat_app()
            app.activateWithOptions_(AppKit.NSApplicationActivateIgnoringOtherApps)
            time.sleep(0.15)
            focused = window_is_current(before_press["window"], app, require_front=True)
            focused_scan = scan(perception) if focused else {"ok": False}
            focused_target = (
                _managed_send_target(perception, fill, focused_scan)
                if focused_scan.get("ok")
                and focused_scan.get("title") == expected_title
                and focused_scan.get("digest") == expected_digest
                else None
            )
            pressed = False
            if focused_target and focused_target.get("mode") == "accessibility":
                import ApplicationServices as A  # type: ignore

                pressed = A.AXUIElementPerformAction(focused_target["control"], A.kAXPressAction) == 0
                send_mode = "accessibility"
            elif _same_visual_point(send_target, focused_target):
                point = tuple(float(value) for value in focused_target["point"])
                for event_type in (Q.kCGEventLeftMouseDown, Q.kCGEventLeftMouseUp):
                    event = Q.CGEventCreateMouseEvent(None, event_type, point, Q.kCGMouseButtonLeft)
                    Q.CGEventSetFlags(event, 0)
                    Q.CGEventSetIntegerValueField(event, Q.kCGMouseEventClickState, 1)
                    Q.CGEventPost(Q.kCGHIDEventTap, event)
                pressed = True
                send_mode = "visual"
        except Exception:
            pressed = False
    if not pressed:
        return {
            "ok": False,
            "category": "send_action_refused",
            "error": "WeChat refused the managed Send action; the draft remains visible",
        }
    time.sleep(0.35)
    remaining = _managed_input_text(fill, target, input_mode)
    after_press = scan(perception)
    normalized_draft = _compact_visible_text(draft)
    outgoing_confirmed = bool(
        after_press.get("ok")
        and after_press.get("title") == expected_title
        and any(
            message.get("side") == "me"
            and normalized_draft
            and normalized_draft in _compact_visible_text(message.get("text"))
            for message in after_press.get("messages", [])[-4:]
        )
    )
    input_cleared = remaining is not None and not _compact_visible_text(remaining)
    if not outgoing_confirmed and not input_cleared:
        return {
            "ok": False,
            "category": "delivery_unconfirmed",
            "error": "WeChat delivery could not be verified; managed mode was paused without retrying",
        }
    return {
        "ok": True,
        "sent": True,
        "inputMode": input_mode,
        "sendMode": send_mode,
        "reason": "sent once through the verified WeChat Send control",
    }


def main() -> None:
    request = load_request()
    if sys.platform != "darwin":
        emit({"ok": False, "error": "the local WeChat scene currently requires macOS"}, 2)
    perception, fill = load_jev(request.get("jevRoot"))
    action = bounded_text(request.get("action"), 40)
    if action == "status":
        emit(status(perception, fill))
    if action == "request-permissions":
        emit(request_permissions(perception, fill))
    if action == "scan":
        emit(scan(perception))
    if action == "fill":
        emit(fill_draft(perception, fill, request))
    if action == "send-preflight":
        emit(managed_send_preflight(perception, fill, request))
    if action == "send":
        emit(send_managed_draft(perception, fill, request))
    emit({"ok": False, "error": "unsupported bridge action"}, 2)


if __name__ == "__main__":
    # Keep Python and native frameworks quiet: stdout is the JSON protocol.
    os.environ.setdefault("PYTHONUNBUFFERED", "1")
    main()
