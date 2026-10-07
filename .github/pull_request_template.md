## 变更目的

说明解决的用户问题及范围。

## 主要变更

- 

## 风险与兼容性

说明权限、安全、性能、数据格式和 Windows/Linux 差异；无风险也请明确写出。

## 验证证据

- [ ] `npm test`
- [ ] `npm run typecheck`
- [ ] `npm run format:check`
- [ ] `cargo test --manifest-path web-service/Cargo.toml`
- [ ] 相关平台的 Rust fmt / Clippy
- [ ] 界面变更附截图并检查中英文、键盘和高对比度

## 安全确认

- [ ] 未提交密钥、真实主机信息或用户隐私
- [ ] 未扩大 WebGUI/完整扫描的 loopback-only 边界；局域网端口 API 仍执行 peer/Host/Origin 与 Token 分级校验
- [ ] 新增外部输入已校验，错误信息已限制长度并脱敏
