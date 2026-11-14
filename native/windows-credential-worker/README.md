# Hara Windows credential worker (S1; Host activation gated)

Rust standard library + Windows system libraries only. Compile for x86_64-pc-windows-msvc;
never build a worker on demand on a user's computer. No general encrypt/decrypt/file-path API.

One length-prefixed binary request per process, bounded before allocation (8,500,000 bytes).
`HVQ1`, operation byte (probe=0/get=1/set=2/setMany=3/remove=4), 16-byte nonce,
32-byte trusted Host-home namespace, u16 entry count, then u16 ASCII-ref byte length/ref,
u32 UTF-16 code-unit length/key bytes (LE). Keys preserve JS UTF-16 exactly, including lone
surrogates. 240-byte refs, 16,384 code units per key, at most 256 same-scope unique entries.
Reply: u32 length, `HVR1`, same nonce, fixed status byte, u16 value count; each value has
presence byte and, if present, u32 code units + key bytes. No stderr diagnostics or secret argv.
Malformed framing exits without printing input. No environment-supplied storage path.

Ciphertext lives under system KnownFolder LocalAppData/Hara/credential-vault/v1/<namespace>.
Private subtree/files have a protected current-SID-only DACL and owner. Ancestor handles deny
delete sharing; actual file handles reject reparse points and hardlinks and verify the DACL.
The exclusive namespace lock spans reads/writes/readback. Per-ref writes encrypt before creating
any temporary file, flush ciphertext, rename the open handle, and decrypt readback. Multi-file
setMany is not an OS transaction; Host metadata must publish only after the whole batch succeeds.
Unknown writes require readback, never automatic replay. Old refs remain independently readable.
CurrentUser DPAPI only, UI forbidden; authenticated payload and entropy bind service/home/ref.
Buffers are best-effort wiped; this does not promise that JS GC/swap/crash dumps contain no copy.

References: [DPAPI](https://learn.microsoft.com/windows/win32/api/dpapi/nf-dpapi-cryptprotectdata),
[handle rename](https://learn.microsoft.com/windows/win32/api/winbase/ns-winbase-file_rename_info),
[reparse points](https://learn.microsoft.com/windows/win32/fileio/reparse-point-operations).
No production Host switch is part of S1. Real Windows evidence + review precede S2 activation.
