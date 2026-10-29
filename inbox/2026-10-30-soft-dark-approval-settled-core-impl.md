# Soft Dark 建同事确认卡过期／拒绝态 — Core impl

时间：2026-10-30 Asia/Taipei  
授权：Jeff t1060u；合／装／正式闸另批  
Branch：`feat/core-agent-create-approval-settled-20261030`＠base `29c567f`

## 做了什么

- `approval()`／`finish` 区分 `declined`／`expired`／`aborted`
- `agent_create` 未确认时软返 `{created:false, humanConfirmed:false, approvalState, displayName}`（对齐 turn_limit；不再 throw）
- declined／expired **不** abort 整轮；仅 aborted 掐 run
- 可选 Host `approvalTimeoutMs`（测用）缩短卡寿命，不改 run budget
- 测：declined／expired 结构化字段；既有 turn_cap 仍绿

## sha256

- `src/workspace/local-host.ts`: `000be81bc1d58c25c1c90ea27ad23e0f868072a16efef10430ef9cb398a47a21`
- `test/workspace-production-entry.test.mjs`: `5d7461b00bdbcafa5a5c1a7a26ca17f8268512e0ac713fc3ef070d7cafd3d950`

## 验证

- `npm run build` 绿
- `workspace-production-entry`：turn_cap + soft-returns declined/expired 绿
