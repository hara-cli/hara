/** Hara-owned stdio bridge, embedded in npm and standalone builds. No repository Python is executed. */
export const LAYA_PACKAGE_VERSION = "0.2.0";
export const LAYA_MODEL = "aac6fef/laya-multilingual-mlx";
export const LAYA_REVISION = "ba40c87fcb357f1643d04d71323af9cdc3b9e591";
export const LAYA_WEIGHT_SHA256 = "7fc5834af4d8fdfb268d272a9d1a66e5819a0daac98241651c4c888cc43adff1";
export const LAYA_WHEEL = "https://files.pythonhosted.org/packages/61/21/89b7f030fcbfb6327f1fc553480fbeaa2aae7408338ee422c2cf37746e66/laya_mlx-0.2.0-py3-none-any.whl#sha256=1a80a0cc79c55be808de0b1208a172566209b5780d796b98d86235e9cf335187";

// These programs are intentionally not an HTTP server. Task data travels only over private pipes.
// Preparation is a separate, explicit operation; inference always has HF_HUB_OFFLINE=1.
export const LAYA_MODEL_PREPARE = String.raw`
import sys
from huggingface_hub import snapshot_download
root, model, revision, expected_weight = sys.argv[1:]
snapshot_download(model, revision=revision, token=False, local_dir=root,
    allow_patterns=["model.safetensors", "rl_agent_config.json", "encoder/config.json",
                    "tokenizer/*", "mlx_config.json", "manifest.json", "LICENSE", "NOTICE"])
`;

export const LAYA_WORKER = String.raw`
import hashlib, importlib.metadata, json, sys
from pathlib import Path

def verified_model(root, expected_weight):
    root = Path(root).resolve()
    manifest = json.loads((root / "manifest.json").read_text())
    required = ["model.safetensors", "rl_agent_config.json", "encoder/config.json",
                "tokenizer/tokenizer.json", "tokenizer/tokenizer_config.json"]
    for name in required:
        entry = manifest["files"][name]
        target = root / name
        if target.is_symlink() or target.resolve() != target or not target.is_file():
            raise ValueError("invalid_model_file")
        if not isinstance(entry["sha256"], str) or len(entry["sha256"]) != 64:
            raise ValueError("invalid_model_manifest")
        digest = hashlib.sha256()
        with target.open("rb") as handle:
            for part in iter(lambda: handle.read(1024 * 1024), b""):
                digest.update(part)
        actual = digest.hexdigest()
        if actual != entry["sha256"] or (name == "model.safetensors" and actual != expected_weight):
            raise ValueError("model_checksum_mismatch")
    return root

def check_budget(agent, state, questions):
    from laya_mlx.common import build_prefix, render_options, serialize_state
    for definition in questions.values():
        q = agent._to_internal(definition)
        tok = agent.tok
        head_limit = agent.cfg.get("head_max_len", 192)
        head = tok(q["t"] + " question: " + str(q["ins"]).replace(tok.mask_token, " "),
                   add_special_tokens=False)["input_ids"]
        opts = [tok(" " + option.replace(tok.mask_token, " "), add_special_tokens=False)["input_ids"]
                for option in render_options(q)]
        # Upstream truncates both questions/options and the state. Never accept either silently.
        if any(len(option) > 48 for option in opts) or len(head) + sum(len(o) + 1 for o in opts) > head_limit:
            raise ValueError("question_budget_exceeded")
        prefix, _ = build_prefix(tok, q, head_limit)
        body = tok(serialize_state(state).replace(tok.mask_token, " "), add_special_tokens=False)["input_ids"]
        if len(prefix) + len(body) + 1 > min(agent.cfg.get("max_len", 512), 1024):
            raise ValueError("context_budget_exceeded")

def main():
    root, model, revision, expected_weight, version, operation = sys.argv[1:]
    if importlib.metadata.version("laya-mlx") != version:
        raise ValueError("runtime_version_mismatch")
    root = verified_model(root, expected_weight)
    if operation == "verify":
        print(json.dumps({"verified": True}), flush=True)
        return
    from laya_mlx import Agent
    agent = Agent(root, dtype="float16", device="gpu", batch_size=1)
    print(json.dumps({"ready": True, "model": model, "revision": revision}), flush=True)
    for line in sys.stdin:
        request = json.loads(line)
        request_id = request.get("id")
        try:
            check_budget(agent, request["state"], request["questions"])
            result = agent.predict(request["state"], request["questions"])
            result["model"] = model + "@" + revision
            print(json.dumps({"id": request_id, "result": result}, allow_nan=False), flush=True)
        except Exception as error:
            # No action text, file paths, model dumps or tracebacks cross the receipt boundary.
            code = str(error) if str(error) in ("context_budget_exceeded", "question_budget_exceeded") else "inference_failed"
            print(json.dumps({"id": request_id, "error": code}), flush=True)

if __name__ == "__main__":
    try:
        main()
    except Exception:
        print(json.dumps({"error": "runtime_verification_failed"}), flush=True)
        sys.exit(1)
`;
