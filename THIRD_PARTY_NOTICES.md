# Third-party notices

## Jev Chat Jarvis for macOS

Hara includes a minimal, audited subset of Jev's macOS WeChat perception and explicit-fill
implementation. It is used only by the local WeChat group Agent scene.

- Upstream: `jev-chat-jarvis-mac`
- Revision: `924273d6b0e09bcc011a591841b79d798f8ee0d3`
- Copyright: 2026 eatmoreduck
- License: MIT

MIT License

Copyright (c) 2026 eatmoreduck

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and
associated documentation files (the "Software"), to deal in the Software without restriction,
including without limitation the rights to use, copy, modify, merge, publish, distribute,
sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial
portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT
NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES
OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN
CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

## On-demand local OCR runtime

Preparing the macOS WeChat scene installs these packages into Hara's private local runtime; they are not
vendored into the source tree or returned to Desktop:

- `rapidocr-onnxruntime` — Apache-2.0
- `onnxruntime` — MIT
- `opencv-python` — Apache-2.0
- `numpy` — BSD-3-Clause
- PyObjC frameworks used by the bridge — MIT

Their upstream distributions include the authoritative license and notice files for the exact versions
resolved at installation time.
