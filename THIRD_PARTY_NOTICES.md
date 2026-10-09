# Third-party notices

## Embedded Pi coding worker

Hara embeds `@earendil-works/pi-coding-agent` 1.1.0 and its locked Pi dependencies as an optional
execution choice. Hara supplies the model route, bounded tools and authorization; the upstream
standalone Pi application, credentials, extensions and update mechanism are not activated.

- Upstream: https://github.com/earendil-works/pi
- License: MIT

MIT License

Copyright (c) 2025 Mario Zechner

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

Third-party dependencies retain their own license terms and notices in their npm distributions.

### Model Context Protocol code included by Pi MCP

The embedded `@earendil-works/pi-mcp` distribution includes code from the TypeScript Model Context
Protocol SDK and the following upstream attribution.

MIT License

Copyright (c) 2024 Anthropic, PBC

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## Hara Code Runtime (OpenCode)

Hara's npm installation includes the matching native optional OpenCode package. Hara Desktop supplies
the separately checksum-pinned sidecar. Hara uses the executable behind its own model, workspace,
tool and approval boundaries; the upstream Desktop and web applications are not included.

- Upstream: https://github.com/anomalyco/opencode
- Version: 1.18.32
- Source revision: 545f51d26cc39a907d2867492d498d9607ea5fa4
- License: MIT

MIT License

Copyright (c) 2025 opencode

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

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

## On-demand Laya-MLX decision runtime

The optional local Action Guard backend installs the following runtime after explicit download consent.
Neither its Python package nor model weights are vendored into Hara's source or npm package. Hara owns
the embedded stdio bridge; it does not execute a separately checked-out Laya repository.

- `laya-mlx` 0.2.0 — Apache-2.0, with upstream `LICENSE` and `NOTICE` in its distribution.
- MLX — MIT; Transformers / Hugging Face Hub — Apache-2.0; NumPy — BSD-3-Clause.
- Checkpoint: `aac6fef/laya-multilingual-mlx`, revision
  `ba40c87fcb357f1643d04d71323af9cdc3b9e591`, derived from the multilingual Laya model.
  Model license/notice files are included in the explicit checkpoint download when supplied upstream.

Use the license and notice files accompanying the resolved package/model distributions for full terms
and attribution. The Laya backend is independent of Jev/TypeSafe and does not imply their endorsement.
