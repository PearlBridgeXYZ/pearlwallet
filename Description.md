# PearlWallet PRL 扫描修复说明

本次修复解决 PearlWallet 在线页面中 PRL 余额无法加载、近期活动一直停留在“正在扫描珍珠+以太”的问题。

## 问题原因

钱包原本直接在浏览器里请求 Pearl RPC。当前端无法稳定访问公共 RPC，或遇到浏览器 CORS 限制时，PRL 余额和交易活动扫描会失败或一直等待。

另外，部分 PRL 地址以混合大小写传给 Blockbook 时，会被拒绝，导致接口返回地址格式错误。

## 修复内容

- 新增同源接口 `/api/pearl-rpc`。
- 由服务端代理 Pearl JSON-RPC 请求到 Blockbook。
- 默认 PRL RPC 改为 `/api/pearl-rpc`。
- 保留原有 Pearl 哨兵 RPC 作为备用。
- 查询前统一规范化 PRL 地址大小写。
- 增加请求超时处理，避免页面无限加载。

## 验证结果

- TypeScript 类型检查通过。
- PRL RPC 测试通过。
- 近期活动扫描测试通过。
- 网络配置测试通过。
- RPC fallback 测试通过。
